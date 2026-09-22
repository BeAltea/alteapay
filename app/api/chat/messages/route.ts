// GET /api/chat/messages?since=<iso> (onda R) — polling das mensagens da PRÓPRIA
// sessão (chat_messages) + o prompt ativo. A UI faz polling 2–3s enquanto o n8n
// empurra mensagens/prompts via chat.send/prompt.ask. Sessão pelo cookie JWT.
// Nunca devolve PII em claro (chat_messages já é texto neutro; sem documento).
import { NextRequest, NextResponse } from "next/server"
import { verifyChatJwt, CHAT_COOKIE_NAME } from "@/lib/negotiation/crypto"
import { createServiceClient } from "@/lib/supabase/service"

export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  if (process.env.CHAT_JOURNEY_ENABLED !== "true") {
    return NextResponse.json({ error: "not found" }, { status: 404 })
  }
  const cookie = req.cookies.get(CHAT_COOKIE_NAME)?.value
  const claims = cookie ? verifyChatJwt(cookie) : null
  if (!claims) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const since = req.nextUrl.searchParams.get("since")
  const supabase = createServiceClient()

  let q = supabase
    .from("chat_messages")
    .select("id, role, text, button_id, prompt_id, n8n_execution_id, engine, offers_snapshot, created_at")
    .eq("session_id", claims.sid)
    .eq("company_id", claims.cid)
    .order("created_at", { ascending: true })
    .limit(200)
  if (since) q = q.gt("created_at", since)
  const { data: rawMessages } = await q

  // Anexa o botão-link externo (ex.: quitação → #contato) quando a mensagem o
  // carrega em offers_snapshot.message_action. A UI renderiza como <a> abaixo da
  // bolha; offers_snapshot cru não vaza para o cliente. Sem PII.
  const messages = (rawMessages ?? []).map((m) => {
    const snapshot = m.offers_snapshot as { message_action?: unknown } | null
    const action =
      snapshot && typeof snapshot === "object" && snapshot.message_action ? snapshot.message_action : null
    const { offers_snapshot: _drop, ...rest } = m as Record<string, unknown>
    return action ? { ...rest, action } : rest
  })

  const { data: activePrompt } = await supabase
    .from("chat_prompts")
    .select("id, kind, question, buttons, status, created_at")
    .eq("session_id", claims.sid)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  return NextResponse.json({
    ok: true,
    messages: messages ?? [],
    active_prompt: activePrompt ?? null,
    server_time: new Date().toISOString(),
  })
}
