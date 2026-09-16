// Ações de domínio da jornada (F3.5). TODAS deduplicam por eventId (via
// journey_events.event_id UNIQUE) e registram jornada. O servidor é a
// autoridade: ofertas saem da matriz; entrada de IA/n8n é sugestão validada.

import { createServiceClient } from "@/lib/supabase/service"
import { agingDays } from "@/lib/negotiation/config"
import { resolveMatrixRow } from "@/lib/negotiation/matrix"
import {
  generateOfferTerms, persistOffer, validateProposedTerms,
  type OfferTerms,
} from "@/lib/negotiation/offers"
import { recordEvent, type JourneyActor } from "./events"
import { addSuppression } from "./suppressions"

export interface SessionCtx {
  sessionId: string
  companyId: string
  customerId: string
  debtId: string
}

export async function loadSessionCtx(sessionId: string): Promise<SessionCtx | null> {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from("negotiation_sessions")
    .select("id, company_id, customer_id, debt_id, outcome")
    .eq("id", sessionId)
    .maybeSingle()
  if (!data || !data.customer_id || !data.debt_id) return null
  return {
    sessionId: data.id, companyId: data.company_id,
    customerId: data.customer_id, debtId: data.debt_id,
  }
}

// ---------- debt.summary ----------
export interface DebtSummary {
  debtId: string
  creditorName: string
  originalValue: number
  agingDays: number
  oldestDueDate: string | null
  invoices: Array<{ invoice: string; due_date: string; value: number }>
}

export async function debtSummary(ctx: SessionCtx): Promise<DebtSummary> {
  const supabase = createServiceClient()
  const { data: debt } = await supabase
    .from("debts")
    .select("id, amount, due_date, description, company_id")
    .eq("id", ctx.debtId)
    .single()
  const { data: company } = await supabase
    .from("companies").select("name").eq("id", ctx.companyId).single()
  const { data: customer } = await supabase
    .from("customers").select("document").eq("id", ctx.customerId).single()
  const doc = (customer?.document ?? "").replace(/\D/g, "")
  const { data: invoices } = await supabase
    .from("vmax_invoices")
    .select("fatura, vencimento, saldo")
    .eq("id_company", ctx.companyId)
    .eq("doc", doc)
    .order("vencimento", { ascending: true })
  const oldest = invoices?.[0]?.vencimento ?? debt?.due_date ?? null
  await recordEvent({
    companyId: ctx.companyId, customerId: ctx.customerId, debtId: ctx.debtId,
    sessionId: ctx.sessionId, type: "debt.viewed", actor: "customer",
  })
  return {
    debtId: ctx.debtId,
    creditorName: company?.name ?? "",
    originalValue: Number(debt?.amount ?? 0),
    agingDays: oldest ? agingDays(oldest) : 0,
    oldestDueDate: oldest,
    invoices: (invoices ?? []).map((i) => ({
      invoice: i.fatura, due_date: i.vencimento, value: Number(i.saldo),
    })),
  }
}

// ---------- offer.list (gera se não houver; expiração lazy) ----------
export interface ListedOffer { id: string; terms: OfferTerms; valid_until: string | null }

export async function listOffers(ctx: SessionCtx): Promise<ListedOffer[]> {
  const supabase = createServiceClient()
  const now = new Date().toISOString()
  // expiração lazy
  const { data: expired } = await supabase
    .from("negotiation_offers")
    .update({ status: "expired", responded_at: now })
    .eq("session_id", ctx.sessionId)
    .eq("status", "presented")
    .lt("valid_until", now)
    .select("id")
  for (const e of expired ?? []) {
    await recordEvent({
      companyId: ctx.companyId, customerId: ctx.customerId, debtId: ctx.debtId,
      sessionId: ctx.sessionId, type: "offer.expired", actor: "system",
      payload: { offer_id: e.id },
    })
  }
  const { data: current } = await supabase
    .from("negotiation_offers")
    .select("id, terms, valid_until")
    .eq("session_id", ctx.sessionId)
    .eq("status", "presented")
    .order("created_at", { ascending: true })
  if (current && current.length > 0) {
    return current.map((o) => ({ id: o.id, terms: o.terms as OfferTerms, valid_until: o.valid_until }))
  }
  // gerar da matriz
  const summary = await debtSummary(ctx)
  const row = await resolveMatrixRow({
    companyId: ctx.companyId, agingDays: summary.agingDays, debtValue: summary.originalValue,
  })
  if (!row) return []
  const firstDue = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10)
  const validUntil = new Date(Date.now() + row.proposal_validity_days * 86400_000).toISOString()
  const out: ListedOffer[] = []
  for (const terms of generateOfferTerms(summary.originalValue, row, firstDue)) {
    const id = await persistOffer({
      companyId: ctx.companyId, sessionId: ctx.sessionId, customerId: ctx.customerId,
      debtId: ctx.debtId, matrixId: row.id, source: "system", status: "presented",
      terms, validUntil,
    })
    await recordEvent({
      companyId: ctx.companyId, customerId: ctx.customerId, debtId: ctx.debtId,
      sessionId: ctx.sessionId, type: "offer.presented", actor: "system",
      payload: { offer_id: id, installments: terms.installments, total: terms.total_value },
    })
    out.push({ id, terms, valid_until: validUntil })
  }
  return out
}

// ---------- offer.propose (sugestão de IA/cliente; validada) ----------
export async function proposeOffer(
  ctx: SessionCtx, terms: OfferTerms, actor: JourneyActor, eventId?: string,
): Promise<{ ok: boolean; offerId: string; error?: string }> {
  const summary = await debtSummary(ctx)
  const row = await resolveMatrixRow({
    companyId: ctx.companyId, agingDays: summary.agingDays, debtValue: summary.originalValue,
  })
  if (!row) return { ok: false, offerId: "", error: "NO_MATRIX_ROW" }
  const verdict = validateProposedTerms(terms, row)
  const validUntil = new Date(Date.now() + row.proposal_validity_days * 86400_000).toISOString()
  const offerId = await persistOffer({
    companyId: ctx.companyId, sessionId: ctx.sessionId, customerId: ctx.customerId,
    debtId: ctx.debtId, matrixId: row.id,
    source: actor === "n8n" || actor === "ai" ? "ai" : "customer",
    status: verdict.ok ? "presented" : "invalid",
    terms, validUntil: verdict.ok ? validUntil : null,
    validationError: verdict.ok ? null : verdict.error,
  })
  await recordEvent({
    companyId: ctx.companyId, customerId: ctx.customerId, debtId: ctx.debtId,
    sessionId: ctx.sessionId, eventId,
    type: verdict.ok ? "offer.presented" : "offer.invalid", actor,
    payload: { offer_id: offerId, error: verdict.ok ? undefined : verdict.error },
  })
  return verdict.ok ? { ok: true, offerId } : { ok: false, offerId, error: verdict.error }
}

// ---------- offer.reject ----------
export async function rejectOffer(
  ctx: SessionCtx, offerId: string, actor: JourneyActor, reason?: string, eventId?: string,
): Promise<void> {
  const supabase = createServiceClient()
  await supabase
    .from("negotiation_offers")
    .update({ status: "rejected", responded_at: new Date().toISOString(), rejection_reason: reason ?? null })
    .eq("id", offerId)
    .eq("session_id", ctx.sessionId)
    .eq("status", "presented")
  await recordEvent({
    companyId: ctx.companyId, customerId: ctx.customerId, debtId: ctx.debtId,
    sessionId: ctx.sessionId, eventId, type: "offer.rejected", actor,
    payload: { offer_id: offerId, reason },
  })
}

// ---------- casos: dispute / payment_claim / human ----------
async function openCase(
  ctx: SessionCtx,
  type: "dispute" | "payment_claim" | "human_handoff",
  details: Record<string, unknown>,
): Promise<string> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from("negotiation_cases")
    .insert({
      company_id: ctx.companyId, session_id: ctx.sessionId,
      customer_id: ctx.customerId, debt_id: ctx.debtId,
      type, details,
    })
    .select("id")
    .single()
  if (error) throw new Error(`openCase: ${error.message}`)
  return data.id
}

export async function registerDispute(
  ctx: SessionCtx, details: Record<string, unknown>, actor: JourneyActor, eventId?: string,
): Promise<string> {
  const caseId = await openCase(ctx, "dispute", details)
  await addSuppression({
    companyId: ctx.companyId, scope: "debt", debtId: ctx.debtId,
    customerId: ctx.customerId, channel: "all", reason: "dispute", source: "chat",
  })
  await recordEvent({
    companyId: ctx.companyId, customerId: ctx.customerId, debtId: ctx.debtId,
    sessionId: ctx.sessionId, eventId, type: "dispute.registered", actor,
    payload: { case_id: caseId },
  })
  return caseId
}

export async function registerPaymentClaim(
  ctx: SessionCtx,
  details: { paidAt?: string; amount?: number; channel?: string; note?: string },
  actor: JourneyActor, eventId?: string,
): Promise<string> {
  const caseId = await openCase(ctx, "payment_claim", details)
  await recordEvent({
    companyId: ctx.companyId, customerId: ctx.customerId, debtId: ctx.debtId,
    sessionId: ctx.sessionId, eventId, type: "payment_claim.registered", actor,
    payload: { case_id: caseId },
  })
  return caseId
}

export async function transferToHuman(
  ctx: SessionCtx, reason: string, actor: JourneyActor, eventId?: string,
): Promise<string> {
  const supabase = createServiceClient()
  const caseId = await openCase(ctx, "human_handoff", { reason })
  await addSuppression({
    companyId: ctx.companyId, scope: "customer", customerId: ctx.customerId,
    channel: "all", reason: "human", source: "chat",
  })
  await recordEvent({
    companyId: ctx.companyId, customerId: ctx.customerId, debtId: ctx.debtId,
    sessionId: ctx.sessionId, eventId, type: "human.transfer", actor,
    payload: { case_id: caseId, reason },
  })
  // aviso por e-mail (fila existente) — melhor esforço
  try {
    const { data: cfg } = await supabase
      .from("tenant_chat_config")
      .select("creditor_notification_emails")
      .eq("company_id", ctx.companyId)
      .maybeSingle()
    const emails: string[] = cfg?.creditor_notification_emails ?? []
    if (emails.length > 0) {
      const { sendEmail } = await import("@/lib/notifications/email")
      await sendEmail({
        to: emails,
        subject: "[AlteaPay] Atendimento humano solicitado em negociação",
        html: `<p>Um cliente solicitou atendimento humano.</p><p>Caso: ${caseId}</p><p>Motivo: ${reason}</p>`,
      })
    }
  } catch (err) {
    console.warn("[journey] aviso de handoff falhou:", (err as Error).message)
  }
  return caseId
}

// ---------- session.close ----------
export async function closeSession(
  ctx: SessionCtx, outcome: string, actor: JourneyActor, eventId?: string,
): Promise<void> {
  const supabase = createServiceClient()
  await supabase
    .from("negotiation_sessions")
    .update({ outcome, updated_at: new Date().toISOString() })
    .eq("id", ctx.sessionId)
  await recordEvent({
    companyId: ctx.companyId, customerId: ctx.customerId, debtId: ctx.debtId,
    sessionId: ctx.sessionId, eventId, type: "session.closed", actor,
    payload: { outcome },
  })
}
