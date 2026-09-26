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
  status?: string // "generating" | "ready" | "failed" (QA rodada 5)
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
  // QA rodada 5 (Q2-01): o servidor reconciliou o acordo sem cobrança e confirmou
  // que NENHUMA cobrança existe no ASAAS (acordo cancelado) — o devedor pode
  // tentar de novo. Só vem do servidor; nunca inferido pelo client.
  | { status: "failed" }

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
  if (data.status === "failed") return { status: "failed" }
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

// ---------------------------------------------------------------------------
// QA round 2 (QAB1-H1, ALTO) — RELOAD DURANTE O PAGAR. O servidor agora persiste
// wait_state='gerando_cobranca' na sessão ANTES de chamar o payService (Pagar e
// aceite de parcela) e, ao final, limpa (link entregue → o prompt pós-link já
// existe) ou grava 'erro_cobranca'. O client, ao reidratar um desses estados
// pelo GET /api/chat/messages, precisa mostrar um caminho: a copy progressiva +
// poll de GET /api/chat/payment até o link/prompt aparecer, ou a saída humana no
// teto (~60 s). Regra PURA abaixo; chat.tsx só consome.
// ---------------------------------------------------------------------------

/** Estados de PAGAR persistíveis no servidor (a espera de negociação é outra). */
export const PAY_WAIT_STATES: ReadonlySet<string> = new Set(["gerando_cobranca", "erro_cobranca", "link_entregue"])

/** true quando o wait_state do servidor pertence ao PAGAR (reconciliado por
 *  decidePayResume, não pela reidratação da espera de negociação). */
export function isPayWaitState(state: string | null | undefined): boolean {
  return typeof state === "string" && PAY_WAIT_STATES.has(state)
}

/** Copy da espera RETOMADA (reload durante o Pagar): a mesma frase progressiva do
 *  clique longo (A1), porque o devedor já esperava antes de recarregar. */
export const PAY_RESUME_GENERATING_TEXT = "Ainda estou gerando o seu link de pagamento."

/** Copy do processing nascido nesta aba (worker gerando; A1/R3). */
export const PAY_PROCESSING_TEXT = "Estou gerando seu link de pagamento. Assim que estiver pronto, ele aparece aqui."

/** Copy do teto do poll (~60 s) antes das saídas humanas. */
export const PAY_PROCESSING_SLOW_TEXT =
  "Está demorando um pouco mais que o normal para gerar o link. Você pode continuar aguardando, voltar às opções ou falar com o nosso atendimento."

export type PayResumeDecision = "resume_generating" | "show_error" | "settle_idle" | "none"

export interface PayResumeInput {
  /** wait_state devolvido pelo GET /api/chat/messages (null = sem espera). */
  serverWaitState: string | null | undefined
  /** estado local da máquina de espera nesta aba. */
  localWaitState: string
  /** true enquanto o POST do Pagar desta aba está em voo (o clique governa). */
  payInFlight: boolean
  /** true quando o estado local de PAGAR nasceu de reidratação/recuperação (não
   *  de um clique com resposta nesta aba) — aí o servidor é a autoridade. */
  resumed: boolean
  /** há um prompt ativo na tela depois de aplicar este poll. */
  hasActivePrompt: boolean
  /** este poll trouxe uma bolha de link VIVO (o resultado já está na tela). */
  linkDelivered: boolean
}

/**
 * Decide como o client reconcilia o estado de PAGAR do servidor a cada poll:
 *  - POST em voo nesta aba, ou link já entregue → 'none' (nada a repor);
 *  - servidor 'gerando_cobranca' e o client fora dessa espera → 'resume_generating'
 *    (copy progressiva + poll do link + saídas no teto); já nessa espera → 'none';
 *  - servidor 'erro_cobranca' → 'show_error' (painel de erro com saídas), salvo
 *    quando o client já mostra um erro/espera de um clique próprio;
 *  - servidor sem espera de pagamento e o client numa espera RETOMADA com um
 *    prompt ativo na tela → 'settle_idle' (o servidor já concluiu: outcome +
 *    menu vieram no poll; o menu conduz). Sem prompt ainda → espera (o teto dá
 *    a saída). Pura.
 */
export function decidePayResume(i: PayResumeInput): PayResumeDecision {
  if (i.payInFlight) return "none"
  if (i.localWaitState === "link_entregue" || i.linkDelivered) return "none"
  const localPay = i.localWaitState === "gerando_cobranca" || i.localWaitState === "erro_cobranca"
  if (i.serverWaitState === "gerando_cobranca") {
    if (i.localWaitState === "gerando_cobranca") return "none"
    if (i.localWaitState === "erro_cobranca" && !i.resumed) return "none"
    return "resume_generating"
  }
  if (i.serverWaitState === "erro_cobranca") {
    if (i.localWaitState === "erro_cobranca") return "none"
    if (localPay && !i.resumed) return "none"
    return "show_error"
  }
  if (localPay && i.resumed && i.hasActivePrompt) return "settle_idle"
  return "none"
}
