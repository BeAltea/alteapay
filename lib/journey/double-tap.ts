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
  return (await lastCustomerClick(sessionId, promptId)).at
}

/** Último clique válido da sessão/prompt: instante + botão. Nunca lança. */
export async function lastCustomerClick(
  sessionId: string,
  promptId?: string | null,
): Promise<{ at: string | null; buttonId: number | null }> {
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
    const row = data as { created_at?: string | null; button_id?: number | null } | null
    return {
      at: typeof row?.created_at === "string" ? row.created_at : null,
      buttonId: typeof row?.button_id === "number" ? row.button_id : null,
    }
  } catch {
    return { at: null, buttonId: null }
  }
}

/**
 * QA round 2 (B6 M-1) — o guard do `reopen {handoff}` (sem prompt) só vale quando
 * o último clique foi o próprio NEGOCIAR (o único vetor observado: o bloco de
 * espera nascia sob o ponteiro). Um handoff < 2 s depois de outro clique (ex.:
 * Pagar → erro rápido → "Falar com atendimento") é legítimo e transfere.
 * Botões: 1 = Negociar (menu de 3 opções), 3 = Negociar (legado debt_consult).
 */
export const NEGOTIATE_BUTTON_IDS: ReadonlySet<number> = new Set([1, 3])

export function reopenHandoffGuardApplies(lastButtonId: number | null | undefined): boolean {
  return typeof lastButtonId === "number" && NEGOTIATE_BUTTON_IDS.has(lastButtonId)
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
  const last = await lastCustomerClick(input.sessionId, input.promptId)
  const lastClickAt = last.at
  // M-1: no reopen (sem prompt), só um clique em NEGOCIAR arma o guard.
  const applies = input.source === "button" || reopenHandoffGuardApplies(last.buttonId)
  const doubleTap = applies && isWithinWindow(lastClickAt, nowMs, DOUBLE_TAP_WINDOW_MS)
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

// ---------------------------------------------------------------------------
// QA round 4 (R-11/R-21, S2 servidor) — TOQUE MÚLTIPLO com EFEITO DE NEGÓCIO.
//
// QAB1-R2-01 (ALTO): triplo toque em "Já paguei este valor" → o 2º toque caiu
// em "Não reconheço" e gravou uma contestação que o devedor não declarou. O
// guard do handoff [99] (acima) é generalizado para os controles cujo efeito é
// de negócio: Não reconheço [0], Pagar [4] e o "Já paguei" [96] (payment_claim,
// POST /api/chat/reopen — eco persistido com button_id 96). Um clique num
// desses que chega < DOUBLE_TAP_WINDOW_MS depois de um clique VÁLIDO de OUTRO
// controle da sessão é o 2º toque de um toque múltiplo: ignorado com 200
// { ok:true, ignored:'double_tap', prompt } — nenhum efeito (ack negativo,
// disputa, handoff, cobrança, caso), decisão auditada em journey_events
// (`chat.click_ignored`, só append). O MESMO controle repetido segue pelos
// caminhos próprios (isDuplicateClick no /button; claim reusado no /reopen).
// Um clique isolado ≥ 2 s depois de outro grava normalmente (fluxo intocado).

/** "Já paguei este valor" — id reservado do eco do payment_claim (fora do
 *  alcance das ofertas 2..N e dos ids de menu). */
export const BTN_PAYMENT_CLAIM = 96

/** Controles com efeito de negócio protegidos pelo guard de toque múltiplo. */
export const EFFECT_BUTTON_IDS: ReadonlySet<number> = new Set([0, 4, BTN_PAYMENT_CLAIM])

/**
 * Regra PURA: o clique em `buttonId` é o 2º toque de um toque múltiplo iniciado
 * noutro controle? Só para controles de efeito; o último clique precisa ser de
 * OUTRO botão e estar dentro da janela.
 */
export function isEffectDoubleTap(
  last: { at: string | null; buttonId: number | null },
  buttonId: number,
  nowMs: number = Date.now(),
  windowMs: number = DOUBLE_TAP_WINDOW_MS,
): boolean {
  if (!EFFECT_BUTTON_IDS.has(buttonId)) return false
  if (typeof last.buttonId !== "number" || last.buttonId === buttonId) return false
  return isWithinWindow(last.at, nowMs, windowMs)
}

/**
 * Guard de toque múltiplo para os controles de efeito (lê o último clique da
 * SESSÃO — qualquer prompt, inclusive o eco [96] do payment_claim). Registra a
 * decisão na auditoria quando ignora (best-effort). `recheckAfterMs` (> 0): se o
 * 1º exame não achou toque múltiplo, relê depois dessa pausa — cobre a corrida
 * em que o eco do 1º toque ainda está sendo gravado por outra requisição
 * concorrente (usado só no Não reconheço, efeito irreversível e raro).
 */
export async function checkEffectDoubleTap(input: {
  sessionId: string
  companyId: string
  customerId?: string | null
  debtId?: string | null
  buttonId: number
  promptId?: string | null
  source: "button" | "reopen"
  recheckAfterMs?: number
  nowMs?: number
}): Promise<DoubleTapCheck> {
  if (!EFFECT_BUTTON_IDS.has(input.buttonId)) return { doubleTap: false, lastClickAt: null }
  const startMs = input.nowMs ?? Date.now()
  let last = await lastCustomerClick(input.sessionId)
  let doubleTap = isEffectDoubleTap(last, input.buttonId, startMs)
  if (!doubleTap && input.recheckAfterMs && input.recheckAfterMs > 0) {
    await new Promise((r) => setTimeout(r, input.recheckAfterMs))
    last = await lastCustomerClick(input.sessionId)
    // a janela é medida contra o instante em que ESTE clique chegou.
    doubleTap = isEffectDoubleTap(last, input.buttonId, startMs)
  }
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
        button_id: input.buttonId,
        previous_button_id: last.buttonId,
        ...(input.promptId ? { prompt_id: input.promptId } : {}),
        last_click_at: last.at,
        window_ms: DOUBLE_TAP_WINDOW_MS,
      },
    }).catch(() => ({ ok: false, duplicate: false }))
  }
  return { doubleTap, lastClickAt: last.at }
}
