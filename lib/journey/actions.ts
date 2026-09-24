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

/**
 * R15 — nome do cedente para a copy do devedor (mensagens de handoff / já paguei).
 * Precedência CANÔNICA (idêntica a buildAckContext, §0 da copy): branding.brand_name
 * › companies.name (VMAX) › "Credor". Nunca AlteaPay como responsável pela dívida,
 * nunca "empresa credora"/"null"/terceiro (anti-GNLink). NUNCA lança: em qualquer
 * falha de I/O cai no genérico "Credor" (rede de segurança, não estado de operação).
 * `hasRealName=false` sinaliza ao chamador que caiu no genérico (para alerta de dado).
 */
export interface CreditorName {
  name: string
  hasRealName: boolean
}

export async function resolveCreditorName(input: {
  companyId: string
}): Promise<CreditorName> {
  try {
    const supabase = createServiceClient()
    const { data: company } = await supabase
      .from("companies")
      .select("name")
      .eq("id", input.companyId)
      .maybeSingle()
    const { data: cfg } = await supabase
      .from("tenant_chat_config")
      .select("branding")
      .eq("company_id", input.companyId)
      .maybeSingle()
    const branding = (cfg?.branding ?? {}) as Record<string, unknown>
    const brandName =
      typeof branding.brand_name === "string" && branding.brand_name.trim().length > 0
        ? branding.brand_name.trim()
        : ""
    const companyName =
      typeof company?.name === "string" && company.name.trim().length > 0
        ? company.name.trim()
        : ""
    const real = brandName || companyName
    return real ? { name: real, hasRealName: true } : { name: "Credor", hasRealName: false }
  } catch {
    return { name: "Credor", hasRealName: false }
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
  // R15: nome do cedente pela precedência canônica (branding › companies.name ›
  // "Credor"). Nunca "" — cair em vazio deixava o resumo sem cedente identificado.
  const creditor = await resolveCreditorName({ companyId: ctx.companyId })
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
    creditorName: creditor.name,
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

/**
 * R2 — copy de confirmação da transferência ao atendimento (nunca silêncio/"Sessão
 * encerrada" seca). NOMEIA o canal (WhatsApp AlteaPay) e a expectativa de contato,
 * SEM prometer prazo que não podemos cumprir e SEM expor número em claro (o número
 * real do WhatsApp AlteaPay não foi fornecido — mensagem de fallback segura).
 * D36: sem ameaça; dúvidas sobre a origem do débito ficam com o cedente ({credor}).
 * `creditorName` já vem resolvido pela precedência canônica (R15). Sem PII.
 */
export function humanHandoffReply(creditorName: string): string {
  return (
    "Certo. Vou encaminhar você ao nosso atendimento. " +
    "Em breve a nossa equipe entra em contato com você pelo WhatsApp da AlteaPay. " +
    `Dúvidas sobre a origem do débito são com a ${creditorName}. ` +
    "Se você já pagou, é só desconsiderar esta mensagem."
  )
}

export async function transferToHuman(
  ctx: SessionCtx, reason: string, actor: JourneyActor, eventId?: string,
): Promise<string> {
  const supabase = createServiceClient()
  const caseId = await openCase(ctx, "human_handoff", { reason })

  // R2 (N-01 ALTO): ANTES de suprimir/encerrar, persistir uma MENSAGEM ao devedor
  // com o próximo passo — nunca cair em "Sessão encerrada" mudo (silêncio = erro
  // para o devedor, justo quando ele PEDIU ajuda humana). O poll seguinte do client
  // (que roda antes de marcar o desfecho terminal) traz esta bolha. Best-effort: uma
  // falha aqui não pode derrubar o handoff (o caso/suppressão/evento seguem).
  try {
    const creditor = await resolveCreditorName({ companyId: ctx.companyId })
    if (!creditor.hasRealName) {
      // Alerta de dado (sem PII): cedente sem companies.name/branding — usando genérico.
      console.warn(`[journey] handoff: cedente sem nome real (company=${ctx.companyId}) — usando fallback "Credor"`)
    }
    const { persistAssistantMessage } = await import("./acknowledgement")
    await persistAssistantMessage({
      companyId: ctx.companyId,
      sessionId: ctx.sessionId,
      text: humanHandoffReply(creditor.name),
    })
  } catch (err) {
    console.warn("[journey] mensagem de handoff ao devedor falhou (não-fatal):", (err as Error).message)
  }

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

/**
 * R5 — "Já paguei / enviar comprovante". REGISTRA a alegação de pagamento como um
 * caso `payment_claim` (a equipe concilia) e persiste uma MENSAGEM ao devedor
 * orientando a guardar/enviar o comprovante — SEM declarar pago (D6/M15: quem
 * confirma é a conciliação/webhook). Reusa a peça que já existe no modo assistido
 * (registerPaymentClaim / openCase 'payment_claim'). NÃO cobra, NÃO fecha acordo,
 * NÃO suprime o contato (diferente do handoff): o devedor pode seguir no menu. NUNCA
 * é beco sem saída — o chamador reabre o menu de 3 opções (M7). Sem PII no log.
 */
export async function handlePaymentClaim(
  ctx: SessionCtx, actor: JourneyActor, eventId?: string,
): Promise<{ ok: true; caseId: string; reply: string }> {
  const caseId = await registerPaymentClaim(
    ctx,
    { channel: "chat", note: "devedor informou que já pagou (Já paguei) — aguardando conferência" },
    actor,
    eventId,
  )
  const creditor = await resolveCreditorName({ companyId: ctx.companyId })
  const reply = paymentClaimReply(creditor.name)
  try {
    const { persistAssistantMessage } = await import("./acknowledgement")
    await persistAssistantMessage({
      companyId: ctx.companyId,
      sessionId: ctx.sessionId,
      text: reply,
    })
  } catch (err) {
    console.warn("[journey] mensagem de payment_claim ao devedor falhou (não-fatal):", (err as Error).message)
  }
  return { ok: true, caseId, reply }
}

/**
 * R5 — copy do "Já paguei". Registramos a informação para conferência (NÃO declara
 * pago — D6/M15) e orientamos o devedor a guardar o comprovante. Sem ameaça (D36),
 * sem prometer baixa imediata. `creditorName` já resolvido (R15). Sem PII.
 */
export function paymentClaimReply(creditorName: string): string {
  return (
    "Obrigado por avisar. Registramos que você informou já ter pago este valor e a nossa " +
    "equipe vai conferir. Enquanto isso, guarde o seu comprovante de pagamento — ele pode ser " +
    `pedido para a baixa. Se o pagamento foi feito com a ${creditorName}, informe também o credor ` +
    "para que ele atualize o cadastro. Você não precisa fazer mais nada por aqui agora."
  )
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
