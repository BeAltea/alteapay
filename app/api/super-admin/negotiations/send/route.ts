// POST /api/super-admin/negotiations/send
//
// Dispara a negociação por (devedor, CANAL). O corpo carrega os CANAIS marcados
// no diálogo (channels: ["whatsapp","email"]) e `dedupe` ("não duplicar"). Cada
// devedor recebe por TODOS os canais que possuir (E2/E3); com dedupe, quem tem os
// dois vai só por WhatsApp. NÃO cria cobrança nem e-mail de cobrança — o link do
// chat (/n/{code}) vai por WhatsApp (Voxuy mock) e/ou por e-mail (SendGrid).
//
// Canais em SEQUÊNCIA INDEPENDENTE (E3): uma falha no e-mail não afeta o WhatsApp.
//
// Fonte da verdade do FORMATO: components/super-admin/negotiations/send-contract.ts
// (a rota emite { dryRun, channels, dedupe, counts, results } que o diálogo lê).
//
// EMAIL_SEND_MODE/DISPATCH_MODE=inline|queue (default queue). inline dispara na
// request, com teto INLINE_DISPATCH_MAX_BATCH (25) + TRAVA em super_admin. Acima
// do teto orienta dividir em lotes. dryRun = resultado completo sem enviar.
//
// Segurança (§3): só admin do tenant e super_admin; company_id DERIVADO no
// servidor. Provider mock é o default (nada sai).

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { maskDocument } from "@/lib/journey/document"
import { createHubCampaign, loadTenantHubConfig } from "@/lib/journey/campaigns"
import { runHubSend, type HubSendItem } from "@/lib/journey/campaign-send"
import { resolveSelection, type SelectionBody } from "../selection"
import type {
  SendChannel,
  SendOutcome,
  SendResultRow,
} from "@/components/super-admin/negotiations/send-contract"

export const dynamic = "force-dynamic"
export const revalidate = 0
export const maxDuration = 120

const noCache = { "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0" }

const INLINE_DISPATCH_MAX_BATCH = Number(process.env.INLINE_DISPATCH_MAX_BATCH ?? "25")

interface SendBody extends SelectionBody {
  companyId?: string
  channels?: string[]
  dedupe?: boolean
  dryRun?: boolean
  /** A1: chave de idempotência gerada 1x pelo diálogo. Double-click/retry com a
   * mesma chave reusam a mesma campanha (não duplicam envio real). */
  idempotencyKey?: string
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
  // EMAIL_SEND_MODE/DISPATCH_MODE compartilham o mesmo eixo (inline dispara na
  // request; queue enfileira). Qualquer um dos dois em 'inline' liga o modo inline.
  const raw = (process.env.EMAIL_SEND_MODE ?? process.env.DISPATCH_MODE ?? "queue").toLowerCase()
  return raw === "inline" ? "inline" : "queue"
}

const ALL: SendChannel[] = ["whatsapp", "email"]

function parseChannels(raw: unknown): SendChannel[] {
  if (!Array.isArray(raw)) return [...ALL]
  const out = raw.filter((c): c is SendChannel => c === "whatsapp" || c === "email")
  return Array.from(new Set(out))
}

/** status do item do hub → desfecho do contrato. São nomes iguais, mas o cast
 * garante o tipo do contrato mesmo se os conjuntos divergirem no futuro. */
function toOutcome(status: HubSendItem["status"]): SendOutcome {
  switch (status) {
    case "sent":
    case "failed":
    case "suppressed":
    case "skipped":
      return status
    default:
      return "skipped"
  }
}

/** Mascara o documento de cada customer (nunca em claro). */
async function maskedDocuments(companyId: string, customerIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (customerIds.length === 0) return out
  const supabase = createServiceClient()
  const chunk = 300
  for (let i = 0; i < customerIds.length; i += chunk) {
    const part = customerIds.slice(i, i + chunk)
    const { data } = await (supabase as any)
      .from("customers")
      .select("id, document")
      .eq("company_id", companyId)
      .in("id", part)
    for (const c of data ?? []) out.set(c.id, maskDocument(c.document ?? null))
  }
  return out
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as SendBody
    const auth = await resolveCompany(request, body.companyId)
    if ("error" in auth) return auth.error
    const { companyId, role, userId } = auth

    // Aceita { customerIds } OU { allFiltered }. Resolve ids no servidor.
    const selection = await resolveSelection(body, companyId)
    if ("error" in selection) {
      return NextResponse.json({ error: selection.error }, { status: selection.status, headers: noCache })
    }
    const { customerIds } = selection

    const channels = parseChannels(body.channels)
    if (channels.length === 0) {
      return NextResponse.json({ error: "Selecione ao menos um canal" }, { status: 400, headers: noCache })
    }
    const dedupe = body.dedupe === true
    const dryRun = body.dryRun === true

    const hub = await loadTenantHubConfig(companyId)
    const dispatchMode = resolveDispatch()

    // inline só para super_admin (E2/§4): dispara na request, teto + rate-limit.
    // Acima do teto: orienta dividir em lotes (não trunca silenciosamente).
    if (dispatchMode === "inline" && !dryRun) {
      if (role !== "super_admin") {
        return NextResponse.json({ error: "inline dispatch restrito a super_admin" }, { status: 403, headers: noCache })
      }
      if (customerIds.length > INLINE_DISPATCH_MAX_BATCH) {
        return NextResponse.json(
          {
            error: `Envio inline limitado a ${INLINE_DISPATCH_MAX_BATCH} devedores por lote (recebidos ${customerIds.length}). Divida a seleção em lotes de até ${INLINE_DISPATCH_MAX_BATCH}.`,
            maxBatch: INLINE_DISPATCH_MAX_BATCH,
            received: customerIds.length,
          },
          { status: 400, headers: noCache },
        )
      }
    }

    // O envio do hub dispara o LINK do chat por canal. Não cria cobrança.
    const { campaignId } = await createHubCampaign({
      companyId,
      name: `Hub ${new Date().toISOString().slice(0, 10)}`,
      templateKey: "hub_link",
      customerIds,
      createdBy: userId,
      sendMode: "whatsapp_chat",
      provider: hub.provider,
      channels,
      dedupe,
      // dryRun não consome/colide com a chave do envio real.
      idempotencyKey: dryRun ? null : (typeof body.idempotencyKey === "string" ? body.idempotencyKey : null),
    })
    const hubResult = await runHubSend({ campaignId, companyId, dispatchMode, dryRun })

    // counts (=summary) + results POR (DEVEDOR, CANAL) com documento MASCARADO.
    const items: HubSendItem[] = hubResult.items
    const docs = await maskedDocuments(companyId, Array.from(new Set(items.map((i) => i.customerId))))
    const results: SendResultRow[] = items.map((i) => ({
      customerId: i.customerId,
      documentMasked: docs.get(i.customerId) ?? "***",
      channel: i.channel ?? null,
      outcome: toOutcome(i.status),
      detail: i.reason ?? null,
    }))
    const counts = hubResult.summary

    return NextResponse.json(
      {
        dryRun,
        channels,
        dedupe,
        dispatchMode,
        campaignId,
        counts,
        results,
      },
      { headers: noCache },
    )
  } catch (error: any) {
    console.error("[negotiations/send] erro:", error?.message)
    return NextResponse.json({ error: error?.message ?? "Erro interno" }, { status: 500, headers: noCache })
  }
}
