// GET /api/chat/history (N6) — histórico da PRÓPRIA sessão do cliente:
// transcrição (chat_messages) + cartão do acordo das colunas reais. Documento
// nunca em claro. Sessão pelo cookie JWT httpOnly.
import { NextRequest, NextResponse } from "next/server"
import { verifyChatJwt, CHAT_COOKIE_NAME } from "@/lib/negotiation/crypto"
import { customerHistory } from "@/lib/journey/history"
import { filterN8nRowsForRead } from "@/lib/negotiation/n8n-text-guard"

export const dynamic = "force-dynamic"
export const fetchCache = "force-no-store"
export const revalidate = 0

export async function GET(req: NextRequest) {
  if (process.env.CHAT_JOURNEY_ENABLED !== "true") {
    return NextResponse.json({ error: "not found" }, { status: 404 })
  }
  const cookie = req.cookies.get(CHAT_COOKIE_NAME)?.value
  const claims = cookie ? verifyChatJwt(cookie) : null
  if (!claims) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const history = await customerHistory(claims.sid, claims.cid)
  // N8N-6 (API-06): mesmo filtro de leitura do GET /api/chat/messages.
  const messages = await filterN8nRowsForRead(history.messages, { sessionId: claims.sid, companyId: claims.cid })
  return NextResponse.json({ ok: true, ...history, messages })
}
