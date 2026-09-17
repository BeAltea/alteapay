import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { getServerSupabaseUrl } from "@/lib/supabase/url"

/**
 * DEBUG ENDPOINT: Compare ASAAS payments with local database
 *
 * This endpoint helps identify discrepancies between ASAAS and local DB.
 * Use: GET /api/debug/asaas-payments?company_id=XXX
 *
 * Returns:
 * - All RECEIVED/CONFIRMED payments from ASAAS
 * - All local agreements with their status
 * - Mismatches (payments in ASAAS but not properly reflected locally)
 */

export const dynamic = "force-dynamic"

const supabase = createClient(
  getServerSupabaseUrl(),
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
)

const ASAAS_API_URL = process.env.ASAAS_API_URL || "https://api.asaas.com/v3"
const ASAAS_API_KEY = process.env.ASAAS_API_KEY

// Status considered "paid" in ASAAS
const ASAAS_PAID_STATUSES = ["RECEIVED", "RECEIVED_IN_CASH", "CONFIRMED"]

interface AsaasPayment {
  id: string
  customer: string
  status: string
  value: number
  netValue: number
  billingType: string
  externalReference: string | null
  paymentDate: string | null
  confirmedDate: string | null
}

async function fetchAsaasPayments(): Promise<AsaasPayment[]> {
  const allPayments: AsaasPayment[] = []
  let offset = 0
  const limit = 100

  while (true) {
    const url = `${ASAAS_API_URL}/payments?offset=${offset}&limit=${limit}`
    const response = await fetch(url, {
      headers: {
        "Content-Type": "application/json",
        "access_token": ASAAS_API_KEY!,
      },
    })

    if (!response.ok) {
      console.error("ASAAS API error:", response.status)
      break
    }

    const data = await response.json()
    if (!data.data || data.data.length === 0) break

    allPayments.push(...data.data)

    if (!data.hasMore) break
    offset += limit
  }

  return allPayments
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const companyId = searchParams.get("company_id")

  if (!companyId) {
    return NextResponse.json({ error: "company_id required" }, { status: 400 })
  }

  try {
    // 1. Fetch all payments from ASAAS
    console.log("[DEBUG] Fetching all payments from ASAAS...")
    const asaasPayments = await fetchAsaasPayments()
    console.log(`[DEBUG] Found ${asaasPayments.length} total payments in ASAAS`)

    // 2. Filter to paid payments only
    const paidAsaasPayments = asaasPayments.filter(p =>
      ASAAS_PAID_STATUSES.includes(p.status)
    )
    console.log(`[DEBUG] Found ${paidAsaasPayments.length} PAID payments in ASAAS`)

    // 3. Fetch all local agreements with ASAAS payment IDs
    const { data: localAgreements, error: agError } = await supabase
      .from("agreements")
      .select("id, asaas_payment_id, asaas_customer_id, status, payment_status, asaas_status, customer_id, company_id, agreed_amount")
      .eq("company_id", companyId)

    if (agError) {
      return NextResponse.json({ error: agError.message }, { status: 500 })
    }

    // 4. Get customer documents for local agreements
    const customerIds = [...new Set(localAgreements?.map(a => a.customer_id).filter(Boolean) || [])]
    const customerDocMap = new Map<string, string>()

    if (customerIds.length > 0) {
      const { data: customers } = await supabase
        .from("customers")
        .select("id, document, name")
        .in("id", customerIds)

      customers?.forEach(c => {
        const normalizedDoc = (c.document || "").replace(/\D/g, "")
        if (normalizedDoc) customerDocMap.set(c.id, normalizedDoc)
      })
    }

    // 5. Build comparison report
    const localAgreementsByAsaasId = new Map(
      localAgreements?.filter(a => a.asaas_payment_id).map(a => [a.asaas_payment_id, a]) || []
    )

    // Find paid ASAAS payments that don't have matching local agreement with paid status
    const mismatches: any[] = []
    const correctlyMatched: any[] = []

    for (const asaasPayment of paidAsaasPayments) {
      const localAgreement = localAgreementsByAsaasId.get(asaasPayment.id)

      if (!localAgreement) {
        // Payment exists in ASAAS but no matching agreement in local DB
        mismatches.push({
          type: "missing_local",
          asaas_payment_id: asaasPayment.id,
          asaas_status: asaasPayment.status,
          asaas_value: asaasPayment.value,
          asaas_customer: asaasPayment.customer,
          asaas_billing_type: asaasPayment.billingType,
          asaas_payment_date: asaasPayment.paymentDate,
          asaas_external_ref: asaasPayment.externalReference,
        })
      } else {
        // Check if local status reflects paid
        const localIsPaid =
          localAgreement.status === "completed" ||
          localAgreement.status === "paid" ||
          localAgreement.payment_status === "received" ||
          localAgreement.payment_status === "confirmed"

        if (!localIsPaid) {
          mismatches.push({
            type: "status_mismatch",
            asaas_payment_id: asaasPayment.id,
            asaas_status: asaasPayment.status,
            asaas_value: asaasPayment.value,
            local_agreement_id: localAgreement.id,
            local_status: localAgreement.status,
            local_payment_status: localAgreement.payment_status,
            local_asaas_status: localAgreement.asaas_status,
          })
        } else {
          correctlyMatched.push({
            asaas_payment_id: asaasPayment.id,
            asaas_status: asaasPayment.status,
            asaas_value: asaasPayment.value,
            local_agreement_id: localAgreement.id,
            local_status: localAgreement.status,
            local_payment_status: localAgreement.payment_status,
          })
        }
      }
    }

    // 6. Also check local agreements that claim to be paid but aren't in ASAAS
    const localPaidNotInAsaas: any[] = []
    for (const agreement of localAgreements || []) {
      const localIsPaid =
        agreement.status === "completed" ||
        agreement.status === "paid" ||
        agreement.payment_status === "received" ||
        agreement.payment_status === "confirmed"

      if (localIsPaid && agreement.asaas_payment_id) {
        const asaasPayment = paidAsaasPayments.find(p => p.id === agreement.asaas_payment_id)
        if (!asaasPayment) {
          localPaidNotInAsaas.push({
            local_agreement_id: agreement.id,
            asaas_payment_id: agreement.asaas_payment_id,
            local_status: agreement.status,
            local_payment_status: agreement.payment_status,
            local_asaas_status: agreement.asaas_status,
          })
        }
      }
    }

    return NextResponse.json({
      summary: {
        total_asaas_payments: asaasPayments.length,
        paid_asaas_payments: paidAsaasPayments.length,
        total_local_agreements: localAgreements?.length || 0,
        correctly_matched: correctlyMatched.length,
        mismatches: mismatches.length,
        local_paid_not_in_asaas: localPaidNotInAsaas.length,
      },
      correctly_matched: correctlyMatched,
      mismatches: mismatches,
      local_paid_not_in_asaas: localPaidNotInAsaas,
      raw_paid_asaas_payments: paidAsaasPayments.map(p => ({
        id: p.id,
        status: p.status,
        value: p.value,
        customer: p.customer,
        billingType: p.billingType,
        paymentDate: p.paymentDate,
        externalReference: p.externalReference,
      })),
    })

  } catch (error: any) {
    console.error("[DEBUG] Error:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
