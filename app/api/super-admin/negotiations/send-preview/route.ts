// POST /api/super-admin/negotiations/send-preview
//
// Preview SEM efeito colateral: distribuição por canal (WhatsApp/e-mail),
// excluídos POR DEVEDOR com motivo, quantos com cobrança viva (informativo), o
// `mode` vigente, os modos permitidos pelo tenant e o link /n/{code} que será
// enviado. NÃO cria campanha, token, mensagem nem cobrança.
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
  evaluateHubEligibility,
  summarizeHubEligibility,
} from "@/lib/journey/campaigns"
import { resolveSelection, type SelectionBody } from "../selection"
import type {
  SendMode,
  SendPreviewExcluded,
  SendPreviewResponse,
} from "@/components/super-admin/negotiations/send-contract"

export const dynamic = "force-dynamic"
export const revalidate = 0

const noCache = { "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0" }

interface PreviewBody extends SelectionBody {
  companyId?: string
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

const VALID_MODES: SendMode[] = ["whatsapp_chat", "charge_email", "both"]

/**
 * Modos permitidos pelo tenant: whatsapp_chat é SEMPRE oferecido (é o link do
 * chat, base da jornada). charge_email/both só quando o send mode configurado do
 * tenant os habilita (negotiation_send_mode). Isso alimenta a troca de modo no
 * diálogo (canSwitchMode).
 */
function allowedModesFor(sendMode: SendMode): SendMode[] {
  if (sendMode === "both") return ["whatsapp_chat", "charge_email", "both"]
  if (sendMode === "charge_email") return ["whatsapp_chat", "charge_email"]
  return ["whatsapp_chat"]
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
    const mode: SendMode = VALID_MODES.includes(body.mode as SendMode)
      ? (body.mode as SendMode)
      : hub.sendMode

    const evaluated = await evaluateHubEligibility({
      companyId,
      customerIds,
      cooldownDays: hub.cooldownDays,
      minDebtValue: hub.minDebtValue,
    })
    const counts = summarizeHubEligibility(evaluated)

    const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"
    const publicLink = hub.publicLinkCode && hub.publicLinkEnabled ? `${base}/n/${hub.publicLinkCode}` : null

    // Excluídos POR DEVEDOR (array), com documento MASCARADO + motivo.
    const excludedIds = evaluated.filter((e) => !e.eligible).map((e) => e.customerId)
    const docs = await maskedDocuments(companyId, excludedIds)
    const excluded: SendPreviewExcluded[] = evaluated
      .filter((e) => !e.eligible)
      .map((e) => ({
        customerId: e.customerId,
        documentMasked: docs.get(e.customerId) ?? "***",
        reason: e.reason ?? "excluido",
      }))

    const response: SendPreviewResponse & {
      // por-devedor (sem PII: só id + canal/motivo) — auxiliar para depuração.
      rows: Array<{ customerId: string; channel: string | null; eligible: boolean; reason: string | null; hasLiveCharge: boolean }>
    } = {
      mode,
      total: counts.eligibleTotal,
      byChannel: { whatsapp: counts.byChannel.whatsapp, email: counts.byChannel.email },
      withLiveCharge: counts.liveChargeCount,
      publicLink,
      linkEnabled: hub.publicLinkEnabled,
      allowedModes: allowedModesFor(hub.sendMode),
      excluded,
      rows: evaluated.map((e) => ({
        customerId: e.customerId,
        channel: e.channel ?? null,
        eligible: e.eligible,
        reason: e.reason ?? null,
        hasLiveCharge: !!e.hasLiveCharge,
      })),
    }

    return NextResponse.json(response, { headers: noCache })
  } catch (error: any) {
    console.error("[negotiations/send-preview] erro:", error?.message)
    return NextResponse.json({ error: error?.message ?? "Erro interno" }, { status: 500, headers: noCache })
  }
}
