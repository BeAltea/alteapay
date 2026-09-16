// Conciliação da jornada (F3.8): chamada ADITIVA ao final do webhook ASAAS,
// SEMPRE dentro de try/catch no chamador e atrás de CHAT_JOURNEY_ENABLED.
// Erro aqui NUNCA propaga — vira journey_events(payment.sync_error).

import { createServiceClient } from "@/lib/supabase/service"
import { recordEvent } from "./events"
import { addSuppression } from "./suppressions"
import { revokeTokens } from "./tokens"

const PAID_EVENTS = new Set(["PAYMENT_RECEIVED", "PAYMENT_CONFIRMED", "RECEIVED_IN_CASH", "DUNNING_RECEIVED"])

export interface JourneyPaymentEvent {
  eventType: string // PAYMENT_RECEIVED etc.
  paymentId: string
  agreementId: string | null
  installmentIndex?: number | null
}

export function journeyEnabled(): boolean {
  return process.env.CHAT_JOURNEY_ENABLED === "true"
}

export async function journeyOnPaymentEvent(ev: JourneyPaymentEvent): Promise<void> {
  if (!journeyEnabled()) return
  if (!ev.agreementId) return
  const supabase = createServiceClient()
  const { data: ag } = await supabase
    .from("agreements")
    .select("id, company_id, customer_id, debt_id, negotiation_session_id, agreed_amount")
    .eq("id", ev.agreementId)
    .maybeSingle()
  if (!ag || !ag.negotiation_session_id) return // acordo fora da jornada: nada a fazer

  const base = {
    companyId: ag.company_id,
    customerId: ag.customer_id,
    debtId: ag.debt_id,
    sessionId: ag.negotiation_session_id,
    agreementId: ag.id,
  }

  try {
    if (PAID_EVENTS.has(ev.eventType)) {
      await recordEvent({
        ...base, type: "payment.paid", actor: "provider",
        eventId: `journey-paid-${ev.paymentId}`,
        payload: { installment_index: ev.installmentIndex ?? null },
      })
      // primeiro pagamento fecha a negociação
      await supabase.from("negotiation_sessions")
        .update({ outcome: "agreement_paid", updated_at: new Date().toISOString() })
        .eq("id", ag.negotiation_session_id)
        .eq("outcome", "in_progress")
      await recordEvent({ ...base, type: "session.closed", actor: "system", payload: { outcome: "paid" } })
      if (ag.debt_id) {
        await addSuppression({
          companyId: ag.company_id, scope: "debt", debtId: ag.debt_id,
          customerId: ag.customer_id, channel: "all", reason: "paid", source: "webhook",
        })
      }
      await revokeTokens({ companyId: ag.company_id, customerId: ag.customer_id, reason: "paid" })
      // aviso ao credor (melhor esforço) + recibo
      try {
        const { data: cfg } = await supabase
          .from("tenant_chat_config")
          .select("creditor_notification_emails")
          .eq("company_id", ag.company_id)
          .maybeSingle()
        const emails: string[] = cfg?.creditor_notification_emails ?? []
        if (emails.length > 0) {
          const { sendEmail } = await import("@/lib/notifications/email")
          await sendEmail({
            to: emails,
            subject: "[AlteaPay] Pagamento recebido em negociação",
            html: `<p>Pagamento confirmado.</p><p>Acordo: ${ag.id}</p><p>Valor acordado: R$ ${Number(ag.agreed_amount).toFixed(2)}</p><p>Pagamento ASAAS: ${ev.paymentId}</p>`,
          })
          await recordEvent({ ...base, type: "creditor.notified", actor: "system" })
        }
      } catch (mailErr) {
        console.warn("[journey] aviso ao credor falhou:", (mailErr as Error).message)
      }
      await recordEvent({ ...base, type: "receipt.issued", actor: "system" })
      return
    }

    if (ev.eventType === "PAYMENT_OVERDUE") {
      await recordEvent({
        ...base, type: "payment.overdue", actor: "provider",
        eventId: `journey-overdue-${ev.paymentId}`,
      })
      // retry conforme matriz (não dispara nada sozinho)
      const { data: matrix } = await supabase
        .from("negotiation_condition_matrix")
        .select("retry_after_days, max_retries")
        .eq("company_id", ag.company_id)
        .eq("active", true)
        .limit(1)
      if (matrix?.[0]?.retry_after_days) {
        await recordEvent({
          ...base, type: "retry.available", actor: "system",
          payload: { after_days: matrix[0].retry_after_days, max_retries: matrix[0].max_retries },
        })
      }
      return
    }

    if (ev.eventType === "PAYMENT_DELETED" || ev.eventType === "PAYMENT_REFUNDED") {
      await recordEvent({
        ...base, type: "payment.cancelled", actor: "provider",
        eventId: `journey-cancel-${ev.paymentId}-${ev.eventType}`,
      })
      const { data: offer } = await supabase
        .from("negotiation_offers")
        .select("valid_until")
        .eq("session_id", ag.negotiation_session_id)
        .eq("status", "accepted")
        .maybeSingle()
      const stillValid = offer?.valid_until && new Date(offer.valid_until) > new Date()
      await supabase.from("negotiation_sessions")
        .update({
          outcome: stillValid ? "in_progress" : "abandoned",
          updated_at: new Date().toISOString(),
        })
        .eq("id", ag.negotiation_session_id)
      return
    }

    if (ev.eventType === "PAYMENT_CHECKOUT_VIEWED" || ev.eventType === "PAYMENT_VIEWED") {
      await recordEvent({
        ...base, type: "payment.viewed", actor: "customer",
        eventId: `journey-viewed-${ev.paymentId}`,
      })
    }
  } catch (err) {
    await recordEvent({
      ...base, type: "payment.sync_error", actor: "system",
      payload: { error: (err as Error).message.slice(0, 200), event: ev.eventType },
    }).catch(() => {})
  }
}
