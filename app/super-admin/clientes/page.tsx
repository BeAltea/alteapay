import { createAdminClient } from "@/lib/supabase/admin"
import { SuperAdminClientesContent } from "./clientes-content"
import { PAID_AGREEMENT_STATUSES, PAID_PAYMENT_STATUSES, PAID_ASAAS_STATUSES } from "@/lib/constants/payment-status"
import { maskDocument } from "@/lib/journey/document"

export const dynamic = "force-dynamic"
export const revalidate = 0

export default async function SuperAdminClientesPage() {
  const supabase = createAdminClient()

  // Fetch all companies
  const { data: companies } = await supabase
    .from("companies")
    .select("id, name")
    .order("name")

  // Fetch all VMAX records (paginated to handle large datasets)
  let allVmaxRecords: any[] = []
  let page = 0
  const pageSize = 1000
  let hasMore = true

  while (hasMore) {
    const { data: vmaxPage, error: vmaxPageError } = await supabase
      .from("VMAX")
      .select("*")
      .range(page * pageSize, (page + 1) * pageSize - 1)

    if (vmaxPageError) {
      console.error("VMAX page error:", vmaxPageError.message)
      break
    }

    if (vmaxPage && vmaxPage.length > 0) {
      allVmaxRecords = [...allVmaxRecords, ...vmaxPage]
      page++
      hasMore = vmaxPage.length === pageSize
    } else {
      hasMore = false
    }
  }

  // Fetch agreements for negotiation status (paginated to handle large datasets)
  // IMPORTANT: Must use pagination to avoid Supabase 1000-row default limit
  let allAgreements: any[] = []
  let agreementPage = 0
  let agreementHasMore = true

  while (agreementHasMore) {
    const { data: agreementPageData, error: agreementPageError } = await supabase
      .from("agreements")
      .select("customer_id, status, payment_status, asaas_status, asaas_payment_id, company_id")
      .range(agreementPage * pageSize, (agreementPage + 1) * pageSize - 1)

    if (agreementPageError) {
      console.error("Agreements page error:", agreementPageError.message)
      break
    }

    if (agreementPageData && agreementPageData.length > 0) {
      allAgreements = [...allAgreements, ...agreementPageData]
      agreementPage++
      agreementHasMore = agreementPageData.length === pageSize
    } else {
      agreementHasMore = false
    }
  }

  const agreements = allAgreements

  // Fetch customers table to map customer_id -> document (CPF/CNPJ)
  // IMPORTANT: Use pagination to avoid Supabase 1000-row default limit
  const customerIds = [...new Set((agreements || []).map(a => a.customer_id).filter(Boolean))]
  const customerDocMap = new Map<string, string>()

  if (customerIds.length > 0) {
    // Fetch customers in batches (Supabase .in() has limits)
    const batchSize = 500
    for (let i = 0; i < customerIds.length; i += batchSize) {
      const batch = customerIds.slice(i, i + batchSize)
      const { data: customersData } = await supabase
        .from("customers")
        .select("id, document")
        .in("id", batch)

      if (customersData) {
        customersData.forEach((c: any) => {
          const normalizedDoc = (c.document || "").replace(/\D/g, "")
          if (normalizedDoc) {
            customerDocMap.set(c.id, normalizedDoc)
          }
        })
      }
    }
  }

  // Build agreement status map keyed by normalized CPF/CNPJ (not customer_id)
  // This allows matching with VMAX records by document
  const docToStatus = new Map<string, { hasAgreement: boolean; isPaid: boolean; isActive: boolean; hasAsaasCharge: boolean }>()

  ;(agreements || []).forEach((a: any) => {
    const normalizedDoc = customerDocMap.get(a.customer_id)
    if (!normalizedDoc) return

    // Skip cancelled agreements
    if (a.status === "cancelled") return

    const existing = docToStatus.get(normalizedDoc) || { hasAgreement: false, isPaid: false, isActive: false, hasAsaasCharge: false }
    existing.hasAgreement = true

    if (a.asaas_payment_id) {
      existing.hasAsaasCharge = true
    }

    // Check all paid status indicators (aligned with lib/constants/payment-status.ts)
    const isPaidAgreement =
      PAID_AGREEMENT_STATUSES.includes(a.status as any) ||
      PAID_PAYMENT_STATUSES.includes(a.payment_status as any) ||
      PAID_ASAAS_STATUSES.includes(a.asaas_status as any)

    if (isPaidAgreement) {
      existing.isPaid = true
    }

    // Active = has agreement but not paid
    if (!isPaidAgreement && (a.status === "active" || a.status === "draft" || a.status === "pending")) {
      existing.isActive = true
    }

    docToStatus.set(normalizedDoc, existing)
  })

  // Transform VMAX records to client format
  const clientes = allVmaxRecords.map((record: any) => {
    const vencidoStr = String(record.Vencido || "0")
    const cleanValue = vencidoStr.replace(/R\$/g, "").replace(/\s/g, "").replace(/\./g, "").replace(",", ".")
    const totalDebt = Number(cleanValue) || 0

    const diasInad = Number(String(record["Dias Inad."] || "0").replace(/\./g, "")) || 0

    // Look up by normalized CPF/CNPJ to match VMAX records to agreements
    const cpfCnpj = (record["CPF/CNPJ"] || "").replace(/\D/g, "")
    const agreementStatus = docToStatus.get(cpfCnpj)

    let negotiationStatus = "NENHUMA"
    if (agreementStatus?.isPaid) {
      negotiationStatus = "PAGO"
    } else if (agreementStatus?.isActive && agreementStatus?.hasAsaasCharge) {
      negotiationStatus = "ATIVA_ASAAS"
    } else if (agreementStatus?.isActive) {
      negotiationStatus = "ATIVA"
    } else if (agreementStatus?.hasAgreement) {
      negotiationStatus = "DRAFT"
    }

    return {
      id: record.id,
      name: record.Cliente || "N/A",
      // Privacidade (A5): o documento em claro NUNCA trafega no payload da lista.
      // Enviamos só o mascarado; o claro sai apenas pelo reveal auditado por linha.
      documentMasked: maskDocument(record["CPF/CNPJ"] || ""),
      email: record.Email || "",
      phone: record.Telefone || "",
      city: record.Cidade || "",
      state: record.UF || "",
      companyId: record.id_company,
      totalDebt,
      daysOverdue: diasInad,
      negotiationStatus,
      hasAsaasCharge: agreementStatus?.hasAsaasCharge || false,
      recoveryScore: record.recovery_score,
      recoveryClass: record.recovery_class,
      approvalStatus: record.approval_status,
    }
  })

  return (
    <SuperAdminClientesContent
      clientes={clientes}
      companies={companies || []}
    />
  )
}
