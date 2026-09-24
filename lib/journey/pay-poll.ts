// R3 — resolução do PAGAR em `processing`. Quando a cobrança volta em
// `processing` (worker gerando o link, CHARGE_MODE=queue), a UI NÃO pode ficar
// muda: faz polling de GET /api/chat/payment até o link aparecer. Este módulo é a
// lógica PURA (mapear a resposta do endpoint) para ser testada em node; o wire-up
// (timer/estado) fica no chat.tsx.
//
// NUNCA declara pago (M15): 'ready' só significa que o link existe — a quitação é
// do webhook. Sem PII.

/** Shape mínimo da resposta de GET /api/chat/payment que nos interessa. */
export interface ChatPaymentResponse {
  ok?: boolean
  status?: string // "generating" | "ready"
  payment?: {
    invoiceUrl?: string | null
    boletoUrl?: string | null
    pixQrCodeUrl?: string | null
    dueDate?: string | null
    total?: number | null
  } | null
}

/** Resultado do poll traduzido para a UI. */
export type PayPollResult =
  | { status: "ready"; link: string; valor: number | null; vencimentoLink: string | null }
  | { status: "generating" }

/** Melhor URL de pagamento: invoice › boleto › PIX copia-e-cola. */
function bestLink(p: NonNullable<ChatPaymentResponse["payment"]>): string | null {
  return p.invoiceUrl ?? p.boletoUrl ?? p.pixQrCodeUrl ?? null
}

/**
 * Interpreta a resposta do /api/chat/payment. Só resolve para 'ready' quando há
 * status 'ready' E um link real; qualquer outra coisa (generating / sem link /
 * corpo malformado) continua 'generating' (a UI segue no poll ou oferece saída).
 */
export function interpretPaymentPoll(data: ChatPaymentResponse | null | undefined): PayPollResult {
  if (!data || data.ok === false) return { status: "generating" }
  const p = data.payment
  if (data.status === "ready" && p) {
    const link = bestLink(p)
    if (link) {
      return {
        status: "ready",
        link,
        valor: typeof p.total === "number" ? p.total : null,
        vencimentoLink: typeof p.dueDate === "string" ? p.dueDate : null,
      }
    }
  }
  return { status: "generating" }
}

/** Teto de tentativas de poll antes de oferecer a saída acionável (nunca espera
 *  muda infinita). Com poll a cada ~2,5s, ~24 tentativas ≈ 60s. */
export const PAY_POLL_MAX_ATTEMPTS = 24

/** Passado o teto, a UI mostra a saída "Falar com atendimento" (sem declarar
 *  erro nem pago) — só decide QUANDO oferecer a saída, não cancela o poll. */
export function shouldOfferProcessingExit(attempts: number): boolean {
  return attempts >= PAY_POLL_MAX_ATTEMPTS
}
