// Turno canônico do chat da jornada (N3): grava chat_messages, mede latência,
// chama o engine (n8n|stub|disabled), grava a resposta com n8n_execution_id, e
// devolve reply + ofertas atuais. A auth chega ao n8n no 1º turno via o
// contexto (context.ts) — o engine n8n embute o payload chat.turn.
//
// Reutiliza runChatbotTurn (que também grava conversation_messages para a
// auditoria LGPD existente e aplica os efeitos do funil). chat_messages é a
// visão turno-a-turno da onda, com rastreio de engine/execução.

import { createServiceClient } from "@/lib/supabase/service"
import { engineName } from "@/lib/negotiation/engine"
import { runChatbotTurn } from "@/lib/negotiation/turn"
import type { NegotiationSession } from "@/lib/negotiation/types"
import { listOffers, type SessionCtx } from "./actions"
import { recordEvent } from "./events"

const N8N_TIMEOUT_MS = Number(process.env.N8N_TIMEOUT_MS || "20000")

export interface ChatTurnOutput {
  reply: string
  offers: Awaited<ReturnType<typeof listOffers>>
  action: string | null
  processing?: boolean
}

async function recordChatMessage(input: {
  companyId: string
  sessionId: string
  role: "customer" | "assistant" | "system"
  text: string
  offersSnapshot?: unknown
  n8nExecutionId?: string | null
  engine?: string | null
  latencyMs?: number | null
}): Promise<void> {
  const supabase = createServiceClient()
  await supabase.from("chat_messages").insert({
    company_id: input.companyId,
    session_id: input.sessionId,
    role: input.role,
    text: input.text,
    offers_snapshot: input.offersSnapshot ?? null,
    n8n_execution_id: input.n8nExecutionId ?? null,
    engine: input.engine ?? null,
    latency_ms: input.latencyMs ?? null,
  })
}

/** Neutraliza tags e apara. Nunca lança. */
function sanitize(text: string): string {
  return (text || "").replace(/<[^>]*>/g, "").trim()
}

/**
 * Executa um turno do chat autenticado. `ctx` vem do cookie de sessão.
 * A resposta neutra + chat.engine_error (1x/sessão) fica a cargo do chamador
 * quando o engine lança.
 */
export async function runJourneyTurn(ctx: SessionCtx, rawText: string): Promise<ChatTurnOutput> {
  const supabase = createServiceClient()
  const text = sanitize(rawText)
  if (!text) return { reply: "", offers: await listOffers(ctx), action: null }

  const engine = engineName()

  // 1) grava a mensagem do cliente + evento
  await recordChatMessage({ companyId: ctx.companyId, sessionId: ctx.sessionId, role: "customer", text, engine })
  await recordEvent({
    companyId: ctx.companyId, customerId: ctx.customerId, debtId: ctx.debtId,
    sessionId: ctx.sessionId, type: "chat.turn.customer", actor: "customer",
  })
  await supabase
    .from("negotiation_sessions")
    .update({ last_activity_at: new Date().toISOString() })
    .eq("id", ctx.sessionId)

  // 2) carrega a sessão completa (runChatbotTurn precisa do row inteiro)
  const { data: session } = await supabase
    .from("negotiation_sessions")
    .select("*")
    .eq("id", ctx.sessionId)
    .maybeSingle()
  if (!session) throw new Error("sessão não encontrada")

  // 3) roda o engine com timeout de N8N_TIMEOUT_MS (modo assíncrono no estouro).
  const t0 = Date.now()
  let result: Awaited<ReturnType<typeof runChatbotTurn>>
  try {
    result = await withTimeout(
      runChatbotTurn(session as NegotiationSession, text, "webchat"),
      engine === "n8n" ? N8N_TIMEOUT_MS : 60_000,
    )
  } catch (err) {
    if (err instanceof TimeoutError) {
      // N3.3: timeout → modo assíncrono. O fluxo n8n devolve depois via
      // session.message async (callback assinado). Ao cliente, mensagem neutra.
      await recordChatMessage({
        companyId: ctx.companyId, sessionId: ctx.sessionId, role: "system",
        text: "engine timeout — modo assíncrono", engine, latencyMs: Date.now() - t0,
      })
      const reply = "Estou verificando com o credor e já te respondo por aqui."
      return { reply, offers: await listOffers(ctx), action: null, processing: true }
    }
    throw err
  }
  const latency = Date.now() - t0

  // 4) grava a resposta do assistente + evento (com rastreio de execução)
  const offers = await listOffers(ctx)
  await recordChatMessage({
    companyId: ctx.companyId, sessionId: ctx.sessionId, role: "assistant",
    text: result.reply, offersSnapshot: offers.length ? offers : null,
    n8nExecutionId: result.n8n_execution_id ?? null,
    engine: result.engine ?? engine, latencyMs: latency,
  })
  await recordEvent({
    companyId: ctx.companyId, customerId: ctx.customerId, debtId: ctx.debtId,
    sessionId: ctx.sessionId, type: "chat.turn.assistant", actor: engine === "n8n" ? "n8n" : "ai",
    payload: { latency_ms: latency, action: result.action },
  })

  return { reply: result.reply, offers, action: result.action }
}

class TimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(`timeout ${ms}ms`)), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}
