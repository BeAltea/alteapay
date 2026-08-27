// Cliente HTTP do agente de negociação (server-to-server, x-app-token).
// O browser NUNCA fala direto com o agente — só a v2.

import { agentBaseUrl, appSharedToken } from "./config"
import type { FulfillmentMode } from "./types"

export interface AgentSessionInit {
  thread_id: string
  company_id: string
  customer_name: string
  document: string
  debt_id: string
  amount: number
  original_amount?: number
  aging_days: number
  due_date?: string
  description?: string
  channel: "webchat" | "whatsapp" | "n8n"
  identity_preverified: boolean
  fulfillment_mode?: FulfillmentMode
  official_channel_label?: string
  attendance_channel_label?: string
}

export interface AgentChatResponse {
  reply: string
  tool_calls: Array<{ name: string; args: unknown }>
  events: string[]
  prompt_version: string
  verified: boolean
  agreement_id: string | null
  action: "agreement_closed" | "redirect_payment" | "redirect_attendance" | "handoff" | null
}

function headers(): Record<string, string> {
  return { "Content-Type": "application/json", "x-app-token": appSharedToken() }
}

export async function agentSessionInit(payload: AgentSessionInit): Promise<void> {
  const resp = await fetch(`${agentBaseUrl()}/session/init`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  })
  if (!resp.ok) {
    throw new Error(`agente /session/init retornou ${resp.status}: ${(await resp.text()).slice(0, 200)}`)
  }
}

// Modelo local (~qwen2.5:14b em GPU compartilhada) pode levar ~100s por turno.
const CHAT_TIMEOUT_MS = 300_000

export async function agentChat(threadId: string, message: string, companyId: string): Promise<AgentChatResponse> {
  const resp = await fetch(`${agentBaseUrl()}/chat`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ thread_id: threadId, message, source: "live", company_id: companyId }),
    signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
  })
  if (!resp.ok) {
    throw new Error(`agente /chat retornou ${resp.status}: ${(await resp.text()).slice(0, 200)}`)
  }
  return (await resp.json()) as AgentChatResponse
}

export async function agentHealth(): Promise<{ ok: boolean; detail?: string }> {
  try {
    const resp = await fetch(`${agentBaseUrl()}/health`, { signal: AbortSignal.timeout(5_000) })
    if (!resp.ok) return { ok: false, detail: `status ${resp.status}` }
    return { ok: true }
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
}
