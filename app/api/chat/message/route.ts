// POST /api/chat/message (N3) — turno canônico do chat autenticado.
// Sessão pelo cookie JWT httpOnly (mesmo esquema do chatbot). Grava
// chat_messages(customer) + chat.turn.customer → roda o engine → grava a
// resposta (assistant, n8n_execution_id, latency_ms) → devolve {reply, offers,
// action}. Falha do engine → mensagem neutra + chat.engine_error (1x/sessão).
import { NextRequest, NextResponse } from "next/server"
import { verifyChatJwt, CHAT_COOKIE_NAME } from "@/lib/negotiation/crypto"
import { loadSessionCtx } from "@/lib/journey/actions"
import { runJourneyTurn } from "@/lib/journey/chat-turn"
import { recordEvent } from "@/lib/journey/events"
import { MAX_MESSAGE_CHARS } from "@/lib/negotiation/config"

export const dynamic = "force-dynamic"
export const fetchCache = "force-no-store"
export const revalidate = 0
export const maxDuration = 60

async function sessionFromCookie(req: NextRequest) {
  if (process.env.CHAT_JOURNEY_ENABLED !== "true") return null
  const cookie = req.cookies.get(CHAT_COOKIE_NAME)?.value
  if (!cookie) return null
  const claims = verifyChatJwt(cookie)
  if (!claims) return null
  return loadSessionCtx(claims.sid)
}

export async function POST(req: NextRequest) {
  if (process.env.CHAT_JOURNEY_ENABLED !== "true") {
    return NextResponse.json({ error: "not found" }, { status: 404 })
  }
  const ctx = await sessionFromCookie(req)
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const body = await req.json().catch(() => ({} as Record<string, unknown>))
  const text = String(body.text ?? "").slice(0, MAX_MESSAGE_CHARS)
  if (!text.trim()) return NextResponse.json({ error: "mensagem vazia" }, { status: 422 })

  try {
    const out = await runJourneyTurn(ctx, text)
    return NextResponse.json({
      ok: true,
      reply: out.reply,
      offers: out.offers,
      action: out.action,
      ...(out.processing ? { processing: true } : {}),
    })
  } catch (err) {
    console.error("[chat:message] turno falhou:", err instanceof Error ? err.message : err)
    // chat.engine_error é deduplicado por sessão via event_id derivado da sessão.
    await recordEvent({
      companyId: ctx.companyId, customerId: ctx.customerId, debtId: ctx.debtId,
      sessionId: ctx.sessionId, type: "chat.engine_error", actor: "system",
      eventId: `chat.engine_error|${ctx.sessionId}`,
    })
    return NextResponse.json({
      ok: true,
      reply:
        "Não consegui responder agora. Você pode usar as opções abaixo para continuar ou tentar novamente em instantes.",
      offers: [],
      action: null,
    })
  }
}
