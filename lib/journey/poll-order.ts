// QA round 2 (QAA2-06 / QAB1-H4) — ORDEM DOS POLLS no client, lógica PURA.
//
// Dois GET /api/chat/messages podem estar em voo ao mesmo tempo (o poll explícito
// pós-clique convive com o do intervalo; em rede lenta o 1º responde DEPOIS do
// 2º). Aplicar a resposta mais antiga por cima da mais nova regredia
// `active_prompt` (o menu "piscava" para um prompt já consumido — o clique
// seguinte caía em 409) e podia repor `wait_state`/`dead_payment_links` velhos.
// Regra: uma resposta só é aplicada se for mais nova que a última aplicada —
// pelo `server_time` do servidor (relógio único) e, faltando/empatando, pela
// sequência local de disparo. Pular uma resposta antiga nunca perde mensagem: as
// linhas vêm em ordem ascendente e `since` só avança com a resposta aplicada,
// então tudo o que a antiga traria já está (ou virá) na mais nova.
//
// Sem PII.

export interface PollStamp {
  /** sequência local de disparo (1, 2, 3…): maior = disparado depois. */
  seq: number
  /** `server_time` da resposta (ISO) — relógio do servidor; null se ausente. */
  serverTime: string | null
}

function parse(iso: string | null): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

/**
 * true quando `incoming` é mais ANTIGA que a última resposta aplicada e deve ser
 * ignorada por inteiro (mensagens, prompt, espera, links mortos). Sem última
 * aplicada → aplica. Com `server_time` nos dois lados, decide o relógio do
 * servidor (estritamente menor = antiga); empate ou ausência → a sequência local.
 */
export function isStalePoll(incoming: PollStamp, lastApplied: PollStamp | null | undefined): boolean {
  if (!lastApplied) return false
  const a = parse(incoming.serverTime)
  const b = parse(lastApplied.serverTime)
  if (a !== null && b !== null) {
    if (a < b) return true
    if (a > b) return false
  }
  return incoming.seq < lastApplied.seq
}

// ---------------------------------------------------------------------------
// QA round 4 (R-13/R-22, S3) — o CORPO DO POST é estado aplicado. Ao aplicar o
// prompt/outcome devolvido por um POST (clique, Já paguei, Voltar), o client
// ergue uma CERCA na sequência de polls: todo GET disparado ANTES (seq ≤ cerca)
// é mais antigo que o estado do POST e não mexe em prompt, espera nem link — as
// mensagens dele chegam no GET seguinte (o `since` só avança com a resposta
// aplicada, nada se perde). E um GET com `active_prompt:null` nunca limpa o
// prompt que um POST aplicou há pouco (ou enquanto o servidor sinaliza
// `prompt_pending`: a troca de prompt ainda está em curso).

/** Janela em que um GET com `active_prompt:null` não limpa um prompt aplicado por POST. */
export const POST_PROMPT_HOLD_MS = 10_000

/** true quando o GET foi disparado antes do último estado aplicado por POST. */
export function isFencedPoll(pollSeq: number, fenceSeq: number | null | undefined): boolean {
  return typeof fenceSeq === "number" && pollSeq <= fenceSeq
}

/**
 * true quando um GET sem prompt ativo (`active_prompt:null`) deve MANTER o
 * prompt que está na tela: o servidor está no meio da troca (`prompt_pending`)
 * ou um POST aplicou um prompt há menos de POST_PROMPT_HOLD_MS.
 */
export function shouldHoldPromptOnNull(input: {
  promptPending: boolean
  lastPostPromptAtMs: number | null
  nowMs: number
  hasPromptOnScreen: boolean
}): boolean {
  if (!input.hasPromptOnScreen) return false
  if (input.promptPending) return true
  return typeof input.lastPostPromptAtMs === "number" && input.nowMs - input.lastPostPromptAtMs < POST_PROMPT_HOLD_MS
}

/** Janela em que um prompt recém-respondido sem sucessor conta como "troca em curso". */
export const PROMPT_PENDING_WINDOW_MS = 8000

/**
 * QA round 4 (R-22) — PURA: a sessão está no meio de uma troca de prompt? true
 * quando o prompt mais recente está `answered` há menos de
 * PROMPT_PENDING_WINDOW_MS (o handler ainda vai criar o sucessor).
 */
export function isPromptPending(
  rows: Array<{ status?: string | null; created_at?: string | null; answered_at?: string | null }>,
  nowMs: number,
): boolean {
  if (rows.length === 0) return false
  const last = rows[rows.length - 1]
  if (last.status !== "answered") return false
  const at = Date.parse(last.answered_at ?? last.created_at ?? "")
  if (!Number.isFinite(at)) return false
  return nowMs - at < PROMPT_PENDING_WINDOW_MS
}
