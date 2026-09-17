// Casos (super-admin): contestações / já-paguei / handoff. Server carrega via
// service role e MASCARA nome/documento antes de enviar à UI.
import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { maskCpf, maskName } from "@/lib/negotiation/pii"
import { CasesAdmin, type CaseView } from "@/components/journey/cases-admin"

export const dynamic = "force-dynamic"

function detailNote(details: unknown): string {
  if (!details || typeof details !== "object") return ""
  const d = details as Record<string, unknown>
  const parts: string[] = []
  if (typeof d.reason === "string") parts.push(d.reason)
  if (typeof d.note === "string") parts.push(d.note)
  if (typeof d.channel === "string") parts.push(`canal: ${d.channel}`)
  if (typeof d.amount === "number") parts.push(`valor: ${d.amount}`)
  return parts.join(" · ")
}

export default async function CasosPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect("/auth/login")
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single()
  if (profile?.role !== "super_admin") redirect("/")

  const service = createServiceClient()
  const { data } = await service
    .from("negotiation_cases")
    .select(
      "id, type, status, details, created_at, companies(name), customers(name, document)",
    )
    .order("created_at", { ascending: false })
    .limit(300)

  const cases: CaseView[] = (data ?? []).map((c) => {
    const company = c.companies as unknown as { name: string } | null
    const customer = c.customers as unknown as { name: string; document: string } | null
    return {
      id: c.id,
      company_name: company?.name ?? "—",
      customer_name_masked: customer ? maskName(customer.name) : "—",
      document_masked: customer ? maskCpf(customer.document) : "—",
      type: c.type,
      status: c.status,
      detail_note: detailNote(c.details),
      created_at: c.created_at,
    }
  })

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Casos</h1>
        <p className="text-muted-foreground">
          Contestações, alegações de pagamento e pedidos de atendimento humano.
        </p>
      </div>
      <CasesAdmin cases={cases} />
    </div>
  )
}
