// Contexto da sessão para o n8n (N2, Apêndice A.1 do spec). ÚNICO lugar que
// monta o payload chat.turn.session/tenant/customer/debt/matrix/offers.
//
// Mascaramento EMBUTIDO: document_masked + document_hash sempre; o documento em
// CLARO só viaja quando send_document_to_engine=true E payment_origin='n8n'
// (as duas flags, por tenant). Fora disso customer.document = null.
//
// Valores monetários em CENTAVOS (Integer) — o LLM/fluxo nunca lida com reais.

import { createHash } from "node:crypto"
import { createServiceClient } from "@/lib/supabase/service"
import { agingDays } from "@/lib/negotiation/config"
import { resolveMatrixRow } from "@/lib/negotiation/matrix"
import type { OfferTerms } from "@/lib/negotiation/offers"
import { maskDocument, normalizeDocument } from "./document"

const toCents = (reais: number) => Math.round((reais || 0) * 100)
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex")

export interface SessionContext {
  session: {
    id: string
    channel: "web_campaign" | "web_generic" | "admin_preview"
    verified: boolean
    verified_at: string | null
    consent: boolean
    turn_index: number
    engine: string
    locale: "pt-BR"
  }
  tenant: {
    id: string
    slug: string | null
    brand_name: string
    creditor_name: string
    fulfillment_mode: string
    payment_origin: "platform" | "n8n"
  }
  customer: {
    id: string
    first_name: string
    document_type: "cpf" | "cnpj"
    document_masked: string
    document_hash: string
    document: string | null // claro só com as 2 flags
  }
  debt: {
    id: string
    ids: string[]
    original_value: number // centavos
    updated_value: number // centavos
    oldest_due_date: string | null
    aging_days: number
    invoice_count: number
    invoices: Array<{ invoice: string; due_date: string; value: number }>
  }
  matrix: {
    id: string
    max_discount_pct: number
    min_entry_pct: number
    max_installments: number
    allowed_billing_types: string[]
    proposal_validity_days: number
  } | null
  offers: Array<{ id: string; terms: OfferTermsCents; valid_until: string | null }>
  // Reconhecimento da dívida (onda R): última resposta por (session, primary_debt).
  debt_acknowledgement: {
    answered: boolean
    acknowledged: boolean | null
    button_id: number | null
    answered_at: string | null
    prompt_id: string | null
  }
  // Prompt ATIVO da sessão (se houver) — para o fluxo saber que há uma pergunta
  // pendente de clique (botões em ids; valores só na borda, sem PII).
  active_prompt: {
    id: string
    kind: string
    question: string
    buttons: Array<{ id: number; label: string; value?: string }>
  } | null
  agreement: null
}

interface OfferTermsCents {
  discount_pct: number
  entry_value: number
  installments: number
  installment_value: number
  total_value: number
  billing_type: string
  first_due_date: string
}

function offerTermsToCents(t: OfferTerms): OfferTermsCents {
  return {
    discount_pct: t.discount_pct,
    entry_value: toCents(t.entry_value),
    installments: t.installments,
    installment_value: toCents(t.installment_value),
    total_value: toCents(t.total_value),
    billing_type: t.billing_type,
    first_due_date: t.first_due_date,
  }
}

/**
 * Monta o contexto completo da sessão. `turnIndex` é o número do turno atual
 * (0-based) para o payload. Retorna null se a sessão/cliente/dívida não
 * resolverem (chamador trata como engine indisponível).
 */
export async function buildSessionContext(
  sessionId: string,
  turnIndex = 0,
): Promise<SessionContext | null> {
  const supabase = createServiceClient()
  const { data: session } = await supabase
    .from("negotiation_sessions")
    .select(
      "id, company_id, customer_id, debt_id, primary_debt_id, debt_ids, channel, engine, identity_verified_at, consent_lgpd_at, consent_at, fulfillment_mode",
    )
    .eq("id", sessionId)
    .maybeSingle()
  if (!session || !session.customer_id) return null

  const primaryDebtId = session.primary_debt_id ?? session.debt_id
  const debtIds: string[] =
    (session.debt_ids?.length ? session.debt_ids : primaryDebtId ? [primaryDebtId] : []) as string[]
  if (!primaryDebtId || debtIds.length === 0) return null

  const [{ data: cfg }, { data: company }, { data: customer }] = await Promise.all([
    supabase
      .from("tenant_chat_config")
      .select("branding, fulfillment_mode, payment_origin, send_document_to_engine")
      .eq("company_id", session.company_id)
      .maybeSingle(),
    supabase.from("companies").select("name").eq("id", session.company_id).maybeSingle(),
    supabase
      .from("customers")
      .select("id, name, document")
      .eq("id", session.customer_id)
      .eq("company_id", session.company_id)
      .maybeSingle(),
  ])
  if (!customer) return null

  const doc = normalizeDocument(customer.document)
  const paymentOrigin = (cfg?.payment_origin ?? "platform") as "platform" | "n8n"
  const sendPlain = cfg?.send_document_to_engine === true && paymentOrigin === "n8n"
  const branding = (cfg?.branding ?? {}) as Record<string, unknown>
  const brandName =
    (typeof branding.brand_name === "string" && branding.brand_name) || company?.name || "Credor"
  const slug = typeof branding.slug === "string" ? branding.slug : null

  // dívidas abertas (consolidado)
  const { data: debts } = await supabase
    .from("debts")
    .select("id, amount, due_date")
    .eq("company_id", session.company_id)
    .in("id", debtIds)
  const totalOriginal = (debts ?? []).reduce((s, d) => s + Number(d.amount ?? 0), 0)
  const totalUpdated = (debts ?? []).reduce(
    (s, d) => s + Number(d.amount ?? 0),
    0,
  )

  // faturas por documento (detalhe fino)
  const { data: invoices } = await supabase
    .from("vmax_invoices")
    .select("fatura, vencimento, saldo")
    .eq("id_company", session.company_id)
    .eq("doc", doc)
    .order("vencimento", { ascending: true })
  const oldestInvoiceDue = invoices?.[0]?.vencimento ?? null
  const oldestDebtDue =
    (debts ?? []).map((d) => d.due_date).filter(Boolean).sort()[0] ?? null
  const oldestDueDate = oldestInvoiceDue ?? oldestDebtDue
  const aging = oldestDueDate ? agingDays(oldestDueDate) : 0

  // matriz (server decide) — pura leitura
  const row = await resolveMatrixRow({
    companyId: session.company_id,
    agingDays: aging,
    debtValue: totalUpdated,
  })

  // ofertas válidas atuais da sessão
  const now = new Date().toISOString()
  const { data: currentOffers } = await supabase
    .from("negotiation_offers")
    .select("id, terms, valid_until")
    .eq("session_id", sessionId)
    .eq("status", "presented")
    .or(`valid_until.is.null,valid_until.gt.${now}`)
    .order("created_at", { ascending: true })

  // reconhecimento da dívida (onda R): última resposta por (session, primary_debt)
  const { data: ackLatest } = await supabase
    .from("debt_acknowledgement_latest")
    .select("acknowledged, button_id, created_at, prompt_id")
    .eq("session_id", sessionId)
    .eq("debt_id", primaryDebtId)
    .maybeSingle()

  // prompt ATIVO da sessão (se houver)
  const { data: activePrompt } = await supabase
    .from("chat_prompts")
    .select("id, kind, question, buttons")
    .eq("session_id", sessionId)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  return {
    session: {
      id: session.id,
      channel: (session.channel ?? "web_generic") as SessionContext["session"]["channel"],
      verified: Boolean(session.identity_verified_at),
      verified_at: session.identity_verified_at ?? null,
      consent: Boolean(session.consent_at ?? session.consent_lgpd_at),
      turn_index: turnIndex,
      engine: session.engine ?? process.env.NEGOTIATION_ENGINE ?? "disabled",
      locale: "pt-BR",
    },
    tenant: {
      id: session.company_id,
      slug,
      brand_name: brandName,
      creditor_name: brandName,
      fulfillment_mode: session.fulfillment_mode ?? cfg?.fulfillment_mode ?? "A",
      payment_origin: paymentOrigin,
    },
    customer: {
      id: customer.id,
      first_name: (customer.name ?? "").trim().split(/\s+/)[0] ?? "",
      document_type: doc.length === 14 ? "cnpj" : "cpf",
      document_masked: maskDocument(doc),
      document_hash: sha256(doc),
      document: sendPlain ? doc : null,
    },
    debt: {
      id: primaryDebtId,
      ids: debtIds,
      original_value: toCents(totalOriginal),
      updated_value: toCents(totalUpdated),
      oldest_due_date: oldestDueDate,
      aging_days: aging,
      invoice_count: invoices?.length ?? (debts?.length ?? 0),
      invoices: (invoices ?? []).map((i) => ({
        invoice: i.fatura,
        due_date: i.vencimento,
        value: toCents(Number(i.saldo)),
      })),
    },
    matrix: row
      ? {
          id: row.id,
          max_discount_pct: row.max_discount_pct,
          min_entry_pct: row.min_entry_pct,
          max_installments: row.max_installments,
          allowed_billing_types: row.allowed_billing_types,
          proposal_validity_days: row.proposal_validity_days,
        }
      : null,
    offers: (currentOffers ?? []).map((o) => ({
      id: o.id,
      terms: offerTermsToCents(o.terms as OfferTerms),
      valid_until: o.valid_until,
    })),
    debt_acknowledgement: {
      answered: Boolean(ackLatest),
      acknowledged: ackLatest ? Boolean(ackLatest.acknowledged) : null,
      button_id: ackLatest?.button_id ?? null,
      answered_at: ackLatest?.created_at ?? null,
      prompt_id: ackLatest?.prompt_id ?? null,
    },
    active_prompt: activePrompt
      ? {
          id: activePrompt.id,
          kind: activePrompt.kind,
          question: activePrompt.question,
          buttons: (activePrompt.buttons ?? []) as Array<{ id: number; label: string; value?: string }>,
        }
      : null,
    agreement: null,
  }
}
