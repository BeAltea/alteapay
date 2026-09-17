import type {
  InboundWhatsAppMessage,
  WhatsAppMessage,
  WhatsAppProvider,
  WhatsAppSendResult,
} from "./types"

/**
 * Mock provider — used until real BSP credentials exist. Messages are logged
 * and kept in an in-memory outbox so tests and the negotiation simulator can
 * assert on them.
 */
export class MockWhatsAppProvider implements WhatsAppProvider {
  readonly name = "mock"
  readonly outbox: WhatsAppSendResult[] = []
  private seq = 0

  async sendMessage(msg: WhatsAppMessage): Promise<WhatsAppSendResult> {
    const result: WhatsAppSendResult = {
      id: `mock-wa-${++this.seq}`,
      provider: this.name,
      accepted: true,
      raw: { to: msg.to, text: msg.text },
    }
    this.outbox.push(result)
    console.log(`[whatsapp:mock] → ${msg.to}: ${msg.text.slice(0, 120)}`)
    return result
  }

  parseInboundWebhook(payload: unknown): InboundWhatsAppMessage[] {
    const body = payload as { messages?: { from: string; text?: { body: string }; id: string; timestamp: string }[] }
    return (body?.messages ?? []).map((m) => ({
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
