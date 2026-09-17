// Efeitos de um evento inbound normalizado (compartilhado pelas rotas de
// captura: a estática /voxuy da V5 e a dinâmica [provider]). Aplica status da
// mensagem (com procedência V7), cliques, supressões e jornada. A captura bruta
// e o dedupe por event_hash ficam na função captureRawInbound.

import { createHash } from "node:crypto"
import { createServiceClient } from "@/lib/supabase/service"
import { recordEvent } from "@/lib/journey/events"
import { addSuppression } from "@/lib/journey/suppressions"
import type { NormalizedWhatsAppEvent } from "./provider"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const inboundEventHash = (provider: string, rawBody: string) =>
  createHash("sha256").update(`${provider}:${rawBody}`).digest("hex")

export async function applyNormalizedEvent(
  ev: NormalizedWhatsAppEvent,
  provider: string,
): Promise<void> {
  const supabase = createServiceClient()
  if ("providerMessageId" in ev && ev.providerMessageId) {
    // provider message ids são strings do provider — só casamos por
    // whatsapp_messages.id quando de fato é UUID (senão o filtro estoura).
    const orClause = UUID_RE.test(ev.providerMessageId)
      ? `provider_message_id.eq.${ev.providerMessageId},id.eq.${ev.providerMessageId}`
      : `provider_message_id.eq.${ev.providerMessageId}`
    const { data: msg } = await supabase
      .from("whatsapp_messages")
      .select("id, company_id, campaign_id, customer_id, status, status_history, phone_e164")
      .or(orClause)
      .maybeSingle()
    if (!msg) return
    const now = ev.at
    if (ev.type === "sent" || ev.type === "delivered" || ev.type === "read" || ev.type === "failed") {
      const col = { sent: "sent_at", delivered: "delivered_at", read: "read_at", failed: null }[ev.type]
      const patch: Record<string, unknown> = {
        status: ev.type,
        status_history: [...(msg.status_history ?? []), { at: now, to: ev.type }],
      }
      if (col) patch[col] = now
      if (ev.type === "failed") patch.error = ev.error ?? "provider_failed"
      // V7: delivered/read só com FONTE real; registra procedência.
      if (ev.type === "delivered" || ev.type === "read") {
        patch.provider_status_source = provider === "voxuy" ? "voxuy_webhook" : "manual"
      }
      await supabase.from("whatsapp_messages").update(patch).eq("id", msg.id)
      await recordEvent({
        companyId: msg.company_id, campaignId: msg.campaign_id, messageId: msg.id,
        customerId: msg.customer_id,
        type: (`message.${ev.type}`) as "message.sent" | "message.delivered" | "message.read" | "message.failed",
        actor: "provider", occurredAt: now,
      })
      return
    }
    if (ev.type === "clicked") {
      if (ev.button === "consult") {
        await supabase.from("whatsapp_messages").update({ clicked_at: now }).eq("id", msg.id)
        await recordEvent({
          companyId: msg.company_id, campaignId: msg.campaign_id, messageId: msg.id,
          customerId: msg.customer_id, type: "link.clicked", actor: "customer", occurredAt: now,
          payload: { via: "provider_button" },
        })
      } else {
        const reason = ev.button === "optout" ? "optout" : "blocked"
        await addSuppression({
          companyId: msg.company_id, scope: "phone", phoneE164: msg.phone_e164,
          customerId: msg.customer_id, channel: "whatsapp", reason,
          source: provider === "voxuy" ? "voxuy" : "webhook",
        })
        await recordEvent({
          companyId: msg.company_id, campaignId: msg.campaign_id, messageId: msg.id,
          customerId: msg.customer_id,
          type: ev.button === "optout" ? "optout.received" : "block.received",
          actor: "customer", occurredAt: now,
        })
      }
      return
    }
  }
  // eventos por telefone (optout/block sem message id)
  if (ev.type === "optout" || ev.type === "block") {
    await addSuppression({
      companyId: null, scope: "phone", phoneE164: ev.phone, channel: "whatsapp",
      reason: ev.type === "optout" ? "optout" : "blocked",
      source: provider === "voxuy" ? "voxuy" : "webhook",
    })
  }
}

export interface CaptureResult {
  duplicate: boolean
  applied: number
}

/**
 * Grava TUDO em whatsapp_provider_events (dedupe por event_hash) e aplica os
 * efeitos dos eventos normalizados. Formato desconhecido fica processed=false.
 * Nunca lança por causa de um applyEvent — só loga (a rota responde 200).
 */
export async function captureRawInbound(input: {
  provider: string
  rawBody: string
  events: NormalizedWhatsAppEvent[]
  companyId?: string | null
}): Promise<CaptureResult> {
  const supabase = createServiceClient()
  const { error: insErr } = await supabase.from("whatsapp_provider_events").insert({
    provider: input.provider,
    company_id: input.companyId ?? null,
    event_hash: inboundEventHash(input.provider, input.rawBody),
    raw: (() => {
      try {
        return JSON.parse(input.rawBody)
      } catch {
        return { text: input.rawBody.slice(0, 2000) }
      }
    })(),
    normalized: input.events.length ? input.events : null,
    processed: input.events.length > 0,
    error: input.events.length === 0 ? "formato_desconhecido" : null,
  })
  if (insErr?.code === "23505") return { duplicate: true, applied: 0 }

  let applied = 0
  for (const ev of input.events) {
    try {
      await applyNormalizedEvent(ev, input.provider)
      applied++
    } catch (err) {
      console.error("[whatsapp-webhook] applyEvent:", (err as Error).message)
    }
  }
  return { duplicate: false, applied }
}
