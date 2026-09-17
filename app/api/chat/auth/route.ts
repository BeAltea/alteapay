// Autenticação do devedor no link seguro (F3.4). Timing equalizado (padding
// para ~600ms) para não vazar lock/erro/CPF-inexistente por tempo de resposta.
import { NextRequest, NextResponse } from "next/server"
import { validateToken } from "@/lib/journey/tokens"
import { authenticateDebtor, GENERIC_AUTH_MESSAGE } from "@/lib/journey/auth"

export const dynamic = "force-dynamic"

const MIN_RESPONSE_MS = 600

function clientIp(req: NextRequest): string | null {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? req.headers.get("x-nf-client-connection-ip")
    ?? null
}

export async function POST(req: NextRequest) {
  if (process.env.CHAT_JOURNEY_ENABLED !== "true") {
    return NextResponse.json({ error: "not found" }, { status: 404 })
  }
  const t0 = Date.now()
  const pad = async () => {
    const rest = MIN_RESPONSE_MS - (Date.now() - t0)
    if (rest > 0) await new Promise((r) => setTimeout(r, rest))
  }

  let body: { token?: string; document?: string; birthDate?: string; consent?: boolean }
  try {
    body = await req.json()
  } catch {
    await pad()
    return NextResponse.json({ ok: false, message: GENERIC_AUTH_MESSAGE }, { status: 400 })
  }
  if (!body.token) {
    await pad()
    return NextResponse.json({ ok: false, message: GENERIC_AUTH_MESSAGE }, { status: 400 })
  }
  const tv = await validateToken(body.token)
  if (!tv.ok) {
    await pad()
    // token inválido/expirado: mensagem própria (não é erro de credencial)
    return NextResponse.json({ ok: false, message: "Este link não está mais disponível. Aguarde um novo contato." }, { status: 410 })
  }

  const result = await authenticateDebtor({
    tokenRow: tv.tokenRow,
    document: body.document ?? "",
    birthDate: body.birthDate ?? null,
    consent: body.consent === true,
    ip: clientIp(req),
    userAgent: req.headers.get("user-agent"),
  })
  await pad()
  if (!result.ok) {
    return NextResponse.json({ ok: false, message: result.message }, { status: 401 })
  }
  const res = NextResponse.json({ ok: true, sessionId: result.sessionId })
  res.cookies.set(result.cookieName, result.cookieValue, {
    httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: result.cookieMaxAge,
  })
  return res
}
