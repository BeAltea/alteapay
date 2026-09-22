// Domínio das sessões de negociação: criação (handoff), resolução de token,
// sessão via cookie, auditoria de mensagens e outcome. Todas as escritas com
// service role; company_id sempre derivado server-side (sessão/token), nunca
// confiado do client.

import { createServiceClient } from "@/lib/supabase/service"
import { appUrl, agingDays, HANDOFF_TOKEN_TTL_HOURS } from "./config"
import { generateHandoffToken, sha256Hex, verifyChatJwt, CHAT_COOKIE_NAME } from "./crypto"
import { onlyDigits, redactPii } from "./pii"
import type {
  ChannelOrigin,
  ConversationMessage,
  FrontendMode,
  MessageChannel,
  MessageDirection,
  MessageSender,
  NegotiationSession,
  SessionOutcome,
  TenantChatConfig,
} from "./types"

export interface CreateHandoffInput {
  company_id: string
  customer_id?: string | null
  debt_id?: string | null
  document: string // CPF/CNPJ em claro — só o hash persiste
  channel_origin: ChannelOrigin
  frontend_mode?: FrontendMode
  identity_verified?: boolean // true SOMENTE quando o gate já passou (WhatsApp)
  debt_acknowledged?: boolean
  thread_id?: string
}

export interface CreateHandoffResult {
  session: NegotiationSession
  token: string // em claro, retornado UMA única vez
  deep_link: string
}

export async function loadTenantConfig(companyId: string): Promise<TenantChatConfig | null> {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from("tenant_chat_config")
    .select("*")
    .eq("company_id", companyId)
    .maybeSingle()
  return (data as TenantChatConfig) ?? null
}

export async function createHandoffSession(input: CreateHandoffInput): Promise<CreateHandoffResult> {
  const supabase = createServiceClient()
  const digits = onlyDigits(input.document)
  if (!digits) throw new Error("documento sem dígitos")

  const tenant = await loadTenantConfig(input.company_id)
  const fulfillmentMode = tenant?.fulfillment_mode ?? "A"
  const frontendMode: FrontendMode =
    input.frontend_mode ?? (tenant?.widget_enabled ? "whitelabel" : "alteapay")

  const { token, tokenHash } = generateHandoffToken()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + HANDOFF_TOKEN_TTL_HOURS * 3_600_000)

  const insert = {
    company_id: input.company_id,
    customer_id: input.customer_id ?? null,
    debt_id: input.debt_id ?? null,
    document_hash: sha256Hex(digits),
    channel_origin: input.channel_origin,
    frontend_mode: frontendMode,
    handoff_token_hash: tokenHash,
    token_expires_at: expiresAt.toISOString(),
    identity_verified_at: input.identity_verified ? now.toISOString() : null,
    debt_acknowledged_at: input.debt_acknowledged ? now.toISOString() : null,
    fulfillment_mode: fulfillmentMode,
    thread_id: input.thread_id ?? null,
  }

  const { data, error } = await supabase
    .from("negotiation_sessions")
    .insert(insert)
    .select()
    .single()
  if (error || !data) throw new Error(`falha ao criar negotiation_session: ${error?.message}`)

  const session = data as NegotiationSession
  // thread_id determinístico por sessão quando não informado
  if (!session.thread_id) {
    const threadId = `web_${session.id}`
    const { data: updated, error: updErr } = await supabase
      .from("negotiation_sessions")
      .update({ thread_id: threadId })
      .eq("id", session.id)
      .select()
      .single()
    if (updErr || !updated) throw new Error(`falha ao gravar thread_id: ${updErr?.message}`)
    session.thread_id = (updated as NegotiationSession).thread_id
  }

  const deepLink = `${appUrl()}/negociar/${token}`
  return { session, token, deep_link: deepLink }
}

// ===========================================================================
// Reuso de sessão (A1.1): em vez de criar uma sessão nova a cada autenticação
// do mesmo devedor, reaproveita a sessão 'open' mais recente que ainda esteja
// dentro do TTL. Evita a proliferação de registros (ex.: 6 sessões do mesmo CPF
// em 40 min). Espelha o reaproveitamento que o link /c/{token} já fazia.
// ===========================================================================

export interface ReusableSessionRow {
  id: string
  status: string | null
  last_activity_at: string | null
  reopen_count: number | null
}

/**
 * Busca a sessão 'open' mais recente de (company_id, customer_id) cuja
 * last_activity_at ainda esteja dentro de `ttlMinutes`. Devolve null quando não
 * há candidata (sem sessão aberta OU a mais recente já expirou o TTL).
 *
 * A busca é servida pelo índice (company_id, customer_id, status, last_activity_at desc).
 * Sem PII: só ids e timestamps.
 */
export async function findReusableOpenSession(input: {
  companyId: string
  customerId: string
  ttlMinutes: number
}): Promise<ReusableSessionRow | null> {
  const supabase = createServiceClient()
  const cutoff = new Date(Date.now() - input.ttlMinutes * 60_000).toISOString()
  const { data } = await supabase
    .from("negotiation_sessions")
    .select("id, status, last_activity_at, reopen_count")
    .eq("company_id", input.companyId)
    .eq("customer_id", input.customerId)
    .eq("status", "open")
    .gte("last_activity_at", cutoff)
    .order("last_activity_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data as ReusableSessionRow) ?? null
}

/**
 * REABRE uma sessão existente: bump de last_activity_at=now(), reopen_count+1 e
 * consentimento/atividade renovados. NÃO recria a 1ª mensagem — o bootstrap de
 * reconhecimento/quitação já é idempotente (não duplica). Devolve o mesmo id.
 *
 * `currentReopenCount` vem da candidata lida em findReusableOpenSession (mesma
 * request), então o +1 não precisa de RPC — o reuso é 1 request por visita e a
 * janela de corrida é desprezível.
 */
export async function reopenSession(input: {
  sessionId: string
  channel: string
  userAgent: string | null
  ipHash: string | null
  currentReopenCount: number
}): Promise<void> {
  const supabase = createServiceClient()
  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from("negotiation_sessions")
    .update({
      last_activity_at: now,
      updated_at: now,
      consent_at: now,
      consent_lgpd_at: now,
      reopen_count: input.currentReopenCount + 1,
      channel: input.channel,
      user_agent: input.userAgent,
      ip_hash: input.ipHash,
    })
    .eq("id", input.sessionId)
    .select("id")
  if (error || !data?.length) {
    throw new Error(`falha ao reabrir negotiation_session ${input.sessionId}: ${error?.message ?? "0 linhas"}`)
  }
}

export type ResolveTokenResult =
  | { ok: true; session: NegotiationSession; firstUse: boolean }
  | { ok: false; reason: "not_found" | "expired" | "already_used" }

/**
 * Valida token opaco: hash + TTL + single-use. Reuso do link só é aceito pela
 * MESMA sessão de browser (cookie válido apontando para a mesma sessão).
 */
export async function resolveHandoffToken(
  token: string,
  cookieValue: string | null,
): Promise<ResolveTokenResult> {
  const supabase = createServiceClient()
  const tokenHash = sha256Hex(token)
  const { data } = await supabase
    .from("negotiation_sessions")
    .select("*")
    .eq("handoff_token_hash", tokenHash)
    .maybeSingle()
  if (!data) return { ok: false, reason: "not_found" }
  const session = data as NegotiationSession

  if (new Date(session.token_expires_at).getTime() < Date.now()) {
    if (session.outcome === "in_progress") {
      await supabase
        .from("negotiation_sessions")
        .update({ outcome: "expired" satisfies SessionOutcome })
        .eq("id", session.id)
        .select("id")
    }
    return { ok: false, reason: "expired" }
  }

  if (session.token_used_at) {
    const claims = cookieValue ? verifyChatJwt(cookieValue) : null
    if (claims?.sid === session.id) return { ok: true, session, firstUse: false }
    return { ok: false, reason: "already_used" }
  }

  const { data: updated, error } = await supabase
    .from("negotiation_sessions")
    .update({ token_used_at: new Date().toISOString() })
    .eq("id", session.id)
    .is("token_used_at", null) // corrida: só o primeiro clique vence
    .select()
    .single()
  if (error || !updated) return { ok: false, reason: "already_used" }
  return { ok: true, session: updated as NegotiationSession, firstUse: true }
}

/** Sessão autenticada pelo cookie httpOnly do chat. */
export async function getSessionFromCookie(cookieValue: string | null | undefined): Promise<NegotiationSession | null> {
  if (!cookieValue) return null
  const claims = verifyChatJwt(cookieValue)
  if (!claims) return null
  const supabase = createServiceClient()
  const { data } = await supabase
    .from("negotiation_sessions")
    .select("*")
    .eq("id", claims.sid)
    .eq("company_id", claims.cid)
    .maybeSingle()
  return (data as NegotiationSession) ?? null
}

export { CHAT_COOKIE_NAME }

export interface RecordMessageInput {
  session: Pick<NegotiationSession, "id" | "company_id">
  channel: MessageChannel
  direction: MessageDirection
  sender: MessageSender
  content: string
  tool_calls?: unknown
  llm_model?: string | null
  prompt_version?: string | null
  provider_message_id?: string | null
}

export async function recordMessage(input: RecordMessageInput): Promise<ConversationMessage> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from("conversation_messages")
    .insert({
      session_id: input.session.id,
      company_id: input.session.company_id,
      channel: input.channel,
      direction: input.direction,
      sender: input.sender,
      content: input.content,
      content_redacted: redactPii(input.content),
      tool_calls: input.tool_calls ?? null,
      llm_model: input.llm_model ?? null,
      prompt_version: input.prompt_version ?? null,
      provider_message_id: input.provider_message_id ?? null,
    })
    .select()
    .single()
  if (error || !data) throw new Error(`falha ao gravar conversation_message: ${error?.message}`)
  return data as ConversationMessage
}

export async function updateSession(
  sessionId: string,
  patch: Partial<
    Pick<
      NegotiationSession,
      "outcome" | "agreement_id" | "identity_verified_at" | "consent_lgpd_at" | "consent_lgpd_version" | "user_agent" | "ip_hash"
    >
  >,
): Promise<void> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from("negotiation_sessions")
    .update(patch)
    .eq("id", sessionId)
    .select("id")
  if (error || !data?.length) {
    throw new Error(`falha ao atualizar negotiation_session ${sessionId}: ${error?.message ?? "0 linhas"}`)
  }
}

/**
 * Efeitos de um turno do agente sobre o funil da sessão (identidade
 * verificada, acordo fechado, handoff). Compartilhado entre o BFF web
 * (/api/negotiation/message) e o canal n8n (rota sync + worker async).
 */
export async function applyTurnEffects(
  session: NegotiationSession,
  response: { events: string[]; action: string | null; agreement_id: string | null },
): Promise<void> {
  const patch: Parameters<typeof updateSession>[1] = {}
  if (response.events.includes("identity_verified") && !session.identity_verified_at) {
    patch.identity_verified_at = new Date().toISOString()
  }
  if (response.action === "agreement_closed") {
    patch.outcome = "agreement_closed"
    if (response.agreement_id) patch.agreement_id = response.agreement_id
  } else if (response.action === "handoff") {
    patch.outcome = "handoff_human"
  }
  if (Object.keys(patch).length > 0) await updateSession(session.id, patch)
}

export interface SessionDebtContext {
  customer_name: string
  document: string
  debt_id: string
  amount: number
  due_date: string
  description: string | null
  aging_days: number
}

/** Carrega cliente + dívida da sessão (dados reais do tenant, server-side). */
export async function loadSessionDebtContext(session: NegotiationSession): Promise<SessionDebtContext | null> {
  if (!session.debt_id || !session.customer_id) return null
  const supabase = createServiceClient()
  const [{ data: debt }, { data: customer }] = await Promise.all([
    supabase
      .from("debts")
      .select("id, amount, due_date, description, status, company_id")
      .eq("id", session.debt_id)
      .eq("company_id", session.company_id)
      .maybeSingle(),
    supabase
      .from("customers")
      .select("id, name, document")
      .eq("id", session.customer_id)
      .eq("company_id", session.company_id)
      .maybeSingle(),
  ])
  if (!debt || !customer) return null
  return {
    customer_name: customer.name,
    document: onlyDigits(customer.document),
    debt_id: debt.id,
    amount: Number(debt.amount),
    due_date: debt.due_date,
    description: debt.description,
    aging_days: agingDays(debt.due_date),
  }
}
