// Tipos das tabelas do chatbot de negociação (migration 20260702).

export type FulfillmentMode = "A" | "B" | "C"
export type ChannelOrigin = "whatsapp" | "direct" | "mock" | "n8n"
export type FrontendMode = "alteapay" | "whitelabel"
export type SessionOutcome =
  | "in_progress"
  | "agreement_closed"
  | "redirected_official"
  | "handoff_human"
  | "abandoned"
  | "identity_failed"
  | "expired"
export type MessageChannel = "whatsapp" | "webchat" | "n8n"
export type MessageDirection = "inbound" | "outbound" | "system"
export type MessageSender = "debtor" | "agent" | "system" | "human_operator"

export interface NegotiationSession {
  id: string
  company_id: string
  customer_id: string | null
  debt_id: string | null
  document_hash: string
  channel_origin: ChannelOrigin
  frontend_mode: FrontendMode
  handoff_token_hash: string | null
  token_expires_at: string
  token_used_at: string | null
  identity_verified_at: string | null
  debt_acknowledged_at: string | null
  consent_lgpd_at: string | null
  consent_lgpd_version: string | null
  fulfillment_mode: FulfillmentMode | null
  outcome: SessionOutcome
  agreement_id: string | null
  thread_id: string | null
  user_agent: string | null
  ip_hash: string | null
  // T1: dono do engine desta sessão. 'platform' = assistido/determinístico (default);
  // 'n8n' = os turnos vão ao fluxo n8n (setado no reconhecimento "Sim").
  engine_owner: "platform" | "n8n" | null
  created_at: string
  updated_at: string
}

export interface ConversationMessage {
  id: string
  session_id: string
  company_id: string
  channel: MessageChannel
  direction: MessageDirection
  sender: MessageSender
  content: string
  content_redacted: string | null
  tool_calls: unknown | null
  llm_model: string | null
  prompt_version: string | null
  provider_message_id: string | null
  created_at: string
}

export interface RedirectEvent {
  id: string
  session_id: string
  company_id: string
  debt_id: string | null
  customer_id: string | null
  debt_amount_at_redirect: number
  offer_presented: unknown | null
  official_channel_url: string
  clicked_at: string
  confirmed_intent: boolean
  created_at: string
}

export interface WhatsAppInboundEvent {
  id: string
  wamid: string | null
  phone_hash: string | null
  payload: unknown
  session_id: string | null
  processed_at: string | null
  created_at: string
}

export interface TenantBranding {
  displayName?: string
  primaryColor?: string
  secondaryColor?: string
  logoUrl?: string | null
  welcomeMessage?: string
}

export interface TenantChatConfig {
  company_id: string
  fulfillment_mode: FulfillmentMode
  official_channel_url: string | null
  official_channel_label: string | null
  branding: TenantBranding
  allowed_origins: string[]
  widget_enabled: boolean
  privacy_policy_url: string | null
  dpo_contact: string | null
  // N2 (chat/n8n): origem do pagamento e envio do documento ao engine.
  payment_origin: "platform" | "n8n"
  send_document_to_engine: boolean
  debt_selection: "consolidated" | "choose"
  n8n_chat_flow_url: string | null
  auth_require_otp: boolean
  // TTL da sessão do chat (minutos). Governa o `exp` do JWT e o maxAge do cookie
  // em TODOS os caminhos de auth. Ausente → cai no default generoso (30 dias).
  session_ttl_minutes: number | null
  created_at: string
  updated_at: string
}
