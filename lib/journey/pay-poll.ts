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

// ---------------------------------------------------------------------------
// A4 (S14/S15, N-D5-8) — copy do LINK DE PAGAMENTO, fonte ÚNICA para a bolha
// persistida (lib/journey/pay.ts) e para o painel-fallback do client
// (components/journey/chat.tsx). Este módulo é puro e client-safe (sem supabase),
// por isso a copy mora aqui e não em pay.ts (server). Apêndice B:
//   "Aqui está seu link para pagar {valor}, válido até {vencimento_link}."
//   "Você já tem uma cobrança ativa de {valor}. Use o link abaixo; não é preciso gerar outro."
// NUNCA declara pago (M15). Sem PII (só valor/vencimento/URL).
// ---------------------------------------------------------------------------

/** Reais no padrão pt-BR (R$ 250,00) — mesma formatação da UI/buildAckContext. */
function formatBRL(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return ""
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v)
}

/** Vencimento do link ASAAS (YYYY-MM-DD) → dd/mm/aaaa para a copy. Ausente → "". */
export function formatDueDatePt(iso: string | null | undefined): string {
  if (!iso) return ""
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  return m ? `${m[3]}/${m[2]}/${m[1]}` : ""
}

/**
 * Copy do link de pagamento (pura). `link` presente → a URL entra numa linha
 * própria (histórico/painel); `link:null` → só o texto (o botão "Abrir link de
 * pagamento" já carrega a URL — N-D1-8).
 */
export function payLinkMessageText(input: {
  link: string | null
  valor: number | null
  vencimentoLink: string | null
  alreadyCharged: boolean
}): string {
  const valorTxt = input.valor != null ? formatBRL(input.valor) : ""
  const venc = formatDueDatePt(input.vencimentoLink)
  const linkLine = input.link ? `\n${input.link}` : ""
  if (input.alreadyCharged) {
    // S15: sem travessão; sem "se já pagou desconsidere" (é o botão "Já paguei").
    const head = valorTxt
      ? `Você já tem uma cobrança ativa de ${valorTxt}.`
      : "Você já tem uma cobrança ativa."
    return `${head} Use o link abaixo; não é preciso gerar outro.${linkLine}`
  }
  // S14: uma frase; valor + validade do link. Sem "Pronto!".
  const head = valorTxt ? `Aqui está seu link para pagar ${valorTxt}` : "Aqui está seu link de pagamento"
  const vencPart = venc ? `, válido até ${venc}` : ""
  return `${head}${vencPart}.${linkLine}`
}
