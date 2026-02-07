import { createAdminClient } from "@/lib/supabase/server"
import { NegotiationsClient } from "@/components/super-admin/negotiations-client"

export const dynamic = "force-dynamic"
export const revalidate = 0

async function fetchData() {
  const supabase = createAdminClient()

  // Fetch all companies
  const { data: companiesData, error: companiesError } = await supabase
    .from("companies")
    .select("id, name")
    .order("name")

  if (companiesError) {
    console.error("[v0] Error fetching companies:", companiesError)
    return { companies: [] }
  }

  return {
    companies: companiesData || [],
  }
}

export default async function NegotiationsPage() {
  const { companies } = await fetchData()

  return (
    <div className="w-full overflow-x-hidden space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Negociações</h1>
        <p className="text-muted-foreground">
          Gerencie o envio de cobranças e negociações para os clientes das empresas.
        </p>
      </div>

      <NegotiationsClient companies={companies} />
    </div>
  )
}
