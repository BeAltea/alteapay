// POST /api/super-admin/negotiations/send
//
// Dispara a negociação por devedor. Modos (tenant_chat_config.negotiation_send_mode
// é o default):
//   whatsapp_chat (default) — dispara o LINK do chat (/n/{code}) por WhatsApp ou
//     e-mail (precedência E2/H10). NÃO cria cobrança nem e-mail de cobrança.
//   charge_email — comportamento ANTIGO preservado. Esta rota NÃO reescreve a
//     criação de cobrança/e-mail: apenas roteia para o caminho legado
//     (/api/super-admin/send-bulk-negotiations), que continua intacto.
//   both — dispara o link do chat E sinaliza a cobrança pelo caminho legado.
//
// Precedência de canal (E2/H10): celular válido → WhatsApp (Voxuy API via
// getWhatsAppProvider com voxuy_flow_id do tenant); senão e-mail válido → e-mail
// (mesmo link); senão no_contact (fora, listado).
//
// DISPATCH_MODE=inline|queue (default queue). inline dispara na request, com teto
// INLINE_DISPATCH_MAX_BATCH (25) + rate-limit e TRAVA em super_admin. dryRun =
// resultado completo sem enviar.
//
// Segurança (§3): só admin do tenant e super_admin; company_id DERIVADO no
// servidor. Provider mock é o default (nada sai).

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createHubCampaign, loadTenantHubConfig, type NegotiationSendMode } from "@/lib/journey/campaigns"
import { runHubSend } from "@/lib/journey/campaign-send"

export const dynamic = "force-dynamic"
export const revalidate = 0
export const maxDuration = 120

const noCache = { "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0" }

const INLINE_DISPATCH_MAX_BATCH = Number(process.env.INLINE_DISPATCH_MAX_BATCH ?? "25")

interface SendBody {
  companyId?: string
  customerIds?: string[]
  mode?: string
  dryRun?: boolean
}

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
    companyId = profile?.company_id ?? null
    if (bodyCompanyId && bodyCompanyId !== companyId) {
      return { error: NextResponse.json({ error: "company_id não pertence ao usuário" }, { status: 403, headers: noCache }) }
    }
  }
  if (!companyId) {
    return { error: NextResponse.json({ error: "companyId obrigatório" }, { status: 400, headers: noCache }) }
  }
  return { companyId, role: role as "admin" | "super_admin", userId: user.id, fullName: profile?.full_name ?? null }
}

function resolveDispatch(): "inline" | "queue" {
  return (process.env.DISPATCH_MODE ?? "queue").toLowerCase() === "inline" ? "inline" : "queue"
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as SendBody
    const auth = await resolveCompany(request, body.companyId)
    if ("error" in auth) return auth.error
    const { companyId, role, userId } = auth

    const customerIds = Array.isArray(body.customerIds) ? body.customerIds : []
    if (customerIds.length === 0) {
      return NextResponse.json({ error: "customerIds obrigatório" }, { status: 400, headers: noCache })
    }

    const hub = await loadTenantHubConfig(companyId)
    const mode: NegotiationSendMode =
      body.mode === "charge_email" || body.mode === "both" || body.mode === "whatsapp_chat"
        ? body.mode
        : hub.sendMode
    const dryRun = body.dryRun === true
    const dispatchMode = resolveDispatch()

    // inline só para super_admin (E2/§4): dispara na request, teto + rate-limit.
    if (dispatchMode === "inline" && !dryRun) {
      if (role !== "super_admin") {
        return NextResponse.json({ error: "inline dispatch restrito a super_admin" }, { status: 403, headers: noCache })
      }
      if (customerIds.length > INLINE_DISPATCH_MAX_BATCH) {
        return NextResponse.json(
          { error: `inline dispatch limitado a ${INLINE_DISPATCH_MAX_BATCH} por lote (recebido ${customerIds.length})` },
          { status: 400, headers: noCache },
        )
      }
    }

    // charge_email: NÃO reescreve a criação de cobrança/e-mail — o caminho antigo
    // (/api/super-admin/send-bulk-negotiations) fica intacto. Aqui apenas roteia
    // (o cliente chama o endpoint legado para a parte de cobrança).
    const chargeEmailDelegation =
      mode === "charge_email" || mode === "both"
        ? { delegated: true, endpoint: "/api/super-admin/send-bulk-negotiations", note: "cobrança/e-mail preservados no caminho legado" }
        : null

    // A parte do LINK do chat só roda em whatsapp_chat e both.
    let hubResult = null as Awaited<ReturnType<typeof runHubSend>> | null
    let campaignId: string | null = null
    if (mode === "whatsapp_chat" || mode === "both") {
      const { campaignId: cid } = await createHubCampaign({
        companyId,
        name: `Hub ${new Date().toISOString().slice(0, 10)}`,
        templateKey: "hub_link",
        customerIds,
        createdBy: userId,
        sendMode: mode,
        provider: hub.provider,
      })
      campaignId = cid
      hubResult = await runHubSend({ campaignId: cid, companyId, dispatchMode, dryRun })
    }

    return NextResponse.json(
      {
        mode,
        dispatchMode,
        dryRun,
        campaignId,
        chargeEmail: chargeEmailDelegation,
        ...(hubResult
          ? { summary: hubResult.summary, items: hubResult.items }
          : { summary: null, items: [] }),
      },
      { headers: noCache },
    )
  } catch (error: any) {
    console.error("[negotiations/send] erro:", error?.message)
    return NextResponse.json({ error: error?.message ?? "Erro interno" }, { status: 500, headers: noCache })
  }
}
