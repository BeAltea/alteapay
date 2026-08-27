import type {
  InboundWhatsAppMessage,
  WhatsAppMessage,
  WhatsAppProvider,
  WhatsAppSendResult,
} from "./types"

/**
 * Meta WhatsApp Cloud API (Graph API) — DORMANTE: placeholders por padrão;
 * assertConfigured() falha explicitamente sem credenciais reais. Nunca é
 * selecionado enquanto WHATSAPP_CHANNEL_ENABLED != "1" (ver factory).
 */
export class MetaCloudProvider implements WhatsAppProvider {
  readonly name = "meta_cloud"

  private accessToken = process.env.WHATSAPP_ACCESS_TOKEN ?? "PLACEHOLDER"
  private phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID ?? "PLACEHOLDER"
  private apiVersion = process.env.WHATSAPP_GRAPH_API_VERSION ?? "v21.0"

  private assertConfigured(): void {
    if (this.accessToken.startsWith("PLACEHOLDER") || this.phoneNumberId.startsWith("PLACEHOLDER")) {
      throw new Error(
        "MetaCloudProvider sem credenciais reais (WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID). " +
          "Canal WhatsApp é dormante nesta fase — use WHATSAPP_BSP_PROVIDER=mock.",
      )
    }
  }

  async sendMessage(msg: WhatsAppMessage): Promise<WhatsAppSendResult> {
    this.assertConfigured()
    const url = `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`
    const body = msg.templateName
      ? {
          messaging_product: "whatsapp",
          to: msg.to,
          type: "template",
          template: {
            name: msg.templateName,
            language: { code: "pt_BR" },
            components: msg.templateParams
              ? [
                  {
                    type: "body",
                    parameters: Object.values(msg.templateParams).map((text) => ({ type: "text", text })),
                  },
                ]
              : [],
          },
        }
      : { messaging_product: "whatsapp", to: msg.to, type: "text", text: { body: msg.text } }

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
    const raw = await resp.json().catch(() => null)
    if (!resp.ok) {
      return { id: "", provider: this.name, accepted: false, raw }
    }
    const id = (raw as { messages?: Array<{ id: string }> })?.messages?.[0]?.id ?? ""
    return { id, provider: this.name, accepted: true, raw }
  }

  parseInboundWebhook(payload: unknown): InboundWhatsAppMessage[] {
    // Envelope Cloud API: entry[].changes[].value.messages[]
    const body = payload as {
      entry?: Array<{
        changes?: Array<{
          value?: {
            messages?: Array<{ from: string; id: string; timestamp: string; text?: { body: string } }>
          }
        }>
      }>
    }
    const out: InboundWhatsAppMessage[] = []
    for (const entry of body?.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const m of change.value?.messages ?? []) {
          out.push({ from: m.from, text: m.text?.body ?? "", messageId: m.id, timestamp: m.timestamp })
        }
      }
    }
    return out
  }

  verifyWebhookToken(token: string): boolean {
    return token === (process.env.WHATSAPP_VERIFY_TOKEN || process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || "")
  }
}
