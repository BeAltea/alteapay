// Contrato do provider de WhatsApp (D12): a plataforma fala com o provider
// (Voxuy ou mock) atrás desta interface; o n8n NÃO participa do disparo.

export type NormalizedWhatsAppEvent =
  | { type: "sent" | "delivered" | "read" | "failed"; providerMessageId: string; at: string; error?: string }
  | { type: "clicked"; providerMessageId: string; button: "consult" | "optout" | "block"; at: string }
  | { type: "optout" | "block"; phone: string; at: string }
  | { type: "reply"; phone: string; text: string; at: string }

export interface SendCampaignMessageInput {
  companyId: string
  messageId: string // whatsapp_messages.id — vira o "id" externo no provider
  to: string // E.164
  customerName: string
  document: string
  templateKey: string
  variables: {
    consult_url: string
    brand_name: string
    sender_label: string
  }
}

export interface SendResult {
  accepted: boolean
  providerMessageId?: string
  raw?: unknown
  error?: string
}

export interface WhatsAppProvider {
  name: "voxuy" | "mock"
  sendCampaignMessage(input: SendCampaignMessageInput): Promise<SendResult>
  /** Valida autenticação e normaliza o corpo bruto do webhook inbound. */
  parseInboundEvent(rawBody: string, headers: Headers): Promise<NormalizedWhatsAppEvent[]>
  syncSuppression?(input: { phone: string; reason: "optout" | "blocked" }): Promise<void>
}
