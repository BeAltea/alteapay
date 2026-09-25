// POST /api/webhooks/n8n — API de domínio do chatbot para fluxos do n8n.
// Autenticação por HMAC-SHA256 sobre `${timestamp}.${corpo}` (headers
// x-alteapay-signature / x-alteapay-timestamp, janela ±300s).
//
// Os fluxos n8n são o CÉREBRO da conversa; a plataforma é o sistema de
// registro e de ações de domínio. Ações (campo "action" do corpo):
//   ping             — teste de conectividade/assinatura + saúde do engine
//   session.create   — cria sessão de negociação (registro + deep link)
//   session.message  — turno completo conduzido pela plataforma (engine →
//                      fluxo N8N_CHAT_FLOW_URL); sync ou async com callback
//   session.record   — auditoria de mensagem de conversa conduzida PELO fluxo
//                      (canal externo), com efeitos de funil opcionais
//   agreement.close  — fecha acordo com as regras de desconto DO SERVIDOR e
//                      enfileira a cobrança
//   session.redirect — modo B: registra o redirect e devolve a URL oficial do
//                      tenant (único caminho para obtê-la)
//   session.status   — funil da sessão + links de pagamento do acordo
//
// Documentação completa: docs/N8N_INTEGRATION.md

import { NextResponse } from "next/server"
import { z } from "zod"

import { closeAgreement } from "@/lib/negotiation/close-agreement"
import { CONSENT_VERSION, MAX_MESSAGE_CHARS } from "@/lib/negotiation/config"
import { engineHealth, engineSessionInit } from "@/lib/negotiation/engine"
import {
  N8N_SIGNATURE_HEADER,
  N8N_TIMESTAMP_HEADER,
  cacheTurnResult,
  getCachedTurnResult,
  markEventSeen,
  verifyN8nRequest,
} from "@/lib/negotiation/n8n"
import { onlyDigits } from "@/lib/negotiation/pii"
import { LIMITS, rateLimit } from "@/lib/negotiation/rate-limit"
import {
  applyTurnEffects,
  createHandoffSession,
  loadSessionDebtContext,
  loadTenantConfig,
  recordMessage,
  updateSession,
} from "@/lib/negotiation/sessions"
import { runChatbotTurn, type EngineTurnResult } from "@/lib/negotiation/turn"
import type { NegotiationSession } from "@/lib/negotiation/types"
import { n8nQueue } from "@/lib/queue/queues"
import { createServiceClient } from "@/lib/supabase/service"
import type { PaymentRecordArgs } from "@/lib/journey/payment-actions"
import type { ChatSendArgs } from "@/lib/journey/chat-send"
import type { Button } from "@/lib/journey/buttons"

export const dynamic = "force-dynamic"
export const fetchCache = "force-no-store"
export const revalidate = 0
export const maxDuration = 300

const N8N_IP_LIMIT = { limit: 120, windowSeconds: 60 }

const pingSchema = z.object({ action: z.literal("ping") })

const createSchema = z.object({
  action: z.literal("session.create"),
  company_id: z.string().uuid(),
  document: z.string().min(11).max(20).optional(),
  debt_id: z.string().uuid().optional(),
  identity_verified: z.boolean().optional(), // true SOMENTE se o fluxo n8n já validou CPF+DOB
  debt_acknowledged: z.boolean().optional(),
  consent: z.boolean().optional(), // consentimento LGPD colhido no canal de origem
})

const messageSchema = z.object({
  action: z.literal("session.message"),
  session_id: z.string().uuid(),
  message: z.string().min(1).max(MAX_MESSAGE_CHARS),
  mode: z.enum(["sync", "async"]).default("sync"),
  callback_url: z.string().url().optional(), // obrigatório no modo async
  event_id: z.string().min(1).max(128).optional(), // idempotência
  metadata: z.record(z.unknown()).optional(), // ecoado no callback
})

const statusSchema = z.object({
  action: z.literal("session.status"),
  session_id: z.string().uuid(),
})

// Auditoria de conversa conduzida PELO fluxo n8n (canal externo): grava a
// mensagem em conversation_messages e aplica efeitos de funil opcionais.
const recordSchema = z.object({
  action: z.literal("session.record"),
  session_id: z.string().uuid(),
  direction: z.enum(["inbound", "outbound"]),
  sender: z.enum(["debtor", "agent", "system", "human_operator"]).optional(),
  content: z.string().min(1).max(MAX_MESSAGE_CHARS),
  provider_message_id: z.string().max(256).optional(),
  // Efeitos do turno decididos pelo fluxo (só com direction=outbound):
  events: z.array(z.string()).optional(),
  turn_action: z.enum(["agreement_closed", "redirect_payment", "redirect_attendance", "handoff"]).nullish(),
  agreement_id: z.string().uuid().nullish(),
})

// Fechamento de acordo: termos derivam SEMPRE das regras do servidor.
const closeSchema = z.object({
  action: z.literal("agreement.close"),
  session_id: z.string().uuid(),
  offer_id: z.string().min(1).max(32), // 'avista' | 'parc_N'
  event_id: z.string().min(1).max(128).optional(), // idempotência
})

// Modo B: registra o redirect e devolve a URL oficial do tenant.
const redirectSchema = z.object({
  action: z.literal("session.redirect"),
  session_id: z.string().uuid(),
  offer_presented: z
    .object({
      type: z.string().optional(),
      label: z.string().optional(),
      total: z.union([z.string(), z.number()]).optional(),
      installments: z.number().optional(),
      discount_pct: z.union([z.string(), z.number()]).optional(),
    })
    .nullish(),
  confirmed_intent: z.boolean().optional(),
})

const JOURNEY_ACTIONS = [
  "debt.summary", "offer.list", "offer.propose", "offer.accept", "offer.reject",
  "payment.create", "payment.record", "payment.status", "negotiation.note",
  "dispute.register", "payment_claim.register", "human.transfer",
  "session.close", "journey.timeline",
  // onda R: o n8n empurra mensagens/prompts para o chat do cliente.
  "chat.send", "prompt.ask", "prompt.close",
] as const

const journeySchema = z.object({
  action: z.enum(JOURNEY_ACTIONS),
  event_id: z.string().min(8).max(128).optional(),
  session_id: z.string().uuid(),
  args: z.record(z.unknown()).optional(),
})

const bodySchema = z.union([
  z.discriminatedUnion("action", [
    pingSchema,
    createSchema,
    messageSchema,
    statusSchema,
    recordSchema,
    closeSchema,
    redirectSchema,
  ]),
  journeySchema,
])

function jsonError(status: number, error: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ success: false, error, ...extra }, { status })
}

async function loadSessionById(sessionId: string): Promise<NegotiationSession | null> {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from("negotiation_sessions")
    .select("*")
    .eq("id", sessionId)
    .maybeSingle()
  return (data as NegotiationSession) ?? null
}

function formatCpfCnpj(digits: string): string | null {
  if (digits.length === 11) {
    return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`
  }
  if (digits.length === 14) {
    return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12)}`
  }
  return null
}

interface ResolvedDebt {
  debt: { id: string; company_id: string; customer_id: string }
  customer: { id: string; name: string; document: string }
}

/** Resolve dívida+cliente do tenant: por debt_id explícito ou pelo documento
 * do devedor (dívida pending mais antiga). company_id sempre restringe. */
async function resolveDebt(
  companyId: string,
  debtId?: string,
  document?: string,
): Promise<ResolvedDebt | { error: string; status: number }> {
  const supabase = createServiceClient()

  if (debtId) {
    const { data: debt } = await supabase
      .from("debts")
      .select("id, company_id, customer_id, status")
      .eq("id", debtId)
      .eq("company_id", companyId)
      .maybeSingle()
    if (!debt) return { error: "dívida não encontrada para este tenant", status: 404 }
    const { data: customer } = await supabase
      .from("customers")
      .select("id, name, document")
      .eq("id", debt.customer_id)
      .maybeSingle()
    if (!customer) return { error: "cliente da dívida não encontrado", status: 404 }
    return { debt, customer }
  }

  if (document) {
    const digits = onlyDigits(document)
    const formatted = formatCpfCnpj(digits)
    const candidates = formatted ? [digits, formatted] : [digits]
    const { data: customer } = await supabase
      .from("customers")
      .select("id, name, document")
      .eq("company_id", companyId)
      .in("document", candidates)
      .limit(1)
      .maybeSingle()
    if (!customer) return { error: "cliente não encontrado pelo documento", status: 404 }
    const { data: debts } = await supabase
      .from("debts")
      .select("id, company_id, customer_id, status")
      .eq("company_id", companyId)
      .eq("customer_id", customer.id)
      .eq("status", "pending")
      .order("due_date", { ascending: true })
      .limit(1)
    const debt = debts?.[0]
    if (!debt) return { error: "nenhuma dívida pending para este cliente", status: 404 }
    return { debt, customer }
  }

  return { error: "informe debt_id ou document", status: 422 }
}

function sanitize(text: string): string {
  return text.replace(/<[^>]*>/g, "").trim()
}

async function handleCreate(input: z.infer<typeof createSchema>) {
  const resolved = await resolveDebt(input.company_id, input.debt_id, input.document)
  if ("error" in resolved) return jsonError(resolved.status, resolved.error)

  const { session, token, deep_link } = await createHandoffSession({
    company_id: input.company_id,
    customer_id: resolved.customer.id,
    debt_id: resolved.debt.id,
    document: resolved.customer.document,
    channel_origin: "n8n",
    identity_verified: input.identity_verified ?? false,
    debt_acknowledged: input.debt_acknowledged ?? false,
  })

  if (input.consent) {
    await updateSession(session.id, {
      consent_lgpd_at: new Date().toISOString(),
      consent_lgpd_version: CONSENT_VERSION,
    })
  }

  // Semeia o contexto no engine (no-op para o engine n8n — o contexto viaja
  // em todo turno; obrigatório apenas no engine legado de agente).
  const tenant = await loadTenantConfig(session.company_id)
  const context = await loadSessionDebtContext(session)
  if (session.thread_id && context) {
    try {
      await engineSessionInit({
        thread_id: session.thread_id,
        company_id: session.company_id,
        customer_name: context.customer_name,
        document: context.document,
        debt_id: context.debt_id,
        amount: context.amount,
        aging_days: context.aging_days,
        due_date: context.due_date,
        description: context.description ?? undefined,
        channel: "n8n",
        identity_preverified: Boolean(session.identity_verified_at),
        fulfillment_mode: session.fulfillment_mode ?? tenant?.fulfillment_mode ?? "A",
        official_channel_label: tenant?.official_channel_label ?? undefined,
        attendance_channel_label: tenant?.official_channel_label ?? undefined,
      })
    } catch (err) {
      console.error("[webhooks:n8n] session/init falhou:", err instanceof Error ? err.message : err)
      return jsonError(502, "engine indisponível — sessão criada mas não inicializada", {
        session_id: session.id,
      })
    }
  }

  return NextResponse.json({
    success: true,
    session_id: session.id,
    thread_id: session.thread_id,
    token,
    deep_link,
    expires_at: session.token_expires_at,
    fulfillment_mode: session.fulfillment_mode,
    consent_recorded: Boolean(input.consent),
  })
}

async function handleMessage(input: z.infer<typeof messageSchema>) {
  const session = await loadSessionById(input.session_id)
  if (!session) return jsonError(404, "sessão não encontrada")
  if (!session.consent_lgpd_at) {
    return jsonError(403, "consentimento LGPD pendente — crie a sessão com consent:true")
  }
  if (!session.thread_id) return jsonError(409, "sessão sem thread")

  const bySession = await rateLimit(
    `msg:s:${session.id}`,
    LIMITS.messagePerSession.limit,
    LIMITS.messagePerSession.windowSeconds,
  )
  if (!bySession.allowed) return jsonError(429, "muitas mensagens para esta sessão")

  const message = sanitize(input.message)
  if (!message) return jsonError(422, "mensagem vazia")

  if (input.event_id) {
    const cached = await getCachedTurnResult<EngineTurnResult>(input.event_id)
    if (cached) {
      return NextResponse.json({ success: true, duplicate: true, session_id: session.id, ...cached })
    }
    const fresh = await markEventSeen(input.event_id)
    if (!fresh) {
      return NextResponse.json({
        success: true,
        duplicate: true,
        session_id: session.id,
        detail: "event_id já recebido; processamento em andamento",
      })
    }
  }

  if (input.mode === "async") {
    if (!input.callback_url) return jsonError(422, "callback_url é obrigatório no modo async")
    if (!/^https?:\/\//.test(input.callback_url)) return jsonError(422, "callback_url inválido")
    const job = await n8nQueue.add(`n8n-${input.event_id ?? session.id}-${Date.now()}`, {
      session_id: session.id,
      message,
      callback_url: input.callback_url,
      event_id: input.event_id,
      metadata: input.metadata,
    })
    return NextResponse.json(
      { success: true, queued: true, job_id: job.id, event_id: input.event_id ?? null },
      { status: 202 },
    )
  }

  let result: EngineTurnResult
  try {
    result = await runChatbotTurn(session, message, "n8n")
  } catch (err) {
    console.error("[webhooks:n8n] turno falhou:", err instanceof Error ? err.message : err)
    return jsonError(502, "engine indisponível, tente novamente")
  }
  if (input.event_id) await cacheTurnResult(input.event_id, result)

  return NextResponse.json({ success: true, session_id: session.id, ...result })
}

async function handleRecord(input: z.infer<typeof recordSchema>) {
  const session = await loadSessionById(input.session_id)
  if (!session) return jsonError(404, "sessão não encontrada")
  if (!session.consent_lgpd_at) {
    return jsonError(403, "consentimento LGPD pendente — crie a sessão com consent:true")
  }

  const sender = input.sender ?? (input.direction === "inbound" ? "debtor" : "agent")
  const message = await recordMessage({
    session,
    channel: "n8n",
    direction: input.direction,
    sender,
    content: input.content,
    llm_model: input.direction === "outbound" ? "n8n-flow" : null,
    provider_message_id: input.provider_message_id ?? null,
  })

  if (input.direction === "outbound" && (input.events?.length || input.turn_action)) {
    await applyTurnEffects(session, {
      events: input.events ?? [],
      action: input.turn_action ?? null,
      agreement_id: input.agreement_id ?? null,
    }).catch((err) => console.error("[webhooks:n8n] efeitos do record:", err.message))
  }

  return NextResponse.json({ success: true, message_id: message.id, session_id: session.id })
}

async function handleClose(input: z.infer<typeof closeSchema>) {
  const session = await loadSessionById(input.session_id)
  if (!session) return jsonError(404, "sessão não encontrada")
  if (!session.consent_lgpd_at) return jsonError(403, "consentimento LGPD pendente")
  if (!session.identity_verified_at) {
    return jsonError(403, "identidade não verificada — acordo exige identity_verified")
  }
  if (!session.debt_id) return jsonError(409, "sessão sem dívida vinculada")
  if (session.outcome === "agreement_closed" && session.agreement_id) {
    return NextResponse.json({
      success: true,
      duplicate: true,
      agreement_id: session.agreement_id,
      message: "acordo já registrado para esta sessão",
    })
  }

  if (input.event_id) {
    const fresh = await markEventSeen(`close:${input.event_id}`)
    if (!fresh) {
      return NextResponse.json({
        success: true,
        duplicate: true,
        agreement_id: session.agreement_id,
        detail: "event_id já recebido",
      })
    }
  }

  const result = await closeAgreement({
    company_id: session.company_id,
    debt_id: session.debt_id,
    offer_id: input.offer_id,
    origin: `n8n flow session ${session.id}`,
    channel: "n8n",
  })
  if (!result.ok) return jsonError(result.status, result.error)

  await updateSession(session.id, {
    outcome: "agreement_closed",
    agreement_id: result.agreement_id,
  }).catch((err) => console.error("[webhooks:n8n] outcome do close:", err.message))

  return NextResponse.json({
    success: true,
    agreement_id: result.agreement_id,
    message: result.message,
    terms: result.terms,
    hint: "links de pagamento chegam async — consultar session.status",
  })
}

async function handleRedirect(input: z.infer<typeof redirectSchema>) {
  const session = await loadSessionById(input.session_id)
  if (!session) return jsonError(404, "sessão não encontrada")
  if (!session.consent_lgpd_at) return jsonError(403, "consentimento LGPD pendente")

  const tenant = await loadTenantConfig(session.company_id)
  if (!tenant?.official_channel_url) {
    return jsonError(409, "canal oficial não configurado para este tenant")
  }

  const context = await loadSessionDebtContext(session)
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from("redirect_events")
    .insert({
      session_id: session.id,
      company_id: session.company_id, // sempre da sessão, nunca do fluxo
      debt_id: session.debt_id,
      customer_id: session.customer_id,
      debt_amount_at_redirect: context?.amount ?? 0,
      offer_presented: input.offer_presented ?? null,
      official_channel_url: tenant.official_channel_url,
      confirmed_intent: input.confirmed_intent ?? true,
    })
    .select()
    .single()
  if (error || !data) {
    console.error("[webhooks:n8n] redirect:", error?.message)
    return jsonError(500, "falha ao registrar redirect")
  }

  if (session.outcome === "in_progress") {
    await updateSession(session.id, { outcome: "redirected_official" }).catch((err) =>
      console.error("[webhooks:n8n] outcome do redirect:", err.message),
    )
  }

  return NextResponse.json({
    success: true,
    redirect_event_id: data.id,
    official_channel_url: tenant.official_channel_url,
    official_channel_label: tenant.official_channel_label,
  })
}

async function handleStatus(input: z.infer<typeof statusSchema>) {
  const session = await loadSessionById(input.session_id)
  if (!session) return jsonError(404, "sessão não encontrada")

  let agreement = null
  if (session.agreement_id) {
    const supabase = createServiceClient()
    const { data } = await supabase
      .from("agreements")
      .select(
        "id, agreed_amount, installments, installment_amount, due_date, status, payment_status, asaas_boleto_url, asaas_pix_qrcode_url, asaas_invoice_url, asaas_payment_url",
      )
      .eq("id", session.agreement_id)
      .eq("company_id", session.company_id)
      .maybeSingle()
    agreement = data ?? null
  }

  return NextResponse.json({
    success: true,
    session_id: session.id,
    outcome: session.outcome,
    identity_verified: Boolean(session.identity_verified_at),
    consent_recorded: Boolean(session.consent_lgpd_at),
    channel_origin: session.channel_origin,
    created_at: session.created_at,
    agreement,
  })
}

export async function POST(request: Request) {
  const rawBody = await request.text()
  const verdict = verifyN8nRequest(
    rawBody,
    request.headers.get(N8N_SIGNATURE_HEADER),
    request.headers.get(N8N_TIMESTAMP_HEADER),
  )
  if (!verdict.ok) return jsonError(verdict.status, verdict.reason)

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown"
  const byIp = await rateLimit(`n8n:ip:${ip}`, N8N_IP_LIMIT.limit, N8N_IP_LIMIT.windowSeconds)
  if (!byIp.allowed) return jsonError(429, "rate limit excedido")

  let json: unknown
  try {
    json = JSON.parse(rawBody)
  } catch {
    return jsonError(400, "JSON inválido")
  }
  const parsed = bodySchema.safeParse(json)
  if (!parsed.success) {
    return jsonError(422, "corpo inválido", { issues: parsed.error.issues.slice(0, 5) })
  }

  try {
    switch (parsed.data.action) {
      case "ping":
        return NextResponse.json({ success: true, service: "alteapay-chatbot", engine: await engineHealth() })
      case "session.create":
        return await handleCreate(parsed.data)
      case "session.message":
        return await handleMessage(parsed.data)
      case "session.record":
        return await handleRecord(parsed.data)
      case "agreement.close":
        return await handleClose(parsed.data)
      case "session.redirect":
        return await handleRedirect(parsed.data)
      case "session.status":
        return await handleStatus(parsed.data)
      default:
        return await handleJourneyAction(parsed.data as z.infer<typeof journeySchema>)
    }
  } catch (err) {
    console.error("[webhooks:n8n] erro:", err instanceof Error ? err.message : err)
    return jsonError(500, "erro interno")
  }
}


// ---------- Ações de domínio da JORNADA (papel B ampliado) ----------
// Mesma segurança (HMAC/anti-replay) do POST; validação da matriz no servidor;
// erros de validação retornam 4xx com código estável.
async function handleJourneyAction(input: z.infer<typeof journeySchema>) {
  const { loadSessionCtx, debtSummary, listOffers, proposeOffer, rejectOffer,
    registerDispute, registerPaymentClaim, transferToHuman, closeSession } =
    await import("@/lib/journey/actions")
  const ctx = await loadSessionCtx(input.session_id)
  if (!ctx) return jsonError(404, "sessão não encontrada")
  const args = (input.args ?? {}) as Record<string, unknown>

  // Dedupe por event_id na BORDA (§7) SÓ para ações cujo retry é um efeito
  // colateral puro, sem payload idempotente próprio a reenviar:
  //   dispute.register / payment_claim.register / human.transfer → abrem
  //   negotiation_cases ANTES do recordEvent, e a tabela não tem event_id UNIQUE
  //   → retry duplicava o caso. negotiation.note idem (evento puro).
  // As demais NÃO entram aqui de propósito: payment.create/payment.record/
  // offer.accept têm idempotência própria por (session_id, offer_id)/aceite e
  // devolvem o MESMO payload (link/agreement) no reenvio (§8); offer.propose/
  // offer.reject/chat.send/prompt.* devolvem ids que o fluxo precisa de volta.
  // Escopo por ação. Fail-open (markEventSeen trata Redis indisponível).
  const DEDUPE_AT_EDGE = new Set([
    "dispute.register", "payment_claim.register", "human.transfer", "negotiation.note",
  ])
  if (input.event_id && DEDUPE_AT_EDGE.has(input.action)) {
    const fresh = await markEventSeen(`journey:${input.action}:${input.event_id}`)
    if (!fresh) {
      return NextResponse.json({
        success: true,
        duplicate: true,
        session_id: input.session_id,
        detail: "event_id já recebido para esta ação",
      })
    }
  }

  switch (input.action) {
    case "debt.summary":
      return NextResponse.json({ success: true, summary: await debtSummary(ctx) })
    case "offer.list":
      return NextResponse.json({ success: true, offers: await listOffers(ctx) })
    case "offer.propose": {
      const terms = args.terms as Parameters<typeof proposeOffer>[1] | undefined
      if (!terms) return jsonError(422, "args.terms obrigatório")
      const r = await proposeOffer(ctx, terms, "n8n", input.event_id)
      if (!r.ok) return jsonError(422, r.error ?? "OFFER_INVALID", { offer_id: r.offerId })
      return NextResponse.json({ success: true, offer_id: r.offerId })
    }
    case "offer.accept": {
      const offerId = args.offer_id as string | undefined
      if (!offerId) return jsonError(422, "args.offer_id obrigatório")
      const { buildAcceptSummary, confirmAccept } = await import("@/lib/journey/closing")
      const pre = await buildAcceptSummary(ctx, offerId)
      if (!pre.ok) return jsonError(409, pre.error)
      const r = await confirmAccept({
        ctx, offerId, termsHash: pre.summary.termsHash, eventId: input.event_id,
      })
      if (!r.ok) return jsonError(409, r.error)
      return NextResponse.json({ success: true, agreement_id: r.agreementId })
    }
    case "offer.reject": {
      const offerId = args.offer_id as string | undefined
      if (!offerId) return jsonError(422, "args.offer_id obrigatório")
      await rejectOffer(ctx, offerId, "n8n", args.reason as string | undefined, input.event_id)
      return NextResponse.json({ success: true })
    }
    case "dispute.register": {
      const caseId = await registerDispute(ctx, args, "n8n", input.event_id)
      return NextResponse.json({ success: true, case_id: caseId })
    }
    case "payment_claim.register": {
      const caseId = await registerPaymentClaim(
        ctx, args as { paidAt?: string; amount?: number; channel?: string; note?: string },
        "n8n", input.event_id,
      )
      return NextResponse.json({ success: true, case_id: caseId })
    }
    case "human.transfer": {
      const caseId = await transferToHuman(ctx, String(args.reason ?? ""), "n8n", input.event_id)
      return NextResponse.json({ success: true, case_id: caseId })
    }
    case "payment.create": {
      // Papel A (variante A é o ÚNICO caminho): a plataforma executa (guard
      // SEMPRE + guard de reconhecimento). Exige sessão verificada. Valores
      // monetários da resposta em CENTAVOS (contrato v2, §6.4/Apêndice B.1).
      if (!(await sessionIsVerified(input.session_id))) return jsonError(403, "sessão não verificada")
      const offerId = args.offer_id as string | undefined
      if (!offerId) return jsonError(422, "args.offer_id obrigatório")
      const billingType = (args.billing_type as string | undefined) ?? null
      const { paymentCreateOrExistingLink, paymentCreateOrLinkResponseForN8n } = await import("@/lib/journey/payment-actions")
      // Ponto de entrada único: já cobrada (D7/D23) devolve o LINK EXISTENTE via
      // payment.status em vez de recriar — nunca gera 2ª cobrança.
      const r = await paymentCreateOrExistingLink(ctx, offerId, input.event_id)
      if (!r.ok) return jsonError(r.status, r.message, { code: r.code })
      return NextResponse.json(paymentCreateOrLinkResponseForN8n(r, billingType))
    }
    case "payment.record": {
      // Papel B (variante B): n8n criou a cobrança e registra aqui. Guard antes;
      // NUNCA aceita status pago (D6). Exige sessão verificada.
      if (!(await sessionIsVerified(input.session_id))) return jsonError(403, "sessão não verificada")
      const { paymentRecord } = await import("@/lib/journey/payment-actions")
      const r = await paymentRecord(ctx, args as PaymentRecordArgs, input.event_id)
      if (!r.ok) return jsonError(r.status, r.message, { code: r.code })
      return NextResponse.json(r.code === "claim" ? { ok: true, code: "claim", case_id: r.case_id } : { ok: true, code: "recorded", agreement_id: r.agreement_id })
    }
    case "payment.status": {
      // Valores em CENTAVOS na borda n8n (§6.4). NUNCA aceita status do fluxo (B.3).
      const { paymentStatus, reaisToCents } = await import("@/lib/journey/payment-actions")
      const status = await paymentStatus(ctx)
      const payment = status.payment
        ? {
            ...status.payment,
            total_value: reaisToCents(status.payment.total_value),
          }
        : null
      return NextResponse.json({ ok: true, ...status, payment })
    }
    case "chat.send": {
      // onda R: empurra mensagem (+opcional prompt +payment_ref) ao chat.
      const { chatSend } = await import("@/lib/journey/chat-send")
      const r = await chatSend(ctx, args as unknown as ChatSendArgs, input.event_id)
      if (!r.ok) return jsonError(r.status, r.message, { code: r.code })
      return NextResponse.json({ ok: true, message_id: r.message_id, prompt_id: r.prompt_id ?? null, duplicate: r.duplicate ?? false })
    }
    case "prompt.ask": {
      const { promptAsk } = await import("@/lib/journey/chat-send")
      const r = await promptAsk(ctx, args as unknown as { kind: string; question: string; buttons: Button[]; n8n_execution_id?: string })
      if (!r.ok) return jsonError(r.status, r.message, { code: r.code })
      return NextResponse.json({ ok: true, prompt_id: r.prompt_id })
    }
    case "prompt.close": {
      const { promptClose } = await import("@/lib/journey/chat-send")
      const r = await promptClose(ctx)
      return NextResponse.json({ ok: true, closed: r.closed })
    }
    case "negotiation.note": {
      const { negotiationNote } = await import("@/lib/journey/payment-actions")
      await negotiationNote(ctx, args, input.event_id)
      return NextResponse.json({ success: true })
    }
    case "session.close":
      await closeSession(ctx, String(args.outcome ?? "closed_by_flow"), "n8n", input.event_id)
      return NextResponse.json({ success: true })
    case "journey.timeline": {
      const { getTimeline } = await import("@/lib/journey/events")
      const timeline = await getTimeline({ companyId: ctx.companyId, sessionId: ctx.sessionId, limit: 100 })
      return NextResponse.json({ success: true, timeline })
    }
  }
}

/** true se a sessão está verificada (identity_verified_at) — exigido p/ pagamento. */
async function sessionIsVerified(sessionId: string): Promise<boolean> {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from("negotiation_sessions")
    .select("identity_verified_at, status, outcome")
    .eq("id", sessionId)
    .maybeSingle()
  if (!data) return false
  if (data.status === "closed" || data.outcome === "expired") return false
  return Boolean(data.identity_verified_at)
}
