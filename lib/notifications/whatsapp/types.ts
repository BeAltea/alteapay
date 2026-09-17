/**
 * WhatsApp BSP provider abstraction.
 * Switching providers (mock → 360dialog) is configuration only:
 * set WHATSAPP_BSP_PROVIDER — zero code changes anywhere else.
 */
export interface WhatsAppMessage {
  to: string // E.164 phone
  text: string
  templateName?: string
  templateParams?: Record<string, string>
}

export interface WhatsAppSendResult {
  id: string
  provider: string
  accepted: boolean
  raw?: unknown
}

export interface InboundWhatsAppMessage {
  from: string
  text: string
  messageId: string
  timestamp: string
}

export interface WhatsAppProvider {
  readonly name: string
  sendMessage(msg: WhatsAppMessage): Promise<WhatsAppSendResult>
  parseInboundWebhook(payload: unknown): InboundWhatsAppMessage[]
  verifyWebhookToken(token: string): boolean
}
