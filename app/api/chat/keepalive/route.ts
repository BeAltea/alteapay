// POST /api/chat/keepalive — mantém a sessão do chat VIVA enquanto a aba está
// aberta. Enquanto o cookie atual for válido, RE-ASSINA o JWT com um novo `exp`
// (TTL do tenant, generoso) e RE-SETA o cookie, para que o `exp` nunca vença em
// uso. Também renova negotiation_sessions.last_activity_at (mantém a sessão
// dentro do TTL de reuso). Cookie inválido/ausente → 401 (o client mostra o
// modal "Entrar novamente", NUNCA redireciona sozinho).
//
// Idempotente e barato: uma verificação de JWT + um UPDATE enxuto. Sem PII.
import { NextRequest, NextResponse } from "next/server"
import { verifyChatJwt, signChatJwt, CHAT_COOKIE_NAME, CHAT_JWT_TTL_SECONDS } from "@/lib/negotiation/crypto"
import { createServiceClient } from "@/lib/supabase/service"

export const dynamic = "force-dynamic"

export async function POST(req: NextRequest) {
  if (process.env.CHAT_JOURNEY_ENABLED !== "true") {
    return NextResponse.json({ error: "not found" }, { status: 404 })
  }

  const cookie = req.cookies.get(CHAT_COOKIE_NAME)?.value
  const claims = cookie ? verifyChatJwt(cookie) : null
  // Só renova sessão VÁLIDA. Cookie expirado/adulterado/ausente → 401.
  if (!claims) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const supabase = createServiceClient()

  // TTL do tenant governa o novo `exp`/maxAge; ausente → default generoso.
  const { data: cfg } = await supabase
    .from("tenant_chat_config")
    .select("session_ttl_minutes")
    .eq("company_id", claims.cid)
    .maybeSingle()
  const ttlSeconds = (cfg?.session_ttl_minutes ?? CHAT_JWT_TTL_SECONDS / 60) * 60

  // Renova a atividade da sessão (mantém dentro do TTL de reuso). Best-effort:
  // uma falha aqui não pode derrubar o keep-alive do cookie.
  const now = new Date().toISOString()
  await supabase
    .from("negotiation_sessions")
    .update({ last_activity_at: now, updated_at: now })
    .eq("id", claims.sid)
    .eq("company_id", claims.cid)

  // Re-assina com `exp` fresco e re-seta o cookie httpOnly. As mesmas flags dos
  // demais caminhos (httpOnly/secure/sameSite=lax/path=/).
  const cookieValue = signChatJwt({ sid: claims.sid, cid: claims.cid }, ttlSeconds)
  const res = NextResponse.json({ ok: true })
  res.cookies.set(CHAT_COOKIE_NAME, cookieValue, {
    httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: ttlSeconds,
  })
  return res
}
