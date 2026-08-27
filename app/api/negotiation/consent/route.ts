// POST /api/negotiation/consent — registra o aceite LGPD (versão + timestamp).
// O chat fica bloqueado (rota message recusa) até o consentimento existir.

import { cookies } from "next/headers"
import { NextResponse } from "next/server"

import { CONSENT_VERSION } from "@/lib/negotiation/config"
import { corsHeaders } from "@/lib/negotiation/cors"
import { CHAT_COOKIE_NAME } from "@/lib/negotiation/crypto"
import { getSessionFromCookie, loadTenantConfig, updateSession } from "@/lib/negotiation/sessions"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  const session = await getSessionFromCookie(cookies().get(CHAT_COOKIE_NAME)?.value)
  if (!session) {
    return NextResponse.json({ success: false, error: "sessão inválida" }, { status: 401 })
  }

  const tenant = await loadTenantConfig(session.company_id)
  const origin = request.headers.get("origin")
  const headers = corsHeaders(origin, tenant?.allowed_origins ?? [])

  if (!session.consent_lgpd_at) {
    await updateSession(session.id, {
      consent_lgpd_at: new Date().toISOString(),
      consent_lgpd_version: CONSENT_VERSION,
    })
  }
  return NextResponse.json({ success: true, consent_version: CONSENT_VERSION }, { headers })
}
