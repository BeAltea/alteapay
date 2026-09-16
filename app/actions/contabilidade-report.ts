"use server"

import { createClient } from "@supabase/supabase-js"
import { PAID_ASAAS_STATUSES, PAID_PAYMENT_STATUSES, PAID_AGREEMENT_STATUSES } from "@/lib/constants/payment-status"
import { getServerSupabaseUrl } from "@/lib/supabase/url"

// Types
interface SetupRule {
  id: string
  operator: string
  min_days: number
  max_days: number | null
  profit_percentage: number
  sort_order: number
}

export interface ContabilidadeReportRow {
  clientName: string
  cpfCnpj: string
  debtAmount: number
  paidAmount: number
  paymentDate: string
  dueDate: string
  daysExpired: number
  ruleLabel: string
  profitPercentage: number
  alteapayProfit: number
  clientTransfer: number
}

export interface DirectPaymentRow {
  clientName: string
  cpfCnpj: string
  debtAmount: number
  paidAmount: number
  paymentDate: string
}

export interface ContabilidadeReportResult {
  asaasPayments: ContabilidadeReportRow[]
  directPayments: DirectPaymentRow[]
  error: string | null
}

/**
 * Generate contabilidade report using admin client to bypass RLS
 * This is necessary because super-admin needs to query other companies' data
 *
 * Returns two separate lists:
 * - asaasPayments: Payments via ASAAS (with profit calculation)
 * - directPayments: Payments directly to client (pago_ao_cliente, no profit)
 */
export async function generateContabilidadeReport(
  companyId: string,
  startDate: Date,
  endDate: Date,
  rules: SetupRule[]
): Promise<ContabilidadeReportResult> {
  try {
    // Use service role client to bypass RLS
    const supabaseAdmin = createClient(
      getServerSupabaseUrl(),
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    // Fetch paid agreements with related customer data
    // Use .range(0, 99999) to bypass the 1000-row default limit
    const paidStatusFilter = `asaas_status.in.(${PAID_ASAAS_STATUSES.join(",")}),payment_status.in.(${PAID_PAYMENT_STATUSES.join(",")}),status.in.(${PAID_AGREEMENT_STATUSES.join(",")})`

    const { data: agreementsData, error: agreementsError } = await supabaseAdmin
      .from("agreements")
      .select(`
        id,
        customer_id,
        company_id,
        debt_id,
        agreed_amount,
        asaas_status,
        payment_status,
        status,
        payment_received_at,
        due_date,
        updated_at,
        created_at,
        customers (
          id,
          name,
          document,
          external_id
        ),
        debts (
          id,
          due_date,
          amount
        )
      `)
      .eq("company_id", companyId)
      .or(paidStatusFilter)
      .range(0, 99999)

    if (agreementsError) {
      console.error("[Contabilidade] Query error:", agreementsError)
      return { asaasPayments: [], directPayments: [], error: agreementsError.message }
    }

    // Filter by payment date (payment_received_at with updated_at fallback)
    const startTime = startDate.getTime()
    const endTime = endDate.getTime()

    const paidAgreementsInPeriod = (agreementsData || []).filter((a: any) => {
      const paymentDateStr = a.payment_received_at || a.updated_at
      if (!paymentDateStr) return false
      const paymentDate = new Date(paymentDateStr)
      return paymentDate.getTime() >= startTime && paymentDate.getTime() <= endTime
    })

    console.log(`[Contabilidade] Found ${paidAgreementsInPeriod.length} paid agreements in period for company ${companyId}`)

    // Also fetch agreements where payment_received_at is NULL but status is pago_ao_cliente
    // Check both payment_status and status fields for "pago_ao_cliente"
    const { data: directPaidData } = await supabaseAdmin
      .from("agreements")
      .select(`
        id,
        customer_id,
        company_id,
        debt_id,
        agreed_amount,
        asaas_status,
        payment_status,
        status,
        payment_received_at,
        due_date,
        updated_at,
        created_at,
        customers (
          id,
          name,
          document,
          external_id
        ),
        debts (
          id,
          due_date,
          amount
        )
      `)
      .eq("company_id", companyId)
      .or("payment_status.eq.pago_ao_cliente,status.eq.pago_ao_cliente")
      .is("payment_received_at", null)
      .gte("updated_at", startDate.toISOString())
      .lte("updated_at", endDate.toISOString())
      .range(0, 99999)

    // Combine and deduplicate by id
    const existingIds = new Set(paidAgreementsInPeriod.map((a: any) => a.id))
    const allAgreements = [...paidAgreementsInPeriod]
    for (const a of (directPaidData || [])) {
      if (!existingIds.has(a.id)) {
        allAgreements.push(a)
      }
    }

    console.log(`[Contabilidade] Total agreements after dedup: ${allAgreements.length}`)

    // Get all customer external_ids to fetch VMAX data for "Dias Inad."
    const externalIds = allAgreements
      .map((a: any) => a.customers?.external_id)
      .filter(Boolean)

    // Fetch VMAX records to get original "Dias Inad." (days overdue from original debt date)
    let vmaxMap = new Map<string, { diasInad: number; vecto: string | null }>()

    if (externalIds.length > 0) {
      const { data: vmaxData } = await supabaseAdmin
        .from("VMAX")
        .select('id, "Dias Inad.", Vecto')
        .in("id", externalIds)
        .range(0, 99999)

      if (vmaxData) {
        for (const v of vmaxData) {
          const diasInadStr = String(v["Dias Inad."] || "0")
          const diasInad = parseInt(diasInadStr.replace(/\./g, "")) || 0
          vmaxMap.set(v.id, { diasInad, vecto: v.Vecto })
        }
      }
    }

    console.log(`[Contabilidade] Fetched ${vmaxMap.size} VMAX records for days calculation`)

    // Helper to check if agreement is a direct payment (paid directly to client, not via ASAAS)
    // Check both payment_status AND status fields for "pago_ao_cliente"
    const isDirectPayment = (a: any) =>
      a.payment_status === "pago_ao_cliente" || a.status === "pago_ao_cliente"

    // Separate ASAAS payments from direct payments (pago_ao_cliente)
    const asaasAgreements = allAgreements.filter((a: any) =>
      !isDirectPayment(a) && PAID_ASAAS_STATUSES.includes(a.asaas_status)
    )

    const directAgreements = allAgreements.filter(isDirectPayment)

    console.log(`[Contabilidade] ASAAS payments: ${asaasAgreements.length}, Direct payments: ${directAgreements.length}`)

    // Sort rules by sort_order for proper matching
    const sortedRules = [...rules].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))

    // Process ASAAS payments (with profit calculation)
    const asaasPayments: ContabilidadeReportRow[] = []

    for (const agreement of asaasAgreements) {
      const paymentDateStr = agreement.payment_received_at || agreement.updated_at || agreement.created_at
      if (!paymentDateStr) continue

      const paymentDate = new Date(paymentDateStr)

      // Get "Dias Inad." from VMAX (the REAL days overdue from original debt date)
      const externalId = agreement.customers?.external_id
      const vmaxInfo = externalId ? vmaxMap.get(externalId) : null

      // Use VMAX "Dias Inad." if available, otherwise calculate from debts.due_date
      let daysExpired = 0
      let originalDueDate: string | null = null

      if (vmaxInfo) {
        daysExpired = vmaxInfo.diasInad
        originalDueDate = vmaxInfo.vecto || null
      } else {
        // Fallback: calculate from debts.due_date (less accurate)
        originalDueDate = agreement.debts?.due_date || agreement.due_date
        if (originalDueDate) {
          const dueDate = new Date(originalDueDate)
          const diffMs = paymentDate.getTime() - dueDate.getTime()
          daysExpired = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)))
        }
      }

      // Find matching rule based on operator (first match wins)
      let matchingRule: SetupRule | null = null
      for (const rule of sortedRules) {
        let matches = false
        switch (rule.operator) {
          case "=":
            matches = daysExpired === rule.min_days
            break
          case "<=":
            matches = daysExpired <= rule.min_days
            break
          case ">=":
            matches = daysExpired >= rule.min_days
            break
          case "entre":
          default:
            if (rule.max_days === null) {
              matches = daysExpired >= rule.min_days
            } else {
              matches = daysExpired >= rule.min_days && daysExpired <= rule.max_days
            }
            break
        }
        if (matches) {
          matchingRule = rule
          break
        }
      }

      // Skip if no matching rule
      if (!matchingRule) {
        console.log(`[Contabilidade] No matching rule for ${daysExpired} days overdue (${agreement.customers?.name})`)
        continue
      }

      // Calculate amounts
      const paidAmount = Number(agreement.agreed_amount) || 0
      const alteapayProfit = paidAmount * (matchingRule.profit_percentage / 100)
      const clientTransfer = paidAmount - alteapayProfit

      // Client info
      const clientName = agreement.customers?.name || "N/A"
      const cpfCnpj = agreement.customers?.document || "N/A"
      const debtAmount = Number(agreement.debts?.amount) || paidAmount

      // Format rule label
      let ruleLabel = "Sem faixa"
      if (matchingRule.operator === "<=") {
        ruleLabel = `<= ${matchingRule.min_days} dias`
      } else if (matchingRule.operator === ">=") {
        ruleLabel = `>= ${matchingRule.min_days} dias`
      } else if (matchingRule.operator === "entre") {
        ruleLabel = `${matchingRule.min_days}-${matchingRule.max_days} dias`
      } else if (matchingRule.operator === "=") {
        ruleLabel = `= ${matchingRule.min_days} dias`
      }

      asaasPayments.push({
        clientName,
        cpfCnpj: formatCpfCnpj(cpfCnpj),
        debtAmount,
        paidAmount,
        paymentDate: formatDate(paymentDate),
        dueDate: originalDueDate ? formatDateBR(originalDueDate) : "N/A",
        daysExpired,
        ruleLabel,
        profitPercentage: matchingRule.profit_percentage,
        alteapayProfit,
        clientTransfer,
      })
    }

    // Process direct payments (pago_ao_cliente - no profit calculation)
    const directPayments: DirectPaymentRow[] = []

    for (const agreement of directAgreements) {
      const paymentDateStr = agreement.payment_received_at || agreement.updated_at || agreement.created_at
      if (!paymentDateStr) continue

      const paymentDate = new Date(paymentDateStr)
      const paidAmount = Number(agreement.agreed_amount) || 0
      const clientName = agreement.customers?.name || "N/A"
      const cpfCnpj = agreement.customers?.document || "N/A"
      const debtAmount = Number(agreement.debts?.amount) || paidAmount

      directPayments.push({
        clientName,
        cpfCnpj: formatCpfCnpj(cpfCnpj),
        debtAmount,
        paidAmount,
        paymentDate: formatDate(paymentDate),
      })
    }

    console.log(`[Contabilidade] Generated ${asaasPayments.length} ASAAS rows, ${directPayments.length} direct rows`)

    return { asaasPayments, directPayments, error: null }
  } catch (error) {
    console.error("[Contabilidade] Error generating report:", error)
    return { asaasPayments: [], directPayments: [], error: String(error) }
  }
}

// Helper functions
function formatCpfCnpj(doc: string): string {
  const cleaned = doc.replace(/\D/g, "")
  if (cleaned.length === 11) {
    return cleaned.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4")
  } else if (cleaned.length === 14) {
    return cleaned.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5")
  }
  return doc
}

function formatDate(date: Date): string {
  const day = String(date.getDate()).padStart(2, "0")
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const year = date.getFullYear()
  return `${day}/${month}/${year}`
}

// Format date from DD/MM/YYYY string (VMAX Vecto format)
function formatDateBR(dateStr: string): string {
  // If already in DD/MM/YYYY format, return as-is
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateStr)) {
    return dateStr
  }
  // If ISO format, convert to DD/MM/YYYY
  const date = new Date(dateStr)
  if (!isNaN(date.getTime())) {
    return formatDate(date)
  }
  return dateStr
}
