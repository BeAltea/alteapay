// POST /api/negotiation/message — um turno de conversa. Grava inbound,
// chama o agente (server-to-server), grava outbound com tool_calls e
// prompt_version (LGPD art. 20) e atualiza o funil da sessão.

import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { z } from "zod"

import { agentChat } from "@/lib/negotiation/agent-client"
import { MAX_MESSAGE_CHARS } from "@/lib/negotiation/config"
import { corsHeaders } from "@/lib/negotiation/cors"
import { CHAT_COOKIE_NAME } from "@/lib/negotiation/crypto"
import { LIMITS, rateLimit } from "@/lib/negotiation/rate-limit"
import { applyTurnEffects, getSessionFromCookie, loadTenantConfig, recordMessage } from "@/lib/negotiation/sessions"

export const dynamic = "force-dynamic"
export const maxDuration = 300 // modelo local ~100s/turno

const bodySchema = z.object({ message: z.string().min(1).max(MAX_MESSAGE_CHARS) })

function sanitize(text: string): string {
  return text.replace(/<[^>]*>/g, "").trim()
}

export async function POST(request: Request) {
  const session = await getSessionFromCookie(cookies().get(CHAT_COOKIE_NAME)?.value)
  if (!session) {
    return NextResponse.json({ success: false, error: "sessão inválida" }, { status: 401 })
  }
  if (!session.consent_lgpd_at) {
    return NextResponse.json({ success: false, error: "consentimento pendente" }, { status: 403 })
  }
  if (!session.thread_id) {
    return NextResponse.json({ success: false, error: "sessão sem thread" }, { status: 409 })
  }

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown"
  const [bySession, byIp] = await Promise.all([
    rateLimit(`msg:s:${session.id}`, LIMITS.messagePerSession.limit, LIMITS.messagePerSession.windowSeconds),
    rateLimit(`msg:ip:${ip}`, LIMITS.messagePerIp.limit, LIMITS.messagePerIp.windowSeconds),
  ])
  if (!bySession.allowed || !byIp.allowed) {
    return NextResponse.json({ success: false, error: "muitas mensagens" }, { status: 429 })
  }

  let parsed
  try {
    parsed = bodySchema.safeParse(await request.json())
  } catch {
    return NextResponse.json({ success: false, error: "JSON inválido" }, { status: 400 })
  }
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: "mensagem inválida" }, { status: 422 })
  }
  const message = sanitize(parsed.data.message)
  if (!message) {
    return NextResponse.json({ success: false, error: "mensagem vazia" }, { status: 422 })
  }

  const tenant = await loadTenantConfig(session.company_id)
  const origin = request.headers.get("origin")
  const headers = corsHeaders(origin, tenant?.allowed_origins ?? [])

  await recordMessage({
    session,
    channel: "webchat",
    direction: "inbound",
    sender: "debtor",
    content: message,
  })

  let agentResponse
  try {
    agentResponse = await agentChat(session.thread_id, message, session.company_id)
  } catch (err) {
    console.error("[negotiation:message] agente falhou:", err instanceof Error ? err.message : err)
    return NextResponse.json(
      { success: false, error: "agente indisponível, tente novamente" },
      { status: 502, headers },
    )
  }

  await recordMessage({
    session,
    channel: "webchat",
    direction: "outbound",
    sender: "agent",
    content: agentResponse.reply,
    tool_calls: agentResponse.tool_calls.length ? agentResponse.tool_calls : null,
    llm_model: process.env.NEGOTIATION_MODEL || "qwen2.5:14b",
    prompt_version: agentResponse.prompt_version,
  })

  await applyTurnEffects(session, agentResponse).catch((err) =>
    console.error("[negotiation:message] efeitos do turno:", err.message),
  )

  return NextResponse.json(
    {
      success: true,
      reply: agentResponse.reply,
      action: agentResponse.action,
      agreement_id: agentResponse.agreement_id,
      verified: agentResponse.verified,
      official_channel_label: agentResponse.action === "redirect_payment"
        ? tenant?.official_channel_label ?? null
        : null,
    },
    { headers },
  )
}
