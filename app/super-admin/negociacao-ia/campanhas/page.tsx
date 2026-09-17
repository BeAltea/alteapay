// Campanhas (super-admin). Server: carrega empresas + campanhas via service role.
// Colunas HONESTAS (V6): Aceitas pelo provedor, Cliques, Autenticações, Acordos,
// Suprimidas, Falhas. Entregue/Lido só aparecem quando há FONTE do provider
// (provider_status_source != 'none'); senão "não informado pelo provedor".
import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { CampaignsAdmin, type CampaignView } from "@/components/journey/campaigns-admin"

export const dynamic = "force-dynamic"

async function campaignCounts(service: ReturnType<typeof createServiceClient>, campaignId: string) {
  // Contadores derivados de whatsapp_messages (fonte confiável nossa).
  const { data: msgs } = await service
    .from("whatsapp_messages")
    .select("status, clicked_at, provider_status_source")
    .eq("campaign_id", campaignId)
  const rows = msgs ?? []
  const accepted = rows.filter((m) => m.status === "accepted" || m.status === "sent").length
  const clicks = rows.filter((m) => m.clicked_at).length
  const suppressed = rows.filter((m) => m.status === "suppressed").length
  const failed = rows.filter((m) => m.status === "failed").length
  const hasDeliverySource = rows.some((m) => m.provider_status_source && m.provider_status_source !== "none")

  // Autenticações e acordos vindos da jornada (auth.success / agreement.created).
  const [{ count: auths }, { count: agreements }] = await Promise.all([
    service
      .from("journey_events")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaignId)
      .eq("event_type", "auth.success"),
    service
      .from("journey_events")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaignId)
      .eq("event_type", "agreement.created"),
  ])

  return {
    accepted,
    clicks,
    auths: auths ?? 0,
    agreements: agreements ?? 0,
    suppressed,
    failed,
    hasDeliverySource: hasDeliverySource,
  }
}

export default async function CampanhasPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect("/auth/login")
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single()
  if (profile?.role !== "super_admin") redirect("/")

  const service = createServiceClient()
  const [{ data: companies }, { data: campaigns }, { count: unprocessedEvents }] = await Promise.all([
    service.from("companies").select("id, name").order("name", { ascending: true }),
    service
      .from("whatsapp_campaigns")
      .select("id, company_id, name, status, template_key, counts, created_at, companies(name)")
      .order("created_at", { ascending: false })
      .limit(200),
    service
      .from("whatsapp_provider_events")
      .select("id", { count: "exact", head: true })
      .eq("processed", false),
  ])

  const companyList = (companies ?? []).map((c) => ({ id: c.id, name: c.name ?? "—" }))
  const rows: CampaignView[] = await Promise.all(
    (campaigns ?? []).map(async (c) => {
      const company = c.companies as unknown as { name: string } | null
      const counts = (c.counts ?? {}) as { eligible?: number; queued?: number; ineligible?: Record<string, number> }
      const live = await campaignCounts(service, c.id)
      const dupPhones =
        typeof counts.ineligible?.telefone_duplicado === "number" ? counts.ineligible.telefone_duplicado : 0
      return {
        id: c.id,
        company_name: company?.name ?? "—",
        name: c.name,
        status: c.status,
        template_key: c.template_key,
        eligible: typeof counts.eligible === "number" ? counts.eligible : null,
        queued: typeof counts.queued === "number" ? counts.queued : null,
        accepted: live.accepted,
        clicks: live.clicks,
        auths: live.auths,
        agreements: live.agreements,
        suppressed: live.suppressed,
        failed: live.failed,
        hasDeliverySource: live.hasDeliverySource,
        duplicatePhones: dupPhones,
        created_at: c.created_at,
      }
    }),
  )

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Campanhas</h1>
        <p className="text-muted-foreground">
          Disparo por lista explícita de clientes (nunca por filtro vivo).
        </p>
      </div>
      <CampaignsAdmin
        companies={companyList}
        campaigns={rows}
        unprocessedProviderEvents={unprocessedEvents ?? 0}
      />
    </div>
  )
}
