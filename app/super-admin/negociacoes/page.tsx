// Negociações por devedor (super-admin, T5): lista com estágio, perfil de
// contato, canal, valor em aberto, cobrança viva; seleção múltipla + envio;
// filtros na URL; contadores por estágio. Documento SEMPRE mascarado (na camada
// de dados). super_admin obrigatório; company_id resolvido no servidor.
import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { NegotiationsTable } from "@/components/super-admin/negotiations/negotiations-table"

export const dynamic = "force-dynamic"

export default async function NegociacoesPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect("/auth/login")
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single()
  if (profile?.role !== "super_admin") redirect("/")

  // opções de filtro (cedente/campanha/canal) — carregadas server-side.
  const service = createServiceClient()
  const [{ data: companies }, { data: campaigns }, { data: channels }] = await Promise.all([
    service.from("companies").select("id, name").order("name", { ascending: true }),
    service
      .from("whatsapp_campaigns")
      .select("id, name")
      .order("created_at", { ascending: false })
      .limit(200),
    service.from("negotiation_state").select("channel").not("channel", "is", null).limit(1000),
  ])

  const channelOptions = Array.from(
    new Set((channels ?? []).map((c: { channel: string | null }) => c.channel).filter(Boolean)),
  ) as string[]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Negociações por devedor</h1>
        <p className="text-muted-foreground">
          Status por devedor (estágio do funil), seleção e envio de negociação. Documento
          sempre mascarado.
        </p>
      </div>

      <NegotiationsTable
        companyOptions={(companies ?? []) as Array<{ id: string; name: string }>}
        campaignOptions={(campaigns ?? []) as Array<{ id: string; name: string }>}
        channelOptions={channelOptions}
      />
    </div>
  )
}
