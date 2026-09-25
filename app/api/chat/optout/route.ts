// POST das ações destrutivas do link (V4.3): cancelar inscrição / bloquear
// número. NUNCA em GET (prefetch-safe). Valida CSRF de sessão curta (cookie +
// corpo casam) antes de aplicar a supressão. Idempotente por token de uso único.
import { NextRequest, NextResponse } from "next/server"
import { applyBlock, applyOptout, verifyActionCsrf } from "@/lib/journey/optout"

export const dynamic = "force-dynamic"
export const fetchCache = "force-no-store"
export const revalidate = 0

export async function POST(req: NextRequest) {
  if (process.env.CHAT_JOURNEY_ENABLED !== "true") {
    return NextResponse.json({ error: "not found" }, { status: 404 })
  }
  const body = await req.json().catch(() => ({})) as {
    token?: string
    kind?: "optout" | "block"
    csrf?: string
  }
  const token = body.token ?? ""
  const kind = body.kind
  if (!token || (kind !== "optout" && kind !== "block")) {
    return NextResponse.json({ ok: false }, { status: 400 })
  }
  const purpose = kind
  const cookieCsrf = req.cookies.get(`ap_csrf_${purpose}`)?.value ?? ""
  if (!body.csrf || body.csrf !== cookieCsrf || !verifyActionCsrf(body.csrf, token, purpose)) {
    return NextResponse.json({ ok: false, reason: "csrf" }, { status: 403 })
  }

  const result = kind === "optout" ? await applyOptout(token) : await applyBlock(token)
  // Resposta neutra: sucesso e "já feito" são ambos 200 (idempotência amigável).
  if (result.ok || result.reason === "already_done") {
    return NextResponse.json({ ok: true })
  }
  return NextResponse.json({ ok: false }, { status: 410 })
}
