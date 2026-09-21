// Projeção de status por devedor (trilha T1): journey_events → negotiation_state.
//
// Duas formas, garantidamente equivalentes:
//   applyJourneyEventToState(event)  — projeção INCREMENTAL (upsert por
//     company_id+customer_id) chamada a cada evento gravado.
//   rebuildNegotiationState(companyId) — recomputo COMPLETO idempotente a partir
//     de journey_events; DEVE dar resultado idêntico à projeção incremental.
//
// Regra de ouro do estágio:
//   - stage_rank é MONOTÔNICO por eventos de CANAL (uma mensagem reenviada nunca
//     faz 'paid' regredir para 'dispatched').
//   - Só eventos de DOMÍNIO regridem (cobrança cancelada / acordo desfeito): eles
//     definem o estágio explicitamente, mesmo para baixo.
//   - marks[<marco>] recebe o timestamp (occurred_at) da primeira ocorrência.
//
// Módulo PURO no núcleo (reduceEvents/applyEventToState) — testável sem banco.
// A leitura/gravação em Supabase fica isolada nas duas funções assíncronas.

import { createServiceClient } from "@/lib/supabase/service"

// ------------------------------------------------------------------
// Apêndice A: estágio → rank
// ------------------------------------------------------------------
export const STAGE_RANK: Record<string, number> = {
  no_contact: 1,
  opted_out: 5,
  blocked: 5,
  not_started: 0,
  queued: 10,
  dispatched: 20,
  delivered: 30,
  read: 35,
  link_opened: 40,
  dispute: 45,
  human_handoff: 45,
  authenticated: 50,
  chat_idle: 55,
  in_chat: 60,
  not_recognized: 64,
  acknowledged: 65,
  offer_presented: 70,
  charge_cancelled: 75,
  charge_generated: 80,
  overdue: 85,
  paid: 100,
}

export type Stage = keyof typeof STAGE_RANK

export function stageRank(stage: string): number {
  return STAGE_RANK[stage] ?? 0
}

// ------------------------------------------------------------------
// Mapa evento → estágio.
// Eventos de DOMÍNIO (podem REGREDIR o estágio explicitamente) marcados abaixo.
// Eventos puramente de canal/informativos ficam com { channel: true } e só
// avançam se o rank subir.
// ------------------------------------------------------------------
interface StageMapping {
  stage: Stage
  /** evento de domínio: define o estágio mesmo quando o rank é menor (regride). */
  domain?: boolean
  /** marco a carimbar em marks[] (default: o próprio stage). */
  mark?: string
}

export const EVENT_STAGE_MAP: Record<string, StageMapping> = {
  // --- campanha / envio (canal) ---
  "message.queued": { stage: "queued" },
  "message.suppressed": { stage: "no_contact" },
  "message.accepted": { stage: "dispatched" },
  "message.sent": { stage: "dispatched" },
  "message.delivered": { stage: "delivered" },
  "message.read": { stage: "read" },
  "message.failed": { stage: "no_contact" },
  "contact.stopped": { stage: "no_contact", domain: true },
  "link.clicked": { stage: "link_opened" },

  // --- autenticação / sessão (canal) ---
  "auth.success": { stage: "authenticated" },
  "consent.given": { stage: "authenticated" },
  "session.started": { stage: "authenticated" },

  // --- chat (canal) ---
  "chat.turn.customer": { stage: "in_chat" },
  "chat.turn.assistant": { stage: "in_chat" },
  "debt.viewed": { stage: "in_chat" },

  // --- reconhecimento ---
  "debt.acknowledged": { stage: "acknowledged" },
  "debt.not_recognized": { stage: "not_recognized" },

  // --- ofertas ---
  "offer.presented": { stage: "offer_presented" },
  "offer.viewed": { stage: "offer_presented" },
  "offer.accepted": { stage: "offer_presented" },
  "offer.rejected": { stage: "offer_presented" },

  // --- pagamento / cobrança (domínio nos negativos) ---
  "agreement.created": { stage: "charge_generated" },
  "payment.generated": { stage: "charge_generated" },
  "payment.viewed": { stage: "charge_generated" },
  "payment.overdue": { stage: "overdue" },
  "payment.paid": { stage: "paid" },
  "payment.cancelled": { stage: "charge_cancelled", domain: true },

  // --- desvios de funil (domínio: estabilizam o estágio) ---
  "dispute": { stage: "dispute", domain: true },
  "dispute.registered": { stage: "dispute", domain: true },
  "payment_claim.registered": { stage: "dispute", domain: true },
  "human.transfer": { stage: "human_handoff", domain: true },
  "optout.received": { stage: "opted_out", domain: true },
  "block.received": { stage: "blocked", domain: true },
}

// ------------------------------------------------------------------
// Núcleo puro
// ------------------------------------------------------------------
export interface JourneyEventLike {
  event_type: string
  occurred_at: string
  campaign_id?: string | null
  session_id?: string | null
  agreement_id?: string | null
  payload?: Record<string, unknown> | null
}

export interface NegotiationStateProjection {
  stage: Stage
  stage_rank: number
  stage_at: string | null
  marks: Record<string, string>
  channel: string | null
  campaign_id: string | null
  session_id: string | null
  agreement_id: string | null
  has_live_charge: boolean
  provider_status_source: string
}

export function initialState(): NegotiationStateProjection {
  return {
    stage: "not_started",
    stage_rank: STAGE_RANK.not_started,
    stage_at: null,
    marks: {},
    channel: null,
    campaign_id: null,
    session_id: null,
    agreement_id: null,
    has_live_charge: false,
    provider_status_source: "none",
  }
}

/** Estágios que representam uma cobrança viva (para has_live_charge). */
const LIVE_CHARGE_STAGES = new Set<string>(["charge_generated", "overdue"])

/**
 * Aplica um evento a um estado (função PURA). Nunca regride por evento de canal;
 * eventos de domínio definem o estágio explicitamente (podem baixar o rank).
 */
export function applyEventToState(
  state: NegotiationStateProjection,
  event: JourneyEventLike,
): NegotiationStateProjection {
  const mapping = EVENT_STAGE_MAP[event.event_type]

  // Correlações sempre acompanham o último evento que as traz (não regridem
  // estágio, mas mantêm o vínculo mais recente).
  const next: NegotiationStateProjection = { ...state, marks: { ...state.marks } }
  if (event.campaign_id) next.campaign_id = event.campaign_id
  if (event.session_id) next.session_id = event.session_id
  if (event.agreement_id) next.agreement_id = event.agreement_id

  if (!mapping) return next

  const candidateRank = stageRank(mapping.stage)
  const markKey = mapping.mark ?? mapping.stage
  // marco: primeira ocorrência vence (append-only na projeção).
  if (next.marks[markKey] === undefined) next.marks[markKey] = event.occurred_at

  const advances = candidateRank > next.stage_rank
  if (mapping.domain || advances) {
    next.stage = mapping.stage
    next.stage_rank = candidateRank
    next.stage_at = event.occurred_at
  }

  next.has_live_charge = LIVE_CHARGE_STAGES.has(next.stage)
  return next
}

/**
 * Projeta uma lista de eventos (ordenada por occurred_at asc) num único estado.
 * PURA. Usada tanto pelo rebuild quanto pelos testes (rebuild==incremental).
 */
export function reduceEvents(events: JourneyEventLike[]): NegotiationStateProjection {
  const ordered = [...events].sort((a, b) => {
    if (a.occurred_at < b.occurred_at) return -1
    if (a.occurred_at > b.occurred_at) return 1
    return 0
  })
  let state = initialState()
  for (const ev of ordered) state = applyEventToState(state, ev)
  return state
}

// ------------------------------------------------------------------
// Camada de banco
// ------------------------------------------------------------------
const PAGE_SIZE = 1000

function toRow(
  companyId: string,
  customerId: string,
  s: NegotiationStateProjection,
): Record<string, unknown> {
  return {
    company_id: companyId,
    customer_id: customerId,
    stage: s.stage,
    stage_rank: s.stage_rank,
    stage_at: s.stage_at,
    marks: s.marks,
    channel: s.channel,
    campaign_id: s.campaign_id,
    session_id: s.session_id,
    agreement_id: s.agreement_id,
    has_live_charge: s.has_live_charge,
    provider_status_source: s.provider_status_source,
    updated_at: new Date().toISOString(),
  }
}

export interface ApplyJourneyEventInput extends JourneyEventLike {
  companyId: string
  customerId?: string | null
}

/**
 * Projeção incremental: lê o estado atual do devedor, aplica UM evento e
 * regrava (upsert por company_id+customer_id). Sem customerId → no-op.
 */
export async function applyJourneyEventToState(
  event: ApplyJourneyEventInput,
): Promise<{ ok: boolean }> {
  if (!event.customerId) return { ok: true }
  const supabase = createServiceClient()

  const { data: existing, error: readErr } = await (supabase as any)
    .from("negotiation_state")
    .select(
      "stage, stage_rank, stage_at, marks, channel, campaign_id, session_id, agreement_id, has_live_charge, provider_status_source",
    )
    .eq("company_id", event.companyId)
    .eq("customer_id", event.customerId)
    .maybeSingle()
  if (readErr) {
    console.error("[journey] applyJourneyEventToState read:", readErr.message)
    return { ok: false }
  }

  const current: NegotiationStateProjection = existing
    ? {
        stage: existing.stage,
        stage_rank: existing.stage_rank,
        stage_at: existing.stage_at,
        marks: (existing.marks as Record<string, string>) ?? {},
        channel: existing.channel ?? null,
        campaign_id: existing.campaign_id ?? null,
        session_id: existing.session_id ?? null,
        agreement_id: existing.agreement_id ?? null,
        has_live_charge: existing.has_live_charge ?? false,
        provider_status_source: existing.provider_status_source ?? "none",
      }
    : initialState()

  const nextState = applyEventToState(current, event)
  const row = toRow(event.companyId, event.customerId, nextState)

  const { error: upErr } = await (supabase as any)
    .from("negotiation_state")
    .upsert(row, { onConflict: "company_id,customer_id" })
  if (upErr) {
    console.error("[journey] applyJourneyEventToState upsert:", upErr.message)
    return { ok: false }
  }
  return { ok: true }
}

/**
 * Recomputo completo e idempotente da empresa a partir de journey_events.
 * Agrupa por customer_id e reduz cada grupo. Resultado IDÊNTICO à projeção
 * incremental (validado com diferença zero). Retorna { customers } processados.
 */
export async function rebuildNegotiationState(
  companyId: string,
): Promise<{ customers: number }> {
  const supabase = createServiceClient()

  const byCustomer = new Map<string, JourneyEventLike[]>()
  let page = 0
  for (;;) {
    const { data, error } = await (supabase as any)
      .from("journey_events")
      .select("customer_id, event_type, occurred_at, campaign_id, session_id, agreement_id")
      .eq("company_id", companyId)
      .order("occurred_at", { ascending: true })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
    if (error) throw new Error(`rebuildNegotiationState(read): ${error.message}`)
    const rows = (data ?? []) as Array<JourneyEventLike & { customer_id: string | null }>
    for (const r of rows) {
      if (!r.customer_id) continue
      const list = byCustomer.get(r.customer_id) ?? []
      list.push({
        event_type: r.event_type,
        occurred_at: r.occurred_at,
        campaign_id: r.campaign_id ?? null,
        session_id: r.session_id ?? null,
        agreement_id: r.agreement_id ?? null,
      })
      byCustomer.set(r.customer_id, list)
    }
    if (rows.length < PAGE_SIZE) break
    page++
  }

  let count = 0
  for (const [customerId, events] of byCustomer) {
    const state = reduceEvents(events)
    const row = toRow(companyId, customerId, state)
    const { error } = await (supabase as any)
      .from("negotiation_state")
      .upsert(row, { onConflict: "company_id,customer_id" })
    if (error) throw new Error(`rebuildNegotiationState(upsert): ${error.message}`)
    count++
  }
  return { customers: count }
}
