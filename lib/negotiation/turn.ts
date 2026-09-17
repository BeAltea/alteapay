// Turno unificado do chatbot: grava inbound, chama o engine (fluxo n8n por
// padrão; agente legado por env), grava outbound com rastreabilidade LGPD
// (tool_calls + prompt_version, art. 20) e aplica os efeitos no funil.
// Usado pelo chat web, pelo webhook n8n (sync) e pelo worker async.

import { engineChat, engineName, type EngineTurnResult } from "./engine"
import {
  applyTurnEffects,
  loadSessionDebtContext,
  loadTenantConfig,
  recordMessage,
} from "./sessions"
import type { MessageChannel, NegotiationSession } from "./types"

export type { EngineTurnResult }

export async function runChatbotTurn(
  session: NegotiationSession,
  message: string,
  channel: MessageChannel,
): Promise<EngineTurnResult> {
  if (!session.thread_id) throw new Error("sessão sem thread_id")

  const [debtor, tenant] = await Promise.all([
    loadSessionDebtContext(session),
    loadTenantConfig(session.company_id),
  ])

  await recordMessage({
    session,
    channel,
    direction: "inbound",
    sender: "debtor",
    content: message,
  })

  const result = await engineChat({ session, message, channel, debtor, tenant })

  await recordMessage({
    session,
    channel,
    direction: "outbound",
    sender: "agent",
    content: result.reply,
    tool_calls: result.tool_calls.length ? result.tool_calls : null,
    llm_model: engineName() === "n8n" ? "n8n-flow" : process.env.NEGOTIATION_MODEL || "qwen2.5:14b",
    prompt_version: result.prompt_version,
  })

  await applyTurnEffects(session, result).catch((err) =>
    console.error("[negotiation:turn] efeitos do turno:", err instanceof Error ? err.message : err),
  )

  return result
}
