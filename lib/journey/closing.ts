// Fechamento da negociação em DOIS passos (F3.7): resumo → confirm.
// No confirm: guard de idempotência (D7, dois níveis) → agreement pela MESMA
// função do fluxo atual (closeAgreement com bloco journey) → prova do aceite
// em negotiation_acceptances → eventos → demais ofertas superseded.

import { createHash } from "node:crypto"
import { createServiceClient } from "@/lib/supabase/service"
import { findBlockingAgreement, findBlockingPayment } from "@/lib/asaas-idempotency"
import { getAsaasPaymentsForCustomer } from "@/lib/asaas"
import { closeAgreement } from "@/lib/negotiation/close-agreement"
import type { OfferTerms } from "@/lib/negotiation/offers"
import { recordEvent } from "./events"
import { rejectOffer, type SessionCtx } from "./actions"

export interface AcceptSummary {
  offerId: string
  terms: OfferTerms
  validUntil: string | null
  creditorName: string
  termsHash: string
}

const termsHash = (terms: OfferTerms) =>
  createHash("sha256").update(JSON.stringify(terms)).digest("hex")

/** Passo 1: monta o resumo para a UI (não escreve nada além do evento). */
export async function buildAcceptSummary(
  ctx: SessionCtx, offerId: string,
): Promise<{ ok: true; summary: AcceptSummary } | { ok: false; error: string }> {
  const supabase = createServiceClient()
  const { data: offer } = await supabase
    .from("negotiation_offers")
    .select("id, terms, valid_until, status")
    .eq("id", offerId)
    .eq("session_id", ctx.sessionId)
    .maybeSingle()
  if (!offer || offer.status !== "presented") return { ok: false, error: "OFFER_NOT_AVAILABLE" }
  if (offer.valid_until && new Date(offer.valid_until) < new Date()) {
    await supabase.from("negotiation_offers").update({ status: "expired" }).eq("id", offerId)
    return { ok: false, error: "OFFER_EXPIRED" }
  }
  const { data: company } = await supabase
    .from("companies").select("name").eq("id", ctx.companyId).single()
  return {
    ok: true,
    summary: {
      offerId,
      terms: offer.terms as OfferTerms,
      validUntil: offer.valid_until,
      creditorName: company?.name ?? "",
      termsHash: termsHash(offer.terms as OfferTerms),
    },
  }
}

export interface ConfirmAcceptInput {
  ctx: SessionCtx
  offerId: string
  termsHash: string // do passo 1 — garante que o cliente confirmou ESTES termos
  ip?: string | null
  userAgent?: string | null
  eventId?: string
}

export type ConfirmAcceptResult =
  | { ok: true; agreementId: string }
  | { ok: false; error: "OFFER_NOT_AVAILABLE" | "OFFER_EXPIRED" | "TERMS_CHANGED" | "ALREADY_CHARGED" | "CLOSE_FAILED" }

export async function confirmAccept(input: ConfirmAcceptInput): Promise<ConfirmAcceptResult> {
  const { ctx } = input
  const supabase = createServiceClient()
  const pre = await buildAcceptSummary(ctx, input.offerId)
  if (!pre.ok) return { ok: false, error: pre.error as "OFFER_NOT_AVAILABLE" | "OFFER_EXPIRED" }
  if (pre.summary.termsHash !== input.termsHash) return { ok: false, error: "TERMS_CHANGED" }

  // idempotência de reenvio do confirm: aceite já registrado para esta oferta
  const { data: prevAccept } = await supabase
    .from("negotiation_acceptances")
    .select("agreement_id")
    .eq("offer_id", input.offerId)
    .maybeSingle()
  if (prevAccept?.agreement_id) return { ok: true, agreementId: prevAccept.agreement_id }

  // ---- guard D7, nível local
  const { data: agreements } = await supabase
    .from("agreements")
    .select("id, asaas_payment_id, payment_status, asaas_status")
    .eq("customer_id", ctx.customerId)
    .eq("company_id", ctx.companyId)
    .not("asaas_payment_id", "is", null)
  let blocked = Boolean(findBlockingAgreement(agreements ?? []))
  // ---- guard D7, nível ASAAS (fonte da verdade)
  if (!blocked) {
    const { data: known } = await supabase
      .from("agreements")
      .select("asaas_customer_id")
      .eq("customer_id", ctx.customerId)
      .not("asaas_customer_id", "is", null)
      .limit(1)
    const asaasCustomerId = known?.[0]?.asaas_customer_id
    if (asaasCustomerId) {
      const payments = await getAsaasPaymentsForCustomer(asaasCustomerId)
      blocked = Boolean(findBlockingPayment(payments))
    }
  }
  if (blocked) {
    await rejectOffer(ctx, input.offerId, "system", "already_charged")
    return { ok: false, error: "ALREADY_CHARGED" }
  }

  // ---- agreement + cobrança pela função existente
  const closed = await closeAgreement({
    company_id: ctx.companyId,
    debt_id: ctx.debtId,
    offer_id: "journey",
    origin: `chat-journey session ${ctx.sessionId}`,
    channel: "journey",
    journey: {
      session_id: ctx.sessionId,
      offer_row_id: input.offerId,
      terms: {
        total_value: pre.summary.terms.total_value,
        installments: pre.summary.terms.installments,
        installment_value: pre.summary.terms.installment_value,
        billing_type: pre.summary.terms.billing_type,
        first_due_date: pre.summary.terms.first_due_date,
      },
      valid_until: pre.summary.validUntil,
    },
  })
  if (!closed.ok) {
    console.error("[journey] closeAgreement falhou:", closed.error)
    return { ok: false, error: "CLOSE_FAILED" }
  }

  const now = new Date().toISOString()
  const ipHash = input.ip
    ? createHash("sha256").update(input.ip).digest("hex").slice(0, 32)
    : null
  await supabase.from("negotiation_acceptances").insert({
    company_id: ctx.companyId,
    session_id: ctx.sessionId,
    offer_id: input.offerId,
    agreement_id: closed.agreement_id,
    ip_hash: ipHash,
    user_agent: input.userAgent ?? null,
    terms_hash: pre.summary.termsHash,
    summary_snapshot: { terms: pre.summary.terms, valid_until: pre.summary.validUntil },
  })
  await supabase.from("negotiation_offers")
    .update({ status: "accepted", responded_at: now })
    .eq("id", input.offerId)
  await supabase.from("negotiation_offers")
    .update({ status: "superseded", responded_at: now })
    .eq("session_id", ctx.sessionId)
    .eq("status", "presented")
  await supabase.from("negotiation_sessions")
    .update({ agreement_id: closed.agreement_id, updated_at: now })
    .eq("id", ctx.sessionId)

  const base = {
    companyId: ctx.companyId, customerId: ctx.customerId, debtId: ctx.debtId,
    sessionId: ctx.sessionId, agreementId: closed.agreement_id,
  }
  await recordEvent({ ...base, eventId: input.eventId, type: "offer.accepted", actor: "customer", payload: { offer_id: input.offerId } })
  await recordEvent({ ...base, type: "agreement.created", actor: "system" })
  await recordEvent({ ...base, type: "payment.generated", actor: "system", payload: { billing_type: pre.summary.terms.billing_type, installments: pre.summary.terms.installments } })

  return { ok: true, agreementId: closed.agreement_id }
}
