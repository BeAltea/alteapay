// Webhook inbound de WhatsApp (Voxuy/mock). Autentica por segredo, deduplica
// por event_hash, normaliza via provider e aplica efeitos (status da mensagem,
// jornada, supressões). Payload desconhecido: captura bruta + 200 (nunca 500).

import { createHash } from "node:crypto"
import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getWhatsAppProvider, type NormalizedWhatsAppEvent } from "@/lib/whatsapp"
import { recordEvent } from "@/lib/journey/events"
import { addSuppression } from "@/lib/journey/suppressions"

export const dynamic = "force-dynamic"

const hash = (s: string) => createHash("sha256").update(s).digest("hex")

async function applyEvent(ev: NormalizedWhatsAppEvent, provider: string): Promise<void> {
  const supabase = createServiceClient()
  if ("providerMessageId" in ev && ev.providerMessageId) {
    const { data: msg } = await supabase
      .from("whatsapp_messages")
      .select("id, company_id, campaign_id, customer_id, status, status_history, phone_e164")
      .or(`provider_message_id.eq.${ev.providerMessageId},id.eq.${ev.providerMessageId}`)
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
      await supabase.from("whatsapp_messages").update(patch).eq("id", msg.id)
      await recordEvent({
        companyId: msg.company_id, campaignId: msg.campaign_id, messageId: msg.id,
        customerId: msg.customer_id, type: (`message.${ev.type}`) as "message.sent" | "message.delivered" | "message.read" | "message.failed", actor: "provider",
        occurredAt: now,
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
  // eventos por telefone (optout/block/reply sem message id)
  if (ev.type === "optout" || ev.type === "block") {
    await addSuppression({
      companyId: null, scope: "phone", phoneE164: ev.phone, channel: "whatsapp",
      reason: ev.type === "optout" ? "optout" : "blocked",
      source: provider === "voxuy" ? "voxuy" : "webhook",
    })
  }
}

export async function POST(req: NextRequest, ctx: { params: { provider: string } }) {
  const providerName = ctx.params.provider
  if (providerName !== "voxuy" && providerName !== "mock") {
    return NextResponse.json({ error: "unknown provider" }, { status: 404 })
  }
  // Mock só existe fora de produção ou com mocks ligados
  if (providerName === "mock" && process.env.NODE_ENV === "production" && process.env.MOCK_ALL_INTEGRATIONS !== "1") {
    return NextResponse.json({ error: "not found" }, { status: 404 })
  }
  const rawBody = await req.text()
  const supabase = createServiceClient()
  const eventHash = hash(`${providerName}:${rawBody}`)

  // autenticação delegada ao provider (voxuy exige segredo; mock não)
  const provider = getWhatsAppProvider(providerName)
  let events: NormalizedWhatsAppEvent[] = []
  try {
    events = await provider.parseInboundEvent(rawBody, req.headers)
  } catch (err) {
    const status = (err as { status?: number }).status ?? 400
    if (status === 401) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
    events = []
  }

  // captura bruta SEMPRE (dedupe por hash)
  const { error: insErr } = await supabase.from("whatsapp_provider_events").insert({
    provider: providerName,
    event_hash: eventHash,
    raw: (() => { try { return JSON.parse(rawBody) } catch { return { text: rawBody.slice(0, 2000) } } })(),
    normalized: events.length ? events : null,
    processed: events.length > 0,
    error: events.length === 0 ? "formato_desconhecido" : null,
  })
  if (insErr?.code === "23505") {
    return NextResponse.json({ ok: true, duplicate: true })
  }

  for (const ev of events) {
    try {
      await applyEvent(ev, providerName)
    } catch (err) {
      console.error("[whatsapp-webhook] applyEvent:", (err as Error).message)
    }
  }
  return NextResponse.json({ ok: true, applied: events.length })
}
