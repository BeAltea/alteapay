// Jornada: eventos append-only com correlação total (cliente/dívida/sessão/
// campanha/mensagem/acordo). Toda escrita via service role; payload nunca
// carrega CPF/telefone em claro (mascarar na entrada). Idempotência por
// event_id (default derivado de tipo+ids+segundo).

import { createHash } from "node:crypto"
import { createServiceClient } from "@/lib/supabase/service"

export type JourneyActor = "system" | "customer" | "ai" | "n8n" | "provider" | "admin"

export type JourneyEventType =
  | "campaign.created" | "campaign.started"
  | "message.queued" | "message.suppressed" | "message.sent" | "message.delivered"
  | "message.read" | "message.failed"
  | "link.clicked"
  | "auth.attempt" | "auth.failed" | "auth.locked" | "auth.success"
  | "consent.given" | "session.started"
  | "chat.turn.customer" | "chat.turn.assistant" | "chat.engine_error"
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

function defaultEventId(input: RecordEventInput, occurredAt: string): string {
  const second = occurredAt.slice(0, 19)
  const key = [
    input.type, input.companyId, input.customerId ?? "", input.debtId ?? "",
    input.sessionId ?? "", input.campaignId ?? "", input.messageId ?? "",
    input.agreementId ?? "", second,
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
  if (!error) return { ok: true, duplicate: false }
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
