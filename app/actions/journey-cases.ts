"use server"

// Server actions do painel super-admin de Negociação IA — casos e campanhas.
// Guardadas por role super_admin; escrita via service role no servidor.
import { revalidatePath } from "next/cache"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { createCampaign, startCampaign } from "@/lib/journey/campaigns"

async function assertSuperAdmin(): Promise<string> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("Não autenticado")
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single()
  if (profile?.role !== "super_admin") throw new Error("Sem permissão")
  return user.id
}

const CASE_STATUSES = ["open", "in_review", "resolved", "rejected"] as const
type CaseStatus = (typeof CASE_STATUSES)[number]

export async function resolveCase(input: {
  caseId: string
  status: CaseStatus
  resolution?: string
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const userId = await assertSuperAdmin()
    if (!CASE_STATUSES.includes(input.status)) return { ok: false, error: "Status inválido." }
    const supabase = createServiceClient()
    const patch: Record<string, unknown> = {
      status: input.status,
      updated_at: new Date().toISOString(),
      assigned_to: userId,
    }
    if (input.status === "resolved" || input.status === "rejected") {
      patch.resolved_at = new Date().toISOString()
      patch.resolution = input.resolution ?? null
    }
    const { error } = await supabase
      .from("negotiation_cases")
      .update(patch)
      .eq("id", input.caseId)
    if (error) return { ok: false, error: error.message }
    revalidatePath("/super-admin/negociacao-ia/casos")
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export async function createJourneyCampaign(input: {
  companyId: string
  name: string
  templateKey: string
  customerIds: string[]
  scheduledAt?: string | null
}): Promise<{ ok: boolean; error?: string; campaignId?: string; eligible?: number }> {
  try {
    const userId = await assertSuperAdmin()
    const name = input.name?.trim()
    if (!name) return { ok: false, error: "Nome da campanha é obrigatório." }
    if (!input.companyId) return { ok: false, error: "Empresa é obrigatória." }
    const ids = Array.from(new Set((input.customerIds ?? []).map((s) => s.trim()).filter(Boolean)))
    if (ids.length === 0) return { ok: false, error: "Informe ao menos um cliente (lista explícita)." }

    const result = await createCampaign({
      companyId: input.companyId,
      name,
      templateKey: input.templateKey?.trim() || "default",
      customerIds: ids,
      scheduledAt: input.scheduledAt ?? null,
      createdBy: userId,
    })
    revalidatePath("/super-admin/negociacao-ia/campanhas")
    return { ok: true, campaignId: result.campaignId, eligible: result.eligible }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export async function startJourneyCampaign(
  campaignId: string,
): Promise<{ ok: boolean; error?: string; queued?: number }> {
  try {
    await assertSuperAdmin()
    if (!campaignId) return { ok: false, error: "Campanha inválida." }
    const { queued } = await startCampaign(campaignId)
    revalidatePath("/super-admin/negociacao-ia/campanhas")
    return { ok: true, queued }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
