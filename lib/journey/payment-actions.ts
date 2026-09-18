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
import { findBlockingAgreement, findBlockingPayment } from "@/lib/asaas-idempotency"
import { getAsaasPaymentsForCustomer } from "@/lib/asaas"
import { buildAcceptSummary, confirmAccept } from "./closing"
import { registerPaymentClaim, rejectOffer, type SessionCtx } from "./actions"
import { recordEvent } from "./events"

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
  invoice_url: string | null
  due_date: string | null
  total_value: number | null
  installments: number | null
}

export type PaymentCreateResult =
  | { ok: true; status: "created"; payment: PaymentDetails }
  | { ok: true; status: "processing"; agreement_id: string; poll_after_ms: number }
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
      "id, asaas_payment_id, asaas_billing_type, asaas_pix_qrcode_url, asaas_boleto_url, asaas_invoice_url, asaas_payment_url, due_date, agreed_amount, installments",
    )
    .eq("id", agreementId)
    .eq("company_id", companyId)
    .maybeSingle()
  return {
    agreement_id: agreementId,
    payment_id: data?.asaas_payment_id ?? null,
    billing_type: data?.asaas_billing_type ?? null,
    pix_copy_paste: data?.asaas_pix_qrcode_url ?? null,
    boleto_url: data?.asaas_boleto_url ?? null,
    invoice_url: data?.asaas_invoice_url ?? data?.asaas_payment_url ?? null,
    due_date: data?.due_date ?? null,
    total_value: data?.agreed_amount != null ? Number(data.agreed_amount) : null,
    installments: data?.installments ?? null,
  }
}

/**
 * payment.create (papel A): converte uma oferta apresentada em cobrança pela
 * plataforma. O guard vive dentro de confirmAccept (nível local + ASAAS). Se a
 * cobrança ainda não voltou do worker, devolve status 'processing'.
 */
export async function paymentCreate(
  ctx: SessionCtx,
  offerId: string,
  eventId?: string,
): Promise<PaymentCreateResult> {
  const origin = await loadTenantPaymentOrigin(ctx.companyId)
  if (origin === "n8n") {
    // Variante B ligada: a plataforma NÃO cria a cobrança — o n8n cria e
    // registra via payment.record. payment.create fica indisponível.
    return { ok: false, status: 409, code: "payment_origin_n8n", message: "payment.create indisponível em payment_origin=n8n; use payment.record" }
  }

  // valida a oferta e termos (passo 1) para obter o termsHash
  const pre = await buildAcceptSummary(ctx, offerId)
  if (!pre.ok) {
    const status = pre.error === "OFFER_EXPIRED" ? 409 : 409
    return { ok: false, status, code: pre.error, message: pre.error }
  }

  const result = await confirmAccept({ ctx, offerId, termsHash: pre.summary.termsHash, eventId })
  if (!result.ok) {
    if (result.error === "ALREADY_CHARGED") {
      return { ok: false, status: 409, code: "already_charged", message: "dívida já possui cobrança viva" }
    }
    return { ok: false, status: 422, code: result.error, message: result.error }
  }

  const details = await fetchPaymentDetails(result.agreementId, ctx.companyId)
  // Workers 0/0 (D5): sem link ainda → processing; a UI/n8n faz polling.
  if (!details.payment_id) {
    return { ok: true, status: "processing", agreement_id: result.agreementId, poll_after_ms: POLL_AFTER_MS }
  }
  return { ok: true, status: "created", payment: details }
}

/**
 * Guard independente para a variante B: recusa registro de cobrança para uma
 * dívida que já tenha cobrança viva (local + ASAAS). Espelha confirmAccept.
 */
async function isDebtAlreadyCharged(ctx: SessionCtx): Promise<boolean> {
  const supabase = createServiceClient()
  const { data: agreements } = await supabase
    .from("agreements")
    .select("id, asaas_payment_id, payment_status, asaas_status")
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
    .select("id, current_amount, amount")
    .eq("id", ctx.debtId)
    .eq("company_id", ctx.companyId)
    .maybeSingle()
  if (!debt) return { ok: false, status: 404, code: "debt_not_found", message: "dívida não encontrada" }

  const originalAmount = Number(debt.current_amount ?? debt.amount ?? 0)
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
}

/** payment.status: estado atual da cobrança do acordo da sessão (fonte = base local). */
export async function paymentStatus(ctx: SessionCtx): Promise<PaymentStatusResult> {
  const supabase = createServiceClient()
  const { data: session } = await supabase
    .from("negotiation_sessions")
    .select("agreement_id")
    .eq("id", ctx.sessionId)
    .maybeSingle()
  const agreementId = session?.agreement_id ?? null
  if (!agreementId) return { agreement_id: null, payment: null, payment_status: null, asaas_status: null }

  const { data } = await supabase
    .from("agreements")
    .select("payment_status, asaas_status")
    .eq("id", agreementId)
    .eq("company_id", ctx.companyId)
    .maybeSingle()
  const payment = await fetchPaymentDetails(agreementId, ctx.companyId)
  return {
    agreement_id: agreementId,
    payment,
    payment_status: data?.payment_status ?? null,
    asaas_status: data?.asaas_status ?? null,
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
