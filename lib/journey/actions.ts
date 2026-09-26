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

/** Linha mínima de negotiation_offers para a regra do conjunto (sem PII). */
export interface OfferSetRow {
  id: string
  status: string
  valid_until: string | null
  source?: string | null
}

/**
 * QA round 1 (QAA1-04 / M2) — CONJUNTO PARCIALMENTE CONSUMIDO. As ofertas de uma
 * apresentação nascem juntas com o MESMO `valid_until` (é a chave do conjunto —
 * sem coluna nova). Se alguma irmã do conjunto vigente já não está 'presented'
 * (rejeitada pelo guard already_charged do n8n, aceita, expirada, superseded), o
 * conjunto está incompleto — "Negociar" mostrava só 2x/3x, sem a opção à vista
 * recomendada. Regra pura: o conjunto vigente (as 'presented' não vencidas de
 * origem 'system') é reaproveitado SÓ quando TODAS as irmãs continuam
 * 'presented'; senão regenera o conjunto completo. Ofertas integrais do PAGAR
 * (mesmo `source:'system'`) têm `valid_until` próprio → não contam como irmãs.
 */
export function isOfferSetIntact(rows: OfferSetRow[], presentedIds: ReadonlySet<string>): boolean {
  const keys = new Set<string>()
  for (const r of rows) if (presentedIds.has(r.id)) keys.add(r.valid_until ?? "")
  if (keys.size === 0) return true
  for (const r of rows) {
    if (!keys.has(r.valid_until ?? "")) continue
    if (r.status !== "presented") return false
  }
  return true
}

/**
 * offer.list — devolve as ofertas VÁLIDAS ('presented' e não vencidas) da sessão;
 * sem nenhuma, gera da matriz (servidor decide, D8). A2 (N-D2-2): UMA leitura
 * (a expiração lazy é decidida em memória e gravada em paralelo), persistência
 * das ofertas e auditoria em LOTE — antes eram ~10 round-trips sequenciais no
 * caminho crítico do "Quero negociar". `summary` (opcional) evita um 2º
 * debtSummary quando o chamador já o tem.
 * QA round 1 (M2): a leitura traz TODAS as ofertas da sessão (mesma 1 leitura);
 * um conjunto vigente com alguma irmã consumida é REGENERADO por inteiro (as
 * 'presented' restantes viram 'superseded') — o menu sempre traz à vista + parcelas.
 */
export async function listOffers(ctx: SessionCtx, opts?: { summary?: DebtSummary }): Promise<ListedOffer[]> {
  const supabase = createServiceClient()
  const nowMs = Date.now()
  const now = new Date(nowMs).toISOString()
  const { data: allRows } = await supabase
    .from("negotiation_offers")
    .select("id, terms, valid_until, created_at, status, source")
    .eq("session_id", ctx.sessionId)
    .order("created_at", { ascending: true })
  const sessionRows = (allRows ?? []) as Array<{
    id: string; terms: OfferTerms; valid_until: string | null; created_at?: string | null; status: string; source?: string | null
  }>
  const rows = sessionRows.filter((r) => r.status === "presented")
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

  // conjunto vigente = 'presented' não vencidas geradas da matriz (source
  // 'system'); intacto → reusa. Ofertas de IA/cliente ('ai'/'customer') não
  // formam conjunto e continuam listadas como antes.
  const setIntact = isOfferSetIntact(
    sessionRows.filter((r) => (r.source ?? "system") === "system"),
    new Set(current.map((o) => o.id)),
  )
  if (current.length > 0 && setIntact) {
    await expireWrite
    return current.map((o) => ({ id: o.id, terms: o.terms, valid_until: o.valid_until }))
  }

  // gerar da matriz (conjunto novo ou regeneração de conjunto incompleto)
  const summary = opts?.summary ?? (await debtSummary(ctx))
  const row = await resolveMatrixRow({
    companyId: ctx.companyId, agingDays: summary.agingDays, debtValue: summary.originalValue,
  })
  if (!row) {
    await expireWrite
    // sem faixa vigente não há como regenerar: devolve o que resta (nunca some
    // uma opção válida por falta de matriz).
    return current.map((o) => ({ id: o.id, terms: o.terms, valid_until: o.valid_until }))
  }
  // as restantes do conjunto incompleto saem de cena (superseded) — nunca duas
  // apresentações vivas ao mesmo tempo.
  const supersedeWrite: Promise<unknown> =
    current.length === 0
      ? Promise.resolve()
      : Promise.all([
          supabase
            .from("negotiation_offers")
            .update({ status: "superseded", responded_at: now })
            .eq("session_id", ctx.sessionId)
            .eq("status", "presented")
            .in("id", current.map((o) => o.id)),
        ])
  const firstDue = new Date(nowMs + 7 * 86400_000).toISOString().slice(0, 10)
  const validUntil = new Date(nowMs + row.proposal_validity_days * 86400_000).toISOString()
  const termsList = generateOfferTerms(summary.originalValue, row, firstDue)
  // persistência em LOTE (ordem de `termsList` preservada pelo Promise.all)…
  const [ids] = await Promise.all([
    Promise.all(
      termsList.map((terms) =>
        persistOffer({
          companyId: ctx.companyId, sessionId: ctx.sessionId, customerId: ctx.customerId,
          debtId: ctx.debtId, matrixId: row.id, source: "system", status: "presented",
          terms, validUntil,
        }),
      ),
    ),
    supersedeWrite,
  ])
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

/**
 * QA round 1 (QAA1-05 / M1) — no máximo UM caso `payment_claim` ABERTO por
 * sessão: um "Já paguei" repetido reusa o caso aberto (a equipe concilia um
 * caso, não N). Nunca lança; falha de leitura → null (abre um novo).
 */
async function findOpenPaymentClaimCase(ctx: SessionCtx): Promise<string | null> {
  try {
    const supabase = createServiceClient()
    const { data } = await supabase
      .from("negotiation_cases")
      .select("id, status, created_at")
      .eq("company_id", ctx.companyId)
      .eq("session_id", ctx.sessionId)
      .eq("type", "payment_claim")
      .order("created_at", { ascending: false })
      .limit(20)
    const open = ((data ?? []) as Array<{ id: string; status?: string | null }>).find(
      (c) => c.status == null || c.status === "open",
    )
    return open?.id ?? null
  } catch {
    return null
  }
}

/**
 * QA round 3 (QAB2-02) — convergência sob CORRIDA entre instâncias: dois "Já
 * paguei" concorrentes podem ambos não achar caso aberto e ambos inserir. Depois
 * do insert, relê os casos `payment_claim` abertos da sessão; o CANÔNICO é o mais
 * antigo (created_at, desempate por id — todas as instâncias elegem o mesmo). Se
 * o nosso não é o canônico, ele é removido (fallback: marcado `rejected` com
 * resolution `duplicate_concurrent`, fora da fila de abertos) e devolvemos o
 * canônico. Nunca lança; falha de leitura → mantém o nosso.
 */
export async function reconcilePaymentClaimCase(ctx: SessionCtx, ownId: string): Promise<string> {
  try {
    const supabase = createServiceClient()
    const { data } = await supabase
      .from("negotiation_cases")
      .select("id, status, created_at")
      .eq("company_id", ctx.companyId)
      .eq("session_id", ctx.sessionId)
      .eq("type", "payment_claim")
      .limit(50)
    const open = ((data ?? []) as Array<{ id: string; status?: string | null; created_at?: string | null }>)
      .filter((c) => c.status == null || c.status === "open")
      .sort((a, b) => {
        const ta = a.created_at ?? ""
        const tb = b.created_at ?? ""
        if (ta !== tb) return ta < tb ? -1 : 1
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      })
    const canonical = open[0]?.id
    if (!canonical || canonical === ownId) return ownId
    const { error } = await supabase
      .from("negotiation_cases")
      .delete()
      .eq("id", ownId)
      .eq("company_id", ctx.companyId)
    if (error) {
      await supabase
        .from("negotiation_cases")
        .update({ status: "rejected", resolution: "duplicate_concurrent", updated_at: new Date().toISOString() })
        .eq("id", ownId)
        .eq("company_id", ctx.companyId)
    }
    return canonical
  } catch {
    return ownId
  }
}

/** QAB2-02 — single-flight por sessão NA MESMA instância: "Já paguei"
 *  concorrentes da mesma sessão compartilham o mesmo registro (1 leitura, no
 *  máximo 1 insert). Entre instâncias, `reconcilePaymentClaimCase` converge. */
const inflightPaymentClaims = new Map<string, Promise<{ caseId: string; reused: boolean }>>()

async function resolvePaymentClaimCase(
  ctx: SessionCtx,
  details: Record<string, unknown>,
): Promise<{ caseId: string; reused: boolean }> {
  const key = `${ctx.companyId}:${ctx.sessionId}`
  const pending = inflightPaymentClaims.get(key)
  if (pending) {
    const r = await pending
    return { caseId: r.caseId, reused: true }
  }
  const p = (async () => {
    const existing = await findOpenPaymentClaimCase(ctx)
    if (existing) return { caseId: existing, reused: true }
    const inserted = await openCase(ctx, "payment_claim", details)
    const canonical = await reconcilePaymentClaimCase(ctx, inserted)
    return { caseId: canonical, reused: canonical !== inserted }
  })()
  inflightPaymentClaims.set(key, p)
  try {
    return await p
  } finally {
    if (inflightPaymentClaims.get(key) === p) inflightPaymentClaims.delete(key)
  }
}

export async function registerPaymentClaim(
  ctx: SessionCtx,
  details: { paidAt?: string; amount?: number; channel?: string; note?: string },
  actor: JourneyActor, eventId?: string,
): Promise<string> {
  const { caseId, reused } = await resolvePaymentClaimCase(ctx, details)
  const existing = reused ? caseId : null
  await recordEvent({
    companyId: ctx.companyId, customerId: ctx.customerId, debtId: ctx.debtId,
    sessionId: ctx.sessionId, eventId, type: "payment_claim.registered", actor,
    payload: { case_id: caseId, ...(existing ? { reused_open_case: true } : {}) },
  })
  return caseId
}

/**
 * R2 — copy de confirmação da transferência ao atendimento (nunca silêncio/"Sessão
 * encerrada" seca). QA round 3 (QAB3-07, carta de voz D45/Apêndice B — sem
 * promessa): a frase anterior ("A nossa equipe vai falar com você pelo WhatsApp da
 * AlteaPay.") prometia canal e contato que o tenant pode não ter (VMAX sem plano
 * Voxuy; o próprio handoff grava contact_suppressions channel=all). Agora só
 * REGISTRA o pedido e orienta sem prazo nem canal prometido; SEM número em claro.
 * D36: sem ameaça; dúvidas sobre a origem do débito ficam com o cedente ({credor}).
 * `creditorName` já vem resolvido pela precedência canônica (R15). Sem PII.
 */
export function humanHandoffReply(creditorName: string): string {
  // T12 / R-33 / QAB3-07: sem "em breve", sem "vai falar com você", sem canal.
  return (
    "Certo. Registramos o seu pedido de atendimento. " +
    "Se precisar, volte a este link para consultar o valor em aberto. " +
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
    // ANTES de o menu ser reemitido pelo chamador. QA round 1 (M1): é a resposta
    // a ESTE clique — fora do dedup de conteúdo de 15 min (um 2º "Já paguei" na
    // janela ficava sem resposta visível).
    await persistAssistantMessage({
      companyId: ctx.companyId,
      sessionId: ctx.sessionId,
      text: reply,
      stage: "payment_claim",
      snapshot: { case_id: caseId },
      skipContentDedup: true,
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
