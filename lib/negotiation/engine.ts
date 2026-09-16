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

import { z } from "zod"

import { agentChat, agentHealth, agentSessionInit, type AgentSessionInit } from "./agent-client"
import { closeAgreement } from "./close-agreement"
import { N8N_SIGNATURE_HEADER, N8N_TIMESTAMP_HEADER, signN8nPayload, n8nWebhookSecret } from "./n8n"
import type { SessionDebtContext } from "./sessions"
import type { NegotiationSession, TenantChatConfig } from "./types"

export type EngineName = "n8n" | "agent" | "disabled"

/**
 * D14: default em produção é DISABLED (chat assistido determinístico).
 * "n8n" sem N8N_CHAT_FLOW_URL e "agent" sem AGENT_URL degradam para
 * disabled (nunca expõem erro ao cliente; o turno loga chat.engine_error).
 */
export function engineName(): EngineName {
  const raw = process.env.NEGOTIATION_ENGINE
  if (raw === "agent") {
    return process.env.AGENT_URL && process.env.AGENT_APP_TOKEN ? "agent" : "disabled"
  }
  if (raw === "n8n") {
    return process.env.N8N_CHAT_FLOW_URL ? "n8n" : "disabled"
  }
  return "disabled"
}

function chatFlowUrl(): string {
  return process.env.N8N_CHAT_FLOW_URL || ""
}

function sessionFlowUrl(): string {
  return process.env.N8N_SESSION_FLOW_URL || ""
}

function flowTimeoutMs(): number {
  return Number(process.env.N8N_FLOW_TIMEOUT_MS || "60000")
}

export interface EngineTurnResult {
  reply: string
  tool_calls: Array<{ name: string; args: unknown }>
  events: string[]
  prompt_version: string
  verified: boolean
  agreement_id: string | null
  action: "agreement_closed" | "redirect_payment" | "redirect_attendance" | "handoff" | null
}

export interface EngineTurnInput {
  session: NegotiationSession
  message: string
  channel: "webchat" | "whatsapp" | "n8n"
  debtor: SessionDebtContext | null
  tenant: TenantChatConfig | null
}

// Resposta do fluxo n8n — leniente: só `reply` é obrigatório.
const flowResponseSchema = z.object({
  reply: z.string().min(1),
  action: z
    .enum(["agreement_closed", "redirect_payment", "redirect_attendance", "handoff"])
    .nullish(),
  events: z.array(z.string()).default([]),
  verified: z.boolean().default(false),
  agreement_id: z.string().nullish(),
  // O fluxo pede que O SERVIDOR feche o acordo com as regras oficiais de
  // desconto ('avista' | 'parc_N') — caminho preferido vs. o fluxo chamar
  // agreement.close em separado.
  close_offer_id: z.string().nullish(),
  tool_calls: z.array(z.object({ name: z.string(), args: z.unknown() })).default([]),
  prompt_version: z.string().default("n8n-flow"),
})

/** POST assinado a um fluxo n8n (mesmo esquema HMAC do webhook inbound). */
export async function callN8nFlow(url: string, payload: unknown, timeoutMs = flowTimeoutMs()): Promise<unknown> {
  const body = JSON.stringify(payload)
  const timestamp = String(Math.floor(Date.now() / 1000))
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [N8N_SIGNATURE_HEADER]: signN8nPayload(body, timestamp),
      [N8N_TIMESTAMP_HEADER]: timestamp,
    },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!resp.ok) {
    throw new Error(`fluxo n8n ${url} retornou ${resp.status}: ${(await resp.text()).slice(0, 200)}`)
  }
  return resp.json()
}

function buildTurnPayload(input: EngineTurnInput) {
  const { session, debtor, tenant } = input
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
    debtor: debtor
      ? { name: debtor.customer_name, document: debtor.document }
      : null,
    debt: debtor
      ? {
          id: debtor.debt_id,
          amount: debtor.amount,
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

async function n8nEngineChat(input: EngineTurnInput): Promise<EngineTurnResult> {
  const url = chatFlowUrl()
  if (!url) throw new Error("N8N_CHAT_FLOW_URL não configurado")

  const raw = await callN8nFlow(url, buildTurnPayload(input))
  const parsed = flowResponseSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(`resposta do fluxo n8n inválida: ${parsed.error.issues[0]?.message}`)
  }
  const flow = parsed.data

  let action = flow.action ?? null
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
  }
}

export async function engineChat(input: EngineTurnInput): Promise<EngineTurnResult> {
  if (engineName() === "agent") {
    if (!input.session.thread_id) throw new Error("sessão sem thread_id")
    return agentChat(input.session.thread_id, input.message, input.session.company_id)
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

export async function engineHealth(): Promise<{ ok: boolean; engine: EngineName; detail?: string }> {
  if (engineName() === "agent") {
    const health = await agentHealth()
    return { ...health, engine: "agent" }
  }
  if (!n8nWebhookSecret()) return { ok: false, engine: "n8n", detail: "N8N_WEBHOOK_SECRET não configurado" }
  if (!chatFlowUrl()) return { ok: false, engine: "n8n", detail: "N8N_CHAT_FLOW_URL não configurado" }
  return { ok: true, engine: "n8n" }
}
