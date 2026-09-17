// POST /api/negotiation/redirect — cenário 2 (modo B): registra o CLIQUE real
// do devedor no botão de canal oficial (redirect_events, com valor e oferta) e
// devolve a URL configurada do tenant — o ÚNICO caminho para obtê-la.

import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { z } from "zod"

import { corsHeaders } from "@/lib/negotiation/cors"
import { CHAT_COOKIE_NAME } from "@/lib/negotiation/crypto"
import {
  getSessionFromCookie,
  loadSessionDebtContext,
  loadTenantConfig,
  updateSession,
} from "@/lib/negotiation/sessions"
import { createServiceClient } from "@/lib/supabase/service"

export const dynamic = "force-dynamic"

const bodySchema = z.object({
  // Oferta que o devedor aceitou/viu antes do redirect (evidência p/ faturamento)
  offer_presented: z
    .object({
      type: z.string().optional(),
      label: z.string().optional(),
      total: z.union([z.string(), z.number()]).optional(),
      installments: z.number().optional(),
      discount_pct: z.union([z.string(), z.number()]).optional(),
    })
    .nullish(),
  confirmed_intent: z.boolean().optional(),
})

export async function POST(request: Request) {
  const session = await getSessionFromCookie(cookies().get(CHAT_COOKIE_NAME)?.value)
  if (!session) {
    return NextResponse.json({ success: false, error: "sessão inválida" }, { status: 401 })
  }
  if (!session.consent_lgpd_at) {
    return NextResponse.json({ success: false, error: "consentimento pendente" }, { status: 403 })
  }

  const tenant = await loadTenantConfig(session.company_id)
  const origin = request.headers.get("origin")
  const headers = corsHeaders(origin, tenant?.allowed_origins ?? [])
  if (!tenant?.official_channel_url) {
    return NextResponse.json(
      { success: false, error: "canal oficial não configurado para este tenant" },
      { status: 409, headers },
    )
  }

  let parsed
  try {
    parsed = bodySchema.safeParse(await request.json().catch(() => ({})))
  } catch {
    parsed = bodySchema.safeParse({})
  }
  const body = parsed.success ? parsed.data : {}

  const context = await loadSessionDebtContext(session)
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from("redirect_events")
    .insert({
      session_id: session.id,
      company_id: session.company_id, // sempre da sessão, nunca do client
      debt_id: session.debt_id,
      customer_id: session.customer_id,
      debt_amount_at_redirect: context?.amount ?? 0,
      offer_presented: body.offer_presented ?? null,
      official_channel_url: tenant.official_channel_url,
      confirmed_intent: body.confirmed_intent ?? true,
    })
    .select()
    .single()
  if (error || !data) {
    console.error("[negotiation:redirect]", error?.message)
    return NextResponse.json({ success: false, error: "falha ao registrar redirect" }, { status: 500, headers })
  }

  if (session.outcome === "in_progress") {
    await updateSession(session.id, { outcome: "redirected_official" }).catch((err) =>
      console.error("[negotiation:redirect] outcome:", err.message),
    )
  }

  return NextResponse.json(
    {
      success: true,
      redirect_event_id: data.id,
      official_channel_url: tenant.official_channel_url,
      official_channel_label: tenant.official_channel_label,
    },
    { headers },
  )
}
