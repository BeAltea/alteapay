// Provider mock: grava tudo em whatsapp_provider_events e simula o ciclo
// sent → delivered → read gravando eventos normalizados que o webhook mock
// consome. Usado no laboratório e no canário (WHATSAPP_PROVIDER=mock).

import { createHash } from "node:crypto"
import { createServiceClient } from "@/lib/supabase/service"
import type { NormalizedWhatsAppEvent, SendCampaignMessageInput, SendResult, WhatsAppProvider } from "./provider"

const eventHash = (payload: unknown) =>
  createHash("sha256").update(JSON.stringify(payload)).digest("hex")

export class MockWhatsAppProvider implements WhatsAppProvider {
  name = "mock" as const

  async sendCampaignMessage(input: SendCampaignMessageInput): Promise<SendResult> {
    const supabase = createServiceClient()
    const providerMessageId = `mock-wa-${input.messageId.slice(0, 8)}`
    const raw = {
      kind: "mock.send",
      messageId: input.messageId,
      to: `***${input.to.slice(-4)}`,
      templateKey: input.templateKey,
      variables: { ...input.variables, consult_url: "[url]" },
      at: new Date().toISOString(),
    }
    await supabase.from("whatsapp_provider_events").insert({
      provider: "mock",
      company_id: input.companyId,
      event_hash: eventHash(raw),
      raw,
      normalized: null,
      processed: true,
    })
    console.log(`[mock:whatsapp] send message=${input.messageId} template=${input.templateKey}`)
    return { accepted: true, providerMessageId, raw }
  }

  // O mock aceita o contrato normalizado direto (Apêndice A.3) — o mesmo que
  // será usado como passo intermediário no n8n enquanto a Voxuy não confirma
  // o formato real.
  async parseInboundEvent(rawBody: string): Promise<NormalizedWhatsAppEvent[]> {
    const body = JSON.parse(rawBody) as {
      event: string
      message_ref?: string
      phone?: string
      button?: "consult" | "optout" | "block"
      occurred_at?: string
      text?: string
    }
    const at = body.occurred_at ?? new Date().toISOString()
    switch (body.event) {
      case "sent":
      case "delivered":
      case "read":
      case "failed":
        return [{ type: body.event, providerMessageId: body.message_ref ?? "", at }]
      case "clicked":
        return [{ type: "clicked", providerMessageId: body.message_ref ?? "", button: body.button ?? "consult", at }]
      case "optout":
      case "block":
        return [{ type: body.event, phone: body.phone ?? "", at }]
      case "reply":
        return [{ type: "reply", phone: body.phone ?? "", text: body.text ?? "", at }]
      default:
        return []
    }
  }
}
