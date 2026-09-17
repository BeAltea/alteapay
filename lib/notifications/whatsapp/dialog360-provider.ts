import type {
  InboundWhatsAppMessage,
  WhatsAppMessage,
  WhatsAppProvider,
  WhatsAppSendResult,
} from "./types"

/**
 * 360Dialog BSP provider — wired but inert until real credentials replace the
 * documented placeholders (WHATSAPP_BSP_API_KEY etc). The interface contract
 * guarantees that activating it requires configuration only.
 */
export class Dialog360Provider implements WhatsAppProvider {
  readonly name = "360dialog"
  private apiKey = process.env.WHATSAPP_BSP_API_KEY ?? "PLACEHOLDER_360DIALOG_KEY"
  private baseUrl = process.env.WHATSAPP_BSP_BASE_URL ?? "PLACEHOLDER"
  private phoneId = process.env.WHATSAPP_BUSINESS_PHONE_ID ?? "PLACEHOLDER"

  private assertConfigured(): void {
    if ([this.apiKey, this.baseUrl, this.phoneId].some((v) => v.startsWith("PLACEHOLDER"))) {
      throw new Error("360Dialog provider not configured — real BSP credentials required (placeholders found)")
    }
  }

  async sendMessage(msg: WhatsAppMessage): Promise<WhatsAppSendResult> {
    this.assertConfigured()
    const res = await fetch(`${this.baseUrl}/messages`, {
      method: "POST",
      headers: { "D360-API-KEY": this.apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: msg.to,
        type: "text",
        text: { body: msg.text },
      }),
    })
    if (!res.ok) throw new Error(`360dialog send failed: ${res.status}`)
    const body = (await res.json()) as { messages?: { id: string }[] }
    return { id: body.messages?.[0]?.id ?? "unknown", provider: this.name, accepted: true, raw: body }
  }

  parseInboundWebhook(payload: unknown): InboundWhatsAppMessage[] {
    const body = payload as {
      entry?: { changes?: { value?: { messages?: { from: string; text?: { body: string }; id: string; timestamp: string }[] } }[] }[]
    }
    const messages = body?.entry?.flatMap((e) => e.changes ?? []).flatMap((c) => c.value?.messages ?? []) ?? []
    return messages.map((m) => ({
      from: m.from,
      text: m.text?.body ?? "",
      messageId: m.id,
      timestamp: m.timestamp,
    }))
  }

  verifyWebhookToken(token: string): boolean {
    return token === (process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN ?? "PLACEHOLDER")
  }
}
