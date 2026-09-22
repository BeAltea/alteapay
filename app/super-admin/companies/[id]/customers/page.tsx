import { createAdminClient } from "@/lib/supabase/admin"
import { CustomersFilterClient } from "@/components/super-admin/customers-filter-client"
import { maskDocument } from "@/lib/journey/document"
import { Button } from "@/components/ui/button"
import Link from "next/link"
import { ArrowLeft } from "lucide-react"
import { notFound } from "next/navigation"

export const dynamic = "force-dynamic"
export const revalidate = 0

export default async function ManageCustomersPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = createAdminClient()

  const { data: company, error: companyError } = await supabase
    .from("companies")
    .select("*")
    .eq("id", id)
    .single()

  if (companyError || !company) {
    notFound()
  }

  // Fetch completed agreements to identify paid customers (include payment date)
  const { data: completedAgreements } = await supabase
    .from("agreements")
    .select("id, customer_id, status, payment_received_at, agreed_amount")
    .eq("company_id", id)
    .eq("status", "completed")

  // Fetch customers mapping to get documents
  const { data: dbCustomers } = await supabase
    .from("customers")
    .select("id, document")
    .eq("company_id", id)

  // Build map of customer_id -> document for paid agreements
  const customerIdToDoc = new Map<string, string>()
  for (const c of dbCustomers || []) {
    if (c.document) {
      customerIdToDoc.set(c.id, c.document.replace(/\D/g, ""))
    }
  }

  // Get documents with paid agreements and their payment dates
  const paidDocs = new Set<string>()
  const paidDocsInfo = new Map<string, { paymentDate: string | null; paidAmount: number }>()
  for (const a of completedAgreements || []) {
    const doc = customerIdToDoc.get(a.customer_id)
    if (doc) {
      paidDocs.add(doc)
      paidDocsInfo.set(doc, {
        paymentDate: a.payment_received_at || null,
        paidAmount: a.agreed_amount || 0,
      })
    }
  }

  // Buscar SOMENTE da tabela VMAX (tabela customers foi descontinuada)
  let vmaxCustomers: any[] = []
  let page = 0
  const pageSize = 1000
  let hasMore = true

  while (hasMore) {
    const { data: vmaxPage, error: vmaxPageError } = await supabase
      .from("VMAX")
      .select("*")
      .eq("id_company", id)
      .range(page * pageSize, (page + 1) * pageSize - 1)

    if (vmaxPageError) {
      console.log("[v0] VMAX page error:", vmaxPageError.message)
      break
    }

    console.log(`[v0] VMAX customers page ${page}: ${vmaxPage?.length || 0} records`)

    if (vmaxPage && vmaxPage.length > 0) {
      vmaxCustomers = [...vmaxCustomers, ...vmaxPage]
      page++
      hasMore = vmaxPage.length === pageSize
    } else {
      hasMore = false
    }
  }

  console.log("[v0] TOTAL VMAX customers loaded (after pagination):", vmaxCustomers.length)

  // Also check for paid status in VMAX negotiation_status
  for (const v of vmaxCustomers || []) {
    if (v.negotiation_status === "PAGO") {
      const doc = (v["CPF/CNPJ"] || "").replace(/\D/g, "")
      if (doc) {
        paidDocs.add(doc)
        // Use VMAX updated_at or current date as fallback for payment date
        if (!paidDocsInfo.has(doc)) {
          paidDocsInfo.set(doc, {
            paymentDate: v.updated_at || new Date().toISOString(),
            paidAmount: Number(String(v.Vencido || "0").replace(/[^\d,]/g, "").replace(",", ".")) || 0,
          })
        }
      }
    }
  }

  const vmaxProcessed = (vmaxCustomers || []).map((vmax) => {
    const vencidoStr = String(vmax.Vencido || vmax.vencido || "0")
    const vencidoValue = Number(vencidoStr.replace(/[^\d,]/g, "").replace(",", "."))
    // Remove ponto usado como separador de milhar no formato brasileiro
    const diasInadStr = String(vmax["Dias Inad."] || vmax.dias_inad || "0")
    const diasInad = Number(diasInadStr.replace(/\./g, "")) || 0
    const primeiraVencida = vmax.Vecto || vmax.primeira_vencida
    const dtCancelamento = vmax["DT Cancelamento"] || vmax.dt_cancelamento
    const doc = (vmax["CPF/CNPJ"] || "").replace(/\D/g, "")

    // Check if this customer has a paid agreement
    // Only explicit payment indicators: negotiation_status === "PAGO" or document in paidDocs (from completed agreements)
    // Do NOT use dtCancelamento alone - it means "cancelled" not necessarily "paid"
    const isPaid = paidDocs.has(doc) || vmax.negotiation_status === "PAGO"
    const paidInfo = paidDocsInfo.get(doc)

    let status: "active" | "overdue" | "negotiating" | "paid" = "active"
    if (isPaid) {
      status = "paid"
    } else if (diasInad > 0) {
      status = "overdue"
    }

    return {
      id: vmax.id || `vmax-${Math.random()}`,
      name: vmax.Cliente || vmax.cliente || "Cliente VMAX",
      email: null,
      phone: null,
      // Privacidade (A5): só o mascarado trafega; claro sai pelo reveal auditado.
      documentMasked: maskDocument(vmax["CPF/CNPJ"] || vmax.cpf_cnpj || ""),
      company_id: id,
      created_at: primeiraVencida || new Date().toISOString(),
      totalDebt: vencidoValue,
      overdueDebt: isPaid ? 0 : (diasInad > 0 ? vencidoValue : 0),
      lastPayment: dtCancelamento || primeiraVencida || new Date().toISOString(),
      status,
      city: vmax.Cidade || vmax.cidade || null,
      daysOverdue: isPaid ? 0 : diasInad,
      // Payment info for paid customers
      paymentDate: isPaid ? (paidInfo?.paymentDate || null) : null,
      paidAmount: isPaid ? (paidInfo?.paidAmount || vencidoValue) : 0,
    }
  })

  // Usar SOMENTE dados da tabela VMAX
  const allCustomers = vmaxProcessed

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 dark:text-white">Clientes da Empresa</h1>
          <p className="text-gray-600 dark:text-gray-400">{company.name}</p>
        </div>
        <Button asChild variant="outline">
          <Link href={`/super-admin/companies/${id}`}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Voltar
          </Link>
        </Button>
      </div>

      <CustomersFilterClient customers={allCustomers} companyId={id} />
    </div>
  )
}
