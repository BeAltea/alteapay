// POST /api/webhooks/n8n — ponte segura entre fluxos do n8n e o chatbot de
// negociação. Autenticação por HMAC-SHA256 sobre `${timestamp}.${corpo}`
// (headers x-alteapay-signature / x-alteapay-timestamp, janela ±300s).
//
// Ações (campo "action" do corpo):
//   ping            — teste de conectividade/assinatura + saúde do agente
//   session.create  — cria sessão de negociação e semeia o agente
//   session.message — turno de conversa; sync (resposta inline, até ~300s)
//                     ou async (202 + callback assinado no fluxo n8n)
//   session.status  — funil da sessão + links de pagamento do acordo
//
// Documentação completa: docs/N8N_INTEGRATION.md

import { NextResponse } from "next/server"
import { z } from "zod"

import { agentHealth, agentSessionInit } from "@/lib/negotiation/agent-client"
import { CONSENT_VERSION, MAX_MESSAGE_CHARS } from "@/lib/negotiation/config"
import {
  N8N_SIGNATURE_HEADER,
  N8N_TIMESTAMP_HEADER,
  cacheTurnResult,
  getCachedTurnResult,
  markEventSeen,
  runN8nTurn,
  verifyN8nRequest,
  type N8nTurnResult,
} from "@/lib/negotiation/n8n"
import { onlyDigits } from "@/lib/negotiation/pii"
import { LIMITS, rateLimit } from "@/lib/negotiation/rate-limit"
import {
  createHandoffSession,
  loadSessionDebtContext,
  loadTenantConfig,
  updateSession,
} from "@/lib/negotiation/sessions"
import type { NegotiationSession } from "@/lib/negotiation/types"
import { n8nQueue } from "@/lib/queue/queues"
import { createServiceClient } from "@/lib/supabase/service"

export const dynamic = "force-dynamic"
export const maxDuration = 300 // modo sync espera o turno do agente (~100s local)

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

const bodySchema = z.discriminatedUnion("action", [pingSchema, createSchema, messageSchema, statusSchema])

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

  // Semeia o thread no agente já na criação: fluxos n8n conversam
  // server-to-server sem passar pelo resolve do browser.
  const tenant = await loadTenantConfig(session.company_id)
  const context = await loadSessionDebtContext(session)
  if (session.thread_id && context) {
    try {
      await agentSessionInit({
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
      return jsonError(502, "agente indisponível — sessão criada mas não inicializada", {
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
    const cached = await getCachedTurnResult<N8nTurnResult>(input.event_id)
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

  let result: N8nTurnResult
  try {
    result = await runN8nTurn(session, message)
  } catch (err) {
    console.error("[webhooks:n8n] turno falhou:", err instanceof Error ? err.message : err)
    return jsonError(502, "agente indisponível, tente novamente")
  }
  if (input.event_id) await cacheTurnResult(input.event_id, result)

  return NextResponse.json({ success: true, session_id: session.id, ...result })
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
        return NextResponse.json({ success: true, service: "alteapay-chatbot", agent: await agentHealth() })
      case "session.create":
        return await handleCreate(parsed.data)
      case "session.message":
        return await handleMessage(parsed.data)
      case "session.status":
        return await handleStatus(parsed.data)
    }
  } catch (err) {
    console.error("[webhooks:n8n] erro:", err instanceof Error ? err.message : err)
    return jsonError(500, "erro interno")
  }
}
