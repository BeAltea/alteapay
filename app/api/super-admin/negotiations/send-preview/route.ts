// POST /api/super-admin/negotiations/send-preview
//
// Preview SEM efeito colateral: distribuição POR CANAL (WhatsApp/e-mail),
// excluídos POR DEVEDOR com motivo em CADA canal, o CRUZAMENTO (quantos têm os
// dois contatos / recebem pelos dois), quantos com cobrança viva (informativo),
// e o link /n/{code} que será enviado. NÃO cria campanha, token, mensagem nem
// cobrança.
//
// F1: a escolha é por CANAL (channels: ["whatsapp","email"]), não mais por forma
// de pagamento. `dedupe` ("não duplicar") prioriza WhatsApp para quem tem os dois.
//
// Fonte da verdade do FORMATO: components/super-admin/negotiations/send-contract.ts
// (a UI é rica; a rota emite exatamente o que o diálogo consome).
//
// Segurança (§3): só admin do tenant e super_admin. company_id é DERIVADO no
// servidor — admin sempre usa a própria empresa; super_admin pode escolher, mas
// o vínculo é sempre revalidado. Provider mock é o default (nada sai daqui de
// qualquer forma: preview não envia).

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { maskDocument } from "@/lib/journey/document"
import {
  loadTenantHubConfig,
  evaluateHubChannels,
  summarizeHubChannels,
  type HubChannel,
  type HubChannelDecision,
} from "@/lib/journey/campaigns"
import { resolveNegotiationTemplateInfo } from "@/lib/email/templates/resolve-default"
import { resolveSelection, type SelectionBody } from "../selection"
import type {
  SendChannel,
  SendPreviewExcluded,
  SendPreviewResponse,
} from "@/components/super-admin/negotiations/send-contract"

export const dynamic = "force-dynamic"
export const revalidate = 0

const noCache = { "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0" }

interface PreviewBody extends SelectionBody {
  companyId?: string
  channels?: string[]
  dedupe?: boolean
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

const ALL: SendChannel[] = ["whatsapp", "email"]

/** Sanitiza os canais do corpo (default: ambos). Vazio → ambos (o diálogo já
 * desabilita confirmar com nenhum; aqui default-a para o preview não quebrar). */
function parseChannels(raw: unknown): SendChannel[] {
  if (!Array.isArray(raw)) return [...ALL]
  const out = raw.filter((c): c is SendChannel => c === "whatsapp" || c === "email")
  return out.length > 0 ? Array.from(new Set(out)) : [...ALL]
}

/** Mascara o documento de cada customer excluído (nunca em claro). */
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

/** Converte as decisões inelegíveis de um canal no array por-devedor do contrato. */
function toExcluded(decisions: HubChannelDecision[], docs: Map<string, string>): SendPreviewExcluded[] {
  return decisions.map((d) => ({
    customerId: d.customerId,
    documentMasked: docs.get(d.customerId) ?? "***",
    reason: d.reason ?? "excluido",
  }))
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as PreviewBody
    const auth = await resolveCompany(request, body.companyId)
    if ("error" in auth) return auth.error
    const { companyId } = auth

    // Aceita { customerIds } OU { allFiltered }. Resolve ids no servidor.
    const selection = await resolveSelection(body, companyId)
    if ("error" in selection) {
      return NextResponse.json({ error: selection.error }, { status: selection.status, headers: noCache })
    }
    const { customerIds } = selection

    const hub = await loadTenantHubConfig(companyId)
    const channels = parseChannels(body.channels)
    const dedupe = body.dedupe === true

    const decisions = await evaluateHubChannels({
      companyId,
      customerIds,
      cooldownDays: hub.cooldownDays,
      minDebtValue: hub.minDebtValue,
      channels: channels as HubChannel[],
      dedupe,
    })
    const counts = summarizeHubChannels(decisions, channels as HubChannel[])

    const base = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/+$/, "")
    const publicLink = hub.publicLinkCode && hub.publicLinkEnabled ? `${base}/n/${hub.publicLinkCode}` : null

    // documentos mascarados de TODOS os excluídos (qualquer canal), uma vez só.
    const excludedIds = Array.from(
      new Set(
        (["whatsapp", "email"] as HubChannel[]).flatMap((ch) =>
          counts.perChannel[ch].excluded.map((d) => d.customerId),
        ),
      ),
    )
    const docs = await maskedDocuments(companyId, excludedIds)

    // F4: qual template o E-MAIL usará (padrão do cedente → global → convite
    // embutido). Só resolve quando o e-mail está entre os canais marcados.
    const emailTemplate = channels.includes("email")
      ? await resolveNegotiationTemplateInfo(companyId).then((t) => ({ source: t.source, name: t.name }))
      : undefined

    const response: SendPreviewResponse = {
      channels,
      dedupe,
      total: counts.total,
      perChannel: {
        whatsapp: {
          eligible: counts.perChannel.whatsapp.eligible,
          excluded: toExcluded(counts.perChannel.whatsapp.excluded, docs),
        },
        email: {
          eligible: counts.perChannel.email.eligible,
          excluded: toExcluded(counts.perChannel.email.excluded, docs),
        },
      },
      bothCount: counts.bothCount,
      hasBothContacts: counts.hasBothContacts,
      withLiveCharge: counts.liveChargeCount,
      publicLink,
      linkEnabled: hub.publicLinkEnabled,
      whatsappSimulated: hub.provider === "mock",
      emailTemplate,
    }

    return NextResponse.json(response, { headers: noCache })
  } catch (error: any) {
    console.error("[negotiations/send-preview] erro:", error?.message)
    return NextResponse.json({ error: error?.message ?? "Erro interno" }, { status: 500, headers: noCache })
  }
}
