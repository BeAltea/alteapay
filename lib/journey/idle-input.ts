// QA round 4 (R-15/R-23, S6) — o relógio de inatividade conta só INPUT REAL do
// devedor. Lógica PURA; o components/journey/chat.tsx só consome.
//
// QAA1-R4-02: no desktop o modal "Você ainda está aí?" nunca abria — o Chrome
// emite `mousemove` SEM deslocamento quando o conteúdo muda sob o ponteiro parado
// (e o conteúdo mudava a cada poll). Regras:
//  - aceitos: keydown, pointerdown/mousedown, touchstart, wheel, click — só com
//    `isTrusted` (eventos sintéticos de script nunca contam);
//  - movimento (pointermove/mousemove) só com `isTrusted` e deslocamento ≥
//    MIN_MOVE_PX em relação à última posição REAL (a posição só avança num
//    movimento aceito);
//  - `scroll` NÃO conta (dispara também por auto-scroll do log a cada mensagem);
//    a rolagem do usuário chega por wheel/touchstart/keydown.
// Sem PII.

export const MIN_MOVE_PX = 2

/** Eventos que o chat escuta para o relógio de inatividade. */
export const IDLE_ACTIVITY_EVENTS = [
  "pointermove",
  "mousemove",
  "pointerdown",
  "mousedown",
  "keydown",
  "touchstart",
  "wheel",
  "click",
] as const

export interface ActivityEventLike {
  type: string
  isTrusted?: boolean
  clientX?: number
  clientY?: number
}

export interface PointerPos {
  x: number
  y: number
}

/**
 * Decide se o evento é atividade real. Devolve também a posição a guardar
 * (só muda num movimento aceito).
 */
export function isRealActivity(
  ev: ActivityEventLike,
  last: PointerPos | null,
): { real: boolean; pos: PointerPos | null } {
  if (ev.isTrusted !== true) return { real: false, pos: last }
  if (ev.type === "pointermove" || ev.type === "mousemove") {
    if (typeof ev.clientX !== "number" || typeof ev.clientY !== "number") return { real: false, pos: last }
    const pos = { x: ev.clientX, y: ev.clientY }
    if (!last) return { real: false, pos } // 1ª leitura: só ancora (sem deslocamento conhecido)
    const moved = Math.abs(pos.x - last.x) + Math.abs(pos.y - last.y)
    return moved >= MIN_MOVE_PX ? { real: true, pos } : { real: false, pos: last }
  }
  if (ev.type === "scroll") return { real: false, pos: last }
  return { real: true, pos: last }
}
