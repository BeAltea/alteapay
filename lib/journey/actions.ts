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
    // A2 (N-D2-2): as duas leituras são independentes → em paralelo.
    const [{ data: company }, { data: cfg }] = await Promise.all([
      supabase.from("companies").select("name").eq("id", input.companyId).maybeSingle(),
      supabase.from("tenant_chat_config").select("branding").eq("company_id", input.companyId).maybeSingle(),
    ])
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
  // A2 (N-D2-2): dívida, cedente e documento são leituras INDEPENDENTES → em
  // paralelo (antes: 5 round-trips sequenciais por chamada, e o Negociar chamava
  // isto no caminho crítico do clique).
  // R15: nome do cedente pela precedência canônica (branding › companies.name ›
  // "Credor"). Nunca "" — cair em vazio deixava o resumo sem cedente identificado.
  const [{ data: debt }, creditor, { data: customer }] = await Promise.all([
    supabase
      .from("debts")
      .select("id, amount, due_date, description, company_id")
      .eq("id", ctx.debtId)
      .single(),
    resolveCreditorName({ companyId: ctx.companyId }),
    supabase.from("customers").select("document").eq("id", ctx.customerId).single(),
  ])
  const doc = (customer?.document ?? "").replace(/\D/g, "")
  // faturas (depende do documento) em paralelo com o evento de auditoria.
  const [{ data: invoices }] = await Promise.all([
    supabase
      .from("vmax_invoices")
      .select("fatura, vencimento, saldo")
      .eq("id_company", ctx.companyId)
      .eq("doc", doc)
      .order("vencimento", { ascending: true }),
    recordEvent({
      companyId: ctx.companyId, customerId: ctx.customerId, debtId: ctx.debtId,
      sessionId: ctx.sessionId, type: "debt.viewed", actor: "customer",
    }),
  ])
  const oldest = invoices?.[0]?.vencimento ?? debt?.due_date ?? null
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

/** Ordem canônica de exibição das ofertas: à vista primeiro, depois parcelado em
 *  N crescente (a mesma ordem em que generateOfferTerms as produz). Desempate
 *  por created_at. Determinística — não depende da ordem de inserts paralelos. */
function sortOffersCanonical<T extends { terms: OfferTerms; created_at?: string | null }>(list: T[]): T[] {
  return [...list].sort((a, b) =>
    (a.terms.installments ?? 0) - (b.terms.installments ?? 0) ||
    String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")),
  )
}

/**
 * offer.list — devolve as ofertas VÁLIDAS ('presented' e não vencidas) da sessão;
 * sem nenhuma, gera da matriz (servidor decide, D8). A2 (N-D2-2): UMA leitura
 * (a expiração lazy é decidida em memória e gravada em paralelo), persistência
 * das ofertas e auditoria em LOTE — antes eram ~10 round-trips sequenciais no
 * caminho crítico do "Quero negociar". `summary` (opcional) evita um 2º
 * debtSummary quando o chamador já o tem.
 */
export async function listOffers(ctx: SessionCtx, opts?: { summary?: DebtSummary }): Promise<ListedOffer[]> {
  const supabase = createServiceClient()
  const nowMs = Date.now()
  const now = new Date(nowMs).toISOString()
  const { data: presentedRows } = await supabase
    .from("negotiation_offers")
    .select("id, terms, valid_until, created_at")
    .eq("session_id", ctx.sessionId)
    .eq("status", "presented")
    .order("created_at", { ascending: true })
  const rows = (presentedRows ?? []) as Array<{ id: string; terms: OfferTerms; valid_until: string | null; created_at?: string | null }>
  const isExpired = (o: { valid_until: string | null }) => {
    if (!o.valid_until) return false
    const t = Date.parse(o.valid_until)
    return Number.isFinite(t) && t < nowMs
  }
  const expired = rows.filter(isExpired)
  const current = sortOffersCanonical(rows.filter((o) => !isExpired(o)))

  // expiração lazy (escrita + auditoria) em PARALELO com o restante — nunca
  // bloqueia a listagem; a auditoria leva o offer_id (N-D2-8).
  const expireWrite: Promise<unknown> =
    expired.length === 0
      ? Promise.resolve()
      : Promise.all([
          supabase
            .from("negotiation_offers")
            .update({ status: "expired", responded_at: now })
            .eq("session_id", ctx.sessionId)
            .eq("status", "presented")
            .in("id", expired.map((e) => e.id)),
          ...expired.map((e) =>
            recordEvent({
              companyId: ctx.companyId, customerId: ctx.customerId, debtId: ctx.debtId,
              sessionId: ctx.sessionId, type: "offer.expired", actor: "system",
              eventId: `offer.expired|${e.id}`,
              payload: { offer_id: e.id },
            }),
          ),
        ])

  if (current.length > 0) {
    await expireWrite
    return current.map((o) => ({ id: o.id, terms: o.terms, valid_until: o.valid_until }))
  }

  // gerar da matriz
  const summary = opts?.summary ?? (await debtSummary(ctx))
  const row = await resolveMatrixRow({
    companyId: ctx.companyId, agingDays: summary.agingDays, debtValue: summary.originalValue,
  })
  if (!row) {
    await expireWrite
    return []
  }
  const firstDue = new Date(nowMs + 7 * 86400_000).toISOString().slice(0, 10)
  const validUntil = new Date(nowMs + row.proposal_validity_days * 86400_000).toISOString()
  const termsList = generateOfferTerms(summary.originalValue, row, firstDue)
  // persistência em LOTE (ordem de `termsList` preservada pelo Promise.all)…
  const ids = await Promise.all(
    termsList.map((terms) =>
      persistOffer({
        companyId: ctx.companyId, sessionId: ctx.sessionId, customerId: ctx.customerId,
        debtId: ctx.debtId, matrixId: row.id, source: "system", status: "presented",
        terms, validUntil,
      }),
    ),
  )
  // …e auditoria em lote, UMA linha por oferta (event_id explícito por offer_id —
  // N-D2-8: 3 offer.presented no mesmo segundo não colapsam mais em 1).
  await Promise.all([
    expireWrite,
    ...ids.map((id, i) =>
      recordEvent({
        companyId: ctx.companyId, customerId: ctx.customerId, debtId: ctx.debtId,
        sessionId: ctx.sessionId, type: "offer.presented", actor: "system",
        eventId: `offer.presented|${id}`,
        payload: { offer_id: id, installments: termsList[i].installments, total: termsList[i].total_value },
      }),
    ),
  ])
  return ids.map((id, i) => ({ id, terms: termsList[i], valid_until: validUntil }))
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
  // T12 / R-33: remove "em breve" (promessa de prazo sem SLA) e o "se já pagou
  // desconsidere" deslocado. Nomeia o canal (WhatsApp AlteaPay) sem número em claro.
  return (
    "Certo. Vou encaminhar você ao nosso atendimento. " +
    "A nossa equipe vai falar com você pelo WhatsApp da AlteaPay. " +
    `Dúvidas sobre a origem da dívida são com a ${creditorName}.`
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
      console.warn(`[journey] handoff: cedente sem nome real (company=${ctx.companyId}); usando fallback "Credor"`)
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
    { channel: "chat", note: "devedor informou que já pagou (Já paguei); aguardando conferência" },
    actor,
    eventId,
  )
  const creditor = await resolveCreditorName({ companyId: ctx.companyId })
  const reply = paymentClaimReply(creditor.name)
  try {
    const { persistAssistantMessage } = await import("./acknowledgement")
    // A1: resultado da ação como OUTCOME (stage 'payment_claim') — persistido
    // ANTES de o menu ser reemitido pelo chamador.
    await persistAssistantMessage({
      companyId: ctx.companyId,
      sessionId: ctx.sessionId,
      text: reply,
      stage: "payment_claim",
      snapshot: { case_id: caseId },
    })
  } catch (err) {
    console.warn("[journey] mensagem de payment_claim ao devedor falhou (não-fatal):", (err as Error).message)
  }
  return { ok: true, caseId, reply }
}

/**
 * R5 — copy do "Já paguei". Registramos a informação para conferência (NÃO declara
 * pago — D6/M15). Sem ameaça (D36), sem prometer baixa imediata. Sem PII.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function paymentClaimReply(_creditorName?: string): string {
  // A4/S18 (Apêndice B "Já paguei"): "Obrigado por avisar. Vamos conferir o
  // pagamento. Se quiser adiantar, fale com o atendimento: {contato}." NÃO declara
  // pago (D6/M15). A4 r2 (B3-F5): o tenant NÃO tem campo de contato de atendimento
  // (official_channel_* é o canal do CREDOR, usado na contestação — não é o
  // atendimento da negociação), então o segmento ": {contato}" fica fora e a
  // frase termina em "fale com o atendimento." — texto fixo, sem parâmetro morto
  // e sem promessa (o botão "Falar com atendimento" existe). Quando o campo
  // existir (ex.: tenant_chat_config.support_contact), reintroduzir o segmento
  // aqui e ligá-lo no chamador (handlePaymentClaim). `_creditorName` é a
  // assinatura pré-A4 (chamador e testes intocados). Sem PII.
  return "Obrigado por avisar. Vamos conferir o pagamento. Se quiser adiantar, fale com o atendimento."
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
