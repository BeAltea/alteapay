// Campanhas (super-admin). Server: carrega empresas + campanhas via service role.
import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { CampaignsAdmin, type CampaignView } from "@/components/journey/campaigns-admin"

export const dynamic = "force-dynamic"

export default async function CampanhasPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect("/auth/login")
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single()
  if (profile?.role !== "super_admin") redirect("/")

  const service = createServiceClient()
  const [{ data: companies }, { data: campaigns }] = await Promise.all([
    service.from("companies").select("id, name").order("name", { ascending: true }),
    service
      .from("whatsapp_campaigns")
      .select("id, company_id, name, status, template_key, counts, created_at, companies(name)")
      .order("created_at", { ascending: false })
      .limit(200),
  ])

  const companyList = (companies ?? []).map((c) => ({ id: c.id, name: c.name ?? "—" }))
  const rows: CampaignView[] = (campaigns ?? []).map((c) => {
    const company = c.companies as unknown as { name: string } | null
    const counts = (c.counts ?? {}) as { eligible?: number; queued?: number }
    return {
      id: c.id,
      company_name: company?.name ?? "—",
      name: c.name,
      status: c.status,
      template_key: c.template_key,
      eligible: typeof counts.eligible === "number" ? counts.eligible : null,
      queued: typeof counts.queued === "number" ? counts.queued : null,
      created_at: c.created_at,
    }
  })

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Campanhas</h1>
        <p className="text-muted-foreground">
          Disparo por lista explícita de clientes (nunca por filtro vivo).
        </p>
      </div>
      <CampaignsAdmin companies={companyList} campaigns={rows} />
    </div>
  )
}
