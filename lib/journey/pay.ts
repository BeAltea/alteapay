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
  reopenThreeOptions,
  type MessageAction,
} from "./acknowledgement"
import { debtSummary, type DebtSummary, type SessionCtx } from "./actions"
import { BTN_BACK, BTN_HANDOFF, type Button } from "./buttons"
import { recordEvent } from "./events"
import {
  paymentCreateOrExistingLink,
  type PaymentDetails,
} from "./payment-actions"
import { createPrompt, getActivePrompt, promptView, type PromptRow, type PromptView } from "./prompts"
import { payLinkMessageText } from "./pay-poll"
import { createServiceClient } from "@/lib/supabase/service"
import { isBlockingAgreement, isBlockingPayment } from "@/lib/asaas-idempotency"
import { PAID_ASAAS_STATUSES } from "@/lib/constants/payment-status"
import { resolveMatrixRow } from "@/lib/negotiation/matrix"
import { isPendingCharge } from "./charge-reconcile"
import { timed } from "./server-timing"
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

/**
 * QA rodada 5 (Q2-01) — orçamento (ms, desde o início da request do clique) para
 * a cobrança COMEÇAR no ASAAS. O teto observado da função é ~30 s (504 em
 * 30,4 s; `maxDuration=60` da rota NÃO é honrado pelo plano). Depois do POST
 * /payments ainda restam: o próprio POST (p99 alguns segundos), o write-back e a
 * entrega do link (bolha + prompt). Começar até ~17 s deixa folga para tudo
 * terminar antes do teto. Passado o orçamento, nada é cobrado: o clique devolve
 * `charge_deferred` (copy de erro com "tentar de novo") e nenhum acordo fica.
 */
export function payChargeStartBudgetMs(): number {
  const raw = Number.parseInt(process.env.PAY_CHARGE_START_BUDGET_MS ?? "", 10)
  return Number.isFinite(raw) && raw >= 1000 ? raw : 17_000
}

/** D+N em YYYY-MM-DD (borda ASAAS espera date-only). */
function dueDatePlus(days: number): string {
  return new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10)
}

const round2 = (n: number) => Math.round(n * 100) / 100

// A4 (S14/S15, N-D5-8): a copy do link vive em UM lugar, client-safe
// (./pay-poll.ts) — a bolha persistida (aqui) e o painel-fallback do client
// (chat.tsx) usam a MESMA função. Re-exportada para quem a importa de "./pay".
export { payLinkMessageText }

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

// ---------------------------------------------------------------------------
// QA round 1 (QAA1-02 / A1-R3) — `already_charged` NUNCA é beco.
// Em produção, Pagar com uma cobrança viva de OFERTA ACEITA (acordo 3x) devolvia
// `already_charged:true, link:null` sem bolha nem prompt: menu consumido, tela
// sem botões (também após F5). Agora o servidor: (1) resolve o link vivo pelo
// acordo (paymentStatus) e, faltando URL local, pelo ASAAS (`asaas_payment_id`
// ou a cobrança viva do cliente — guard nível-ASAAS sem acordo local, R3);
// (2) com link, persiste a bolha + prompt pós-link como no caminho normal;
// (3) sem link, persiste um OUTCOME humano (stage 'charge_active') + reabre o
// menu curto. Nunca `ok:true` sem outcome e sem prompt.
// ---------------------------------------------------------------------------

/** Marcador de estágio do outcome "cobrança ativa sem link" (OUTCOME_STAGES). */
export const CHARGE_ACTIVE_STAGE = "charge_active"

/** Copy humana do outcome sem link (Apêndice B: frases curtas, sem sistema). */
export const ALREADY_CHARGED_NO_LINK_TEXT =
  "Você já tem uma cobrança ativa. Se o link não aparecer, fale com o atendimento."

/** Melhor URL de uma cobrança ASAAS: checkout (invoiceUrl) › boleto › PIX. */
function asaasPaymentLink(p: { invoiceUrl?: string | null; bankSlipUrl?: string | null; pixQrCodeUrl?: string | null } | null | undefined): string | null {
  if (!p) return null
  return p.invoiceUrl ?? p.bankSlipUrl ?? p.pixQrCodeUrl ?? null
}

/**
 * QA round 2 (B6 B-2) — cobrança PAGÁVEL: viva no ASAAS (isBlockingPayment — nunca
 * deletada/estornada) E ainda não paga (RECEIVED/CONFIRMED/RECEIVED_IN_CASH). Uma
 * cobrança já recebida com o local defasado não vira "cobrança ativa, use o
 * link"; cai no outcome humano (sem link) — e nunca declara pago (D6; quem
 * fecha é o webhook).
 */
export function isPayableCharge(p: { status?: string | null; deleted?: boolean } | null | undefined): boolean {
  if (!p || !isBlockingPayment(p)) return false
  return !(PAID_ASAAS_STATUSES as readonly string[]).includes(p.status ?? "")
}

/** Shape mínimo de uma cobrança ASAAS para o mapeamento (sem PII). */
export interface AsaasChargeLike {
  id?: string
  status?: string | null
  deleted?: boolean
  value?: number
  dueDate?: string | null
  invoiceUrl?: string | null
  bankSlipUrl?: string | null
  pixQrCodeUrl?: string | null
  externalReference?: string | null
  /** id do plano de parcelamento (presente em cada parcela de um parcelado). */
  installment?: string | null
}

/** Acordo local mínimo para o mapeamento (sempre lido por customer_id + company_id). */
export interface AgreementChargeRef {
  id: string
  asaas_payment_id: string | null
  agreed_amount?: number | null
  due_date?: string | null
}

/**
 * QA round 2 (B6 M-2) — passo 2 do `resolveLiveChargeLink`: entre as cobranças
 * VIVAS do cliente no ASAAS, só é exibida a que é MAPEÁVEL a esta empresa/dívida:
 *  - `id` = `asaas_payment_id` de um acordo desta `company_id` (qualquer status
 *    local — o ASAAS diz se está viva), com o TOTAL do acordo (B-3); ou
 *  - `externalReference` = `journey_<esta sessão>_…` (cobrança desta sessão cujo
 *    acordo não ficou gravado): total = `value` só numa cobrança única (numa
 *    parcela o total é desconhecido → copy sem valor).
 * Uma cobrança viva de OUTRO cedente/legada (mesmo CPF, mesma conta ASAAS) nunca
 * é exibida como "a sua cobrança ativa": sem mapeamento → null → outcome
 * `charge_active` sem link (caminho humano). Pura.
 */
export function matchLiveChargeToAgreement(
  payments: AsaasChargeLike[] | null | undefined,
  agreements: AgreementChargeRef[] | null | undefined,
  sessionId: string,
): { payment: AsaasChargeLike; link: string; total: number | null; agreementId: string | null } | null {
  const byPaymentId = new Map<string, AgreementChargeRef>()
  for (const ag of agreements ?? []) if (ag.asaas_payment_id) byPaymentId.set(ag.asaas_payment_id, ag)
  const sessionRef = `journey_${sessionId}_`
  for (const p of payments ?? []) {
    if (!isPayableCharge(p)) continue
    const link = asaasPaymentLink(p)
    if (!link) continue
    const ag = p.id ? byPaymentId.get(p.id) : undefined
    if (ag) {
      const total = typeof ag.agreed_amount === "number" ? ag.agreed_amount : typeof p.value === "number" ? p.value : null
      return { payment: p, link, total, agreementId: ag.id }
    }
    if (typeof p.externalReference === "string" && p.externalReference.startsWith(sessionRef)) {
      const total = !p.installment && typeof p.value === "number" ? p.value : null
      return { payment: p, link, total, agreementId: null }
    }
  }
  return null
}

/**
 * Resolve o LINK VIVO de uma cobrança existente. Ordem: URLs do acordo local →
 * ASAAS pela `asaas_payment_id` do acordo (só se a cobrança continua PAGÁVEL —
 * isPayableCharge, B-2) → cobrança viva do cliente no ASAAS MAPEÁVEL a um
 * acordo desta empresa/sessão (matchLiveChargeToAgreement, M-2). Best-effort:
 * nunca lança; sem link → null (o chamador persiste o outcome humano). Quando
 * resolve pelo ASAAS e há acordo local, grava as URLs de volta (não-fatal).
 * O `total` é o TOTAL do acordo (`agreed_amount`): numa cobrança parcelada o
 * `value` do ASAAS é a PARCELA e não entra na copy "cobrança ativa de R$ X" (B-3).
 */
export async function resolveLiveChargeLink(
  ctx: SessionCtx,
  payment: PaymentDetails | null,
): Promise<{ link: string | null; dueDate: string | null; total: number | null }> {
  const local = linkOf(payment)
  if (local) return { link: local, dueDate: payment?.due_date ?? null, total: payment?.total_value ?? null }
  try {
    const asaas = await import("@/lib/asaas")
    const supabase = createServiceClient()
    // 1) pela cobrança do acordo (asaas_payment_id) — o caso do acordo parcelado
    //    sem URL local (QAA1-02). Só uma cobrança PAGÁVEL (nunca deletada/
    //    estornada/já recebida com o local defasado — B-2).
    if (payment?.payment_id) {
      const p = (await asaas.getAsaasPayment(payment.payment_id).catch(() => null)) as AsaasChargeLike | null
      const link = asaasPaymentLink(p)
      if (p && link && isPayableCharge(p)) {
        if (payment.agreement_id) {
          await supabase
            .from("agreements")
            .update({
              asaas_invoice_url: p.invoiceUrl ?? null,
              asaas_payment_url: p.invoiceUrl ?? null,
              asaas_boleto_url: p.bankSlipUrl ?? null,
              asaas_pix_qrcode_url: p.pixQrCodeUrl ?? null,
            })
            .eq("id", payment.agreement_id)
            .eq("company_id", ctx.companyId)
            .then(() => {}, () => {})
        }
        const total = payment.total_value ?? (typeof p.value === "number" ? p.value : null)
        return { link, dueDate: p.dueDate ?? payment.due_date ?? null, total }
      }
    }
    // 2) cobrança viva do cliente no ASAAS MAPEÁVEL a esta empresa (M-2). Acordos
    //    lidos por customer_id + company_id (B-1); o asaas_customer_id vem deles.
    const { data: known } = await supabase
      .from("agreements")
      .select("id, asaas_payment_id, asaas_customer_id, agreed_amount, due_date")
      .eq("customer_id", ctx.customerId)
      .eq("company_id", ctx.companyId)
    const rows = (known ?? []) as Array<AgreementChargeRef & { asaas_customer_id?: string | null }>
    const asaasCustomerId = rows.find((r) => typeof r.asaas_customer_id === "string" && r.asaas_customer_id)?.asaas_customer_id
    if (asaasCustomerId) {
      const payments = (await asaas.getAsaasPaymentsForCustomer(asaasCustomerId)) as AsaasChargeLike[]
      const mapped = matchLiveChargeToAgreement(payments, rows, ctx.sessionId)
      if (mapped) return { link: mapped.link, dueDate: mapped.payment.dueDate ?? null, total: mapped.total }
    }
  } catch (err) {
    console.warn("[journey] resolveLiveChargeLink falhou (não fatal):", (err as Error).message)
  }
  return { link: null, dueDate: payment?.due_date ?? null, total: payment?.total_value ?? null }
}

export interface DeliveredPaymentOutcome {
  link: string | null
  vencimentoLink: string | null
  agreementId: string | null
  postPromptId: string | null
  /** prompt ATIVO após a entrega (pós-link, ou o menu curto sem link). */
  prompt: PromptView | null
  /** QA round 4 (R-10/R-20): id da bolha do link persistida — o client reconcilia
   *  o resultado do clique com ELA por id (nunca 2 bolhas/painéis). */
  linkMessageId?: string | null
}

/**
 * Entrega o RESULTADO do pagamento ao devedor, sempre com outcome + prompt:
 *  - link resolvido → bolha do link (outcome) + prompt pós-link (caminho normal);
 *  - sem link → outcome humano 'charge_active' + menu curto reaberto.
 * Best-effort em cada escrita (o resultado já é conhecido); nunca lança.
 */
export async function deliverPaymentOutcome(
  ctx: SessionCtx,
  input: {
    payment: PaymentDetails | null
    alreadyCharged: boolean
    /** valor exibido na copy quando a cobrança não informa o total. */
    valor: number | null
    debtIds: string[]
    primaryDebtId?: string | null
  },
): Promise<DeliveredPaymentOutcome> {
  const resolved = await resolveLiveChargeLink(ctx, input.payment)
  const agreementId = input.payment?.agreement_id ?? null
  if (resolved.link) {
    const linkMessageId = await persistPaymentLinkMessage(ctx, {
      link: resolved.link,
      valor: resolved.total ?? input.valor,
      vencimentoLink: resolved.dueDate,
      alreadyCharged: input.alreadyCharged,
      agreementId,
    })
    const post = await publishPostPaymentLinkPrompt(ctx, {
      link: resolved.link,
      agreementId,
      debtIds: input.debtIds,
      primaryDebtId: input.primaryDebtId ?? ctx.debtId,
    })
    return {
      link: resolved.link,
      vencimentoLink: resolved.dueDate,
      agreementId,
      postPromptId: post?.id ?? null,
      prompt: promptView(post),
      linkMessageId,
    }
  }
  // Sem link resolvível: outcome humano ligado a este resultado (fora do dedup de
  // conteúdo — cada Pagar tem a sua resposta) + menu curto (nunca tela sem botão).
  try {
    await persistAssistantMessage({
      companyId: ctx.companyId,
      sessionId: ctx.sessionId,
      text: ALREADY_CHARGED_NO_LINK_TEXT,
      stage: CHARGE_ACTIVE_STAGE,
      snapshot: { agreement_id: agreementId, already_charged: input.alreadyCharged },
      skipContentDedup: true,
    })
  } catch (err) {
    console.warn("[journey] outcome charge_active falhou (não fatal):", (err as Error).message)
  }
  let prompt: PromptView | null = null
  try {
    const back = await reopenThreeOptions({
      companyId: ctx.companyId, sessionId: ctx.sessionId, customerId: ctx.customerId,
      debtIds: input.debtIds, primaryDebtId: input.primaryDebtId ?? ctx.debtId,
    })
    if (back.ok) prompt = promptView(await getActivePrompt(ctx.sessionId))
  } catch (err) {
    console.warn("[journey] reabertura do menu após charge_active falhou (não fatal):", (err as Error).message)
  }
  return { link: null, vencimentoLink: null, agreementId, postPromptId: null, prompt }
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
  /** valor integral cobrado (reais): DEVE bater com o rótulo do botão (D39/D41). */
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
  /** QA round 4 (R-10/R-20): id da bolha do link persistida (null se sem link). */
  link_message_id?: string | null
  /** QA round 1 (QAA1-02): prompt ATIVO após a entrega (pós-link ou menu curto),
   *  no shape do GET — o client renderiza na hora. null só em 'processing'. */
  prompt?: PromptView | null
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
      .select("id, asaas_payment_id, payment_status, asaas_status, status, origin, offer_id, negotiation_session_id")
      .eq("id", agreementId)
      .eq("company_id", ctx.companyId)
      .maybeSingle()
    // QA rodada 5 (Q2-01): acordo pending_charge (espelho gravado antes do ASAAS,
    // função morta no meio) também é reusado — o clique repetido cai na
    // idempotência (session, offer) → 'processing' → o poll reconcilia. NUNCA
    // gera oferta nova (que levaria a uma 2ª cobrança se o ASAAS já criou a 1ª).
    if (ag && (isBlockingAgreement(ag) || isPendingCharge(ag))) return { ok: true, offerId: accepted.id, valor }
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
  opts?: {
    debtIds?: string[]
    eventId?: string
    primaryDebtId?: string | null
    /** QA rodada 5 (Q2-01): início da request do clique (epoch ms). Com ele, a
     *  cobrança só COMEÇA dentro de payChargeStartBudgetMs(). */
    requestStartedAt?: number
  },
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
    timed("offer", () => ensureIntegralOffer(ctx, debtIds)),
  ])
  if (!offer.ok) {
    await emitPayFailed(ctx, offer.error)
    return { ok: false, error: offer.error }
  }

  const chargeNotAfter =
    typeof opts?.requestStartedAt === "number" ? opts.requestStartedAt + payChargeStartBudgetMs() : null
  const r = await timed("payment_create", () =>
    paymentCreateOrExistingLink(ctx, offer.offerId, eventId, { summary: offer.summary, chargeNotAfter }),
  )

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

  // Resultado da ação como OUTCOME, ANTES de qualquer menu: bolha do link (com
  // ação/stage) + prompt pós-link; sem link resolvível (QAA1-02), outcome humano
  // + menu curto. Telemetria em paralelo. Na cobrança já existente, o valor da
  // copy é o da COBRANÇA (um acordo 3x cobra o total com desconto, não o rótulo
  // "Pagar R$ X" do menu).
  const [, delivered] = await timed("deliver", () => Promise.all([
    emitPayLinkReady(ctx, payment, { already_charged: alreadyCharged }),
    deliverPaymentOutcome(ctx, {
      payment,
      alreadyCharged,
      valor: alreadyCharged ? (payment?.total_value ?? offer.valor) : offer.valor,
      debtIds,
      primaryDebtId: opts?.primaryDebtId ?? ctx.debtId,
    }),
  ]))

  return {
    ok: true,
    link: delivered.link,
    valor: alreadyCharged ? (payment?.total_value ?? offer.valor) : offer.valor,
    vencimento_link: delivered.vencimentoLink,
    already_charged: alreadyCharged,
    processing: false,
    agreement_id: delivered.agreementId,
    post_prompt_id: delivered.postPromptId,
    prompt: delivered.prompt,
    link_message_id: delivered.linkMessageId ?? null,
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
