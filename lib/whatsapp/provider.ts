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
  /**
   * Documento do cliente (CPF/CNPJ) SÓ para uso interno da plataforma.
   * O adapter Voxuy JAMAIS o envia (V6/minimização): clientDocument fica null.
   */
  document: string
  templateKey: string
  variables: {
    consult_url: string
    brand_name: string
    sender_label: string
    // Campos aditivos da onda Voxuy (Apêndice B.2). Opcionais para não quebrar
    // o mock/campaign-send legado; o adapter Voxuy exige consult_url + brand.
    optout_url?: string
    block_url?: string
    creditor_name?: string
    first_name?: string
  }
  /**
   * Por-tenant (tenant_chat_config). Necessários pelo adapter Voxuy; o mock
   * ignora. `voxuyEvent` é o `customEvent` (inteiro) da finalidade "abordagem".
   */
  voxuyPlanId?: string | null
  voxuyEvent?: number | null
}

export interface SendResult {
  accepted: boolean
  providerMessageId?: string
  raw?: unknown
  error?: string
  /** classe do erro (V1.5): retryável (429/5xx/timeout) vs de config (401/403). */
  errorClass?: "config" | "retryable" | "validation" | "unexpected"
  /** traceId da Voxuy (400) — guardado em whatsapp_messages.provider_trace_id. */
  traceId?: string
  /** nomes dos campos com erro (400) — nunca valores. */
  errorFields?: string[]
}

export interface SendStopSignalInput {
  companyId: string
  phone: string // E.164
  customerId: string
  /** evento `stop` (customEvent) da conta Voxuy; do tenant_chat_config. */
  voxuyEvent?: number | null
  voxuyPlanId?: string | null
  brandName?: string
  creditorName?: string
}

export interface WhatsAppProvider {
  name: "voxuy" | "mock"
  sendCampaignMessage(input: SendCampaignMessageInput): Promise<SendResult>
  /** Valida autenticação e normaliza o corpo bruto do webhook inbound. */
  parseInboundEvent(rawBody: string, headers: Headers): Promise<NormalizedWhatsAppEvent[]>
  /**
   * Dispara uma transação para o evento `stop` (funil vazio/confirmação). É o
   * mecanismo de "parar de contatar" (V3): a Voxuy cancela o funil anterior do
   * mesmo número ao receber uma nova transação. A Voxuy NÃO tem blacklist (L2),
   * então a supressão autoritativa é sempre a nossa.
   */
  sendStopSignal?(input: SendStopSignalInput): Promise<SendResult>
  /**
   * Compat da onda anterior: implementado COMO sendStopSignal (V2.5). A Voxuy
   * não tem descadastro próprio; isto só reforça o cancelamento do funil.
   */
  syncSuppression?(input: { phone: string; reason: "optout" | "blocked"; companyId?: string; customerId?: string }): Promise<void>
}
