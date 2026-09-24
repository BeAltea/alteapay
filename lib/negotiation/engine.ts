// Engine de conversa do chatbot.
//
// A partir de 2026-09 o cérebro padrão são FLUXOS DO N8N
// (NEGOTIATION_ENGINE=n8n): cada turno é POSTado, assinado com o mesmo esquema
// HMAC do webhook inbound, ao fluxo N8N_CHAT_FLOW_URL (Webhook trigger +
// Respond to Webhook), que devolve o contrato EngineTurnResult. O contexto
// completo da sessão/dívida viaja em TODO turno — fluxos n8n são stateless;
// para memória de conversa, o fluxo usa thread_id como chave (ex.: Memory do
// AI Agent node).
//
// O agente LangGraph interno permanece disponível como implementação legada
// (NEGOTIATION_ENGINE=agent) para o rig de treino local — não é usado em
// produção.
//
// Invariante de segurança preservada nos dois engines: fechar acordo e obter
// URL de canal oficial são operações do SERVIDOR (close-agreement/charge-rules
// e tenant_chat_config) — o fluxo/LLM apenas sinaliza a intenção.

import { createHash } from "node:crypto"

import { z } from "zod"

import type { Button } from "@/lib/journey/buttons"
import { maskDocument } from "@/lib/journey/document"
import { agentChat, agentHealth, agentSessionInit, type AgentSessionInit } from "./agent-client"
import { closeAgreement } from "./close-agreement"
import { buildN8nOutboundHeaders, newEventId, n8nWebhookSecret } from "./n8n"
import type { CanonicalEnvelope } from "./payload"
import type { SessionDebtContext } from "./sessions"
import type { NegotiationSession, TenantChatConfig } from "./types"

export type EngineName = "n8n" | "agent" | "stub" | "disabled"

const IS_PROD = () => process.env.NODE_ENV === "production" && process.env.MOCK_ALL_INTEGRATIONS !== "1"
const IS_LAB = () => process.env.MOCK_ALL_INTEGRATIONS === "1"

/**
 * D14: default em produção é DISABLED (chat assistido determinístico).
 * "n8n" sem N8N_CHAT_FLOW_URL e "agent" sem AGENT_URL degradam para
 * disabled (nunca expõem erro ao cliente; o turno loga chat.engine_error) —
 * EXCETO no laboratório (MOCK_ALL_INTEGRATIONS=1), onde "n8n" sem URL cai para
 * o "stub" para permitir o E2E sem servidor n8n.
 * "stub" (N3) explícito é o roteiro determinístico de laboratório: fora de
 * produção vale "stub"; em produção degrada para disabled.
 */
export function engineName(): EngineName {
  const raw = process.env.NEGOTIATION_ENGINE
  if (raw === "agent") {
    return process.env.AGENT_URL && process.env.AGENT_APP_TOKEN ? "agent" : "disabled"
  }
  if (raw === "n8n") {
    if (process.env.N8N_CHAT_FLOW_URL) return "n8n"
    return IS_LAB() ? "stub" : "disabled"
  }
  if (raw === "stub") {
    return IS_PROD() ? "disabled" : "stub"
  }
  return "disabled"
}

/**
 * H7/H8: seleção do engine POR SESSÃO. Quando `session.engine_owner='n8n'`
 * (setado no reconhecimento "Sim"), os turnos VÃO ao fluxo n8n — desde que o
 * n8n esteja de fato configurado. Se o n8n não estiver disponível
 * (N8N_CHAT_FLOW_URL ausente) ou o engine global degradar para disabled, o
 * turno cai para o ASSISTIDO (fallback resiliente H8) e o cliente NUNCA vê erro.
 *
 * Quando `engine_owner` é 'platform'/null (default), respeita o
 * NEGOTIATION_ENGINE global (assistido/determinístico por padrão).
 *
 * Nunca sobrescreve o global "agent"/"stub" de laboratório: essas são escolhas
 * explícitas de ambiente e continuam valendo como fallback.
 */
export function resolveEngineForSession(
  owner: "platform" | "n8n" | null | undefined,
  opts?: {
    /** §5: override persistido na sessão (negotiation_sessions.engine). Quando
     * o fluxo n8n já falhou e o fallback degradou a sessão, este valor força o
     * assistido (disabled) a partir do próximo turno — vence o dono n8n. */
    sessionEngine?: string | null
    /** §6: URL por tenant (tenant_chat_config.n8n_chat_flow_url). Quando o dono
     * é n8n, uma URL de tenant OU a env já resolvem o fluxo. */
    tenantFlowUrl?: string | null
  },
): EngineName {
  const global = engineName()
  // §5: sessão degradada por fallback técnico → assistido, sem exceção.
  if (opts?.sessionEngine === "disabled") return "disabled"
  if (owner === "n8n") {
    // dono é n8n: se o n8n resolve (URL de tenant OU env presente, ou lab),
    // roteia ao fluxo; senão, fallback assistido (disabled) — sem erro (H8).
    const hasTenantUrl = typeof opts?.tenantFlowUrl === "string" && opts.tenantFlowUrl.trim() !== ""
    if (hasTenantUrl || process.env.N8N_CHAT_FLOW_URL) return "n8n"
    if (IS_LAB()) return "stub"
    return "disabled"
  }
  // dono é a plataforma (default): o global manda (assistido por padrão).
  return global
}

function chatFlowUrl(): string {
  return process.env.N8N_CHAT_FLOW_URL || ""
}

/**
 * §6: resolução da URL do fluxo de chat POR TENANT → env → vazio (disabled).
 * Ordem: tenant_chat_config.n8n_chat_flow_url (por company) → N8N_CHAT_FLOW_URL
 * → "" (o chamador degrada para o assistido, sem erro ao cliente).
 * A URL resolvida é um segredo operacional — nunca logar.
 */
function resolveChatFlowUrl(tenant: TenantChatConfig | null): string {
  const perTenant = tenant?.n8n_chat_flow_url
  if (typeof perTenant === "string" && perTenant.trim()) return perTenant.trim()
  return chatFlowUrl()
}

function sessionFlowUrl(): string {
  return process.env.N8N_SESSION_FLOW_URL || ""
}

function flowTimeoutMs(): number {
  return Number(process.env.N8N_FLOW_TIMEOUT_MS || "60000")
}

/**
 * §2: timeout do turno papel A (chat.turn). Prioriza N8N_TIMEOUT_MS (default
 * 20000ms); se ausente, cai em N8N_FLOW_TIMEOUT_MS (compat com o event flow).
 * UMA tentativa por turno (sem retry) — o estouro vira modo assíncrono/fallback.
 */
function chatTimeoutMs(): number {
  const raw = process.env.N8N_TIMEOUT_MS ?? process.env.N8N_FLOW_TIMEOUT_MS
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : 20000
}

/**
 * §4: janela de espera do modo assíncrono (documentado). Quando o fluxo aceita
 * o turno com HTTP 202, a resposta real chega depois via chat.send (papel B),
 * que o cliente busca por polling em GET /api/chat/messages?since=. Este valor
 * orienta o front sobre por quanto tempo continuar o polling antes de desistir.
 */
export function n8nAsyncWaitMs(): number {
  const n = Number(process.env.N8N_ASYNC_WAIT_MS)
  return Number.isFinite(n) && n > 0 ? n : 60000
}

/**
 * §5: política de fallback quando o fluxo n8n falha (timeout/5xx/corpo inválido/
 * sem reply). "off" = permanece tentando o n8n; qualquer outro valor (default
 * "assisted") = a partir do PRÓXIMO turno a sessão cai no chat assistido. O
 * cliente nunca vê erro nem trava — apenas uma resposta neutra neste turno.
 */
export type FallbackMode = "off" | "assisted"
export function fallbackMode(): FallbackMode {
  return process.env.NEGOTIATION_ENGINE_FALLBACK === "off" ? "off" : "assisted"
}

/** Reply neutro exibido no modo assíncrono e no fallback técnico (sem PII/URL/segredo). */
export const NEUTRAL_REPLY = "Só um instante, estou verificando…"

/**
 * §3: ações de domínio que o fluxo n8n pode SOLICITAR ao servidor no campo
 * `action` da resposta do turno. Lista fechada — ação fora dela é ignorada e
 * gera o evento chat.engine_invalid_action (o `reply` ainda é exibido).
 */
export const N8N_ALLOWED_ACTIONS = [
  "offer.propose", "offer.accept", "offer.reject",
  "payment.create", "payment.status", "chat.send", "prompt.ask",
  "dispute.register", "human.transfer", "session.close", "negotiation.note",
] as const
export type N8nAllowedAction = (typeof N8N_ALLOWED_ACTIONS)[number]

function isAllowedAction(a: unknown): a is N8nAllowedAction {
  return typeof a === "string" && (N8N_ALLOWED_ACTIONS as readonly string[]).includes(a)
}

export interface EngineTurnResult {
  reply: string
  tool_calls: Array<{ name: string; args: unknown }>
  events: string[]
  prompt_version: string
  verified: boolean
  agreement_id: string | null
  action: "agreement_closed" | "redirect_payment" | "redirect_attendance" | "handoff" | null
  /** N3: id da execução do fluxo n8n (quando o engine é n8n). Rastreado por turno. */
  n8n_execution_id?: string | null
  /** N3: nome do engine que respondeu (n8n|stub|disabled|agent). */
  engine?: EngineName
  /** §3: ação de domínio validada solicitada pelo fluxo (null se ausente/inválida). */
  n8n_action?: N8nAllowedAction | null
  /** round-trip do POST papel A em ms (observabilidade §7). */
  latency_ms?: number | null
  /**
   * §4/§5: sinaliza ao chamador o modo do turno n8n.
   *  - "sync": resposta síncrona normal.
   *  - "async": fluxo respondeu 202; `reply` é neutro, a real vem via chat.send.
   *  - "fallback": falha técnica (timeout/5xx/corpo inválido/sem reply); `reply`
   *    é neutro e a sessão deve cair no assistido do próximo turno (se != off).
   */
  n8n_mode?: "sync" | "async" | "fallback"
}

export interface EngineTurnInput {
  session: NegotiationSession
  message: string
  channel: "webchat" | "whatsapp" | "n8n"
  debtor: SessionDebtContext | null
  tenant: TenantChatConfig | null
}

// Ações de "redirect" legadas (contrato v1: o fluxo pede um redirect/handoff).
// Distintas das ações de DOMÍNIO §3 (offer.*/payment.*/…), classificadas à parte.
const REDIRECT_ACTIONS = ["agreement_closed", "redirect_payment", "redirect_attendance", "handoff"] as const

// Resposta do fluxo n8n — leniente: só `reply` é obrigatório. `action` chega
// como string livre e é CLASSIFICADA depois (redirect legado | ação de domínio
// §3 | inválida→ignorada); assim uma ação desconhecida nunca quebra o parse.
const flowResponseSchema = z.object({
  reply: z.string().min(1),
  action: z.string().nullish(),
  events: z.array(z.string()).default([]),
  verified: z.boolean().default(false),
  agreement_id: z.string().nullish(),
  // O fluxo pede que O SERVIDOR feche o acordo com as regras oficiais de
  // desconto ('avista' | 'parc_N') — caminho preferido vs. o fluxo chamar
  // agreement.close em separado.
  close_offer_id: z.string().nullish(),
  n8n_execution_id: z.string().nullish(),
  tool_calls: z.array(z.object({ name: z.string(), args: z.unknown() })).default([]),
  prompt_version: z.string().default("n8n-flow"),
})

/**
 * POST assinado a um fluxo n8n (papel A). Todo request leva HMAC
 * (`X-AlteaPay-Signature`/`-Timestamp`), Event-Id (`X-AlteaPay-Event-Id`) e, se
 * configurado, Basic Auth — montados em lib/negotiation/n8n.ts. O corpo
 * assinado é a string EXATA enviada (sem re-serializar). Lança em não-2xx
 * (contrato usado por emitNegotiationStart/engineSessionInit, que embrulham).
 *
 * IMPORTANTE (segredo): a mensagem de erro NUNCA inclui a URL, o header
 * Authorization nem qualquer credencial — só status + corpo aparado.
 */
export async function callN8nFlow(url: string, payload: unknown, timeoutMs = flowTimeoutMs()): Promise<unknown> {
  const body = JSON.stringify(payload)
  const { headers } = buildN8nOutboundHeaders(body)
  const resp = await fetch(url, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!resp.ok) {
    throw new Error(`fluxo n8n retornou ${resp.status}: ${(await resp.text()).slice(0, 200)}`)
  }
  return resp.json()
}

/**
 * Resultado bruto de uma chamada papel A ao fluxo n8n, SEM lançar em não-2xx —
 * para o chat.turn distinguir 202 (async) de 5xx/timeout (fallback). Nunca
 * vaza URL/segredo: `error` é um rótulo técnico curto.
 */
type N8nCallOutcome =
  | { kind: "ok"; status: number; body: unknown; latencyMs: number }
  | { kind: "accepted"; status: 202; latencyMs: number }
  | { kind: "error"; error: string; latencyMs: number }

/** Uma tentativa (sem retry) do turno papel A. Não lança: classifica o desfecho. */
async function postChatTurn(url: string, payload: unknown, timeoutMs: number): Promise<N8nCallOutcome> {
  const body = JSON.stringify(payload)
  const { headers } = buildN8nOutboundHeaders(body)
  const t0 = Date.now()
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const latencyMs = Date.now() - t0
    // §4: 202 → aceito, resposta virá depois via chat.send (papel B).
    if (resp.status === 202) {
      // drena o corpo para liberar a conexão; o conteúdo é ignorado.
      await resp.text().catch(() => "")
      return { kind: "accepted", status: 202, latencyMs }
    }
    if (!resp.ok) {
      // NÃO logar corpo/URL — só o status é seguro.
      return { kind: "error", error: `http_${resp.status}`, latencyMs }
    }
    const json = await resp.json().catch(() => null)
    return { kind: "ok", status: resp.status, body: json, latencyMs }
  } catch (err) {
    const latencyMs = Date.now() - t0
    // AbortSignal.timeout dispara TimeoutError; qualquer outra falha de rede
    // também vira fallback técnico. Mensagem sem URL/segredo/PII.
    const label = err instanceof Error && err.name === "TimeoutError" ? "timeout" : "network_error"
    return { kind: "error", error: label, latencyMs }
  }
}

// Contrato v2 (onda R): valores monetários na interface n8n em INTEIROS de
// CENTAVOS. A conversão é SÓ nesta borda; as colunas do banco seguem em reais.
const toCents = (reais: number | null | undefined): number | null =>
  reais == null ? null : Math.round(reais * 100)

// Ações de domínio que o fluxo n8n pode chamar de volta (papel B). Viaja em
// `available_actions` no chat.turn para o fluxo saber o que pode acionar.
export const N8N_AVAILABLE_ACTIONS = [
  "debt.summary", "offer.list", "offer.propose", "offer.accept", "offer.reject",
  "payment.create", "payment.status", "chat.send", "prompt.ask", "prompt.close",
  "dispute.register", "payment_claim.register", "human.transfer", "negotiation.note", "session.close",
] as const

export function buildTurnPayload(input: EngineTurnInput) {
  const { session, debtor, tenant } = input
  // Documento em CLARO só viaja com as 2 flags (send_document_to_engine=true E
  // payment_origin='n8n'). Por padrão, o fluxo recebe só máscara + hash.
  const sendPlainDoc =
    tenant?.send_document_to_engine === true && tenant?.payment_origin === "n8n"
  return {
    type: "chat.turn",
    thread_id: session.thread_id,
    session_id: session.id,
    company_id: session.company_id,
    channel: input.channel,
    message: input.message,
    session_state: {
      identity_verified: Boolean(session.identity_verified_at),
      debt_acknowledged: Boolean(session.debt_acknowledged_at),
      fulfillment_mode: session.fulfillment_mode ?? tenant?.fulfillment_mode ?? "A",
      outcome: session.outcome,
    },
    // Reconhecimento da dívida (onda R): o fluxo sabe se o cliente já respondeu.
    // O detalhe fino (button_id, prompt_id, active_prompt) vive em
    // buildSessionContext (context.ts); aqui viaja o mínimo do turno.
    debt_acknowledgement: {
      acknowledged: Boolean(session.debt_acknowledged_at),
      answered_at: session.debt_acknowledged_at ?? null,
    },
    debtor: debtor
      ? {
          // D1: só o PRIMEIRO nome viaja ao fluxo (minimização de PII); o nome
          // completo nunca sai da plataforma.
          first_name: (debtor.customer_name ?? "").trim().split(/\s+/)[0] ?? "",
          document_masked: maskDocument(debtor.document),
          document_hash: createHash("sha256").update(debtor.document).digest("hex"),
          document: sendPlainDoc ? debtor.document : null,
        }
      : null,
    debt: debtor
      ? {
          id: debtor.debt_id,
          // v2: valor em CENTAVOS (inteiro). `amount` deixa de ser reais decimal.
          amount: toCents(debtor.amount),
          due_date: debtor.due_date,
          description: debtor.description,
          aging_days: debtor.aging_days,
        }
      : null,
    tenant: {
      fulfillment_mode: session.fulfillment_mode ?? tenant?.fulfillment_mode ?? "A",
      official_channel_label: tenant?.official_channel_label ?? null,
      // A URL oficial NÃO viaja: o fluxo sinaliza redirect e o front/webhook a
      // obtém do servidor (session.redirect) — o LLM nunca a manuseia.
    },
  }
}

/** Resposta neutra do modo assíncrono/fallback: nunca expõe erro nem trava. */
function neutralN8nResult(mode: "async" | "fallback", latencyMs: number | null): EngineTurnResult {
  return {
    reply: NEUTRAL_REPLY,
    tool_calls: [],
    events: mode === "async" ? ["n8n_async_pending"] : ["n8n_fallback"],
    prompt_version: "n8n-flow",
    verified: false,
    agreement_id: null,
    action: null,
    n8n_execution_id: null,
    engine: "n8n",
    n8n_action: null,
    latency_ms: latencyMs,
    n8n_mode: mode,
  }
}

/** Registra chat.engine_invalid_action e IGNORA a ação (best-effort, não-fatal). */
async function recordInvalidAction(input: EngineTurnInput, action: string): Promise<void> {
  try {
    const { recordEvent } = await import("@/lib/journey/events")
    await recordEvent({
      companyId: input.session.company_id,
      customerId: input.session.customer_id,
      debtId: input.session.debt_id,
      sessionId: input.session.id,
      type: "chat.engine_invalid_action",
      actor: "n8n",
      // rótulo curto — NUNCA payload com URL/segredo/PII.
      payload: { action },
    })
  } catch (err) {
    console.warn("[engine:n8n] falha ao registrar ação inválida (não-fatal):", (err as Error).message)
  }
}

async function n8nEngineChat(input: EngineTurnInput): Promise<EngineTurnResult> {
  // §6: URL por tenant → env → vazio. Vazio aqui é defensivo: resolveEngineForSession
  // já teria caído no assistido; se chegou sem URL, tratamos como fallback (sem erro).
  const url = resolveChatFlowUrl(input.tenant)
  if (!url) return neutralN8nResult("fallback", null)

  // D2: o payload REAL do turno é o `buildSessionContext` (o contrato rico e
  // documentado: first_name, doc mascarado com flag-gate, offers, matrix,
  // active_prompt, debt_acknowledgement — tudo em centavos). O `buildTurnPayload`
  // fica só como fallback se o contexto não resolver.
  let payload: unknown
  try {
    const { buildSessionContext } = await import("@/lib/journey/context")
    const ctx = await buildSessionContext(input.session.id)
    // D1: o envelope canônico usa `type` (não `event`) — alinhado ao Apêndice A e
    // ao buildTurnPayload (que já usa `type`). Antes este caminho mandava `event`.
    payload = ctx
      ? { type: "chat.turn", ...ctx, message: input.message, available_actions: N8N_AVAILABLE_ACTIONS }
      : buildTurnPayload(input)
  } catch (err) {
    // Resiliência: se o contexto rico não montar, manda o payload mínimo
    // (mascarado, first_name) em vez de derrubar o turno.
    console.warn("[engine:n8n] buildSessionContext falhou, usando fallback:", (err as Error).message)
    payload = buildTurnPayload(input)
  }

  // §2: UMA tentativa (sem retry) com timeout N8N_TIMEOUT_MS (fallback FLOW_TIMEOUT_MS).
  const outcome = await postChatTurn(url, payload, chatTimeoutMs())

  // §4: 202 → turno pendente. Reply neutro; a resposta real chega via chat.send.
  if (outcome.kind === "accepted") {
    return neutralN8nResult("async", outcome.latencyMs)
  }
  // §5 (parte técnica): timeout/5xx/rede → fallback neutro.
  if (outcome.kind === "error") {
    // erro é um rótulo curto (timeout|network_error|http_5xx) — sem URL/segredo/PII.
    console.warn("[engine:n8n] turno falhou (fallback):", outcome.error)
    return neutralN8nResult("fallback", outcome.latencyMs)
  }

  // §3: corpo inválido / sem reply → fallback neutro (não lança).
  const parsed = flowResponseSchema.safeParse(outcome.body)
  if (!parsed.success) {
    console.warn("[engine:n8n] corpo do fluxo inválido (fallback):", parsed.error.issues[0]?.message)
    return neutralN8nResult("fallback", outcome.latencyMs)
  }
  const flow = parsed.data

  // §3: classificação do `action`.
  //  - redirect legado (agreement_closed/redirect_*/handoff) → mantém action.
  //  - ação de domínio permitida (offer.*/payment.*/…) → n8nAction.
  //  - qualquer outra string não-vazia → inválida: registra evento e IGNORA.
  let action: EngineTurnResult["action"] = null
  let n8nAction: N8nAllowedAction | null = null
  const rawAction = typeof flow.action === "string" ? flow.action.trim() : ""
  if (rawAction) {
    if ((REDIRECT_ACTIONS as readonly string[]).includes(rawAction)) {
      action = rawAction as EngineTurnResult["action"]
    } else if (isAllowedAction(rawAction)) {
      n8nAction = rawAction
    } else {
      await recordInvalidAction(input, rawAction)
    }
  }

  let agreementId = flow.agreement_id ?? null
  const events = [...flow.events]

  // Fechamento delegado ao servidor: termos SEMPRE de charge-rules.
  if (flow.close_offer_id && input.session.debt_id) {
    const result = await closeAgreement({
      company_id: input.session.company_id,
      debt_id: input.session.debt_id,
      offer_id: flow.close_offer_id,
      origin: `n8n flow session ${input.session.id}`,
      channel: input.channel,
    })
    if (result.ok) {
      action = "agreement_closed"
      agreementId = result.agreement_id
      events.push("agreement_closed")
    } else {
      console.warn(`[engine:n8n] close_offer_id rejeitado (${flow.close_offer_id}):`, result.error)
      events.push("agreement_close_failed")
    }
  }

  return {
    reply: flow.reply,
    tool_calls: flow.tool_calls.map((t) => ({ name: t.name, args: t.args ?? null })),
    events,
    prompt_version: flow.prompt_version,
    verified: flow.verified,
    agreement_id: agreementId,
    action,
    n8n_execution_id: flow.n8n_execution_id ?? null,
    engine: "n8n",
    n8n_action: n8nAction,
    latency_ms: outcome.latencyMs,
    n8n_mode: "sync",
  }
}

export async function engineChat(input: EngineTurnInput): Promise<EngineTurnResult> {
  // H7/H8: o dono do engine da sessão decide o roteamento. engine_owner='n8n'
  // (setado no reconhecimento "Sim") força o fluxo n8n; se ele não estiver
  // configurado, cai no assistido sem erro. Default (platform/null) → global.
  // §5: sessão já degradada por fallback (engine='disabled') vence o dono n8n.
  // §6: URL por tenant também habilita o fluxo quando o dono é n8n.
  const sessionEngine = (input.session as { engine?: string | null }).engine ?? null
  const name = resolveEngineForSession(input.session.engine_owner, {
    sessionEngine,
    tenantFlowUrl: input.tenant?.n8n_chat_flow_url ?? null,
  })
  if (name === "disabled") {
    // D13: chat assistido determinístico (menu servido pelo servidor, sem IA)
    const { assistedChat } = await import("./assisted")
    return { ...(await assistedChat(input)), engine: "disabled" }
  }
  if (name === "stub") {
    // N3: roteiro determinístico de laboratório (exercita todas as ações).
    const { stubChat } = await import("./engines/stub")
    return { ...(await stubChat(input)), engine: "stub" }
  }
  if (name === "agent") {
    if (!input.session.thread_id) throw new Error("sessão sem thread_id")
    return { ...(await agentChat(input.session.thread_id, input.message, input.session.company_id)), engine: "agent" }
  }
  return n8nEngineChat(input)
}

/**
 * Semeia o contexto da sessão no engine. No n8n é opcional: o contexto viaja
 * em todo turno; se N8N_SESSION_FLOW_URL estiver configurado, notifica o fluxo
 * (ex.: para pré-carregar memória/boas-vindas). Nunca falha o handoff por isso.
 */
export async function engineSessionInit(payload: AgentSessionInit): Promise<void> {
  if (engineName() === "agent") {
    await agentSessionInit(payload)
    return
  }
  const url = sessionFlowUrl()
  if (!url) return
  try {
    await callN8nFlow(url, { type: "session.init", ...payload }, 15_000)
  } catch (err) {
    console.warn("[engine:n8n] session.init flow falhou (não-fatal):", err instanceof Error ? err.message : err)
  }
}

// ---------------------------------------------------------------------------
// H7: evento negotiation.start (plataforma → n8n) no clique "Sim" (button_id=1).
// A partir daqui, engine_owner='n8n' e todos os turnos vão ao fluxo. O payload é
// o contrato do Apêndice B (session/tenant/customer/debt/acknowledgement/matrix/
// offers/available_actions) — valores em CENTAVOS, documento MASCARADO + hash
// (claro só com as 2 flags; como payment_origin está travado em 'platform' por
// D17, o CPF nunca sai).

/**
 * §C3: URL do kickoff (negotiation.start) resolvida COMO OS TURNOS.
 * Ordem: endpoint dedicado (N8N_EVENT_FLOW_URL) → fluxo de chat POR TENANT
 * (tenant_chat_config.n8n_chat_flow_url) → env (N8N_CHAT_FLOW_URL) → "".
 *
 * Corrige a assimetria histórica em que o kickoff resolvia a URL só por env
 * (N8N_EVENT_FLOW_URL → N8N_CHAT_FLOW_URL) enquanto os turnos usam
 * resolveChatFlowUrl (por-tenant → env): uma URL só por tenant fazia o start ir
 * para "" (engine_unavailable) mesmo com os turnos indo ao n8n. A URL resolvida
 * é um segredo operacional — nunca logar.
 */
async function resolveEventFlowUrl(companyId: string): Promise<string> {
  // endpoint de eventos dedicado sempre vence, se configurado.
  const dedicated = process.env.N8N_EVENT_FLOW_URL
  if (dedicated && dedicated.trim()) return dedicated.trim()
  // senão, espelha o resolver do TURNO: fluxo de chat por-tenant → env.
  try {
    const { createServiceClient } = await import("@/lib/supabase/service")
    const { data: cfg } = await createServiceClient()
      .from("tenant_chat_config")
      .select("n8n_chat_flow_url")
      .eq("company_id", companyId)
      .maybeSingle()
    const perTenant = cfg?.n8n_chat_flow_url
    if (typeof perTenant === "string" && perTenant.trim()) return perTenant.trim()
  } catch (err) {
    // leitura best-effort: se falhar, cai na env (nunca derruba o kickoff).
    console.warn("[engine:n8n] resolveEventFlowUrl falhou (usando env):", (err as Error).message)
  }
  return process.env.N8N_CHAT_FLOW_URL || ""
}

export interface NegotiationStartPayload {
  // D1: `type` é o campo canônico do envelope (Apêndice A). `event` é MANTIDO
  // (superset compatível) para o fluxo n8n legado que ainda lê `event`.
  type: string
  event: "negotiation.start"
  contract_version: string
  event_id: string
  session_id: string
  company_id: string
  session: unknown
  tenant: unknown
  customer: unknown
  debt: unknown
  acknowledgement: {
    acknowledged: boolean
    button_id: number | null
    answered_at: string | null
  }
  matrix: unknown
  offers: unknown
  available_actions: readonly string[]
  /**
   * URL pública do NOSSO receptor (`${NEXT_PUBLIC_APP_URL}/api/webhooks/n8n`) para
   * onde o fluxo n8n responde no modo ASSÍNCRONO (action='chat.send' assinado,
   * ecoando este event_id). É a nossa URL pública, documentável. Omitido quando
   * NEXT_PUBLIC_APP_URL não está configurado (não quebra o build do payload).
   */
  callback_url?: string
}

/**
 * URL pública do NOSSO receptor de callbacks n8n a partir de NEXT_PUBLIC_APP_URL.
 * Normaliza a barra final (`https://x/` e `https://x` → `https://x/api/webhooks/n8n`,
 * sem barra dupla). Retorna undefined se a env estiver ausente (campo omitido).
 * Valor SEMPRE de process.env no servidor — nunca de entrada externa.
 */
function n8nCallbackUrl(): string | undefined {
  const base = process.env.NEXT_PUBLIC_APP_URL
  if (!base || !base.trim()) return undefined
  return `${base.trim().replace(/\/+$/, "")}/api/webhooks/n8n`
}

export type NegotiationStartResult =
  | { ok: true; delivered: true; event_id: string }
  | { ok: true; delivered: false; reason: "engine_unavailable" | "context_unresolved" }
  | { ok: false; reason: "context_unresolved" }

/**
 * Monta o payload negotiation.start a partir do contexto rico da sessão
 * (buildSessionContext já produz session/tenant/customer/debt/matrix/offers/
 * debt_acknowledgement em CENTAVOS e mascarado). Retorna null se o contexto não
 * resolver (sessão/cliente/dívida inconsistentes).
 */
export async function buildNegotiationStartPayload(
  sessionId: string,
  eventId: string,
): Promise<NegotiationStartPayload | null> {
  const { buildSessionContext } = await import("@/lib/journey/context")
  const { resolveEventName, CONTRACT_VERSION } = await import("./payload")
  const ctx = await buildSessionContext(sessionId)
  if (!ctx) return null

  // rótulo do evento por tenant (default 'negotiation.start').
  const { createServiceClient } = await import("@/lib/supabase/service")
  const { data: cfg } = await createServiceClient()
    .from("tenant_chat_config")
    .select("n8n_event_names")
    .eq("company_id", ctx.tenant.id)
    .maybeSingle()
  const type = resolveEventName("negotiation_start", (cfg?.n8n_event_names ?? null) as never)

  const callbackUrl = n8nCallbackUrl()
  return {
    type,
    event: "negotiation.start",
    contract_version: CONTRACT_VERSION,
    event_id: eventId,
    session_id: sessionId,
    company_id: ctx.tenant.id,
    session: ctx.session,
    tenant: ctx.tenant,
    customer: ctx.customer,
    debt: ctx.debt,
    acknowledgement: {
      acknowledged: ctx.debt_acknowledgement.acknowledged === true,
      button_id: ctx.debt_acknowledgement.button_id,
      answered_at: ctx.debt_acknowledgement.answered_at,
    },
    matrix: ctx.matrix,
    offers: ctx.offers,
    available_actions: N8N_AVAILABLE_ACTIONS,
    // §3: presente só quando NEXT_PUBLIC_APP_URL está configurado (senão omitido).
    ...(callbackUrl ? { callback_url: callbackUrl } : {}),
  }
}

/**
 * §C3: grava o negotiation.start no engine_outbox (JSONB) para ENTREGA DURÁVEL —
 * o mesmo mecanismo provado do session.start. Idempotente por event_id (índice
 * UNIQUE): reentrada/re-clique não duplica a linha. NÃO envia aqui; a entrega
 * fica a cargo do POST best-effort no clique E do flushOutbox do próximo turno
 * (ordem preservada), garantindo reentrega mesmo se o POST curto falhar.
 *
 * NegotiationStartPayload não é um dos três EventKind que buildEnvelope produz,
 * então NÃO passa por enqueueEvent (que tipa CanonicalEnvelope e gate em
 * engine 'disabled'); gravamos o row shape aqui, e postToN8n/dispatchOutboxRow
 * entregam a linha inalterados. Best-effort e não-fatal: nunca lança.
 */
async function enqueueNegotiationStart(p: NegotiationStartPayload): Promise<void> {
  const { createServiceClient } = await import("@/lib/supabase/service")
  const supabase = createServiceClient()
  // idempotente por event_id (UNIQUE) — reentrada não duplica.
  const { data: existing } = await supabase
    .from("engine_outbox")
    .select("id")
    .eq("event_id", p.event_id)
    .maybeSingle()
  if (existing) return
  await supabase.from("engine_outbox").insert({
    session_id: p.session_id,
    company_id: p.company_id,
    event_type: p.type, // rótulo negotiation.start resolvido (por tenant)
    event_id: p.event_id,
    payload: p,
    status: "pending",
    attempts: 0,
    next_attempt_at: new Date().toISOString(),
  })
}

/**
 * §C3: marca a linha do outbox como 'sent' quando o POST curto do clique já
 * entregou — evita um re-POST duplicado no próximo flush. Idempotente por
 * event_id. Best-effort e não-fatal: nunca lança.
 */
async function markOutboxSent(eventId: string): Promise<void> {
  try {
    const { createServiceClient } = await import("@/lib/supabase/service")
    const now = new Date().toISOString()
    await createServiceClient()
      .from("engine_outbox")
      .update({ status: "sent", sent_at: now, next_attempt_at: null, updated_at: now })
      .eq("event_id", eventId)
      .select("id")
  } catch (err) {
    console.warn("[engine:n8n] markOutboxSent falhou (não-fatal):", (err as Error).message)
  }
}

/**
 * §2: resultado normalizado do corpo SÍNCRONO do kickoff. `text` é a bolha do
 * assistente; `prompt` (opcional) vira um prompt de botões; `n8n_execution_id`
 * é repassado. `null` quando o corpo não traz nada renderizável.
 */
export interface KickoffReply {
  text: string
  prompt?: { kind: string; question: string; buttons: Button[] }
  n8n_execution_id?: string
}

/**
 * §2.1/§2.2: parser PURO e LENIENTE do corpo síncrono do kickoff. NUNCA lança.
 * Aceita as duas convenções:
 *  (a) forma enxuta do recipe: `{ text, buttons? }`;
 *  (b) contrato EngineTurnResult: `{ reply, buttons?/prompt?, n8n_execution_id? }`.
 * - texto: `text` OU `reply` (alias), string não-vazia após trim.
 * - prompt: usa `prompt:{kind,question,buttons}` direto; senão, se vier
 *   `buttons:[...]` no topo, monta `{ kind:'offer_choice', question:<texto>, buttons }`.
 * - corpo vazio/{"message":"Workflow was started"}/{}/null/não-objeto/sem texto E
 *   sem buttons → retorna `null` (não persiste; cai no placeholder/outbox atual).
 * A validação fina dos botões fica no chatSend (best-effort); aqui só extraímos.
 */
export function parseKickoffReply(body: unknown): KickoffReply | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null
  const b = body as Record<string, unknown>

  const rawText = typeof b.text === "string" ? b.text : typeof b.reply === "string" ? b.reply : ""
  const text = rawText.trim()

  // prompt explícito tem precedência; senão, buttons no topo montam um offer_choice.
  let prompt: KickoffReply["prompt"] | undefined
  const explicit = b.prompt
  if (explicit && typeof explicit === "object" && !Array.isArray(explicit)) {
    const p = explicit as Record<string, unknown>
    const buttons = Array.isArray(p.buttons) ? (p.buttons as Button[]) : []
    prompt = {
      kind: typeof p.kind === "string" && p.kind.trim() ? p.kind : "offer_choice",
      question: typeof p.question === "string" && p.question.trim() ? p.question : text,
      buttons,
    }
  } else if (Array.isArray(b.buttons) && b.buttons.length > 0) {
    prompt = { kind: "offer_choice", question: text, buttons: b.buttons as Button[] }
  }

  // sem texto E sem prompt renderizável → nada a persistir.
  if (!text && !prompt) return null

  const execId = typeof b.n8n_execution_id === "string" ? b.n8n_execution_id : undefined
  return { text, prompt, ...(execId ? { n8n_execution_id: execId } : {}) }
}

/**
 * §4.1(d): persiste a resposta SÍNCRONA do kickoff via o MESMO write path do
 * inbound async (`chatSend`), reusando `loadSessionCtx(session_id)` (NUNCA
 * reconstrói SessionCtx do payload) e o MESMO `payload.event_id` do kickoff como
 * eventId (dedupe compartilhado SYNC↔ASYNC). Best-effort e NÃO-fatal: qualquer
 * falha (contexto ausente, botões inválidos, erro de escrita) só gera um warn de
 * rótulo curto — NUNCA derruba o clique. Sem log do corpo cru/URL/segredo/PII.
 */
async function persistKickoffReply(p: NegotiationStartPayload, body: unknown): Promise<void> {
  try {
    const parsed = parseKickoffReply(body)
    if (!parsed) return
    const { loadSessionCtx } = await import("@/lib/journey/actions")
    const ctx = await loadSessionCtx(p.session_id)
    if (!ctx) return
    const { chatSend } = await import("@/lib/journey/chat-send")
    const sent = await chatSend(
      ctx,
      { text: parsed.text, prompt: parsed.prompt, n8n_execution_id: parsed.n8n_execution_id },
      p.event_id,
    )
    // D2/M11: a 1ª resposta SÍNCRONA do motor já entrou no histórico → a sessão
    // saiu de 'aguardando_motor' para 'negociando'. Limpa a espera no servidor
    // para que um reload NÃO restaure o spinner (o degrau seria derivado de um
    // wait_started_at obsoleto). Só limpa se a mensagem foi de fato persistida
    // (inclui a variante duplicate, que também significa "o motor já respondeu").
    if (sent.ok) await clearWaitStateOnEngineReply(p.session_id)
  } catch (err) {
    // rótulo curto — sem corpo cru/URL/segredo/PII.
    const label = err instanceof Error ? err.name : "persist_error"
    console.warn("[engine:n8n] persist kickoff (não-fatal)", label)
  }
}

/**
 * D2 — persistência do wait_state no caminho do negotiation.start (§4 do design):
 * quando o motor RESPONDE (kickoff síncrono persistido), a espera acabou → limpa
 * negotiation_sessions.wait_state para NULL ('idle') e zera wait_started_at, de
 * modo que um reload não recomece a animação de espera (M11). NUNCA lança e é
 * DEFENSIVO: se a coluna M-4 ainda não existir em produção (aplicada só no G6), o
 * update erra e apenas logamos um rótulo curto — a resposta do motor já está no
 * histórico e o client transiciona para 'negociando' pelo próprio poll de qualquer
 * forma (a limpeza do servidor é só para o caso de reload). Sem PII/segredo no log.
 */
async function clearWaitStateOnEngineReply(sessionId: string): Promise<void> {
  try {
    const { createServiceClient } = await import("@/lib/supabase/service")
    const { error } = await createServiceClient()
      .from("negotiation_sessions")
      .update({ wait_state: null, wait_started_at: null })
      .eq("id", sessionId)
      .not("wait_state", "is", null) // só toca sessões que estavam esperando
    if (error) {
      console.warn("[engine:n8n] clear wait_state não aplicado (coluna M-4 pendente?)", error.code ?? "")
    }
  } catch (err) {
    console.warn("[engine:n8n] clear wait_state falhou (defensivo)", err instanceof Error ? err.name : "")
  }
}

/**
 * Emite negotiation.start ao n8n (assinado, mesmo esquema HMAC dos outros
 * contratos). RESILIENTE (H8): se o n8n não estiver configurado ou o POST
 * falhar, NÃO lança — devolve delivered:false/reason:'engine_unavailable' para
 * o chamador registrar auditoria e seguir no assistido.
 *
 * §C3 (entrega CONFIÁVEL + sem travar o clique):
 *  1) resolve a URL COMO OS TURNOS (dedicado → por-tenant → env), removendo a
 *     assimetria que fazia o start ir para "" com URL só por tenant.
 *  2) N8N_WEBHOOK_SECRET DEIXA de ser hard-gate (só warn): a assinatura vazia é
 *     problema de config do operador, idêntico ao comportamento dos turnos —
 *     assim o start não "some" silenciosamente quando o secret falta.
 *  3) GRAVA a linha durável no outbox (idempotente) e faz um POST best-effort de
 *     timeout CURTO (N8N_KICKOFF_TIMEOUT_MS, default 2500ms, alinhado ao outbox).
 *     Se o POST falha/estoura, a linha fica 'pending' e o flush do próximo turno
 *     (e o script ops) REENTREGA — a entrega não depende de um único disparo.
 */
export async function emitNegotiationStart(
  sessionId: string,
  eventId: string,
): Promise<NegotiationStartResult> {
  const payload = await buildNegotiationStartPayload(sessionId, eventId).catch(() => null)
  if (!payload) return { ok: false, reason: "context_unresolved" }

  const url = await resolveEventFlowUrl(payload.company_id)
  if (!url) {
    // n8n genuinamente não plugado (sem dedicado, sem tenant, sem env). Enfileira
    // mesmo assim para durabilidade (entrega no dia em que a URL existir, igual ao
    // session.start 'pending'), mas reporta unavailable p/ o chamador seguir assistido.
    await enqueueNegotiationStart(payload).catch(() => {})
    return { ok: true, delivered: false, reason: "engine_unavailable" }
  }

  // Secret ausente NÃO derruba mais o start (era a causa do "não envia nada"): o
  // buildN8nOutboundHeaders segue com assinatura vazia; só avisamos no log.
  if (!n8nWebhookSecret()) {
    console.warn("[engine:n8n] N8N_WEBHOOK_SECRET ausente — negotiation.start irá sem assinatura")
  }

  try {
    // Kickoff (negotiation.start): timeout CURTO (2500ms default, = ENGINE_OUTBOX_TIMEOUT_MS)
    // para não dominar o clique. A entrega NÃO depende deste único disparo:
    const kickoffTimeoutMs = Number(process.env.N8N_KICKOFF_TIMEOUT_MS || "2500")
    await enqueueNegotiationStart(payload) // 1) durável, idempotente
    const body = await callN8nFlow(url, payload, kickoffTimeoutMs) // 2) captura o corpo SYNC
    await markOutboxSent(payload.event_id) // 3) entrega confirmada ANTES da persistência
    // 4) RENDER SYNC (best-effort, NUNCA lança): se o corpo trouxer texto/prompt
    //    AUTORADO pelo n8n, persiste via chatSend com o MESMO event_id (dedupe
    //    compartilhado SYNC↔ASYNC). Corpo vazio/async → não persiste (placeholder).
    await persistKickoffReply(payload, body).catch(() => {})
    return { ok: true, delivered: true, event_id: eventId }
  } catch (err) {
    // POST falhou/estourou → a linha do outbox fica 'pending' e SERÁ reentregue
    // pelo flush do próximo turno / script ops. A entrega não se perde.
    console.warn(
      "[engine:n8n] negotiation.start POST falhou (outbox reentregará):",
      err instanceof Error ? err.message : err,
    )
    return { ok: true, delivered: false, reason: "engine_unavailable" }
  }
}

// ---------------------------------------------------------------------------
// D1/Frente A: session.start (plataforma → n8n) no LOGIN. Envelope canônico
// (payload.ts). Enxuto: sem offers/matrix — só quem/quanto/quando + estado da
// sessão. GRAVA no outbox (idempotente por event_id determinístico); a entrega ao
// n8n é best-effort e NÃO espera a resposta ao devedor (equalização de ~600ms
// preservada pela rota). Gated: engine 'disabled' → outbox nasce
// 'skipped_engine_disabled' e nunca envia.

export interface SessionStartInput {
  sessionId: string
  companyId: string
  customerId: string
  /** documento em CLARO (só p/ máscara+hash; nunca vai no payload). */
  document: string
  debtIds: string[]
  reopenCount: number
  channel: string | null
  threadId: string | null
  identityVerified: boolean
  debtAcknowledged: boolean
  fulfillmentMode: string
  outcome: string | null
  /** true quando NÃO há dívida aberta (quitado): debt=null no envelope. */
  settled?: boolean
}

/**
 * Monta o envelope session.start reusando buildAckContext (valor consolidado
 * REAIS + vencimento ORIGINAL mais antigo + contagem de faturas) e lendo tenant
 * (official_channel_label, brand_name, public_link_code, n8n_event_names) + a
 * presença de cobrança viva (has_live_charge) numa leitura enxuta. Sem I/O extra
 * além do necessário; retorna null se o contexto não montar.
 */
export async function buildSessionStartEnvelope(
  input: SessionStartInput,
): Promise<CanonicalEnvelope | null> {
  const { buildEnvelope } = await import("./payload")
  const { createServiceClient } = await import("@/lib/supabase/service")
  const supabase = createServiceClient()

  // tenant: rótulo do canal oficial, brand_name, public_link_code, rótulos n8n.
  // customer: nome (o envelope reduz ao 1º nome — o fluxo n8n saúda por nome).
  const [{ data: cfg }, { data: company }, { data: customer }] = await Promise.all([
    supabase
      .from("tenant_chat_config")
      .select("official_channel_label, branding, public_link_code, n8n_event_names, fulfillment_mode")
      .eq("company_id", input.companyId)
      .maybeSingle(),
    supabase.from("companies").select("name").eq("id", input.companyId).maybeSingle(),
    supabase
      .from("customers")
      .select("name")
      .eq("id", input.customerId)
      .eq("company_id", input.companyId)
      .maybeSingle(),
  ])
  const branding = (cfg?.branding ?? {}) as Record<string, unknown>
  const brandName =
    (typeof branding.brand_name === "string" && branding.brand_name) || company?.name || "Credor"
  const customerName = (customer?.name as string | null) ?? null

  // Débito primário/mais antigo: o mesmo conjunto do has_live_charge. Usamos o
  // 1º debtId como id representativo do débito no envelope (debt.id da captura).
  const primaryDebtId = input.debtIds[0] ?? null

  // fulfillment_mode: um único valor reusado em session_state E tenant (a captura
  // n8n tem em tenant.fulfillment_mode, redundante com session_state).
  const fulfillmentMode = input.fulfillmentMode || (cfg?.fulfillment_mode as string) || "A"

  // dívida: valor consolidado (reais), vencimento original, contagem de faturas.
  // description: a tabela debts não tem coluna description → null na VMAX (o campo
  // existe no envelope para o fluxo referenciar sem quebrar).
  let debt:
    | {
        debtId: string | null
        amount: number | null
        dueDate: string | null
        description: string | null
        invoiceCount: number
        hasLiveCharge: boolean
      }
    | null = null
  if (!input.settled && input.debtIds.length > 0) {
    // Frente B (perf): UMA leitura indexada por (company_id, document_digits) no
    // snapshot. Quando presente e pronto, monta o payload SEM I/O extra
    // (open_amount_cents já é centavos → reais). Cai no buildAckContext só quando
    // o snapshot não existe (pré-backfill/G4).
    const { normalizeDocument } = await import("@/lib/journey/document")
    const digits = normalizeDocument(input.document)
    const { data: snap } = await supabase
      .from("debtor_engine_snapshot")
      .select("open_amount_cents, oldest_original_due_date, open_invoice_count, has_live_charge, payload_ready")
      .eq("company_id", input.companyId)
      .eq("document_digits", digits)
      .maybeSingle()

    if (snap && snap.payload_ready) {
      debt = {
        debtId: primaryDebtId,
        amount: Number(snap.open_amount_cents) / 100,
        dueDate: (snap.oldest_original_due_date as string | null) ?? null,
        description: null,
        invoiceCount: Number(snap.open_invoice_count ?? 0),
        hasLiveCharge: Boolean(snap.has_live_charge),
      }
    } else {
      const { buildAckContext } = await import("@/lib/journey/acknowledgement")
      const ack = await buildAckContext({
        companyId: input.companyId,
        customerId: input.customerId,
        debtIds: input.debtIds,
      })
      // cobrança viva: algum agreement com status ativo/pendente para as dívidas.
      const { data: liveCharges } = await supabase
        .from("agreements")
        .select("id")
        .eq("company_id", input.companyId)
        .in("debt_id", input.debtIds)
        .in("payment_status", ["pending", "overdue"])
        .limit(1)
      debt = {
        debtId: primaryDebtId,
        amount: ack.updatedValue,
        dueDate: ack.oldestDueDate,
        description: null,
        invoiceCount: ack.invoiceCount,
        hasLiveCharge: (liveCharges?.length ?? 0) > 0,
      }
    }
  }

  return buildEnvelope({
    kind: "session_start",
    eventNames: (cfg?.n8n_event_names ?? null) as never,
    sessionId: input.sessionId,
    companyId: input.companyId,
    reopenCount: input.reopenCount,
    threadId: input.threadId,
    channel: input.channel,
    message: null,
    button: null,
    sessionState: {
      identityVerified: input.identityVerified,
      debtAcknowledged: input.debtAcknowledged,
      fulfillmentMode,
      outcome: input.outcome,
    },
    debtor: { customerId: input.customerId, name: customerName, document: input.document },
    debt,
    tenant: {
      fulfillmentMode,
      officialChannelLabel: (cfg?.official_channel_label as string | null) ?? null,
      brandName,
      publicLinkCode: (cfg?.public_link_code as string | null) ?? null,
    },
  })
}

export type EmitSessionStartResult =
  | { ok: true; enqueued: true; status: "pending" | "skipped_engine_disabled"; eventId: string }
  | { ok: true; enqueued: false; reason: "context_unresolved" }

/**
 * Grava o session.start no outbox (idempotente) e, se não gated, dispara ao n8n
 * best-effort (o chamador usa Promise.allSettled p/ não somar na resposta).
 * RESILIENTE: nunca lança; falha de contexto → enqueued:false.
 */
export async function emitSessionStart(input: SessionStartInput): Promise<EmitSessionStartResult> {
  const envelope = await buildSessionStartEnvelope(input).catch(() => null)
  if (!envelope) return { ok: true, enqueued: false, reason: "context_unresolved" }

  const { enqueueEvent, dispatchOutboxRow } = await import("./outbox")
  const enq = await enqueueEvent({
    sessionId: input.sessionId,
    companyId: input.companyId,
    envelope,
  })
  if (!enq.ok) return { ok: true, enqueued: false, reason: "context_unresolved" }

  // Gated → não envia. Recém-criado e não gated → dispara agora (best-effort).
  if (enq.status === "pending" && enq.created) {
    // não await no caminho crítico do chamador — mas aqui devolvemos a Promise
    // já resolvida; o chamador (login) embrulha em Promise.allSettled.
    await dispatchOutboxRow({ id: enq.id, payload: envelope, attempts: 0, status: "pending" }).catch(() => "pending")
  }
  return {
    ok: true,
    enqueued: true,
    status: enq.status === "skipped_engine_disabled" ? "skipped_engine_disabled" : "pending",
    eventId: envelope.event_id,
  }
}

export async function engineHealth(): Promise<{ ok: boolean; engine: EngineName; detail?: string }> {
  if (engineName() === "disabled") {
    return { ok: true, engine: "disabled", detail: "modo assistido determinístico" }
  }
  if (engineName() === "stub") {
    return { ok: true, engine: "stub", detail: "roteiro determinístico de laboratório" }
  }
  if (engineName() === "agent") {
    const health = await agentHealth()
    return { ...health, engine: "agent" }
  }
  if (!n8nWebhookSecret()) return { ok: false, engine: "n8n", detail: "N8N_WEBHOOK_SECRET não configurado" }
  if (!chatFlowUrl()) return { ok: false, engine: "n8n", detail: "N8N_CHAT_FLOW_URL não configurado" }
  return { ok: true, engine: "n8n" }
}
