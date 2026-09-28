// N8N-15 (a) — aliases de oferta no `payment.create` do n8n.
//
// O caminho CANÔNICO continua sendo o uuid devolvido por `offer.list`. Para o
// fluxo não precisar carregar uuids, `args.offer_id` também aceita:
//   'avista'  → a oferta ATUAL de 1 parcela da sessão
//   'parc_N'  → a oferta ATUAL de N parcelas (N ≥ 2) da sessão
//
// Segurança (regra de ouro: o servidor decide valores):
//  - o alias só SELECIONA uma oferta que o servidor já gerou e apresentou nesta
//    sessão; nunca gera oferta nem monta termos (resolução só-leitura);
//  - resolve apenas se houver EXATAMENTE UMA candidata; zero → 409
//    OFFER_ALIAS_NOT_FOUND (ou OFFER_EXPIRED); mais de uma (ex.: o n8n propôs
//    um à vista próprio além do da matriz) → 409 OFFER_ALIAS_AMBIGUOUS — nunca
//    escolhe "a mais provável" e cobra um valor diferente do que foi dito;
//  - a oferta integral do botão PAGAR (0%/1x) não é "a oferta à vista" da
//    negociação e fica fora;
//  - depois do resolve o fluxo é idêntico ao do uuid (reconhecimento, matriz
//    vigente, guard duplo, idempotência por (sessão, oferta)).
//
// Idempotência entre alias e uuid: após o 1º payment.create a oferta vira
// 'accepted' e as irmãs 'superseded'. Sem candidata 'presented', o alias cai na
// oferta 'accepted' do mesmo tipo desta sessão → mesma oferta → mesmo acordo →
// mesma cobrança (idempotent:true).

import { createServiceClient } from "@/lib/supabase/service"
import { isPayIntegralOfferRow, type OfferTerms } from "./offers"

export type OfferAlias = { raw: string; installments: number }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_ALIAS_INSTALLMENTS = 60

/** 'avista' → 1 parcela; 'parc_N' (2 ≤ N ≤ 60) → N parcelas; senão null. Pura. */
export function parseOfferAlias(offerId: string): OfferAlias | null {
  const v = offerId.trim().toLowerCase()
  if (v === "avista") return { raw: v, installments: 1 }
  const m = v.match(/^parc_(\d{1,2})$/)
  if (!m) return null
  const n = Number(m[1])
  if (n < 2 || n > MAX_ALIAS_INSTALLMENTS) return null
  return { raw: v, installments: n }
}

export interface AliasOfferRow {
  id: string
  terms: Partial<OfferTerms> | null
  status: string
  valid_until: string | null
  source?: string | null
  created_at?: string | null
}

export type AliasPick =
  | { ok: true; offerId: string; via: "presented" | "accepted" }
  | { ok: false; code: "OFFER_ALIAS_NOT_FOUND" | "OFFER_ALIAS_AMBIGUOUS" | "OFFER_EXPIRED"; candidates: number }

/**
 * Escolhe a oferta do alias entre as linhas da sessão. Pura (testável).
 * 1) 'presented' e não vencidas do tipo → exatamente uma, senão ambíguo;
 * 2) nenhuma apresentada → 'accepted' do tipo (reenvio idempotente);
 * 3) só vencidas → OFFER_EXPIRED; nada → OFFER_ALIAS_NOT_FOUND.
 */
export function pickOfferForAlias(alias: OfferAlias, rows: AliasOfferRow[], nowMs: number): AliasPick {
  const systemRows = rows.filter((r) => (r.source ?? "system") === "system")
  const ofKind = rows.filter(
    (r) => Number(r.terms?.installments) === alias.installments && !isPayIntegralOfferRow(r, systemRows),
  )
  const expired = (r: AliasOfferRow) => {
    if (!r.valid_until) return false
    const t = Date.parse(r.valid_until)
    return Number.isFinite(t) && t < nowMs
  }

  const presented = ofKind.filter((r) => r.status === "presented")
  const live = presented.filter((r) => !expired(r))
  if (live.length === 1) return { ok: true, offerId: live[0].id, via: "presented" }
  if (live.length > 1) return { ok: false, code: "OFFER_ALIAS_AMBIGUOUS", candidates: live.length }

  const accepted = ofKind.filter((r) => r.status === "accepted")
  if (accepted.length === 1) return { ok: true, offerId: accepted[0].id, via: "accepted" }
  if (accepted.length > 1) return { ok: false, code: "OFFER_ALIAS_AMBIGUOUS", candidates: accepted.length }

  if (presented.length > 0) return { ok: false, code: "OFFER_EXPIRED", candidates: 0 }
  return { ok: false, code: "OFFER_ALIAS_NOT_FOUND", candidates: 0 }
}

export type OfferIdResolution =
  | { ok: true; offerId: string; alias: string | null }
  | { ok: false; status: 409; code: string; message: string }

const ALIAS_MESSAGES: Record<string, string> = {
  OFFER_ALIAS_NOT_FOUND: "nenhuma oferta apresentada deste tipo nesta sessão — chame offer.list e use o id",
  OFFER_ALIAS_AMBIGUOUS: "mais de uma oferta deste tipo nesta sessão — use o id (uuid) de offer.list",
  OFFER_EXPIRED: "a oferta deste tipo venceu — chame offer.list para gerar as vigentes",
}

/**
 * Resolve `args.offer_id` do payment.create. uuid (canônico) e valores que não
 * são alias passam intactos, SEM leitura (o fluxo de validação de sempre decide).
 * Alias → uuid da oferta da sessão, isolado por sessão + tenant.
 */
export async function resolveOfferIdForSession(
  ctx: { sessionId: string; companyId: string },
  offerId: string,
): Promise<OfferIdResolution> {
  if (UUID_RE.test(offerId)) return { ok: true, offerId, alias: null }
  const alias = parseOfferAlias(offerId)
  if (!alias) return { ok: true, offerId, alias: null }

  const supabase = createServiceClient()
  const { data } = await supabase
    .from("negotiation_offers")
    .select("id, terms, status, valid_until, source, created_at")
    .eq("session_id", ctx.sessionId)
    .eq("company_id", ctx.companyId)
  const pick = pickOfferForAlias(alias, (data ?? []) as AliasOfferRow[], Date.now())
  if (pick.ok) return { ok: true, offerId: pick.offerId, alias: alias.raw }
  return { ok: false, status: 409, code: pick.code, message: ALIAS_MESSAGES[pick.code] }
}
