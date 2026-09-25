// Jornada: eventos append-only com correlação total (cliente/dívida/sessão/
// campanha/mensagem/acordo). Toda escrita via service role; payload nunca
// carrega CPF/telefone em claro (mascarar na entrada). Idempotência por
// event_id (default derivado de tipo+ids+segundo).

import { createHash } from "node:crypto"
import { createServiceClient } from "@/lib/supabase/service"
import { applyJourneyEventToState } from "./negotiation-state"

export type JourneyActor = "system" | "customer" | "ai" | "n8n" | "provider" | "admin"

export type JourneyEventType =
  | "campaign.created" | "campaign.started"
  | "message.queued" | "message.suppressed" | "message.sent" | "message.delivered"
  | "message.read" | "message.failed"
  | "link.clicked"
  | "auth.attempt" | "auth.failed" | "auth.locked" | "auth.success"
  | "consent.given" | "session.started"
  | "chat.turn.customer" | "chat.turn.assistant" | "chat.engine_error" | "chat.engine_invalid_action"
  | "debt.viewed"
  | "debt.acknowledged" | "debt.not_recognized"
  | "offer.presented" | "offer.invalid" | "offer.accepted" | "offer.rejected" | "offer.expired"
  | "agreement.created"
  | "payment.generated" | "payment.viewed" | "payment.paid" | "payment.overdue" | "payment.cancelled"
  | "receipt.issued" | "creditor.notified" | "payment.sync_error"
  | "dispute.registered" | "payment_claim.registered" | "human.transfer"
  | "optout.received" | "block.received"
  | "contact.stopped" | "contact.stop_failed"
  | "message.accepted"
  | "session.closed" | "retry.available"
  // Onda "3 opções" — trilha PAGAR AGORA (§6.4/M17). Telemetria da cobrança à
  // vista iniciada pelo botão PAGAR do chat. Sem PII no payload (só ids/estado).
  //   pay.requested   — clique PAGAR chegou ao payService (gerando_cobranca).
  //   pay.link_ready  — link ASAAS entregue (created OU already_charged).
  //   pay.processing  — cobrança aceita mas o link ainda não voltou (worker off).
  //   pay.failed      — erro ASAAS/guard: rótulo curto, NUNCA mensagem crua.
  | "pay.requested" | "pay.link_ready" | "pay.processing" | "pay.failed"
  // Auditoria de privacidade: super_admin revelou o documento em claro de uma
  // linha (listas super-admin). Aditivo — o payload NUNCA carrega o doc em claro
  // (maskPayload já mascara; registramos ator/motivo/doc mascarado/ids).
  | "document.revealed"

export interface RecordEventInput {
  companyId: string
  customerId?: string | null
  debtId?: string | null
  sessionId?: string | null
  campaignId?: string | null
  messageId?: string | null
  agreementId?: string | null
  type: JourneyEventType
  actor: JourneyActor
  payload?: Record<string, unknown>
  eventId?: string
  occurredAt?: string
}

/** Chaves do payload que DISCRIMINAM eventos legitimamente repetidos no mesmo
 *  segundo (A2 / N-D2-8): 3 `offer.presented` (uma por oferta), 2 `prompt.ask`
 *  etc. Sem isto, o event_id derivado por (tipo, ids, segundo) colapsava as
 *  ofertas 2x/3x em 1 só linha de auditoria. Só valores escalares entram. */
const PAYLOAD_DISCRIMINATORS = ["offer_id", "prompt_id", "button_id", "agreement_id", "message_id"] as const

function payloadDiscriminator(payload: Record<string, unknown> | undefined): string {
  if (!payload) return ""
  return PAYLOAD_DISCRIMINATORS.map((k) => {
    const v = payload[k]
    return typeof v === "string" || typeof v === "number" ? `${k}=${v}` : ""
  }).filter(Boolean).join(",")
}

function defaultEventId(input: RecordEventInput, occurredAt: string): string {
  const second = occurredAt.slice(0, 19)
  const key = [
    input.type, input.companyId, input.customerId ?? "", input.debtId ?? "",
    input.sessionId ?? "", input.campaignId ?? "", input.messageId ?? "",
    input.agreementId ?? "", second, payloadDiscriminator(input.payload),
  ].join("|")
  return createHash("sha256").update(key).digest("hex")
}

/** Mascara valores obviamente sensíveis dentro do payload (defensivo). */
export function maskPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const masked: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(payload)) {
    if (typeof v === "string") {
      masked[k] = v
        .replace(/\b\d{11}(\d{3})?\b/g, (m) => `***${m.slice(-2)}`)
        .replace(/([\w.+-]{2})[\w.+-]*@([\w-]+)/g, "$1***@$2")
    } else {
      masked[k] = v
    }
  }
  return masked
}

/**
 * Grava um evento de jornada. Retorna { ok, duplicate }.
 * Nunca lança: falha vira { ok:false } para o chamador decidir (os caminhos
 * críticos de pagamento embrulham isto em try/catch por regra D14).
 */
export async function recordEvent(input: RecordEventInput): Promise<{ ok: boolean; duplicate: boolean }> {
  const supabase = createServiceClient()
  const occurredAt = input.occurredAt ?? new Date().toISOString()
  const eventId = input.eventId ?? defaultEventId(input, occurredAt)
  const { error } = await supabase.from("journey_events").insert({
    company_id: input.companyId,
    customer_id: input.customerId ?? null,
    debt_id: input.debtId ?? null,
    session_id: input.sessionId ?? null,
    campaign_id: input.campaignId ?? null,
    message_id: input.messageId ?? null,
    agreement_id: input.agreementId ?? null,
    event_type: input.type,
    event_id: eventId,
    actor: input.actor,
    payload: maskPayload(input.payload ?? {}),
    occurred_at: occurredAt,
  })
  if (!error) {
    // GANCHO GLOBAL da projeção negotiation_state: todo evento NOVO (não-duplicata)
    // com devedor identificado atualiza o estágio AO VIVO (auth/chat/reconhecimento/
    // pagamento — não só envio). BEST-EFFORT e NÃO-FATAL: a projeção é idempotente
    // e nunca pode derrubar o recordEvent (regra D14). A projeção NÃO chama
    // recordEvent → sem loop.
    if (input.companyId && input.customerId) {
      try {
        await applyJourneyEventToState({
          companyId: input.companyId,
          customerId: input.customerId,
          event_type: input.type,
          occurred_at: occurredAt,
          payload: input.payload ?? null,
          campaign_id: input.campaignId ?? null,
          session_id: input.sessionId ?? null,
          agreement_id: input.agreementId ?? null,
          channel: typeof input.payload?.channel === "string" ? input.payload.channel : null,
        })
      } catch (err) {
        console.error("[journey] projeção (não-fatal):", (err as Error).message)
      }
    }
    return { ok: true, duplicate: false }
  }
  if (error.code === "23505") return { ok: true, duplicate: true } // event_id UNIQUE
  console.error("[journey] recordEvent falhou:", error.code, error.message)
  return { ok: false, duplicate: false }
}

export interface TimelineQuery {
  companyId: string
  customerId?: string
  sessionId?: string
  debtId?: string
  limit?: number
}

export async function getTimeline(q: TimelineQuery) {
  const supabase = createServiceClient()
  let query = supabase
    .from("journey_timeline")
    .select("*")
    .eq("company_id", q.companyId)
    .order("occurred_at", { ascending: true })
    .limit(q.limit ?? 200)
  if (q.customerId) query = query.eq("customer_id", q.customerId)
  if (q.sessionId) query = query.eq("session_id", q.sessionId)
  if (q.debtId) query = query.eq("debt_id", q.debtId)
  const { data, error } = await query
  if (error) throw new Error(`journey_timeline: ${error.message}`)
  return data ?? []
}
