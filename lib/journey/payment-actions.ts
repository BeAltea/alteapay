// Ações de pagamento do papel B (N4/N5). Guard de idempotência SEMPRE.
//
// Variante A (payment_origin='platform', DEFAULT): a PLATAFORMA executa a
// cobrança. payment.create reutiliza EXATAMENTE o caminho de confirmAccept
// (guard duplo → closeAgreement → chargeQueue → acceptances + eventos). A
// cobrança ASAAS é async (worker); enquanto o link não chega, devolvemos
// {status:'processing', poll_after_ms}. NÃO se escreve um 2º caminho de charge.
//
// Variante B (payment_origin='n8n', DESLIGADA): o n8n cria a cobrança no ASAAS e
// só REGISTRA aqui via payment.record. Mesmo assim a plataforma aplica o guard
// ANTES e recusa registro cuja dívida já tenha cobrança viva
// (offer.rejected(reason='already_charged')). NUNCA aceita status pago (D6): a
// verdade do pagamento é o webhook ASAAS/sync — payment.record com status pago
// vira payment_claim.
//
// D6 inegociável: n8n registra cobrança criada (pending) e URLs, NÃO declara
// pagamento.

import { createServiceClient } from "@/lib/supabase/service"
import { findBlockingAgreement, findBlockingPayment, isTerminalAgreement } from "@/lib/asaas-idempotency"
import { getAsaasPaymentsForCustomer } from "@/lib/asaas"
import { resolveMatrixRow } from "@/lib/negotiation/matrix"
import { validateProposedTerms, type OfferTerms } from "@/lib/negotiation/offers"
import { applyOfferExpiry, buildAcceptSummary, confirmAccept, readConfirmGuards } from "./closing"
import { debtSummary, registerPaymentClaim, rejectOffer, type DebtSummary, type SessionCtx } from "./actions"
import { recordEvent } from "./events"
import { assertAcknowledgedForPayment } from "./acknowledgement"
import { timed } from "./server-timing"
import { isDebtSettled } from "./settled-state"

const PAID_STATUSES = new Set([
  "received", "confirmed", "paid", "RECEIVED", "CONFIRMED", "RECEIVED_IN_CASH",
])

const POLL_AFTER_MS = 3000

export interface PaymentDetails {
  agreement_id: string
  payment_id: string | null
  billing_type: string | null
  pix_copy_paste: string | null
  boleto_url: string | null
  boleto_line: string | null
  invoice_url: string | null
  due_date: string | null
  total_value: number | null // REAIS na base; a borda n8n converte p/ centavos
  installments: number | null
  /** QA rodada 6 (Q4r2-01): valor de CADA parcela (agreements.installment_amount). */
  installment_value?: number | null
}

export type PaymentCreateResult =
  | { ok: true; status: "created"; idempotent: boolean; payment: PaymentDetails }
  | { ok: true; status: "processing"; idempotent: boolean; agreement_id: string; poll_after_ms: number }
  | { ok: false; status: number; code: string; message: string }

async function loadTenantPaymentOrigin(companyId: string): Promise<"platform" | "n8n"> {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from("tenant_chat_config")
    .select("payment_origin")
    .eq("company_id", companyId)
    .maybeSingle()
  const fromEnv = process.env.PAYMENT_ORIGIN
  return (data?.payment_origin ?? fromEnv ?? "platform") as "platform" | "n8n"
}

async function fetchPaymentDetails(agreementId: string, companyId: string): Promise<PaymentDetails> {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from("agreements")
    .select(
      "id, asaas_payment_id, asaas_billing_type, asaas_pix_qrcode_url, asaas_boleto_url, asaas_invoice_url, asaas_payment_url, due_date, agreed_amount, installments, installment_amount",
    )
    .eq("id", agreementId)
    .eq("company_id", companyId)
    .maybeSingle()
  return paymentDetailsFromRow(agreementId, data as Record<string, any> | null)
}

/** PaymentDetails a partir da linha do acordo (mesmas colunas de fetchPaymentDetails). */
function paymentDetailsFromRow(agreementId: string, data: Record<string, any> | null): PaymentDetails {
  return {
    agreement_id: agreementId,
    payment_id: data?.asaas_payment_id ?? null,
    billing_type: data?.asaas_billing_type ?? null,
    pix_copy_paste: data?.asaas_pix_qrcode_url ?? null,
    boleto_url: data?.asaas_boleto_url ?? null,
    // A base não persiste a linha digitável do boleto; o cliente usa o boleto_url.
    boleto_line: null,
    invoice_url: data?.asaas_invoice_url ?? data?.asaas_payment_url ?? null,
    due_date: data?.due_date ?? null,
    total_value: data?.agreed_amount != null ? Number(data.agreed_amount) : null,
    installments: data?.installments ?? null,
    installment_value: data?.installment_amount != null ? Number(data.installment_amount) : null,
  }
}

/**
 * Idempotência por (session_id, offer_id) (§4.2): se já houve payment.create
 * para ESTA oferta nesta sessão, devolve o mesmo agreement/link. Reusa a prova
 * de aceite (negotiation_acceptances: offer_id → agreement_id).
 */
async function findExistingPaymentForOffer(
  ctx: SessionCtx,
  offerId: string,
): Promise<string | null> {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from("negotiation_acceptances")
    .select("agreement_id")
    .eq("company_id", ctx.companyId)
    .eq("session_id", ctx.sessionId)
    .eq("offer_id", offerId)
    .maybeSingle()
  return data?.agreement_id ?? null
}

export type MatrixCheck =
  | { ok: true }
  | { ok: false; code: "no_matrix_row" | "offer_outside_matrix"; error?: string }

/**
 * Revalida a oferta contra a matriz VIGENTE (D8/§3): o servidor é a autoridade.
 * A oferta foi gerada da matriz, mas a matriz pode ter mudado desde então; antes
 * de cobrar, os termos persistidos TÊM que caber na faixa atual (desconto/entrada/
 * parcelas/billing). Fora da matriz → 422 (offer_outside_matrix). Sem linha de
 * matriz para o (aging, valor) do débito → 422 (no_matrix_row). Isola por sessão.
 */
async function assertOfferWithinMatrix(
  ctx: SessionCtx,
  offerId: string,
  precomputedSummary?: DebtSummary,
): Promise<MatrixCheck> {
  const supabase = createServiceClient()
  // Latência (10-latencia.md): com o resumo já calculado pelo chamador, a faixa
  // da matriz não depende da oferta → as duas leituras correm em paralelo (a
  // decisão continua: sem oferta viva → ok; sem faixa → no_matrix_row).
  const matrixRowP = precomputedSummary
    ? resolveMatrixRow({
        companyId: ctx.companyId,
        agingDays: precomputedSummary.agingDays,
        debtValue: precomputedSummary.originalValue,
      })
    : null
  matrixRowP?.catch(() => {}) // lançamento só importa se a oferta estiver viva (abaixo)
  const { data: offer } = await supabase
    .from("negotiation_offers")
    .select("terms, status")
    .eq("id", offerId)
    .eq("session_id", ctx.sessionId)
    .maybeSingle()
  // Sem oferta ou já não apresentável: deixa o passo do buildAcceptSummary (409)
  // reportar; aqui só validamos a matriz para as ofertas ainda vivas.
  if (!offer?.terms) return { ok: true }

  // A1 (N-D1-1): reusa o debtSummary já calculado pelo chamador (payService).
  const row = matrixRowP
    ? await matrixRowP
    : await (async () => {
        const summary = await debtSummary(ctx)
        return resolveMatrixRow({
          companyId: ctx.companyId,
          agingDays: summary.agingDays,
          debtValue: summary.originalValue,
        })
      })()
  if (!row) return { ok: false, code: "no_matrix_row" }

  const verdict = validateProposedTerms(offer.terms as OfferTerms, row)
  if (!verdict.ok) return { ok: false, code: "offer_outside_matrix", error: verdict.error }
  return { ok: true }
}

/**
 * payment.create (papel A): converte uma oferta apresentada em cobrança pela
 * plataforma. O guard vive dentro de confirmAccept (nível local + ASAAS). Se a
 * cobrança ainda não voltou do worker, devolve status 'processing'.
 */
export interface PaymentCreateOpts {
  /** debtSummary já calculado (evita repetir 4 leituras + evento — N-D1-1). */
  summary?: DebtSummary
  /** QA rodada 5 (Q2-01): prazo (epoch ms) para a cobrança COMEÇAR — ver
   *  confirmAccept. Ausente = sem prazo (n8n/worker). */
  chargeNotAfter?: number | null
}

export async function paymentCreate(
  ctx: SessionCtx,
  offerId: string,
  eventId?: string,
  opts?: PaymentCreateOpts,
): Promise<PaymentCreateResult> {
  // Latência (14-latencia-pagar): TODAS as LEITURAS do payment.create correm
  // numa leva só — origem do tenant, idempotência (sessão, oferta), guard de
  // reconhecimento, quitação (F8-02), matriz vigente, resumo do aceite (sem
  // gravar) e as leituras do guard duplo D7 (local + ASAAS) com a dívida/cliente
  // do fechamento. Antes: 4 levas em série. As DECISÕES seguem exatamente a ordem
  // de antes, cada uma sobre o seu dado; nenhuma escrita acontece antes delas, e
  // os DOIS guards (local E ASAAS) terminam e passam antes do POST /payments.
  const matrixP = assertOfferWithinMatrix(ctx, offerId, opts?.summary)
  const preP = buildAcceptSummary(ctx, offerId, { readOnly: true })
  // Defensivo: sem a leitura antecipada (módulo substituído/indisponível), o
  // confirmAccept faz as leituras do guard ele mesmo, como antes.
  let guardP: Promise<Awaited<ReturnType<typeof readConfirmGuards>> | undefined>
  try {
    guardP = readConfirmGuards(ctx, offerId)
  } catch {
    guardP = Promise.resolve(undefined)
  }
  // aguardados só no ponto de decisão de cada um (sem rejeição solta até lá).
  matrixP.catch(() => {})
  preP.catch(() => {})
  guardP.catch(() => {})
  const [origin, existingAgreementId, ackGuard, debtPaid] = await timed("pre_checks", () => Promise.all([
    loadTenantPaymentOrigin(ctx.companyId),
    findExistingPaymentForOffer(ctx, offerId),
    assertAcknowledgedForPayment({
      companyId: ctx.companyId,
      sessionId: ctx.sessionId,
      debtId: ctx.debtId,
    }),
    // F8-02: dívida já quitada → nenhuma cobrança, nem o link da cobrança paga.
    isDebtSettled({ companyId: ctx.companyId, debtId: ctx.debtId, sessionId: ctx.sessionId }),
  ]))
  // Variante A é o ÚNICO caminho (D17/GATE R0). payment_origin != 'platform' →
  // 501 not_implemented (variante B fora do escopo desta onda).
  if (origin !== "platform") {
    return {
      ok: false,
      status: 501,
      code: "not_implemented",
      message: "payment.create só opera com payment_origin='platform' (variante A)",
    }
  }

  // F8-02: o guard de cobrança viva (confirmAccept) contava o acordo PAGO como
  // "já cobrado" e reentregava o link da cobrança paga ("cobrança ativa"); a
  // idempotência por oferta fazia o mesmo. Dívida quitada para aqui, antes dos dois.
  if (debtPaid) {
    return { ok: false, status: 409, code: "debt_paid", message: "dívida já quitada — nenhuma cobrança nova" }
  }

  // Idempotência por (session_id, offer_id) (§4.2): 2ª chamada devolve payload
  // IDÊNTICO (mesmo agreement/link) com idempotent:true, ZERO cobrança nova.
  // Acordo ainda sem cobrança (pending_charge: a 1ª request está criando ou
  // morreu no meio) → 'processing'; o poll reconcilia pela externalReference.
  if (existingAgreementId) {
    const details = await fetchPaymentDetails(existingAgreementId, ctx.companyId)
    if (!details.payment_id) {
      return { ok: true, status: "processing", idempotent: true, agreement_id: existingAgreementId, poll_after_ms: POLL_AFTER_MS }
    }
    return { ok: true, status: "created", idempotent: true, payment: details }
  }

  // Invariante do reconhecimento (§3): com acknowledged=false (ou sem resposta)
  // recusa a menos que allow_payment_without_acknowledgement=true.
  if (!ackGuard.ok) {
    await rejectOffer(ctx, offerId, "system", "debt_not_acknowledged", eventId)
    return {
      ok: false,
      status: 409,
      code: "debt_not_acknowledged",
      message: "dívida não reconhecida — pagamento bloqueado",
    }
  }

  // Revalida a oferta contra a matriz VIGENTE (§3): fora da matriz → 422.
  // O servidor decide — se a matriz mudou e a oferta não cabe mais, não cobra.
  // Em paralelo com o resumo do aceite (as duas só LEEM a oferta).
  const [matrix, pre] = await timed("matrix_summary", () => Promise.all([matrixP, preP]))
  if (!matrix.ok) {
    await rejectOffer(ctx, offerId, "system", matrix.code, eventId)
    return {
      ok: false,
      status: 422,
      code: matrix.code,
      message:
        matrix.code === "no_matrix_row"
          ? "não há condição de matriz vigente para este débito"
          : `oferta fora da matriz vigente (${matrix.error ?? "invalid"})`,
    }
  }

  // valida a oferta e termos (passo 1) para obter o termsHash (revalida matriz
  // vigente dentro de confirmAccept → closeAgreement).
  if (!pre.ok) {
    // leitura antecipada não grava: o 'expired' da oferta vencida é gravado aqui,
    // no mesmo ponto da decisão de antes.
    if (pre.expired) await applyOfferExpiry(offerId)
    return { ok: false, status: 409, code: pre.error, message: pre.error }
  }

  // `pre` já montado → confirmAccept NÃO refaz buildAcceptSummary (N-D1-1).
  // Leitura do guard com falha → undefined: o confirmAccept relê (nunca decide
  // sem os dois guards).
  const guardReads = await guardP.catch(() => undefined)
  const result = await confirmAccept({
    ctx, offerId, termsHash: pre.summary.termsHash, eventId, pre: pre.summary,
    chargeNotAfter: opts?.chargeNotAfter ?? null,
    returnPendingAudit: true,
    guardReads,
  })
  if (!result.ok) {
    if (result.error === "ALREADY_CHARGED") {
      return { ok: false, status: 409, code: "already_charged", message: "dívida já possui cobrança viva" }
    }
    if (result.error === "CHARGE_DEFERRED") {
      // QA rodada 5: nenhuma cobrança foi enviada ao ASAAS (prazo da função).
      return { ok: false, status: 503, code: "charge_deferred", message: "cobrança não iniciada (tempo esgotado); tente novamente" }
    }
    return { ok: false, status: 422, code: result.error, message: result.error }
  }

  // Latência: a linha do acordo gravada pelo write-back inline já traz as colunas
  // do link (mesmo shape de fetchPaymentDetails); sem ela, relê como antes. A
  // auditoria do fechamento termina em paralelo.
  const [details] = await Promise.all([
    result.chargeRow && result.chargeRow.id === result.agreementId
      ? Promise.resolve(paymentDetailsFromRow(result.agreementId, result.chargeRow))
      : fetchPaymentDetails(result.agreementId, ctx.companyId),
    result.pending ?? Promise.resolve(),
  ])
  // CHARGE_MODE='inline': closeAgreement já criou a cobrança e gravou as URLs de
  // forma síncrona → payment_id presente → devolvemos 'created' com o link agora.
  // CHARGE_MODE='queue' (Workers 0/0, D5): sem link ainda → 'processing'; a UI/n8n
  // faz polling até o worker gravar as URLs.
  if (!details.payment_id) {
    return { ok: true, status: "processing", idempotent: false, agreement_id: result.agreementId, poll_after_ms: POLL_AFTER_MS }
  }
  return { ok: true, status: "created", idempotent: false, payment: details }
}

export type PaymentCreateOrLink =
  | { ok: true; status: "created"; idempotent: boolean; payment: PaymentDetails }
  | { ok: true; status: "processing"; idempotent: boolean; agreement_id: string; poll_after_ms: number }
  // já existe cobrança viva (D7/D23): NÃO recria — devolve o LINK EXISTENTE
  // consultado por paymentStatus (acordo vivo do cliente). O front/n8n reenvia.
  | { ok: true; status: "already_charged"; payment: PaymentDetails | null; payment_status: string | null }
  | { ok: false; status: number; code: string; message: string }

/**
 * Ponto de entrada ÚNICO da cobrança para o n8n E para o caminho assistido: cria
 * a cobrança (paymentCreate, guard + matriz + reconhecimento) e, se a dívida já
 * tem cobrança viva (already_charged, D7/D23), consulta paymentStatus e devolve o
 * LINK EXISTENTE em vez de recriar. Garante que os dois caminhos FECHAM idêntico.
 */
export async function paymentCreateOrExistingLink(
  ctx: SessionCtx,
  offerId: string,
  eventId?: string,
  opts?: PaymentCreateOpts,
): Promise<PaymentCreateOrLink> {
  const r = await paymentCreate(ctx, offerId, eventId, opts)
  if (r.ok) return r
  if (r.code === "already_charged") {
    // Nunca cria 2ª cobrança: reenvia o link do acordo vivo (paymentStatus §4).
    const status = await paymentStatus(ctx)
    return {
      ok: true,
      status: "already_charged",
      payment: status.payment,
      payment_status: status.payment_status,
    }
  }
  return r
}

// ============================================================
// Borda n8n (contrato v2): valores monetários em INTEIROS de CENTAVOS.
// As colunas do banco permanecem em reais; a conversão é SÓ aqui.
// ============================================================
export const reaisToCents = (reais: number | null | undefined): number | null =>
  reais == null ? null : Math.round(reais * 100)

/** Mapeia PaymentDetails → campos da resposta n8n (total em CENTAVOS na borda). */
function paymentDetailsForN8n(
  p: PaymentDetails,
  billingType?: string | null,
): Record<string, unknown> {
  return {
    agreement_id: p.agreement_id,
    asaas_payment_id: p.payment_id,
    billing_type: p.billing_type ?? billingType ?? null,
    total_value: reaisToCents(p.total_value), // CENTAVOS
    installments: p.installments,
    due_date: p.due_date,
    invoice_url: p.invoice_url,
    pix_copy_paste: p.pix_copy_paste,
    pix_qr_code_url: p.pix_copy_paste,
    boleto_url: p.boleto_url,
    boleto_line: p.boleto_line,
  }
}

/**
 * Serializa o resultado do payment.create para o formato da resposta ao n8n
 * (Apêndice B.1). total_value em CENTAVOS. billing_type é opcional (args do n8n).
 */
export function paymentCreateResponseForN8n(
  result: PaymentCreateResult,
  billingType?: string | null,
): Record<string, unknown> {
  if (!result.ok) {
    return { ok: false, code: result.code, message: result.message }
  }
  if (result.status === "processing") {
    return {
      ok: true,
      idempotent: result.idempotent,
      status: "processing",
      agreement_id: result.agreement_id,
      poll_after_ms: result.poll_after_ms,
    }
  }
  return {
    ok: true,
    idempotent: result.idempotent,
    status: "created",
    ...paymentDetailsForN8n(result.payment, billingType),
  }
}

/**
 * Resposta n8n do ponto de entrada único (paymentCreateOrExistingLink): inclui o
 * caso `already_charged`, que devolve o LINK EXISTENTE (sem recriar cobrança).
 */
export function paymentCreateOrLinkResponseForN8n(
  result: PaymentCreateOrLink,
  billingType?: string | null,
): Record<string, unknown> {
  if (!result.ok) {
    return { ok: false, code: result.code, message: result.message }
  }
  if (result.status === "processing") {
    return {
      ok: true,
      idempotent: result.idempotent,
      status: "processing",
      agreement_id: result.agreement_id,
      poll_after_ms: result.poll_after_ms,
    }
  }
  if (result.status === "already_charged") {
    return {
      ok: true,
      idempotent: true,
      status: "already_charged",
      payment_status: result.payment_status,
      ...(result.payment ? paymentDetailsForN8n(result.payment, billingType) : {}),
    }
  }
  return {
    ok: true,
    idempotent: result.idempotent,
    status: "created",
    ...paymentDetailsForN8n(result.payment, billingType),
  }
}

/**
 * Guard independente para a variante B: recusa registro de cobrança para uma
 * dívida que já tenha cobrança viva (local + ASAAS). Espelha confirmAccept.
 */
async function isDebtAlreadyCharged(ctx: SessionCtx): Promise<boolean> {
  const supabase = createServiceClient()
  const { data: agreements } = await supabase
    .from("agreements")
    .select("id, asaas_payment_id, payment_status, asaas_status, status")
    .eq("customer_id", ctx.customerId)
    .eq("company_id", ctx.companyId)
    .not("asaas_payment_id", "is", null)
  if (findBlockingAgreement(agreements ?? [])) return true
  const { data: known } = await supabase
    .from("agreements")
    .select("asaas_customer_id")
    .eq("customer_id", ctx.customerId)
    .not("asaas_customer_id", "is", null)
    .limit(1)
  const asaasCustomerId = known?.[0]?.asaas_customer_id
  if (asaasCustomerId) {
    const payments = await getAsaasPaymentsForCustomer(asaasCustomerId)
    if (findBlockingPayment(payments)) return true
  }
  return false
}

export interface PaymentRecordArgs {
  offer_id?: string
  status?: string
  asaas_payment_id?: string
  billing_type?: string
  invoice_url?: string
  boleto_url?: string
  pix_copy_paste?: string
  due_date?: string
  total_value?: number
  installments?: number
}

export type PaymentRecordResult =
  | { ok: true; code: "recorded"; agreement_id: string }
  | { ok: true; code: "claim"; case_id: string }
  | { ok: false; status: number; code: string; message: string }

/**
 * payment.record (papel B, variante B DESLIGADA por padrão). NUNCA aceita status
 * pago: se o n8n disser "pago", vira payment_claim (D6) e emite
 * payment.claim_from_engine. Guard antes. Registra a cobrança PENDING + URLs.
 */
export async function paymentRecord(
  ctx: SessionCtx,
  args: PaymentRecordArgs,
  eventId?: string,
): Promise<PaymentRecordResult> {
  // D6: status pago vindo do fluxo NUNCA muda o acordo — vira claim.
  if (args.status && PAID_STATUSES.has(args.status)) {
    const caseId = await registerPaymentClaim(
      ctx,
      { paidAt: args.due_date, amount: args.total_value, channel: "n8n", note: "payment.record status=paid recusado (D6)" },
      "n8n",
      eventId,
    )
    await recordEvent({
      companyId: ctx.companyId, customerId: ctx.customerId, debtId: ctx.debtId,
      sessionId: ctx.sessionId, type: "payment_claim.registered", actor: "n8n",
      eventId: eventId ? `${eventId}:claim_from_engine` : undefined,
      payload: { case_id: caseId, source: "payment.claim_from_engine" },
    })
    return { ok: true, code: "claim", case_id: caseId }
  }

  // guard independente: dívida com cobrança viva recusa o registro.
  if (await isDebtAlreadyCharged(ctx)) {
    if (args.offer_id) await rejectOffer(ctx, args.offer_id, "n8n", "already_charged", eventId)
    return { ok: false, status: 409, code: "already_charged", message: "dívida já possui cobrança viva" }
  }

  const supabase = createServiceClient()
  const { data: debt } = await supabase
    .from("debts")
    .select("id, amount")
    .eq("id", ctx.debtId)
    .eq("company_id", ctx.companyId)
    .maybeSingle()
  if (!debt) return { ok: false, status: 404, code: "debt_not_found", message: "dívida não encontrada" }

  const originalAmount = Number(debt.amount ?? 0)
  const { data: agreement, error } = await supabase
    .from("agreements")
    .insert({
      debt_id: ctx.debtId,
      customer_id: ctx.customerId,
      company_id: ctx.companyId,
      original_amount: originalAmount,
      agreed_amount: args.total_value ?? originalAmount,
      installments: args.installments ?? 1,
      due_date: args.due_date ?? null,
      status: "active",
      payment_status: "pending", // SEMPRE pending — nunca pago aqui (D6)
      origin: "chat_journey",
      negotiation_session_id: ctx.sessionId,
      asaas_payment_id: args.asaas_payment_id ?? null,
      asaas_billing_type: args.billing_type ?? null,
      asaas_invoice_url: args.invoice_url ?? null,
      asaas_boleto_url: args.boleto_url ?? null,
      asaas_pix_qrcode_url: args.pix_copy_paste ?? null,
      attendant_name: "chat-journey-n8n",
      terms: `n8n payment.record session ${ctx.sessionId}`,
    })
    .select("id")
    .single()
  if (error || !agreement) {
    return { ok: false, status: 500, code: "record_failed", message: error?.message ?? "falha ao registrar" }
  }

  await supabase
    .from("negotiation_sessions")
    .update({ agreement_id: agreement.id, updated_at: new Date().toISOString() })
    .eq("id", ctx.sessionId)

  const base = { companyId: ctx.companyId, customerId: ctx.customerId, debtId: ctx.debtId, sessionId: ctx.sessionId, agreementId: agreement.id }
  await recordEvent({ ...base, eventId, type: "agreement.created", actor: "n8n" })
  await recordEvent({ ...base, type: "payment.generated", actor: "n8n", payload: { billing_type: args.billing_type, source: "n8n" } })

  return { ok: true, code: "recorded", agreement_id: agreement.id }
}

export interface PaymentStatusResult {
  agreement_id: string | null
  payment: PaymentDetails | null
  payment_status: string | null
  asaas_status: string | null
  /** true quando as URLs vêm de um acordo VIVO do cliente (não da sessão) —
   * é o caso already_charged: o front/n8n REENVIA este link em vez de cobrar. */
  from_live_charge?: boolean
}

/**
 * payment.status: estado + URLs da cobrança para a sessão (fonte = base local).
 *
 * §4: no caso `already_charged` a dívida já tem cobrança viva num acordo que
 * pode NÃO estar vinculado à sessão. Aqui, se a sessão não tem acordo próprio,
 * caímos no acordo VIVO do cliente (guard `findBlockingAgreement`) e devolvemos
 * as URLs (PIX/boleto/invoice) para o fluxo REENVIAR o link existente — nunca
 * gerar cobrança nova. ASAAS continua a fonte da verdade do pagamento.
 */
export async function paymentStatus(ctx: SessionCtx): Promise<PaymentStatusResult> {
  const supabase = createServiceClient()
  const { data: session } = await supabase
    .from("negotiation_sessions")
    .select("agreement_id")
    .eq("id", ctx.sessionId)
    .maybeSingle()
  const agreementId = session?.agreement_id ?? null

  if (agreementId) {
    const { data } = await supabase
      .from("agreements")
      .select("payment_status, asaas_status, status")
      .eq("id", agreementId)
      .eq("company_id", ctx.companyId)
      .maybeSingle()
    // A1 / N-D1-2: o acordo da sessão pode estar TERMINAL (cancelado no ASAAS,
    // reembolsado). Nesse caso ele NÃO é "a cobrança viva": cai na busca do
    // acordo vivo do cliente (abaixo) — nunca devolve link morto como 'ready'.
    if (data && !isTerminalAgreement(data)) {
      const payment = await fetchPaymentDetails(agreementId, ctx.companyId)
      return {
        agreement_id: agreementId,
        payment,
        payment_status: data?.payment_status ?? null,
        asaas_status: data?.asaas_status ?? null,
      }
    }
  }

  // Sem acordo (vivo) na sessão: procura o acordo VIVO do cliente
  // (already_charged) e devolve suas URLs para reenvio (§4). Isola por
  // customer_id + company_id. Acordos terminais nunca são "vivos".
  const { data: agreements } = await supabase
    .from("agreements")
    .select("id, asaas_payment_id, payment_status, asaas_status, status")
    .eq("customer_id", ctx.customerId)
    .eq("company_id", ctx.companyId)
    .not("asaas_payment_id", "is", null)
  const live = findBlockingAgreement(
    (agreements ?? []) as Array<{ id: string; asaas_payment_id: string | null; payment_status: string | null; asaas_status: string | null; status?: string | null }>,
  ) as { id?: string; payment_status?: string | null; asaas_status?: string | null } | null
  if (!live?.id) {
    return { agreement_id: null, payment: null, payment_status: null, asaas_status: null }
  }
  const payment = await fetchPaymentDetails(live.id, ctx.companyId)
  return {
    agreement_id: live.id,
    payment,
    payment_status: live.payment_status ?? null,
    asaas_status: live.asaas_status ?? null,
    from_live_charge: true,
  }
}

/** negotiation.note: anota uma observação estruturada no funil (auditoria). */
export async function negotiationNote(
  ctx: SessionCtx,
  note: Record<string, unknown>,
  eventId?: string,
): Promise<void> {
  await recordEvent({
    companyId: ctx.companyId, customerId: ctx.customerId, debtId: ctx.debtId,
    sessionId: ctx.sessionId, eventId, type: "chat.turn.assistant", actor: "n8n",
    payload: { note: true, ...note },
  })
}
