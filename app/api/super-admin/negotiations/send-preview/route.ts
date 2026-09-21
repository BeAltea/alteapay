// POST /api/super-admin/negotiations/send-preview
//
// Preview SEM efeito colateral: contagens por canal (WhatsApp/e-mail), excluídos
// com motivo, quantos com cobrança viva (informativo), o `mode` vigente e o link
// /n/{code} que será enviado. NÃO cria campanha, token, mensagem nem cobrança.
//
// Segurança (§3): só admin do tenant e super_admin. company_id é DERIVADO no
// servidor — admin sempre usa a própria empresa; super_admin pode escolher, mas
// o vínculo é sempre revalidado. Provider mock é o default (nada sai daqui de
// qualquer forma: preview não envia).

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import {
  loadTenantHubConfig,
  evaluateHubEligibility,
  summarizeHubEligibility,
} from "@/lib/journey/campaigns"

export const dynamic = "force-dynamic"
export const revalidate = 0

const noCache = { "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0" }

interface PreviewBody {
  companyId?: string
  customerIds?: string[]
  mode?: string
}

/**
 * Resolve o company_id no servidor:
 *  - super_admin: pode operar qualquer empresa (usa o companyId do corpo).
 *  - admin: SEMPRE a própria empresa (companyId do corpo é ignorado se divergir).
 * Retorna 401/403 se não autorizado.
 */
async function resolveCompany(request: NextRequest, bodyCompanyId?: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: "Não autenticado" }, { status: 401, headers: noCache }) }
  const { data: profile } = await supabase
    .from("profiles")
    .select("role, company_id, full_name")
    .eq("id", user.id)
    .single()
  const role = profile?.role
  if (role !== "super_admin" && role !== "admin") {
    return { error: NextResponse.json({ error: "Sem permissão" }, { status: 403, headers: noCache }) }
  }
  let companyId: string | null
  if (role === "super_admin") {
    companyId = bodyCompanyId ?? profile?.company_id ?? null
  } else {
    // admin: nunca aceita companyId do cliente que não seja o seu vínculo
    companyId = profile?.company_id ?? null
    if (bodyCompanyId && bodyCompanyId !== companyId) {
      return { error: NextResponse.json({ error: "company_id não pertence ao usuário" }, { status: 403, headers: noCache }) }
    }
  }
  if (!companyId) {
    return { error: NextResponse.json({ error: "companyId obrigatório" }, { status: 400, headers: noCache }) }
  }
  return { companyId, role, userId: user.id, fullName: profile?.full_name ?? null }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as PreviewBody
    const auth = await resolveCompany(request, body.companyId)
    if ("error" in auth) return auth.error
    const { companyId } = auth

    const customerIds = Array.isArray(body.customerIds) ? body.customerIds : []
    if (customerIds.length === 0) {
      return NextResponse.json({ error: "customerIds obrigatório" }, { status: 400, headers: noCache })
    }

    const hub = await loadTenantHubConfig(companyId)
    const mode = body.mode === "charge_email" || body.mode === "both" || body.mode === "whatsapp_chat"
      ? body.mode
      : hub.sendMode

    const evaluated = await evaluateHubEligibility({
      companyId,
      customerIds,
      cooldownDays: hub.cooldownDays,
      minDebtValue: hub.minDebtValue,
    })
    const counts = summarizeHubEligibility(evaluated)

    const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"
    const link = hub.publicLinkCode ? `${base}/n/${hub.publicLinkCode}` : null

    return NextResponse.json(
      {
        mode,
        counts: {
          whatsapp: counts.byChannel.whatsapp,
          email: counts.byChannel.email,
          eligibleTotal: counts.eligibleTotal,
          liveCharge: counts.liveChargeCount,
        },
        excluded: counts.excluded,
        link,
        linkEnabled: hub.publicLinkEnabled,
        // por-devedor (sem PII: só id + canal/motivo)
        rows: evaluated.map((e) => ({
          customerId: e.customerId,
          channel: e.channel ?? null,
          eligible: e.eligible,
          reason: e.reason ?? null,
          hasLiveCharge: !!e.hasLiveCharge,
        })),
      },
      { headers: noCache },
    )
  } catch (error: any) {
    console.error("[negotiations/send-preview] erro:", error?.message)
    return NextResponse.json({ error: error?.message ?? "Erro interno" }, { status: 500, headers: noCache })
  }
}
