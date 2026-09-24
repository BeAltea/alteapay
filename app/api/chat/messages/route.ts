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

  // Estado de espera (M11 — onda "3 opções", trilha D2): o client reconstrói a
  // máquina de espera (degraus 1,2/4/10/15s) a partir destes dois campos + o
  // relógio local, então um reload durante a espera restaura o degrau. Zero
  // request extra — vem junto do 1º poll. DEFENSIVO: se as colunas M-4 ainda não
  // existirem em produção (aplicadas só no G6), o SELECT erra → devolvemos null e
  // a UI só não restaura o degrau (nunca quebra o poll). Nunca é PII.
  let waitState: string | null = null
  let waitStartedAt: string | null = null
  const { data: waitRow, error: waitErr } = await supabase
    .from("negotiation_sessions")
    .select("wait_state, wait_started_at")
    .eq("id", claims.sid)
    .eq("company_id", claims.cid)
    .maybeSingle()
  if (!waitErr && waitRow) {
    waitState = (waitRow as { wait_state?: string | null }).wait_state ?? null
    waitStartedAt = (waitRow as { wait_started_at?: string | null }).wait_started_at ?? null
  }

  return NextResponse.json({
    ok: true,
    messages: messages ?? [],
    active_prompt: activePrompt ?? null,
    wait_state: waitState,
    wait_started_at: waitStartedAt,
    server_time: new Date().toISOString(),
  })
}
