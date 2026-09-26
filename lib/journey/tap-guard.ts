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
