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
