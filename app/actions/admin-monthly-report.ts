"use server"

import { createClient } from "@supabase/supabase-js"
import { PAID_ASAAS_STATUSES, PAID_PAYMENT_STATUSES, PAID_AGREEMENT_STATUSES } from "@/lib/constants/payment-status"
import { getServerSupabaseUrl } from "@/lib/supabase/url"

// Types
interface SetupRule {
  id: string
  min_days: number
  max_days: number | null
  profit_percentage: number
  sort_order: number
  operator: string
}

interface Setup {
  id: string
  company_id: string
  name: string
  rules: SetupRule[]
}

export interface MonthlyPaymentRow {
  id: string
  clientName: string
  cpfCnpj: string
  debtAmount: number
  paidAmount: number
  paymentDate: string
  billingType: string // PIX, BOLETO, CREDIT_CARD, Pago ao cliente
  asaasPaymentId: string | null
  // Split calculation (if setup exists)
  alteapayProfit?: number
  clientTransfer?: number
  profitPercentage?: number
}

export interface MonthlyReportResult {
  payments: MonthlyPaymentRow[]
  setup: Setup | null
  summary: {
    totalPayments: number
    totalReceived: number
    // ASAAS-specific (payments via AlteaPay)
    asaasPaymentsCount: number
    totalAsaasReceived: number
    totalAlteapayProfit: number
    totalClientTransfer: number // Only from ASAAS payments
    alteapayPercentage: number | null // weighted average from ASAAS payments only
    // Direct payments (pago_ao_cliente)
    directPaymentsCount: number
    totalDirectReceived: number
  }
  error: string | null
}

/**
 * Generate monthly report for client-admin dashboard
 * Uses admin client to ensure proper data access
 */
export async function generateAdminMonthlyReport(
  companyId: string,
  year: number,
  month: number
): Promise<MonthlyReportResult> {
  try {
    // Use service role client
    const supabaseAdmin = createClient(
      getServerSupabaseUrl(),
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    // Calculate date range for the month
    const startDate = new Date(year, month - 1, 1)
    const endDate = new Date(year, month, 0, 23, 59, 59, 999)

    // Fetch paid status filter
    const paidStatusFilter = `asaas_status.in.(${PAID_ASAAS_STATUSES.join(",")}),payment_status.in.(${PAID_PAYMENT_STATUSES.join(",")}),status.in.(${PAID_AGREEMENT_STATUSES.join(",")})`

    // Fetch paid agreements for this company in the month
    const { data: agreementsData, error: agreementsError } = await supabaseAdmin
      .from("agreements")
      .select(`
        id,
        customer_id,
        company_id,
        debt_id,
        agreed_amount,
        asaas_status,
        asaas_billing_type,
        asaas_payment_id,
        payment_status,
        status,
        payment_received_at,
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
          amount
        )
      `)
      .eq("company_id", companyId)
      .or(paidStatusFilter)
      .range(0, 99999)

    if (agreementsError) {
      console.error("[AdminMonthlyReport] Query error:", agreementsError)
      return {
        payments: [],
        setup: null,
        summary: {
          totalPayments: 0,
          totalReceived: 0,
          asaasPaymentsCount: 0,
          totalAsaasReceived: 0,
          totalAlteapayProfit: 0,
          totalClientTransfer: 0,
          alteapayPercentage: null,
          directPaymentsCount: 0,
          totalDirectReceived: 0,
        },
        error: agreementsError.message
      }
    }

    // Filter by payment date within the month
    const startTime = startDate.getTime()
    const endTime = endDate.getTime()

    const paidAgreementsInMonth = (agreementsData || []).filter((a: any) => {
      const paymentDateStr = a.payment_received_at || a.updated_at
      if (!paymentDateStr) return false
      const paymentDate = new Date(paymentDateStr)
      return paymentDate.getTime() >= startTime && paymentDate.getTime() <= endTime
    })

    // Also fetch agreements with pago_ao_cliente status that have null payment_received_at
    const { data: directPaidData } = await supabaseAdmin
      .from("agreements")
      .select(`
        id,
        customer_id,
        company_id,
        debt_id,
        agreed_amount,
        asaas_status,
        asaas_billing_type,
        asaas_payment_id,
        payment_status,
        status,
        payment_received_at,
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
          amount
        )
      `)
      .eq("company_id", companyId)
      .or("payment_status.eq.pago_ao_cliente,status.eq.pago_ao_cliente")
      .is("payment_received_at", null)
      .gte("updated_at", startDate.toISOString())
      .lte("updated_at", endDate.toISOString())
      .range(0, 99999)

    // Combine and deduplicate
    const existingIds = new Set(paidAgreementsInMonth.map((a: any) => a.id))
    const allAgreements = [...paidAgreementsInMonth]
    for (const a of (directPaidData || [])) {
      if (!existingIds.has(a.id)) {
        allAgreements.push(a)
      }
    }

    // Fetch setup for this company (most recent)
    const { data: setupData } = await supabaseAdmin
      .from("accounting_setups")
      .select("id, company_id, name")
      .eq("company_id", companyId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single()

    let setup: Setup | null = null

    if (setupData) {
      // Fetch rules for this setup
      const { data: rulesData } = await supabaseAdmin
        .from("accounting_setup_rules")
        .select("id, min_days, max_days, profit_percentage, sort_order, operator")
        .eq("setup_id", setupData.id)
        .order("sort_order")

      setup = {
        id: setupData.id,
        company_id: setupData.company_id,
        name: setupData.name,
        rules: rulesData || []
      }
    }

    // Get VMAX data for days calculation if needed
    const externalIds = allAgreements
      .map((a: any) => a.customers?.external_id)
      .filter(Boolean)

    let vmaxMap = new Map<string, { diasInad: number }>()

    if (externalIds.length > 0 && setup) {
      const { data: vmaxData } = await supabaseAdmin
        .from("VMAX")
        .select('id, "Dias Inad."')
        .in("id", externalIds)
        .range(0, 99999)

      if (vmaxData) {
        for (const v of vmaxData) {
          const diasInadStr = String(v["Dias Inad."] || "0")
          const diasInad = parseInt(diasInadStr.replace(/\./g, "")) || 0
          vmaxMap.set(v.id, { diasInad })
        }
      }
    }

    // Process all agreements into payment rows
    const payments: MonthlyPaymentRow[] = []
    let totalReceived = 0
    // ASAAS-specific totals
    let totalAsaasReceived = 0
    let totalAlteapayProfit = 0
    let totalClientTransfer = 0 // Only from ASAAS payments
    let asaasPaymentsCount = 0
    // Direct payment totals
    let totalDirectReceived = 0
    let directPaymentsCount = 0

    // Helper to check if direct payment
    const isDirectPayment = (a: any) =>
      a.payment_status === "pago_ao_cliente" || a.status === "pago_ao_cliente"

    // Helper to get billing type label
    const getBillingTypeLabel = (a: any): string => {
      if (isDirectPayment(a)) return "Pago ao cliente"
      switch (a.asaas_billing_type) {
        case "PIX": return "Pix"
        case "BOLETO": return "Boleto"
        case "CREDIT_CARD": return "Cartao"
        default: return a.asaas_billing_type || "—"
      }
    }

    // Helper to find matching rule
    const findMatchingRule = (daysExpired: number, rules: SetupRule[]): SetupRule | null => {
      const sortedRules = [...rules].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
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
        if (matches) return rule
      }
      return null
    }

    for (const agreement of allAgreements) {
      const paymentDateStr = agreement.payment_received_at || agreement.updated_at || agreement.created_at
      if (!paymentDateStr) continue

      const paymentDate = new Date(paymentDateStr)
      const paidAmount = Number(agreement.agreed_amount) || 0
      const clientName = agreement.customers?.name || "N/A"
      const cpfCnpj = agreement.customers?.document || "N/A"
      const debtAmount = Number(agreement.debts?.amount) || paidAmount
      const isDirect = isDirectPayment(agreement)

      totalReceived += paidAmount

      // Calculate split if setup exists and NOT a direct payment
      let alteapayProfit: number | undefined
      let clientTransfer: number | undefined
      let profitPercentage: number | undefined

      if (isDirect) {
        // Direct payment - goes straight to client, no split via AlteaPay
        clientTransfer = paidAmount
        totalDirectReceived += paidAmount
        directPaymentsCount++
      } else {
        // ASAAS payment - track separately
        totalAsaasReceived += paidAmount
        asaasPaymentsCount++

        if (setup && setup.rules.length > 0) {
          // Get days expired from VMAX
          const externalId = agreement.customers?.external_id
          const vmaxInfo = externalId ? vmaxMap.get(externalId) : null
          const daysExpired = vmaxInfo?.diasInad || 0

          const matchingRule = findMatchingRule(daysExpired, setup.rules)

          if (matchingRule) {
            profitPercentage = matchingRule.profit_percentage
            alteapayProfit = paidAmount * (profitPercentage / 100)
            clientTransfer = paidAmount - alteapayProfit

            totalAlteapayProfit += alteapayProfit
            totalClientTransfer += clientTransfer
          } else {
            // No matching rule - all goes to client
            clientTransfer = paidAmount
            totalClientTransfer += paidAmount
          }
        } else {
          // No setup - can't calculate split, all goes to client
          clientTransfer = paidAmount
          totalClientTransfer += paidAmount
        }
      }

      payments.push({
        id: agreement.id,
        clientName,
        cpfCnpj: formatCpfCnpj(cpfCnpj),
        debtAmount,
        paidAmount,
        paymentDate: formatDate(paymentDate),
        billingType: getBillingTypeLabel(agreement),
        asaasPaymentId: agreement.asaas_payment_id,
        alteapayProfit,
        clientTransfer,
        profitPercentage,
      })
    }

    // Sort by payment date descending
    payments.sort((a, b) => {
      const parseDate = (str: string) => {
        const [d, m, y] = str.split("/").map(Number)
        return new Date(y, m - 1, d).getTime()
      }
      return parseDate(b.paymentDate) - parseDate(a.paymentDate)
    })

    // Calculate weighted average percentage (only from ASAAS payments)
    const alteapayPercentage = totalAsaasReceived > 0 && setup
      ? (totalAlteapayProfit / totalAsaasReceived) * 100
      : null

    return {
      payments,
      setup,
      summary: {
        totalPayments: payments.length,
        totalReceived,
        // ASAAS-specific
        asaasPaymentsCount,
        totalAsaasReceived,
        totalAlteapayProfit,
        totalClientTransfer,
        alteapayPercentage,
        // Direct payments
        directPaymentsCount,
        totalDirectReceived,
      },
      error: null,
    }
  } catch (error) {
    console.error("[AdminMonthlyReport] Error:", error)
    return {
      payments: [],
      setup: null,
      summary: {
        totalPayments: 0,
        totalReceived: 0,
        asaasPaymentsCount: 0,
        totalAsaasReceived: 0,
        totalAlteapayProfit: 0,
        totalClientTransfer: 0,
        alteapayPercentage: null,
        directPaymentsCount: 0,
        totalDirectReceived: 0,
      },
      error: String(error),
    }
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
