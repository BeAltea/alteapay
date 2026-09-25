// Trilha PAGAR AGORA (§6.4, M13–M16) — caminho canônico, 100% NOSSO (independe
// do n8n): o botão "Pagar R$ X" gera o link ASAAS na hora.
//
// payService(ctx) é o serviço server-side que a rota /api/chat/button (trilha D1)
// chama no clique PAGAR (button_id=4). NÃO reimplementa cobrança: reusa o
// caminho canônico interno que hoje só era acionável atrás do webhook HMAC do
// n8n (app/api/webhooks/n8n/route.ts → paymentCreateOrExistingLink). Aqui esse
// núcleo vira uma função chamável SEM HMAC, com os MESMOS invariantes:
//
//   • payment.create é o ÚNICO caminho ao ASAAS (§11): via
//     paymentCreateOrExistingLink → confirmAccept → closeAgreement → charge-inline.
//   • Oferta INTEGRAL 0% EXPLÍCITA (M16/D.3): generateOfferTerms aplicaria
//     max_discount_pct (COM desconto). Aqui geramos e PERSISTIMOS uma oferta
//     integral (valor da fonte canônica, 0% desconto, 1 parcela) e cobramos ELA.
//   • Guard de idempotência (D7) e already_charged (D23): herdados de
//     paymentCreateOrExistingLink — já cobrada devolve o LINK EXISTENTE, NUNCA
//     uma 2ª cobrança.
//   • Reconhecimento (M4/D18): o guard vive dentro de paymentCreate; o clique
//     PAGAR grava reconhecimento implícito ANTES (responsabilidade da rota D1),
//     destravando este caminho.
//   • Vencimento do link = D+3 (parametrizável por PAY_LINK_DUE_DAYS).
//   • A plataforma NUNCA declara pago (M15/D6): quem fecha é o webhook.
//   • Erro do ASAAS → { ok:false, error } com RÓTULO CURTO (a copy humana é da
//     UI, §5.4). NUNCA vaza mensagem crua/HTTP/nome de sistema externo.
//
// A1 (2026-09-25, G1 com dado fresco):
//   • latência (N-D1-1): debtSummary/buildAcceptSummary/buildAckContext UMA vez,
//     eventos em paralelo, sem criar+rejeitar oferta integral por clique repetido
//     (reusa a oferta `accepted` do acordo VIVO — N-D1-5);
//   • o RESULTADO é persistido como outcome (bolha do link com
//     offers_snapshot.message_action = open_payment_link + stage 'payment_link')
//     e, LOGO APÓS, o servidor persiste o prompt pós-link (kind
//     'post_payment_link': [98 Voltar às opções] [99 Falar com atendimento]) —
//     o painel do client deriva da mensagem persistida e sobrevive ao reload
//     (N-D1-3/N-D1-8);
//   • already_charged só com cobrança VIVA (N-D1-2): a resposta idempotente
//     (mesma oferta já aceita) também é reportada como already_charged.
//
// PII: nada de nome/CPF/e-mail/telefone em log ou no retorno.

import {
  buildAckContext,
  persistAssistantMessage,
  REOPEN_MENU_QUESTION,
  type MessageAction,
} from "./acknowledgement"
import { debtSummary, type DebtSummary, type SessionCtx } from "./actions"
import { BTN_BACK, BTN_HANDOFF, type Button } from "./buttons"
import { recordEvent } from "./events"
import {
  paymentCreateOrExistingLink,
  type PaymentDetails,
} from "./payment-actions"
import { createPrompt, getActivePrompt, type PromptRow } from "./prompts"
import { createServiceClient } from "@/lib/supabase/service"
import { isBlockingAgreement } from "@/lib/asaas-idempotency"
import { resolveMatrixRow } from "@/lib/negotiation/matrix"
import {
  persistOffer,
  validateProposedTerms,
  type BillingType,
  type OfferTerms,
} from "@/lib/negotiation/offers"

/** Vencimento do link ASAAS: D+3 por padrão (decisão G1 "link"), parametrizável. */
export function payLinkDueDays(): number {
  const raw = Number.parseInt(process.env.PAY_LINK_DUE_DAYS ?? "", 10)
  return Number.isFinite(raw) && raw > 0 ? raw : 3
}

/** D+N em YYYY-MM-DD (borda ASAAS espera date-only). */
function dueDatePlus(days: number): string {
  return new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10)
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** Reais no padrão pt-BR (R$ 250,00) — mesma formatação da UI/buildAckContext. */
function formatBRL(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return ""
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v)
}

/** Vencimento do link ASAAS (YYYY-MM-DD) → dd/mm/aaaa para a copy. */
function formatDueDatePt(iso: string | null): string {
  if (!iso) return ""
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  return m ? `${m[3]}/${m[2]}/${m[1]}` : ""
}

/**
 * R7 — copy do link de pagamento PARA O HISTÓRICO (chat_messages). Espelha a copy
 * §5.2 (novo link) / §5.3 (already_charged) da UI, mas em uma mensagem PERSISTIDA,
 * para que o reload/reuso de sessão restaure o link (M11). Inclui o {link} em
 * texto (a UI renderiza a bolha; o link fica clicável/copiável no histórico).
 * NUNCA declara pago (M15). Sem PII (só valor/vencimento/URL).
 */
export function payLinkMessageText(input: {
  link: string | null
  valor: number | null
  vencimentoLink: string | null
  alreadyCharged: boolean
}): string {
  const valorTxt = input.valor != null ? formatBRL(input.valor) : ""
  const venc = formatDueDatePt(input.vencimentoLink)
  if (input.alreadyCharged) {
    // T8 / R-30: sem "se já pagou desconsidere" (é o botão "Já paguei" — C10).
    const head = valorTxt
      ? `Você já tem uma cobrança ativa de ${valorTxt}.`
      : "Você já tem uma cobrança ativa."
    const linkLine = input.link ? `\n${input.link}` : ""
    return `${head} Use o mesmo link abaixo — não é preciso gerar outro.${linkLine}`
  }
  // T7 / R-29: sem "Pronto!" e sem "se já pagou desconsidere"; reforço de segurança
  // leve ("o link é pessoal e seguro") no ponto de maior conversão (link na tela).
  const head = valorTxt
    ? `Aqui está o seu link para pagar ${valorTxt}`
    : "Aqui está o seu link de pagamento"
  const vencPart = venc ? `, com vencimento em ${venc}` : ""
  const linkLine = input.link ? `\n${input.link}` : ""
  return `${head}${vencPart}. É só abrir e escolher entre Pix, boleto ou cartão. O link é pessoal e seguro.${linkLine}`
}

/** Marcador de estágio da bolha do link (offers_snapshot.stage). */
export const PAYMENT_LINK_STAGE = "payment_link"

/** Kind do prompt pós-link (servidor persiste após a bolha do link — N-D1-3). */
export const POST_PAYMENT_LINK_KIND = "post_payment_link"

/** Ação anexada à bolha do link: o client renderiza "Abrir link de pagamento"
 *  (+ "Copiar link") a partir DESTA mensagem persistida (fonte única, N-D1-8). */
export function paymentLinkAction(href: string): MessageAction {
  return { type: "open_payment_link", label: "Abrir link de pagamento", href }
}

/** Botões do prompt pós-link: [98 Voltar às opções] [99 Falar com atendimento].
 *  O client mantém a afordância "Já paguei este valor" sob este prompt. */
export function postPaymentLinkButtons(): Button[] {
  return [
    { id: BTN_BACK, label: "Voltar às opções", order: 0 },
    { id: BTN_HANDOFF, label: "Falar com atendimento", order: 1 },
  ]
}

/**
 * R7/A1 — persiste a bolha do link (OUTCOME) no histórico da sessão, com a ação
 * `open_payment_link` e o stage 'payment_link'. Best-effort e IDEMPOTENTE:
 * persistAssistantMessage deduplica por conteúdo (mesmo link/valor/copy numa
 * janela curta) — clique repetido não empilha. Uma falha aqui NÃO derruba o
 * pagamento (o link já volta no corpo do POST). Devolve o id da bolha (ou null).
 */
export async function persistPaymentLinkMessage(
  ctx: SessionCtx,
  input: {
    link: string | null
    valor: number | null
    vencimentoLink: string | null
    alreadyCharged: boolean
    agreementId?: string | null
  },
): Promise<string | null> {
  // Sem link nenhum não há o que restaurar (processing persiste depois, no poll).
  if (!input.link) return null
  try {
    return await persistAssistantMessage({
      companyId: ctx.companyId,
      sessionId: ctx.sessionId,
      text: payLinkMessageText(input),
      stage: PAYMENT_LINK_STAGE,
      action: paymentLinkAction(input.link),
      snapshot: {
        agreement_id: input.agreementId ?? null,
        already_charged: input.alreadyCharged,
        valor: input.valor,
        vencimento_link: input.vencimentoLink,
      },
    })
  } catch (err) {
    console.warn("[journey] persistPaymentLinkMessage falhou (não fatal):", (err as Error).message)
    return null
  }
}

/**
 * A1 (N-D1-3) — o SERVIDOR persiste, logo após a bolha do link, o prompt pós-link
 * (kind 'post_payment_link', pergunta curta, [98 Voltar às opções] [99 Falar com
 * atendimento]). Assim o próximo passo NÃO vive só no client: após F5 o devedor
 * ainda tem link + ações. Idempotente: se já há um post_payment_link ATIVO para o
 * MESMO link, reusa. Best-effort: NUNCA lança (o link já foi entregue).
 */
export async function publishPostPaymentLinkPrompt(
  ctx: SessionCtx,
  input: { link: string | null; agreementId: string | null; debtIds: string[]; primaryDebtId?: string | null },
): Promise<PromptRow | null> {
  if (!input.link) return null
  try {
    const active = await getActivePrompt(ctx.sessionId)
    if (active && active.kind === POST_PAYMENT_LINK_KIND) {
      const link = (active.context as { link?: unknown } | null)?.link
      if (link === input.link) return active
    }
    const created = await createPrompt({
      companyId: ctx.companyId,
      sessionId: ctx.sessionId,
      kind: POST_PAYMENT_LINK_KIND,
      question: REOPEN_MENU_QUESTION,
      buttons: postPaymentLinkButtons(),
      context: {
        stage: "post_payment_link",
        link: input.link,
        agreement_id: input.agreementId,
        debt_ids: input.debtIds,
        primary_debt_id: input.primaryDebtId ?? ctx.debtId,
      },
      createdBy: "platform",
    })
    if (!created.ok) return null
    await persistAssistantMessage({
      companyId: ctx.companyId,
      sessionId: ctx.sessionId,
      text: REOPEN_MENU_QUESTION,
      promptId: created.prompt.id,
      skipContentDedup: true,
    })
    return created.prompt
  } catch (err) {
    console.warn("[journey] publishPostPaymentLinkPrompt falhou (não fatal):", (err as Error).message)
    return null
  }
}

/** Escolhe o billing à vista da matriz: PIX › BOLETO › CREDIT_CARD (mesma
 *  precedência de generateOfferTerms para a condição "à vista"). */
function cashBillingType(allowed: string[]): BillingType {
  if (allowed.includes("PIX")) return "PIX"
  if (allowed.includes("BOLETO")) return "BOLETO"
  return "CREDIT_CARD"
}

export interface PayServiceOk {
  ok: true
  /** link ASAAS (invoice/pix/boleto) para o devedor pagar. */
  link: string | null
  /** valor integral cobrado (reais) — DEVE bater com o rótulo do botão (D39/D41). */
  valor: number
  /** vencimento do link (D+3) no formato ASAAS (YYYY-MM-DD). */
  vencimento_link: string | null
  /** true quando a dívida já tinha cobrança viva: devolve o link existente (D23). */
  already_charged: boolean
  /** cobrança aceita mas o link ainda não voltou do worker (CHARGE_MODE=queue).
   *  A UI faz polling via /api/chat/payment; NUNCA declara pago. */
  processing: boolean
  agreement_id: string | null
  /** id do prompt pós-link persistido pelo servidor (null se sem link). */
  post_prompt_id: string | null
}

export interface PayServiceErr {
  ok: false
  /** rótulo CURTO e estável (a copy humana é da UI, §5.4). Nunca mensagem crua. */
  error: string
}

export type PayServiceResult = PayServiceOk | PayServiceErr

function isIntegralTerms(t: OfferTerms | null, valor: number): boolean {
  return (
    !!t &&
    t.installments === 1 &&
    Number(t.discount_value ?? 0) === 0 &&
    Math.abs(Number(t.total_value) - valor) <= 0.01
  )
}

/**
 * Gera (ou reusa) a oferta INTEGRAL 0% da sessão e devolve o offer_id.
 *
 * A oferta integral é: valor canônico (buildAckContext.updatedValue — a MESMA
 * fonte do rótulo do botão), 0% de desconto, 1 parcela, billing à vista da
 * matriz, vencimento D+3. É PERSISTIDA em negotiation_offers como 'presented'
 * (source 'system'), então paymentCreateOrExistingLink cobra ELA pelo caminho
 * canônico (com revalidação de matriz: uma oferta 0%/1x sempre cabe na faixa).
 *
 * Idempotência do PRÓPRIO passo (N-D1-5): reusa
 *   - uma oferta integral ainda 'presented' nesta sessão, ou
 *   - uma oferta integral já 'accepted' cujo acordo continua VIVO (cobrança em
 *     aberto) — paymentCreate devolve o MESMO acordo/link (idempotente) sem criar
 *     e rejeitar uma oferta nova a cada clique repetido.
 * Uma oferta aceita cujo acordo foi cancelado/deletado NÃO é reusada: o clique
 * gera oferta nova → cobrança nova (runbook Q3.5).
 */
async function ensureIntegralOffer(
  ctx: SessionCtx,
  debtIds: string[],
): Promise<
  | { ok: true; offerId: string; valor: number; summary?: DebtSummary }
  | { ok: false; error: string }
> {
  // Valor canônico (fonte única do rótulo do botão e do e-mail — D39/D41). O
  // conjunto `debtIds` é o MESMO que gerou o rótulo do botão (o menu de 3 opções
  // persiste debt_ids no prompt.context e a rota os repassa).
  const supabase = createServiceClient()
  const [ack, { data: candidates }] = await Promise.all([
    buildAckContext({ companyId: ctx.companyId, customerId: ctx.customerId, debtIds }),
    supabase
      .from("negotiation_offers")
      .select("id, terms, status")
      .eq("session_id", ctx.sessionId)
      .in("status", ["presented", "accepted"]),
  ])
  const valor = round2(ack.updatedValue)
  if (!(valor > 0)) return { ok: false, error: "no_open_amount" }

  const integrals = ((candidates ?? []) as Array<{ id: string; terms: OfferTerms | null; status: string }>).filter((o) =>
    isIntegralTerms(o.terms, valor),
  )
  const presented = integrals.find((o) => o.status === "presented")
  if (presented) return { ok: true, offerId: presented.id, valor }

  // Oferta integral já ACEITA: só reusa se o acordo dela continua VIVO.
  for (const accepted of integrals.filter((o) => o.status === "accepted")) {
    const { data: acc } = await supabase
      .from("negotiation_acceptances")
      .select("agreement_id")
      .eq("offer_id", accepted.id)
      .maybeSingle()
    const agreementId = (acc as { agreement_id?: string | null } | null)?.agreement_id
    if (!agreementId) continue
    const { data: ag } = await supabase
      .from("agreements")
      .select("id, asaas_payment_id, payment_status, asaas_status, status")
      .eq("id", agreementId)
      .eq("company_id", ctx.companyId)
      .maybeSingle()
    if (ag && isBlockingAgreement(ag)) return { ok: true, offerId: accepted.id, valor }
  }

  // Resolve a faixa da matriz vigente para o (aging, valor) do débito. Sem
  // linha de matriz → sem billing permitido conhecido → rótulo curto (a UI cai
  // no menu com atendimento). debtValue = `valor` (valor efetivamente cobrado =
  // updatedValue consolidado), consistente com o rótulo do botão.
  const summary = await debtSummary(ctx)
  const row = await resolveMatrixRow({
    companyId: ctx.companyId,
    agingDays: summary.agingDays,
    debtValue: valor,
  })
  if (!row) return { ok: false, error: "no_matrix_row" }

  const firstDue = dueDatePlus(payLinkDueDays())
  const terms: OfferTerms = {
    original_value: valor,
    discount_pct: 0,
    discount_value: 0,
    entry_value: 0,
    installments: 1,
    installment_value: valor,
    total_value: valor,
    billing_type: cashBillingType(row.allowed_billing_types),
    first_due_date: firstDue,
  }

  // Sanidade: a oferta integral 0%/1x tem que caber na matriz vigente (cabe
  // sempre — 0% <= max_discount_pct, 1 parcela não dispara checks de entrada).
  const verdict = validateProposedTerms(terms, row)
  if (!verdict.ok) return { ok: false, error: "offer_outside_matrix" }

  const validUntil = new Date(
    Date.now() + row.proposal_validity_days * 86400_000,
  ).toISOString()
  const offerId = await persistOffer({
    companyId: ctx.companyId,
    sessionId: ctx.sessionId,
    customerId: ctx.customerId,
    debtId: ctx.debtId,
    matrixId: row.id,
    source: "system",
    status: "presented",
    terms,
    validUntil,
  })
  await recordEvent({
    companyId: ctx.companyId,
    customerId: ctx.customerId,
    debtId: ctx.debtId,
    sessionId: ctx.sessionId,
    type: "offer.presented",
    actor: "system",
    payload: { offer_id: offerId, integral: true, installments: 1, discount_pct: 0 },
  })
  return { ok: true, offerId, valor, summary }
}

/**
 * payService — "Pagar Agora" (§6.4). Ponto de entrada que a rota /api/chat/button
 * (D1) chama no clique PAGAR (button_id=4).
 *
 * Fluxo: oferta integral 0% (ensureIntegralOffer) → paymentCreateOrExistingLink
 * (guard idempotência D7 + revalidação de matriz + guard de reconhecimento +
 * already_charged/D23) → charge-inline via closeAgreement (CHARGE_MODE=inline) →
 * link → bolha do link (outcome) → prompt pós-link.
 *
 * @param opts.debtIds conjunto de dívidas cobradas — DEVE ser o MESMO que gerou o
 *                rótulo do botão (o menu de 3 opções persiste debt_ids no
 *                prompt.context; a rota D1 os repassa). Default: [ctx.debtId]
 *                (compatível com o caminho single-debt e os testes existentes).
 * @param opts.eventId dedup opcional (herda a idempotência de (session,offer) de
 *                paymentCreate; clique repetido reusa a MESMA oferta/cobrança).
 */
export async function payService(
  ctx: SessionCtx,
  opts?: { debtIds?: string[]; eventId?: string; primaryDebtId?: string | null },
): Promise<PayServiceResult> {
  const eventId = opts?.eventId
  // Conjunto de dívidas cobradas = o MESMO do rótulo do botão (D3 ALTO). Sem
  // debt_ids explícitos, cai na dívida primária (single-debt path).
  const debtIds =
    opts?.debtIds && opts.debtIds.length > 0 ? opts.debtIds : [ctx.debtId]

  // Telemetria (clique PAGAR chegou) em PARALELO com a oferta integral.
  const [, offer] = await Promise.all([
    recordEvent({
      companyId: ctx.companyId,
      customerId: ctx.customerId,
      debtId: ctx.debtId,
      sessionId: ctx.sessionId,
      type: "pay.requested",
      actor: "customer",
      payload: { option: "pagar" },
    }).catch(() => ({ ok: false, duplicate: false })),
    ensureIntegralOffer(ctx, debtIds),
  ])
  if (!offer.ok) {
    await emitPayFailed(ctx, offer.error)
    return { ok: false, error: offer.error }
  }

  const r = await paymentCreateOrExistingLink(ctx, offer.offerId, eventId, { summary: offer.summary })

  if (!r.ok) {
    // Rótulo curto e estável (a copy humana é da UI, §5.4). NUNCA a mensagem
    // crua do ASAAS/HTTP/"n8n". Guards conhecidos (409/422) e erro genérico.
    await emitPayFailed(ctx, r.code)
    return { ok: false, error: r.code }
  }

  if (r.status === "processing") {
    // Cobrança aceita, worker ainda não gravou as URLs (CHARGE_MODE=queue). A
    // UI faz polling; NÃO declaramos pago (M15).
    await recordEvent({
      companyId: ctx.companyId,
      customerId: ctx.customerId,
      debtId: ctx.debtId,
      sessionId: ctx.sessionId,
      agreementId: r.agreement_id,
      type: "pay.processing",
      actor: "system",
      payload: { poll_after_ms: r.poll_after_ms },
    }).catch(() => {})
    return {
      ok: true,
      link: null,
      valor: offer.valor,
      vencimento_link: null,
      already_charged: false,
      processing: true,
      agreement_id: r.agreement_id,
      post_prompt_id: null,
    }
  }

  // already_charged (guard D7/D23: acordo vivo, link existente) OU resposta
  // IDEMPOTENTE (a mesma oferta integral já aceita → mesmo acordo/link): nos dois
  // casos o devedor JÁ tem esta cobrança — copy "você já tem uma cobrança ativa".
  const alreadyCharged = r.status === "already_charged" || (r.status === "created" && r.idempotent === true)
  const payment = r.payment
  const link = linkOf(payment)
  const vencimento = payment?.due_date ?? null
  const agreementId = payment?.agreement_id ?? null

  // Resultado da ação como OUTCOME, ANTES de qualquer menu: bolha do link
  // (com ação/stage) + telemetria em paralelo; depois o prompt pós-link.
  await Promise.all([
    emitPayLinkReady(ctx, payment, { already_charged: alreadyCharged }),
    persistPaymentLinkMessage(ctx, {
      link,
      valor: offer.valor,
      vencimentoLink: vencimento,
      alreadyCharged,
      agreementId,
    }),
  ])
  const post = await publishPostPaymentLinkPrompt(ctx, {
    link,
    agreementId,
    debtIds,
    primaryDebtId: opts?.primaryDebtId ?? ctx.debtId,
  })

  return {
    ok: true,
    link,
    valor: offer.valor,
    vencimento_link: vencimento,
    already_charged: alreadyCharged,
    processing: false,
    agreement_id: agreementId,
    post_prompt_id: post?.id ?? null,
  }
}

/** Melhor URL de pagamento: invoice (checkout ASAAS) › boleto › PIX copia-e-cola. */
export function linkOf(p: PaymentDetails | null): string | null {
  if (!p) return null
  return p.invoice_url ?? p.boleto_url ?? p.pix_copy_paste ?? null
}

async function emitPayLinkReady(
  ctx: SessionCtx,
  payment: PaymentDetails | null,
  opts: { already_charged: boolean },
): Promise<void> {
  await recordEvent({
    companyId: ctx.companyId,
    customerId: ctx.customerId,
    debtId: ctx.debtId,
    sessionId: ctx.sessionId,
    agreementId: payment?.agreement_id ?? null,
    type: "pay.link_ready",
    actor: "system",
    payload: {
      already_charged: opts.already_charged,
      billing_type: payment?.billing_type ?? null,
      has_link: Boolean(linkOf(payment)),
    },
  }).catch(() => {})
}

async function emitPayFailed(ctx: SessionCtx, code: string): Promise<void> {
  await recordEvent({
    companyId: ctx.companyId,
    customerId: ctx.customerId,
    debtId: ctx.debtId,
    sessionId: ctx.sessionId,
    type: "pay.failed",
    actor: "system",
    payload: { code }, // rótulo curto, sem PII/mensagem crua
  }).catch(() => {})
}
