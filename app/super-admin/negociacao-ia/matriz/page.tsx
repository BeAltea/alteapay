// Matriz de condições (super-admin). Server: carrega empresas + faixas via
// service role; edição pelas server actions de journey-matrix.
import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { MatrixAdmin, type MatrixRowView } from "@/components/journey/matrix-admin"

export const dynamic = "force-dynamic"

export default async function MatrizPage({
  searchParams,
}: {
  searchParams: Promise<{ company?: string }>
}) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect("/auth/login")
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single()
  if (profile?.role !== "super_admin") redirect("/")

  const { company } = await searchParams
  const service = createServiceClient()
  const { data: companies } = await service
    .from("companies")
    .select("id, name")
    .order("name", { ascending: true })

  const companyList = (companies ?? []).map((c) => ({ id: c.id, name: c.name ?? "—" }))
  const selectedCompanyId = company ?? companyList[0]?.id ?? null

  let rows: MatrixRowView[] = []
  if (selectedCompanyId) {
    const { data } = await service
      .from("negotiation_condition_matrix")
      .select("*")
      .eq("company_id", selectedCompanyId)
      .order("priority", { ascending: false })
    rows = (data ?? []).map((r) => ({
      id: r.id,
      company_id: r.company_id,
      name: r.name,
      priority: r.priority,
      active: r.active,
      aging_min_days: r.aging_min_days,
      aging_max_days: r.aging_max_days,
      max_discount_pct: Number(r.max_discount_pct),
      installment_discount_pct: Number(r.installment_discount_pct),
      min_entry_pct: Number(r.min_entry_pct),
      max_installments: r.max_installments,
      min_installment_value: Number(r.min_installment_value),
      allowed_billing_types: r.allowed_billing_types ?? [],
      proposal_validity_days: r.proposal_validity_days,
      retry_after_days: r.retry_after_days,
      max_retries: r.max_retries,
      min_debt_value: Number(r.min_debt_value),
    }))
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Matriz de condições</h1>
        <p className="text-muted-foreground">
          O servidor decide desconto, entrada e parcelamento a partir destas faixas.
        </p>
      </div>
      <MatrixAdmin
        companies={companyList}
        rows={rows}
        selectedCompanyId={selectedCompanyId}
      />
    </div>
  )
}
