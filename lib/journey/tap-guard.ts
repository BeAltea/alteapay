// QA round 4 (R-11/R-21, S2 client) — TOQUE MÚLTIPLO e CONTROLE QUE SE DESLOCA
// sob o dedo. Lógica PURA; o components/journey/chat.tsx só consome.
//
// QAB1-R2-01 (ALTO): triplo toque em "Já paguei este valor" → o 1º registrava o
// payment_claim, a afordância sumia/o log crescia e o 2º toque caía no botão
// "Não reconheço" (contestação gravada sem o devedor querer). Regras:
//  - QUALQUER toque num controle de ação deixa TODO o bloco de ações inerte por
//    TAP_INERT_MS (≥ 700 ms) — o 2º/3º toque de um toque múltiplo nunca acerta
//    outro controle;
//  - um bloco de ações que NASCE (prompt novo) ou que SE DESLOCA (> 4 px na
//    página) fica inerte por WAIT_EXITS_ARM_MS (2500 ms, a mesma janela das
//    saídas de espera do QAA1-01; ≥ a janela do servidor de 2000 ms);
//  - enquanto uma ação está em voo, o bloco fica inerte (o controle continua no
//    lugar, desabilitado — sem reflow sob o dedo).
// Inerte = aria-disabled + pointer-events:none + o handler ignora — o controle
// não muda de tamanho nem de lugar.
// Sem PII.

import { WAIT_EXITS_ARM_MS } from "./wait-machine"

/** Janela mínima de inércia do bloco de ações depois de QUALQUER toque. */
export const TAP_INERT_MS = 900

/** Janela de arming de um bloco de ações que nasceu ou se deslocou. */
export const ACTIONS_ARM_MS = WAIT_EXITS_ARM_MS

/** Deslocamento (px, coordenada da página) a partir do qual o bloco re-arma. */
export const LAYOUT_SHIFT_PX = 4

/** Novo instante-limite da inércia: nunca encurta uma inércia já em curso. */
export function extendInertUntil(currentUntil: number, nowMs: number, windowMs: number): number {
  return Math.max(currentUntil, nowMs + windowMs)
}

/** true enquanto o bloco de ações deve ignorar toques. */
export function isInert(inertUntil: number, nowMs: number, inFlight = false): boolean {
  return inFlight || nowMs < inertUntil
}

export interface ActionBlockPosition {
  /** id do prompt ativo (null = sem menu). */
  promptId: string | null
  /** topo do bloco em coordenadas da PÁGINA (rect.top + scrollY) — rolar a
   *  página não conta como deslocamento. null = bloco ausente. */
  top: number | null
}

/**
 * Decide se o bloco de ações precisa (re)armar: prompt novo/que aparece, ou o
 * bloco se deslocou mais de LAYOUT_SHIFT_PX na página. O bloco que some não arma
 * (nada a tocar).
 */
export function shouldRearm(prev: ActionBlockPosition | null, next: ActionBlockPosition): boolean {
  if (next.top === null) return false
  if (!prev || prev.top === null) return true
  if (prev.promptId !== next.promptId) return true
  return Math.abs(next.top - prev.top) > LAYOUT_SHIFT_PX
}

// ---------------------------------------------------------------------------
// Correção B8 (A-2) — a inércia de nascimento/deslocamento conta a partir do
// ÚLTIMO TOQUE (nunca do instante em que o menu nasceu ou se moveu): um menu que
// aparece ≥ ACTIONS_ARM_MS depois do último toque já nasce clicável; o 2º/3º
// toque de um toque múltiplo (até ~500 ms depois do 1º) continua protegido.
// Correção B8 (A-1/M-1) — nenhum toque é mudo: o toque ignorado (bloco inerte no
// client, ou `ignored:'double_tap'` do servidor) ganha um aviso curto.

/**
 * Instante-limite da inércia de um bloco que nasceu/se deslocou: último toque +
 * ACTIONS_ARM_MS, ou null quando esse limite já passou (ou não houve toque).
 */
export function rearmUntilFromLastTap(lastTapAtMs: number | null | undefined, nowMs: number): number | null {
  if (typeof lastTapAtMs !== "number" || !Number.isFinite(lastTapAtMs)) return null
  const until = lastTapAtMs + ACTIONS_ARM_MS
  return until > nowMs ? until : null
}

/** Aviso de um toque que caiu na janela de inércia do bloco (aria-live, neutro). */
export const INERT_TAP_NOTICE = "Um instante. Toque de novo para escolher."

/** Aviso de um clique que o servidor ignorou como toque múltiplo (menu segue vivo). */
export const DOUBLE_TAP_NOTICE = "Toque registrado uma vez. Escolha de novo, se quiser."

/** Classe do bloco inerte: sinal visual SEM reflow (mesma caixa, mesmo tamanho). */
export const INERT_CLASS = "opacity-60 cursor-wait"
