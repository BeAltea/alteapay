// POST /api/negotiation/session/resolve — troca o token opaco do deep link por
// um cookie httpOnly de sessão de chat e devolve o contexto público (nome
// mascarado, valor, branding, consentimento pendente). Rate limit 10/min/IP.

import { clientIpFromHeaders } from "@/lib/journey/client-ip"
import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { z } from "zod"

import { engineSessionInit } from "@/lib/negotiation/engine"
import { appUrl } from "@/lib/negotiation/config"
import { corsHeaders, isOriginAllowed } from "@/lib/negotiation/cors"
import { CHAT_COOKIE_NAME, CHAT_JWT_TTL_SECONDS, sha256Hex, signChatJwt } from "@/lib/negotiation/crypto"
import { maskCpf, maskName } from "@/lib/negotiation/pii"
import { LIMITS, rateLimit } from "@/lib/negotiation/rate-limit"
import {
  getSessionFromCookie,
  loadSessionDebtContext,
  loadTenantConfig,
  resolveHandoffToken,
  updateSession,
} from "@/lib/negotiation/sessions"

export const dynamic = "force-dynamic"

const bodySchema = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) })

function clientIp(request: Request): string {
  return clientIpFromHeaders(request.headers) ?? "unknown"
}

export async function OPTIONS(request: Request) {
  // Preflight do widget white-label: valida contra allowed_origins no POST;
  // aqui devolve o eco mínimo (origin é revalidada com o tenant na resolução).
  const origin = request.headers.get("origin")
  return new NextResponse(null, {
    status: 204,
    headers: origin
      ? {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Credentials": "true",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          Vary: "Origin",
        }
      : {},
  })
}

export async function POST(request: Request) {
  const ip = clientIp(request)
  const rl = await rateLimit(`resolve:${ip}`, LIMITS.resolvePerIp.limit, LIMITS.resolvePerIp.windowSeconds)
  if (!rl.allowed) {
    return NextResponse.json({ success: false, error: "muitas tentativas" }, { status: 429 })
  }

  let parsed
  try {
    parsed = bodySchema.safeParse(await request.json())
  } catch {
    return NextResponse.json({ success: false, error: "JSON inválido" }, { status: 400 })
  }
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: "token inválido" }, { status: 422 })
  }

  const cookieStore = cookies()
  const existingCookie = cookieStore.get(CHAT_COOKIE_NAME)?.value ?? null
  const result = await resolveHandoffToken(parsed.data.token, existingCookie)
  if (!result.ok) {
    const status = result.reason === "expired" ? 410 : result.reason === "already_used" ? 409 : 404
    return NextResponse.json({ success: false, error: result.reason }, { status })
  }
  const { session } = result

  const tenant = await loadTenantConfig(session.company_id)
  const origin = request.headers.get("origin")
  if (!isOriginAllowed(origin, tenant?.allowed_origins ?? [])) {
    return NextResponse.json({ success: false, error: "origin não permitida" }, { status: 403 })
  }

  const context = await loadSessionDebtContext(session)

  // Semeia o thread no agente (idempotente). Identidade pré-verificada é
  // repassada SOMENTE se o gate já passou (ex.: WhatsApp) — nunca do client.
  if (session.thread_id && context) {
    try {
      await engineSessionInit({
        thread_id: session.thread_id,
        company_id: session.company_id,
        customer_name: context.customer_name,
        document: context.document,
        debt_id: context.debt_id,
        amount: context.amount,
        aging_days: context.aging_days,
        due_date: context.due_date,
        description: context.description ?? undefined,
        channel: "webchat",
        identity_preverified: Boolean(session.identity_verified_at),
        fulfillment_mode: session.fulfillment_mode ?? tenant?.fulfillment_mode ?? "A",
        official_channel_label: tenant?.official_channel_label
          ? `${tenant.official_channel_label}`
          : undefined,
        attendance_channel_label: tenant?.official_channel_label ?? undefined,
      })
    } catch (err) {
      console.error("[negotiation:resolve] session/init falhou:", err instanceof Error ? err.message : err)
      return NextResponse.json({ success: false, error: "agente indisponível" }, { status: 502 })
    }
  }

  if (result.firstUse) {
    await updateSession(session.id, {
      user_agent: request.headers.get("user-agent")?.slice(0, 500) ?? null,
      ip_hash: sha256Hex(ip),
    }).catch((err) => console.warn("[negotiation:resolve] auditoria de acesso:", err.message))
  }

  // TTL do tenant (mesmo critério dos demais caminhos de auth). NUNCA cai no
  // default curto: o `exp` do JWT e o maxAge do cookie usam session_ttl_minutes.
  const ttlSeconds = (tenant?.session_ttl_minutes ?? CHAT_JWT_TTL_SECONDS / 60) * 60
  const jwt = signChatJwt({ sid: session.id, cid: session.company_id }, ttlSeconds)
  const response = NextResponse.json(
    {
      success: true,
      session: {
        id: session.id,
        frontend_mode: session.frontend_mode,
        fulfillment_mode: session.fulfillment_mode,
        outcome: session.outcome,
        identity_verified: Boolean(session.identity_verified_at),
        consent_pending: !session.consent_lgpd_at,
      },
      debtor: context
        ? {
            name_masked: maskName(context.customer_name),
            document_masked: maskCpf(context.document),
            amount: context.amount,
            due_date: context.due_date,
            description: context.description,
            aging_days: context.aging_days,
          }
        : null,
      tenant: {
        branding: tenant?.branding ?? {},
        privacy_policy_url: tenant?.privacy_policy_url ?? null,
        dpo_contact: tenant?.dpo_contact ?? null,
        official_channel_label: tenant?.official_channel_label ?? null,
      },
    },
    { headers: corsHeaders(origin, tenant?.allowed_origins ?? []) },
  )
  // Secure segue o protocolo real do deploy (cluster local é http puro; com
  // NODE_ENV=production o flag fixo impediria o browser de enviar o cookie).
  // White-label em iframe cross-site exige None+Secure — só possível em https;
  // em http local o demo roda same-origin e Lax funciona.
  const isHttps = appUrl().startsWith("https")
  response.cookies.set(CHAT_COOKIE_NAME, jwt, {
    httpOnly: true,
    secure: isHttps,
    sameSite: session.frontend_mode === "whitelabel" && isHttps ? "none" : "lax",
    maxAge: ttlSeconds,
    path: "/",
  })
  return response
}
