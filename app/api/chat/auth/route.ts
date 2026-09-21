// Autenticação do devedor. Dois caminhos, MESMA resposta uniforme e timing:
//   1. Link de campanha /c/{token}: valida o token e casa o documento (auth.ts).
//   2. Genérico /t/{slug}/negociar: só o documento; resolve no company_id do
//      slug (generic-auth.ts). Fechado ao público (journey_public_enabled=false)
//      → admin-only, decidido na página; a rota exige company_id já resolvido.
// Timing equalizado (padding ~600ms) para não vazar lock/erro/inexistente.
import { NextRequest, NextResponse } from "next/server"
import { validateToken } from "@/lib/journey/tokens"
import { authenticateDebtor, GENERIC_AUTH_MESSAGE } from "@/lib/journey/auth"
import { authenticateByDocument, authenticateByPublicLink, PUBLIC_NO_DEBT_MESSAGE } from "@/lib/journey/generic-auth"
import { normalizeDocument } from "@/lib/journey/document"
import { resolveCompanyBySlug } from "@/lib/journey/resolver"
import { resolvePublicLink } from "@/lib/journey/public-link"

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

  let body: {
    token?: string
    tenantSlug?: string
    code?: string
    document?: string
    birthDate?: string
    consent?: boolean
    captchaToken?: string
  }
  try {
    body = await req.json()
  } catch {
    await pad()
    return NextResponse.json({ ok: false, message: GENERIC_AUTH_MESSAGE }, { status: 400 })
  }

  // ---------- caminho LINK ÚNICO PÚBLICO (/n/{code}, sem token) ----------
  // Resposta SEMPRE 200 nos casos de negócio (resolvido / no_debt / blocked) —
  // MESMA mensagem e MESMO status para no_debt, com timing equalizado. Nada
  // revela se o documento existe. O code endereça o tenant; o documento auth.
  if (!body.token && !body.tenantSlug && body.code) {
    const link = await resolvePublicLink(body.code)
    if (!link.ok) {
      await pad()
      // code inválido/desligado/expirado: neutro (não enumera). Não é 404 que
      // ajude a distinguir — mesma casca "indisponível" da página.
      return NextResponse.json({ ok: false, reason: "unavailable", message: "not available" }, { status: 200 })
    }
    // Defesa em profundidade (D14): NENHUM erro inesperado do resolver pode virar
    // 500 (vaza stack + distingue "existe/não existe"). Qualquer throw colapsa na
    // MESMA resposta neutra no_debt 200, com o padding de timing preservado.
    let result: Awaited<ReturnType<typeof authenticateByPublicLink>>
    try {
      result = await authenticateByPublicLink({
        companyId: link.tenant.companyId,
        document: normalizeDocument(body.document ?? ""),
        consent: body.consent === true,
        ip: clientIp(req),
        userAgent: req.headers.get("user-agent"),
        captchaToken: body.captchaToken ?? null,
      })
    } catch (err) {
      console.error("[chat/auth] public-link resolver falhou:", (err as Error).message)
      await pad()
      return NextResponse.json({ ok: false, reason: "no_debt", message: PUBLIC_NO_DEBT_MESSAGE }, { status: 200 })
    }
    await pad()
    if (!result.ok) {
      // HTTP 200 em todos os casos de negócio (no_debt/blocked/invalid): o
      // status não distingue "documento existe" de "não existe".
      return NextResponse.json({ ok: false, reason: result.reason, message: result.message }, { status: 200 })
    }
    const res = NextResponse.json({ ok: true, sessionId: result.sessionId })
    res.cookies.set(result.cookieName, result.cookieValue, {
      httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: result.cookieMaxAge,
    })
    return res
  }

  // ---------- caminho GENÉRICO (slug, sem token) ----------
  if (!body.token && body.tenantSlug) {
    const companyId = await resolveCompanyBySlug(body.tenantSlug)
    if (!companyId) {
      await pad()
      // slug inexistente é 404 (não é erro de credencial)
      return NextResponse.json({ ok: false, message: "not found" }, { status: 404 })
    }
    const result = await authenticateByDocument({
      companyId,
      document: normalizeDocument(body.document ?? ""),
      consent: body.consent === true,
      ip: clientIp(req),
      userAgent: req.headers.get("user-agent"),
      captchaToken: body.captchaToken ?? null,
      channel: "web_generic",
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

  // ---------- caminho de CAMPANHA (/c/{token}) ----------
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
