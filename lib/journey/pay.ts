// Trilha PAGAR AGORA (§6.4, M13–M16) — caminho canônico, 100% NOSSO (independe
// do n8n): o botão "Quero pagar — R$ X" gera o link ASAAS na hora.
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
// PII: nada de nome/CPF/e-mail/telefone em log ou no retorno.

import { buildAckContext, persistAssistantMessage } from "./acknowledgement"
import { debtSummary, type SessionCtx } from "./actions"
import { recordEvent } from "./events"
import {
  paymentCreateOrExistingLink,
  type PaymentDetails,
} from "./payment-actions"
import { createServiceClient } from "@/lib/supabase/service"
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
    const head = valorTxt
      ? `Você já tem uma cobrança ativa no valor de ${valorTxt}.`
      : "Você já tem uma cobrança ativa."
    const linkLine = input.link ? `\n${input.link}` : ""
    return `${head} Use o mesmo link abaixo — não precisa gerar outro. Se você já pagou, é só desconsiderar.${linkLine}`
  }
  const head = valorTxt
    ? `Pronto! Aqui está o seu link para pagar ${valorTxt}`
    : "Pronto! Aqui está o seu link de pagamento"
  const vencPart = venc ? `, com vencimento em ${venc}` : ""
  const linkLine = input.link ? `\n${input.link}` : ""
  return `${head}${vencPart}. É só abrir e escolher como prefere pagar (Pix, boleto ou cartão). Se você já pagou, pode desconsiderar.${linkLine}`
}

/**
 * R7 — persiste a mensagem do link no histórico da sessão. Best-effort e
 * IDEMPOTENTE: persistAssistantMessage deduplica por conteúdo (mesmo link/valor
 * numa janela curta), então clique repetido / already_charged não empilha. Uma
 * falha aqui NÃO derruba o pagamento (o link já volta no corpo do POST/payResult).
 */
async function persistPayLinkMessage(
  ctx: SessionCtx,
  input: { link: string | null; valor: number | null; vencimentoLink: string | null; alreadyCharged: boolean },
): Promise<void> {
  // Sem link nenhum não há o que restaurar (processing persiste depois, no poll).
  if (!input.link) return
  try {
    await persistAssistantMessage({
      companyId: ctx.companyId,
      sessionId: ctx.sessionId,
      text: payLinkMessageText(input),
    })
  } catch (err) {
    console.warn("[journey] persistPayLinkMessage falhou (não fatal):", (err as Error).message)
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
}

export interface PayServiceErr {
  ok: false
  /** rótulo CURTO e estável (a copy humana é da UI, §5.4). Nunca mensagem crua. */
  error: string
}

export type PayServiceResult = PayServiceOk | PayServiceErr

/**
 * Gera (ou reusa) a oferta INTEGRAL 0% da sessão e devolve o offer_id.
 *
 * A oferta integral é: valor canônico (buildAckContext.updatedValue — a MESMA
 * fonte do rótulo do botão), 0% de desconto, 1 parcela, billing à vista da
 * matriz, vencimento D+3. É PERSISTIDA em negotiation_offers como 'presented'
 * (source 'system'), então paymentCreateOrExistingLink cobra ELA pelo caminho
 * canônico (com revalidação de matriz: uma oferta 0%/1x sempre cabe na faixa).
 *
 * Idempotência do PRÓPRIO passo: se já existe uma oferta integral 0% presented
 * nesta sessão, reusa (não empilha ofertas a cada clique repetido em PAGAR).
 */
async function ensureIntegralOffer(
  ctx: SessionCtx,
  debtIds: string[],
): Promise<
  | { ok: true; offerId: string; valor: number }
  | { ok: false; error: string }
> {
  // Valor canônico (fonte única do rótulo do botão e do e-mail — D39/D41). O
  // conjunto `debtIds` é o MESMO que gerou o rótulo do botão (o menu de 3 opções
  // persiste debt_ids no prompt.context e a rota os repassa). Sem isso, o valor
  // cobrado somaria só a dívida primária enquanto o rótulo somava todas — em
  // sessão multi-fatura o devedor clicaria "R$ 500,00" e a cobrança sairia
  // "R$ 250,00" (D3 ALTO: valor divergente do botão = BLOQUEANTE, §6.4/4).
  const ack = await buildAckContext({
    companyId: ctx.companyId,
    customerId: ctx.customerId,
    debtIds,
  })
  const valor = round2(ack.updatedValue)
  if (!(valor > 0)) return { ok: false, error: "no_open_amount" }

  // Reusa uma oferta integral já apresentada nesta sessão (clique repetido em
  // PAGAR não deve empilhar ofertas). Leitura DIRETA (sem listOffers, que geraria
  // as ofertas COM desconto da matriz como efeito colateral — não queremos isso
  // no caminho "à vista integral").
  const supabase = createServiceClient()
  const { data: presented } = await supabase
    .from("negotiation_offers")
    .select("id, terms")
    .eq("session_id", ctx.sessionId)
    .eq("status", "presented")
  const integral = (presented ?? []).find((o) => {
    const t = o.terms as OfferTerms | null
    return (
      !!t &&
      t.installments === 1 &&
      Number(t.discount_value ?? 0) === 0 &&
      Math.abs(Number(t.total_value) - valor) <= 0.01
    )
  })
  if (integral) return { ok: true, offerId: integral.id, valor }

  // Resolve a faixa da matriz vigente para o (aging, valor) do débito. Sem
  // linha de matriz → sem billing permitido conhecido → rótulo curto (a UI cai
  // no menu com atendimento). A revalidação de matriz do payment.create também
  // barraria depois; aqui damos o erro cedo e legível. debtValue = `valor`
  // (valor efetivamente cobrado = updatedValue consolidado), NÃO o originalValue
  // da dívida primária: garante que a BANDA da matriz corresponde ao que será
  // cobrado (D3 BAIXO), consistente com o rótulo do botão.
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
  return { ok: true, offerId, valor }
}

/**
 * payService — "Pagar Agora" (§6.4). Ponto de entrada que a rota /api/chat/button
 * (D1) chama no clique PAGAR (button_id=4).
 *
 * Fluxo: oferta integral 0% (ensureIntegralOffer) → paymentCreateOrExistingLink
 * (guard idempotência D7 + revalidação de matriz + guard de reconhecimento +
 * already_charged/D23) → charge-inline via closeAgreement (CHARGE_MODE=inline) →
 * link.
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
  opts?: { debtIds?: string[]; eventId?: string },
): Promise<PayServiceResult> {
  const eventId = opts?.eventId
  // Conjunto de dívidas cobradas = o MESMO do rótulo do botão (D3 ALTO). Sem
  // debt_ids explícitos, cai na dívida primária (single-debt path).
  const debtIds =
    opts?.debtIds && opts.debtIds.length > 0 ? opts.debtIds : [ctx.debtId]

  // Telemetria: clique PAGAR chegou (gerando_cobranca). Sem PII.
  await recordEvent({
    companyId: ctx.companyId,
    customerId: ctx.customerId,
    debtId: ctx.debtId,
    sessionId: ctx.sessionId,
    type: "pay.requested",
    actor: "customer",
    payload: { option: "pagar" },
  }).catch(() => {})

  const offer = await ensureIntegralOffer(ctx, debtIds)
  if (!offer.ok) {
    await emitPayFailed(ctx, offer.error)
    return { ok: false, error: offer.error }
  }

  const r = await paymentCreateOrExistingLink(ctx, offer.offerId, eventId)

  if (!r.ok) {
    // Rótulo curto e estável (a copy humana é da UI, §5.4). NUNCA a mensagem
    // crua do ASAAS/HTTP/"n8n". Guards conhecidos (409/422) e erro genérico.
    await emitPayFailed(ctx, r.code)
    return { ok: false, error: r.code }
  }

  if (r.status === "already_charged") {
    // D23/M14: devolve o LINK EXISTENTE, nunca cria 2ª cobrança.
    await emitPayLinkReady(ctx, r.payment, { already_charged: true })
    // R7 — grava o link no histórico (idempotente): reload/reuso restaura o link.
    await persistPayLinkMessage(ctx, {
      link: linkOf(r.payment),
      valor: offer.valor,
      vencimentoLink: r.payment?.due_date ?? null,
      alreadyCharged: true,
    })
    return {
      ok: true,
      link: linkOf(r.payment),
      valor: offer.valor,
      vencimento_link: r.payment?.due_date ?? null,
      already_charged: true,
      processing: false,
      agreement_id: r.payment?.agreement_id ?? null,
    }
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
    }
  }

  // status: 'created' — link pronto (inline).
  await emitPayLinkReady(ctx, r.payment, { already_charged: false })
  // R7 — grava o link no histórico (idempotente): reload/reuso restaura o link.
  await persistPayLinkMessage(ctx, {
    link: linkOf(r.payment),
    valor: offer.valor,
    vencimentoLink: r.payment.due_date ?? null,
    alreadyCharged: false,
  })
  return {
    ok: true,
    link: linkOf(r.payment),
    valor: offer.valor,
    vencimento_link: r.payment.due_date ?? null,
    already_charged: false,
    processing: false,
    agreement_id: r.payment.agreement_id,
  }
}

/** Melhor URL de pagamento: invoice (checkout ASAAS) › boleto › PIX copia-e-cola. */
function linkOf(p: PaymentDetails | null): string | null {
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
