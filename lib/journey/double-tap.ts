// QA round 1 (QAA1-01 / QAA1-06) — TOQUE DUPLO e CLIQUE DUPLICADO no servidor.
//
// QAA1-01 (BLOQUEANTE em produção): um toque duplo em "Negociar" fazia o 2º toque
// cair em "Falar com atendimento" (bloco de espera renderizado sob o ponteiro) →
// handoff, supressão do devedor e conversa encerrada. O client deixou de mostrar
// o bloco no clique (chat.tsx), mas o SERVIDOR também se defende: um handoff
// (botão [99] ou POST /api/chat/reopen {action:'handoff'}) recebido MENOS de
// DOUBLE_TAP_WINDOW_MS depois de um clique válido no mesmo prompt/sessão é
// tratado como toque duplo — ignorado com 200 { ok:true, ignored:'double_tap' }.
// Nunca transfere, nunca suprime, nunca encerra. A decisão fica na auditoria
// (journey_events `chat.click_ignored`, sem PII).
//
// QAA1-06: N POSTs concorrentes do MESMO botão no MESMO prompt eram re-alvejados
// em cascata (3 ecos + 3 outcomes). Um prompt já respondido com o MESMO botão há
// menos de DUPLICATE_CLICK_WINDOW_MS é o MESMO clique chegando de novo: o
// servidor responde 200 { ok:true, duplicate:true, prompt } sem novo efeito. Um
// 2º clique genuinamente tardio (2ª aba, minutos depois) continua re-alvejado
// como a A1 decidiu.
//
// Puro onde possível (janelas testáveis em node); as leituras usam o service
// client no-store. Sem PII em log/payload.

import { createServiceClient } from "@/lib/supabase/service"
import { recordEvent } from "./events"

/** Janela do toque duplo para handoff: < 2 s após um clique válido. */
export const DOUBLE_TAP_WINDOW_MS = 2000

/** Janela do clique duplicado (mesmo prompt + mesmo botão): < 3 s após a resposta. */
export const DUPLICATE_CLICK_WINDOW_MS = 3000

/**
 * true quando `at` (ISO) está a menos de `windowMs` de `nowMs`. Um `at` no
 * futuro (relógio do banco à frente do da função) conta como "agora". Inválido/
 * ausente → false (nunca ignora um clique por falta de dado).
 */
export function isWithinWindow(at: string | null | undefined, nowMs: number, windowMs: number): boolean {
  if (!at) return false
  const t = Date.parse(at)
  if (!Number.isFinite(t)) return false
  return nowMs - t < windowMs
}

/** Linha mínima do prompt para a regra de duplicidade (sem PII). */
export interface AnsweredPromptLike {
  status: string
  answered_button_id: number | null
  answered_at: string | null
}

/**
 * Clique DUPLICADO: o prompt já foi respondido com o MESMO botão há menos de
 * DUPLICATE_CLICK_WINDOW_MS. É o mesmo clique chegando de novo (POSTs
 * concorrentes, retry do client) — não uma intenção nova.
 */
export function isDuplicateClick(
  prompt: AnsweredPromptLike | null | undefined,
  buttonId: number,
  nowMs: number = Date.now(),
  windowMs: number = DUPLICATE_CLICK_WINDOW_MS,
): boolean {
  if (!prompt || prompt.status !== "answered") return false
  if (prompt.answered_button_id !== buttonId) return false
  return isWithinWindow(prompt.answered_at, nowMs, windowMs)
}

/**
 * Instante do ÚLTIMO clique válido (eco role='customer' com button_id) da
 * sessão — ou do prompt, quando `promptId` é informado. null se não houver.
 * Nunca lança (falha de leitura → null → o handoff segue).
 */
export async function lastCustomerClickAt(sessionId: string, promptId?: string | null): Promise<string | null> {
  try {
    const supabase = createServiceClient()
    let q = supabase
      .from("chat_messages")
      .select("created_at, button_id, prompt_id")
      .eq("session_id", sessionId)
      .eq("role", "customer")
      .not("button_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
    if (promptId) q = q.eq("prompt_id", promptId)
    const { data } = await q.maybeSingle()
    const at = (data as { created_at?: string | null } | null)?.created_at
    return typeof at === "string" ? at : null
  } catch {
    return null
  }
}

export interface DoubleTapCheck {
  doubleTap: boolean
  lastClickAt: string | null
}

/**
 * Handoff como TOQUE DUPLO: houve um clique válido há menos de
 * DOUBLE_TAP_WINDOW_MS no mesmo prompt (botão [99] de um prompt) ou na sessão
 * (POST /api/chat/reopen {handoff}, sem prompt). Registra a decisão na
 * auditoria (best-effort) quando ignora.
 */
export async function isDoubleTapHandoff(input: {
  sessionId: string
  companyId: string
  customerId?: string | null
  debtId?: string | null
  promptId?: string | null
  source: "button" | "reopen"
  nowMs?: number
}): Promise<DoubleTapCheck> {
  const nowMs = input.nowMs ?? Date.now()
  const lastClickAt = await lastCustomerClickAt(input.sessionId, input.promptId)
  const doubleTap = isWithinWindow(lastClickAt, nowMs, DOUBLE_TAP_WINDOW_MS)
  if (doubleTap) {
    await recordEvent({
      companyId: input.companyId,
      customerId: input.customerId ?? null,
      debtId: input.debtId ?? null,
      sessionId: input.sessionId,
      type: "chat.click_ignored",
      actor: "customer",
      payload: {
        reason: "double_tap",
        source: input.source,
        button_id: 99,
        ...(input.promptId ? { prompt_id: input.promptId } : {}),
        last_click_at: lastClickAt,
        window_ms: DOUBLE_TAP_WINDOW_MS,
      },
    }).catch(() => ({ ok: false, duplicate: false }))
  }
  return { doubleTap, lastClickAt }
}
