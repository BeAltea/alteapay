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
import { cancelChargelessAgreement, isPendingCharge, reconcilePendingCharge, type PendingChargeRow } from "./charge-reconcile"
import { timed } from "./server-timing"

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
  /** A1 (N-D1-1): resumo JÁ montado pelo chamador (paymentCreate) — evita o 2º
   *  buildAcceptSummary. Só é usado se o termsHash bater. */
  pre?: AcceptSummary
  /** QA rodada 5 (Q2-01): epoch ms após o qual a cobrança NÃO pode mais começar
   *  (teto da função). Antes do fechamento → CHARGE_DEFERRED sem escrita; dentro
   *  do inline, antes do POST /payments → acordo desfeito, CHARGE_DEFERRED. */
  chargeNotAfter?: number | null
}

export type ConfirmAcceptResult =
  | { ok: true; agreementId: string }
  | { ok: false; error: "OFFER_NOT_AVAILABLE" | "OFFER_EXPIRED" | "TERMS_CHANGED" | "ALREADY_CHARGED" | "CLOSE_FAILED" | "CHARGE_DEFERRED" }

const deadlinePassed = (notAfter: number | null | undefined) =>
  typeof notAfter === "number" && Date.now() > notAfter

export async function confirmAccept(input: ConfirmAcceptInput): Promise<ConfirmAcceptResult> {
  const { ctx } = input
  const supabase = createServiceClient()

  // QA rodada 5 (Q2-01 / latência): as leituras independentes do confirm correm
  // em PARALELO — aceite anterior, resumo (se não veio pronto), guard local e o
  // customer ASAAS conhecido. A ordem das DECISÕES não muda:
  //  1) aceite anterior da oferta → mesmo acordo (idempotência de reenvio; precisa
  //     vencer o buildAcceptSummary, que devolveria OFFER_NOT_AVAILABLE);
  //  2) resumo/termsHash; 3) guard D7 local; 4) guard D7 ASAAS.
  const preReady =
    input.pre && input.pre.offerId === input.offerId && input.pre.termsHash === input.termsHash
      ? ({ ok: true, summary: input.pre } as const)
      : null
  const [{ data: prevAccept }, preLoaded, { data: agreements }, { data: known }] = await timed("guard_local", () => Promise.all([
    supabase
      .from("negotiation_acceptances")
      .select("agreement_id")
      .eq("offer_id", input.offerId)
      .maybeSingle(),
    preReady ? Promise.resolve(preReady) : buildAcceptSummary(ctx, input.offerId),
    // guard D7, nível local (status/payment_status terminais têm precedência —
    // acordo cancelado/cobrança deletada NUNCA bloqueia, N-D1-2). Lê TODOS os
    // acordos do cliente nesta empresa: os com cobrança (bloqueio) e os
    // pending_charge da jornada (espelho sem cobrança — QA rodada 5).
    supabase
      .from("agreements")
      .select("id, asaas_payment_id, payment_status, asaas_status, status, origin, offer_id, negotiation_session_id, debt_id, created_at")
      .eq("customer_id", ctx.customerId)
      .eq("company_id", ctx.companyId),
    supabase
      .from("agreements")
      .select("asaas_customer_id")
      .eq("customer_id", ctx.customerId)
      .not("asaas_customer_id", "is", null)
      .limit(1),
  ]))
  if (prevAccept?.agreement_id) return { ok: true, agreementId: prevAccept.agreement_id }

  const pre = preLoaded
  if (!pre.ok) return { ok: false, error: pre.error as "OFFER_NOT_AVAILABLE" | "OFFER_EXPIRED" }
  if (pre.summary.termsHash !== input.termsHash) return { ok: false, error: "TERMS_CHANGED" }

  const rows = (agreements ?? []) as PendingChargeRow[]
  let blocked = Boolean(findBlockingAgreement(rows))
  // QA rodada 5: acordo da jornada à espera de cobrança (espelho gravado antes
  // do ASAAS; função pode ter morrido no meio). Reconcilia pela externalReference
  // ANTES de decidir — achou cobrança → bloqueia (o link é reenviado); ainda na
  // janela de graça → bloqueia (a request original pode estar criando); órfão
  // vencido e sem cobrança → cancelado e segue. Nunca 2ª cobrança.
  if (!blocked) {
    for (const ag of rows.filter(isPendingCharge)) {
      const outcome = await timed("reconcile", () => reconcilePendingCharge(ag, { force: true }))
      if (outcome === "linked" || outcome === "pending") {
        blocked = true
        break
      }
    }
  }
  // ---- guard D7, nível ASAAS (fonte da verdade)
  const asaasCustomerId = (known?.[0]?.asaas_customer_id as string | undefined) ?? null
  if (!blocked && asaasCustomerId) {
    const payments = await timed("guard_asaas", () => getAsaasPaymentsForCustomer(asaasCustomerId))
    blocked = Boolean(findBlockingPayment(payments))
  }
  if (blocked) {
    await rejectOffer(ctx, input.offerId, "system", "already_charged")
    return { ok: false, error: "ALREADY_CHARGED" }
  }

  // QA rodada 5 (Q2-01): passou do prazo para COMEÇAR a cobrança → não fecha
  // nada (zero escrita, oferta continua apresentada). O devedor tenta de novo.
  if (deadlinePassed(input.chargeNotAfter)) return { ok: false, error: "CHARGE_DEFERRED" }

  const now = new Date().toISOString()
  const ipHash = input.ip
    ? createHash("sha256").update(input.ip).digest("hex").slice(0, 32)
    : null

  // ---- agreement + cobrança pela função existente. O ESPELHO (prova do aceite
  //      offer→agreement, oferta aceita, sessão→acordo) é gravado em
  //      beforeCharge: DEPOIS do insert do acordo e ANTES do ASAAS (Q2-01). Se a
  //      função morrer durante/após o POST, o clique repetido e o poll acham o
  //      acordo pela sessão/oferta e reconciliam pela externalReference.
  const closed = await timed("close", () => closeAgreement({
    company_id: ctx.companyId,
    debt_id: ctx.debtId,
    offer_id: "journey",
    origin: `chat-journey session ${ctx.sessionId}`,
    channel: "journey",
    customer_id_hint: ctx.customerId,
    charge: { notAfter: input.chargeNotAfter ?? null, knownAsaasCustomerId: asaasCustomerId },
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
    beforeCharge: async (agreementId) => {
      const [acc] = await Promise.all([
        supabase.from("negotiation_acceptances").insert({
          company_id: ctx.companyId,
          session_id: ctx.sessionId,
          offer_id: input.offerId,
          agreement_id: agreementId,
          ip_hash: ipHash,
          user_agent: input.userAgent ?? null,
          terms_hash: pre.summary.termsHash,
          summary_snapshot: { terms: pre.summary.terms, valid_until: pre.summary.validUntil },
        }),
        supabase.from("negotiation_offers")
          .update({ status: "accepted", responded_at: now })
          .eq("id", input.offerId),
        supabase.from("negotiation_sessions")
          .update({ agreement_id: agreementId, updated_at: now })
          .eq("id", ctx.sessionId),
      ])
      const accErr = (acc as { error?: { message?: string } | null }).error
      if (accErr) throw new Error(`acceptance insert: ${accErr.message ?? "erro"}`)
    },
  }))
  if (!closed.ok) {
    console.error("[journey] closeAgreement falhou:", closed.error)
    return { ok: false, error: "CLOSE_FAILED" }
  }

  if (closed.charge_status === "not_started") {
    // Nenhum POST de cobrança chegou ao ASAAS (prazo ou espelho falhou): desfaz o
    // espelho para o próximo clique seguir o caminho normal (oferta de novo
    // 'presented', sem aceite, sessão sem este acordo, acordo cancelado).
    await undoChargelessClose(ctx, input.offerId, closed.agreement_id)
    return { ok: false, error: "CHARGE_DEFERRED" }
  }

  const base = {
    companyId: ctx.companyId, customerId: ctx.customerId, debtId: ctx.debtId,
    sessionId: ctx.sessionId, agreementId: closed.agreement_id,
  }
  // demais ofertas superseded + eventos em PARALELO (independentes; latência).
  await timed("close_events", () => Promise.all([
    supabase.from("negotiation_offers")
      .update({ status: "superseded", responded_at: now })
      .eq("session_id", ctx.sessionId)
      .eq("status", "presented")
      .neq("id", input.offerId)
      .then(() => {}, () => {}),
    recordEvent({ ...base, eventId: input.eventId, type: "offer.accepted", actor: "customer", payload: { offer_id: input.offerId } }),
    recordEvent({ ...base, type: "agreement.created", actor: "system" }),
    recordEvent({ ...base, type: "payment.generated", actor: "system", payload: { billing_type: pre.summary.terms.billing_type, installments: pre.summary.terms.installments } }),
  ]))

  return { ok: true, agreementId: closed.agreement_id }
}

/**
 * QA rodada 5 — desfaz um fechamento cuja cobrança NUNCA foi enviada ao ASAAS
 * (charge_status 'not_started'). Best-effort, nunca lança.
 */
async function undoChargelessClose(ctx: SessionCtx, offerId: string, agreementId: string): Promise<void> {
  const supabase = createServiceClient()
  try {
    await Promise.all([
      cancelChargelessAgreement({ id: agreementId, debt_id: ctx.debtId }, "charge_not_started"),
      supabase.from("negotiation_acceptances").delete().eq("agreement_id", agreementId).eq("offer_id", offerId),
      supabase.from("negotiation_offers")
        .update({ status: "presented", responded_at: null })
        .eq("id", offerId)
        .eq("status", "accepted"),
      supabase.from("negotiation_sessions")
        .update({ agreement_id: null, updated_at: new Date().toISOString() })
        .eq("id", ctx.sessionId)
        .eq("agreement_id", agreementId),
    ])
  } catch (err) {
    console.warn("[journey] undoChargelessClose falhou:", (err as Error).message)
  }
}
