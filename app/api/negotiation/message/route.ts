// POST /api/negotiation/message — um turno de conversa. Grava inbound,
// chama o engine (fluxo n8n por padrão; agente legado por env), grava
// outbound com rastreabilidade LGPD (art. 20) e atualiza o funil da sessão.

import { clientIpFromHeaders } from "@/lib/journey/client-ip"
import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { z } from "zod"

import { MAX_MESSAGE_CHARS } from "@/lib/negotiation/config"
import { corsHeaders } from "@/lib/negotiation/cors"
import { CHAT_COOKIE_NAME } from "@/lib/negotiation/crypto"
import { LIMITS, rateLimit } from "@/lib/negotiation/rate-limit"
import { getSessionFromCookie, loadTenantConfig } from "@/lib/negotiation/sessions"
import { runChatbotTurn } from "@/lib/negotiation/turn"

export const dynamic = "force-dynamic"
export const maxDuration = 300

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

  const ip = clientIpFromHeaders(request.headers) ?? "unknown"
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

  let result
  try {
    result = await runChatbotTurn(session, message, "webchat")
  } catch (err) {
    console.error("[negotiation:message] engine falhou:", err instanceof Error ? err.message : err)
    return NextResponse.json(
      { success: false, error: "atendimento indisponível, tente novamente" },
      { status: 502, headers },
    )
  }

  return NextResponse.json(
    {
      success: true,
      reply: result.reply,
      action: result.action,
      agreement_id: result.agreement_id,
      verified: result.verified,
      official_channel_label: result.action === "redirect_payment"
        ? tenant?.official_channel_label ?? null
        : null,
    },
    { headers },
  )
}
