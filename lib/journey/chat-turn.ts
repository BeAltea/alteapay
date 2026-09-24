// Turno canônico do chat da jornada (N3): grava chat_messages, mede latência,
// chama o engine (n8n|stub|disabled), grava a resposta com n8n_execution_id, e
// devolve reply + ofertas atuais. A auth chega ao n8n no 1º turno via o
// contexto (context.ts) — o engine n8n embute o payload chat.turn.
//
// Reutiliza runChatbotTurn (que também grava conversation_messages para a
// auditoria LGPD existente e aplica os efeitos do funil). chat_messages é a
// visão turno-a-turno da onda, com rastreio de engine/execução.

import { createServiceClient } from "@/lib/supabase/service"
import { engineName, fallbackMode } from "@/lib/negotiation/engine"
import { runChatbotTurn } from "@/lib/negotiation/turn"
import type { NegotiationSession } from "@/lib/negotiation/types"
import { listOffers, type SessionCtx } from "./actions"
import { recordEvent } from "./events"

// Safety-net externo: o engine n8n já aplica seu próprio N8N_TIMEOUT_MS (default
// 20000) por turno e devolve um resultado NEUTRO (n8n_mode='async'|'fallback')
// em vez de lançar. Este timeout externo cobre só o caso de o engine travar por
// completo (ex.: engine assistido); um pouco acima do do engine para não competir.
const OUTER_TIMEOUT_MS = Number(process.env.N8N_TIMEOUT_MS || "20000") + 5000

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
 * §C3: texto do indicador "trabalhando" do handoff assíncrono ao n8n. Exportado
 * para que o chat-send possa reconhecê-lo (a resposta real do n8n renderiza
 * DEPOIS dele — ordenação natural: "preparando…" → resposta).
 */
export const WORKING_PLACEHOLDER_TEXT = "Estou preparando sua negociação. Só um instante…"

/**
 * §C3: grava o placeholder "trabalhando" logo após o Negociar, para o poller
 * (GET /api/chat/messages) exibir progresso IMEDIATAMENTE — sem mudança no
 * cliente — enquanto o negotiation.start viaja ao n8n e a resposta real ainda
 * não chegou (via chat.send, papel B).
 *
 * Idempotente por CONTEÚDO (mesmo texto, janela 15min) — mesmo padrão do
 * chat-send.ts: re-entradas / re-cliques NUNCA empilham mais de um placeholder,
 * compondo com a dedup do slice de acknowledgement sem conflito. Nunca lança.
 *
 * O slice de acknowledgement/botão chama isto logo após startN8nNegotiation(...).
 */
export async function recordWorkingPlaceholder(input: {
  companyId: string
  sessionId: string
}): Promise<void> {
  const text = WORKING_PLACEHOLDER_TEXT
  try {
    const supabase = createServiceClient()
    const since = new Date(Date.now() - 15 * 60_000).toISOString()
    const { data: dup } = await supabase
      .from("chat_messages")
      .select("id")
      .eq("session_id", input.sessionId)
      .eq("role", "assistant")
      .eq("text", text)
      .gte("created_at", since)
      .limit(1)
      .maybeSingle()
    if (dup?.id) return // dedup — mantém só um
    await supabase.from("chat_messages").insert({
      company_id: input.companyId,
      session_id: input.sessionId,
      role: "assistant",
      text,
      engine: "platform",
    })
  } catch (err) {
    console.warn("[chat-turn] recordWorkingPlaceholder falhou (não-fatal):", (err as Error).message)
  }
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

  // D1/Frente A: flush do outbox ANTES do turno — entrega o session.start
  // pendente (ordem preservada) que o POST no login não conseguiu enviar. Gated
  // ('skipped_engine_disabled') não é elegível. Best-effort e não-fatal.
  await flushOutboxSafe(ctx.sessionId)

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

  // 3) roda o engine. O engine n8n NÃO lança: aplica seu próprio timeout e
  //    devolve n8n_mode='async' (HTTP 202) ou 'fallback' (timeout/5xx/inválido)
  //    com um reply neutro. O timeout externo cobre só um travamento total.
  const t0 = Date.now()
  let result: Awaited<ReturnType<typeof runChatbotTurn>>
  try {
    result = await withTimeout(
      runChatbotTurn(session as NegotiationSession, text, "webchat"),
      OUTER_TIMEOUT_MS,
    )
  } catch (err) {
    if (err instanceof TimeoutError) {
      // Safety-net: engine travou por completo → modo assíncrono neutro.
      await recordChatMessage({
        companyId: ctx.companyId, sessionId: ctx.sessionId, role: "system",
        text: "engine timeout — modo assíncrono", engine, latencyMs: Date.now() - t0,
      })
      // §5: degrada a sessão para o assistido nos próximos turnos (se != off).
      await degradeToAssisted(ctx.sessionId)
      const reply = "Só um instante, estou verificando…"
      return { reply, offers: await listOffers(ctx), action: null, processing: true }
    }
    throw err
  }
  // §7: latência round-trip do POST papel A vem do próprio engine (result.latency_ms);
  // se ausente (assistido/stub), mede aqui.
  const latency = result.latency_ms ?? Date.now() - t0
  const engineUsed = result.engine ?? engine

  // §4: 202 async → turno pendente. A resposta real chega depois via chat.send
  //     (papel B) e o cliente a busca por polling. Grava a resposta neutra e
  //     sinaliza processing (o front mantém o polling por ~N8N_ASYNC_WAIT_MS).
  if (result.n8n_mode === "async") {
    await recordChatMessage({
      companyId: ctx.companyId, sessionId: ctx.sessionId, role: "assistant",
      text: result.reply, n8nExecutionId: result.n8n_execution_id ?? null,
      engine: engineUsed, latencyMs: latency,
    })
    await recordEvent({
      companyId: ctx.companyId, customerId: ctx.customerId, debtId: ctx.debtId,
      sessionId: ctx.sessionId, type: "chat.turn.assistant", actor: "n8n",
      payload: { latency_ms: latency, mode: "async" },
    })
    return { reply: result.reply, offers: await listOffers(ctx), action: null, processing: true }
  }

  // §5: fallback técnico → resposta neutra + degradação da sessão para o
  //     assistido no próximo turno (a menos que NEGOTIATION_ENGINE_FALLBACK=off).
  //     Registra o erro técnico (sem PII/URL/segredo), 1x por sessão.
  if (result.n8n_mode === "fallback") {
    await recordChatMessage({
      companyId: ctx.companyId, sessionId: ctx.sessionId, role: "assistant",
      text: result.reply, engine: engineUsed, latencyMs: latency,
    })
    await recordEvent({
      companyId: ctx.companyId, customerId: ctx.customerId, debtId: ctx.debtId,
      sessionId: ctx.sessionId, type: "chat.engine_error", actor: "system",
      eventId: `chat.engine_error|${ctx.sessionId}`,
    })
    await degradeToAssisted(ctx.sessionId)
    return { reply: result.reply, offers: await listOffers(ctx), action: null, processing: true }
  }

  // 4) resposta síncrona normal: grava assistente + evento (rastreio de execução).
  const offers = await listOffers(ctx)
  await recordChatMessage({
    companyId: ctx.companyId, sessionId: ctx.sessionId, role: "assistant",
    text: result.reply, offersSnapshot: offers.length ? offers : null,
    n8nExecutionId: result.n8n_execution_id ?? null,
    engine: engineUsed, latencyMs: latency,
  })
  await recordEvent({
    companyId: ctx.companyId, customerId: ctx.customerId, debtId: ctx.debtId,
    sessionId: ctx.sessionId, type: "chat.turn.assistant", actor: engineUsed === "n8n" ? "n8n" : "ai",
    payload: { latency_ms: latency, action: result.action },
  })

  return { reply: result.reply, offers, action: result.action }
}

/**
 * §5: marca a sessão para cair no chat assistido a partir do próximo turno
 * (persiste negotiation_sessions.engine='disabled', lido por
 * resolveEngineForSession). No-op quando NEGOTIATION_ENGINE_FALLBACK=off.
 * Best-effort e não-fatal: nunca derruba o turno.
 */
async function degradeToAssisted(sessionId: string): Promise<void> {
  if (fallbackMode() === "off") return
  try {
    const supabase = createServiceClient()
    await supabase.from("negotiation_sessions").update({ engine: "disabled" }).eq("id", sessionId)
  } catch (err) {
    console.warn("[chat-turn] degradeToAssisted falhou (não-fatal):", (err as Error).message)
  }
}

/**
 * D1/Frente A: flush do outbox da sessão no próximo turno. Entrega os eventos
 * 'pending' na ORDEM de criação (session.start antes do 1º chat.turn). Best-effort
 * e não-fatal: nunca derruba o turno. Gated ('skipped_engine_disabled') não é
 * elegível (o flush só pega 'pending').
 */
async function flushOutboxSafe(sessionId: string): Promise<void> {
  try {
    const { flushOutbox } = await import("@/lib/negotiation/outbox")
    await flushOutbox({ sessionId })
  } catch (err) {
    console.warn("[chat-turn] flush do outbox falhou (não-fatal):", (err as Error).message)
  }
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
