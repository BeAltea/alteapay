import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { getServerSupabaseUrl } from "@/lib/supabase/url"

/**
 * Per-client ASAAS sync endpoint
 *
 * Syncs a single client by searching ASAAS for their CPF/CNPJ.
 * This is fast and never times out (single API call per client).
 *
 * NEW: If customer exists in ASAAS but has no charge, can CREATE the charge
 * using debt data from VMAX.
 */

const supabase = createClient(
  getServerSupabaseUrl(),
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const ASAAS_BASE_URL = process.env.ASAAS_API_URL || "https://api.asaas.com/v3"

// Normalize CPF/CNPJ - strip all non-digits
function normalizeCpfCnpj(value: string | null | undefined): string {
  if (!value) return ""
  return value.replace(/\D/g, "")
}

// Format date for ASAAS (YYYY-MM-DD)
function formatDateForAsaas(date?: string | Date | null): string {
  if (!date) {
    // Default to 7 days from now
    const futureDate = new Date()
    futureDate.setDate(futureDate.getDate() + 7)
    return futureDate.toISOString().split("T")[0]
  }

  // If already YYYY-MM-DD format
  if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}/.test(date)) {
    return date.split("T")[0]
  }

  // If DD/MM/YYYY format
  if (typeof date === "string" && /^\d{2}\/\d{2}\/\d{4}/.test(date)) {
    const [day, month, year] = date.split("/")
    return `${year}-${month}-${day}`
  }

  // Fallback
  return new Date(date).toISOString().split("T")[0]
}

// Parse Brazilian currency string to number
function parseDebtAmount(value: string | number | null | undefined): number {
  if (!value) return 0
  if (typeof value === "number") return value

  // Remove R$, spaces, dots (thousands separator), convert comma to dot
  const cleaned = String(value)
    .replace(/R\$/g, "")
    .replace(/\s/g, "")
    .replace(/\./g, "")
    .replace(",", ".")

  return Number(cleaned) || 0
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { vmaxId, cpfCnpj, companyId, customerName, createCharge, debtAmount: providedDebtAmount } = body

    if (!cpfCnpj || !companyId) {
      return NextResponse.json(
        { success: false, error: "CPF/CNPJ e companyId são obrigatórios" },
        { status: 400 }
      )
    }

    const apiKey = process.env.ASAAS_API_KEY
    if (!apiKey) {
      return NextResponse.json(
        { success: false, error: "ASAAS_API_KEY não configurada" },
        { status: 500 }
      )
    }

    const normalizedCpf = normalizeCpfCnpj(cpfCnpj)
    console.log(`[ASAAS Sync Client] Searching for ${customerName || normalizedCpf}...`)

    // 1. Search ASAAS for this CPF/CNPJ
    const searchUrl = `${ASAAS_BASE_URL}/customers?cpfCnpj=${normalizedCpf}`
    const searchResponse = await fetch(searchUrl, {
      headers: {
        "access_token": apiKey,
        "Content-Type": "application/json",
      },
    })

    // Validate response is JSON
    const contentType = searchResponse.headers.get("content-type") || ""
    if (!contentType.includes("application/json")) {
      const text = await searchResponse.text()
      console.error(`[ASAAS Sync Client] Non-JSON response:`, text.substring(0, 200))
      return NextResponse.json(
        {
          success: false,
          error: `ASAAS retornou resposta inválida (${searchResponse.status})`,
          details: text.substring(0, 200),
        },
        { status: 502 }
      )
    }

    if (!searchResponse.ok) {
      const errorData = await searchResponse.json()
      return NextResponse.json(
        {
          success: false,
          error: `Erro ao buscar no ASAAS: ${searchResponse.status}`,
          details: errorData,
        },
        { status: searchResponse.status }
      )
    }

    const searchData = await searchResponse.json()

    if (!searchData.data || searchData.data.length === 0) {
      console.log(`[ASAAS Sync Client] ${customerName || normalizedCpf} not found in ASAAS`)
      return NextResponse.json({
        success: true,
        status: "not_found",
        message: "Cliente não encontrado no ASAAS",
      })
    }

    const asaasCustomer = searchData.data[0]
    console.log(`[ASAAS Sync Client] Found ASAAS customer: ${asaasCustomer.id}`)

    // 2. Check for existing charges
    const chargesResponse = await fetch(
      `${ASAAS_BASE_URL}/payments?customer=${asaasCustomer.id}`,
      {
        headers: {
          "access_token": apiKey,
          "Content-Type": "application/json",
        }
      }
    )

    const chargesContentType = chargesResponse.headers.get("content-type") || ""
    if (!chargesContentType.includes("application/json")) {
      return NextResponse.json(
        {
          success: true,
          status: "customer_only",
          message: "Cliente encontrado no ASAAS mas não foi possível verificar cobranças",
          asaasCustomerId: asaasCustomer.id,
        }
      )
    }

    const chargesData = await chargesResponse.json()

    if (chargesData.data && chargesData.data.length > 0) {
      // Has customer + charge → sync to AlteaPay
      const charge = chargesData.data[0] // Most recent charge
      console.log(`[ASAAS Sync Client] Found charge: ${charge.id} (${charge.status})`)

      // Find or create customer in AlteaPay
      let customerId: string | null = null

      const { data: existingCustomers } = await supabase
        .from("customers")
        .select("id")
        .eq("document", normalizedCpf)
        .eq("company_id", companyId)
        .limit(1)

      if (existingCustomers && existingCustomers.length > 0) {
        customerId = existingCustomers[0].id
      } else {
        // Create customer
        const { data: newCustomer, error: customerError } = await supabase
          .from("customers")
          .insert({
            name: customerName || asaasCustomer.name,
            document: normalizedCpf,
            document_type: normalizedCpf.length === 11 ? "CPF" : "CNPJ",
            phone: asaasCustomer.mobilePhone || asaasCustomer.phone || null,
            email: asaasCustomer.email || null,
            company_id: companyId,
            source_system: "VMAX",
            external_id: vmaxId || null,
          })
          .select("id")
          .single()

        if (customerError || !newCustomer) {
          return NextResponse.json({
            success: false,
            error: `Falha ao criar cliente: ${customerError?.message}`,
            asaasCustomerId: asaasCustomer.id,
            asaasChargeId: charge.id,
          }, { status: 500 })
        }
        customerId = newCustomer.id
      }

      // Check for existing agreement
      const { data: existingAgreements } = await supabase
        .from("agreements")
        .select("id, asaas_payment_id")
        .eq("customer_id", customerId)
        .eq("company_id", companyId)
        .order("created_at", { ascending: false })
        .limit(1)

      const existingAgreement = existingAgreements?.[0]

      if (existingAgreement && existingAgreement.asaas_payment_id) {
        // Agreement already synced
        return NextResponse.json({
          success: true,
          status: "already_synced",
          message: "Cliente já está sincronizado",
          asaasCustomerId: asaasCustomer.id,
          asaasChargeId: existingAgreement.asaas_payment_id,
        })
      }

      if (existingAgreement) {
        // Update existing agreement with ASAAS data
        const { error: updateError } = await supabase
          .from("agreements")
          .update({
            asaas_customer_id: asaasCustomer.id,
            asaas_payment_id: charge.id,
            asaas_payment_url: charge.invoiceUrl || null,
            status: "active",
            payment_status: charge.status?.toLowerCase() || "pending",
            updated_at: new Date().toISOString(),
          })
          .eq("id", existingAgreement.id)

        if (updateError) {
          return NextResponse.json({
            success: false,
            error: `Falha ao atualizar acordo: ${updateError.message}`,
            asaasCustomerId: asaasCustomer.id,
            asaasChargeId: charge.id,
          }, { status: 500 })
        }
      } else {
        // Create new agreement + debt
        const { data: newDebt } = await supabase
          .from("debts")
          .insert({
            customer_id: customerId,
            company_id: companyId,
            amount: charge.value || 0,
            due_date: charge.dueDate || new Date().toISOString().split("T")[0],
            description: `Dívida sincronizada do ASAAS`,
            status: "in_negotiation",
            source_system: "ASAAS",
            external_id: vmaxId || null,
          })
          .select("id")
          .single()

        if (newDebt) {
          await supabase.from("agreements").insert({
            debt_id: newDebt.id,
            customer_id: customerId,
            company_id: companyId,
            original_amount: charge.value || 0,
            agreed_amount: charge.value || 0,
            discount_amount: 0,
            discount_percentage: 0,
            installments: 1,
            installment_amount: charge.value || 0,
            due_date: charge.dueDate || new Date().toISOString().split("T")[0],
            status: "active",
            payment_status: charge.status?.toLowerCase() || "pending",
            asaas_customer_id: asaasCustomer.id,
            asaas_payment_id: charge.id,
            asaas_payment_url: charge.invoiceUrl || null,
          })
        }
      }

      // Update VMAX negotiation_status
      if (vmaxId) {
        await supabase
          .from("VMAX")
          .update({ negotiation_status: "sent" })
          .eq("id", vmaxId)
      }

      return NextResponse.json({
        success: true,
        status: "synced",
        message: `Sincronizado! Cobrança: ${charge.id}`,
        asaasCustomerId: asaasCustomer.id,
        asaasChargeId: charge.id,
        paymentUrl: charge.invoiceUrl || charge.bankSlipUrl || null,
        chargeStatus: charge.status,
      })
    } else {
      // Has customer but NO charge
      console.log(`[ASAAS Sync Client] ${customerName || normalizedCpf} exists in ASAAS but has no charges`)

      // If createCharge flag is set, create the charge now
      if (createCharge) {
        console.log(`[ASAAS Sync Client] Creating charge for existing customer ${asaasCustomer.id}...`)

        // Get debt amount from VMAX or use provided amount
        let debtAmount = providedDebtAmount ? parseDebtAmount(providedDebtAmount) : 0

        if (!debtAmount && vmaxId) {
          // Fetch from VMAX table
          const { data: vmaxRecord } = await supabase
            .from("VMAX")
            .select("Vencido")
            .eq("id", vmaxId)
            .single()

          if (vmaxRecord) {
            debtAmount = parseDebtAmount(vmaxRecord.Vencido)
          }
        }

        if (!debtAmount || debtAmount <= 0) {
          return NextResponse.json({
            success: false,
            status: "customer_only",
            error: "Valor da dívida ausente ou zero — não é possível criar cobrança",
            asaasCustomerId: asaasCustomer.id,
            canCreateCharge: false,
          })
        }

        // Create the charge in ASAAS
        const dueDate = formatDateForAsaas()
        const chargePayload = {
          customer: asaasCustomer.id,
          billingType: "UNDEFINED" as const, // Allows any payment method
          value: debtAmount,
          dueDate,
          description: `Cobrança de dívida - ${customerName || asaasCustomer.name}`,
          postalService: false,
        }

        console.log(`[ASAAS Sync Client] Creating charge:`, chargePayload)

        const chargeResponse = await fetch(`${ASAAS_BASE_URL}/payments`, {
          method: "POST",
          headers: {
            "access_token": apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(chargePayload),
        })

        const chargeContentType = chargeResponse.headers.get("content-type") || ""
        if (!chargeContentType.includes("application/json")) {
          const text = await chargeResponse.text()
          console.error(`[ASAAS Sync Client] Non-JSON response creating charge:`, text.substring(0, 200))
          return NextResponse.json({
            success: false,
            status: "customer_only",
            error: `ASAAS retornou resposta inválida ao criar cobrança: ${text.substring(0, 200)}`,
            asaasCustomerId: asaasCustomer.id,
          }, { status: 502 })
        }

        const chargeData = await chargeResponse.json()

        if (!chargeResponse.ok) {
          console.error(`[ASAAS Sync Client] Error creating charge:`, chargeData)
          return NextResponse.json({
            success: false,
            status: "customer_only",
            error: `Erro ao criar cobrança: ${JSON.stringify(chargeData.errors || chargeData)}`,
            asaasCustomerId: asaasCustomer.id,
          }, { status: chargeResponse.status })
        }

        console.log(`[ASAAS Sync Client] Charge created: ${chargeData.id}`)

        // Now sync to AlteaPay (same logic as when charge exists)
        let customerId: string | null = null

        const { data: existingCustomers } = await supabase
          .from("customers")
          .select("id")
          .eq("document", normalizedCpf)
          .eq("company_id", companyId)
          .limit(1)

        if (existingCustomers && existingCustomers.length > 0) {
          customerId = existingCustomers[0].id
        } else {
          // Create customer in AlteaPay
          const { data: newCustomer, error: customerError } = await supabase
            .from("customers")
            .insert({
              name: customerName || asaasCustomer.name,
              document: normalizedCpf,
              document_type: normalizedCpf.length === 11 ? "CPF" : "CNPJ",
              phone: asaasCustomer.mobilePhone || asaasCustomer.phone || null,
              email: asaasCustomer.email || null,
              company_id: companyId,
              source_system: "VMAX",
              external_id: vmaxId || null,
            })
            .select("id")
            .single()

          if (customerError || !newCustomer) {
            return NextResponse.json({
              success: false,
              error: `Cobrança criada (${chargeData.id}) mas falha ao criar cliente no AlteaPay: ${customerError?.message}`,
              asaasCustomerId: asaasCustomer.id,
              asaasChargeId: chargeData.id,
              partialSuccess: true,
            }, { status: 500 })
          }
          customerId = newCustomer.id
        }

        // Create debt and agreement
        const { data: newDebt, error: debtError } = await supabase
          .from("debts")
          .insert({
            customer_id: customerId,
            company_id: companyId,
            amount: debtAmount,
            due_date: dueDate,
            description: `Dívida sincronizada - ${customerName || asaasCustomer.name}`,
            status: "in_negotiation",
            source_system: "VMAX",
            external_id: vmaxId || null,
          })
          .select("id")
          .single()

        if (debtError || !newDebt) {
          return NextResponse.json({
            success: false,
            error: `Cobrança criada (${chargeData.id}) mas falha ao criar dívida no AlteaPay: ${debtError?.message}`,
            asaasCustomerId: asaasCustomer.id,
            asaasChargeId: chargeData.id,
            partialSuccess: true,
          }, { status: 500 })
        }

        const { error: agreementError } = await supabase.from("agreements").insert({
          debt_id: newDebt.id,
          customer_id: customerId,
          company_id: companyId,
          original_amount: debtAmount,
          agreed_amount: debtAmount,
          discount_amount: 0,
          discount_percentage: 0,
          installments: 1,
          installment_amount: debtAmount,
          due_date: dueDate,
          status: "active",
          payment_status: "pending",
          asaas_customer_id: asaasCustomer.id,
          asaas_payment_id: chargeData.id,
          asaas_payment_url: chargeData.invoiceUrl || null,
        })

        if (agreementError) {
          return NextResponse.json({
            success: false,
            error: `Cobrança criada (${chargeData.id}) mas falha ao criar acordo: ${agreementError.message}`,
            asaasCustomerId: asaasCustomer.id,
            asaasChargeId: chargeData.id,
            partialSuccess: true,
          }, { status: 500 })
        }

        // Update VMAX negotiation_status
        if (vmaxId) {
          await supabase
            .from("VMAX")
            .update({ negotiation_status: "sent" })
            .eq("id", vmaxId)
        }

        return NextResponse.json({
          success: true,
          status: "charge_created",
          message: `Cobrança criada e sincronizada! ID: ${chargeData.id}`,
          asaasCustomerId: asaasCustomer.id,
          asaasChargeId: chargeData.id,
          paymentUrl: chargeData.invoiceUrl || chargeData.bankSlipUrl || null,
          chargeStatus: chargeData.status,
          debtAmount,
        })
      }

      // Not creating charge - just report customer_only status
      // Also get debt info so frontend can offer to create charge
      let debtAmount = 0
      if (vmaxId) {
        const { data: vmaxRecord } = await supabase
          .from("VMAX")
          .select("Vencido")
          .eq("id", vmaxId)
          .single()

        if (vmaxRecord) {
          debtAmount = parseDebtAmount(vmaxRecord.Vencido)
        }
      }

      return NextResponse.json({
        success: true,
        status: "customer_only",
        message: "Cliente encontrado no ASAAS mas sem cobrança.",
        asaasCustomerId: asaasCustomer.id,
        canCreateCharge: debtAmount > 0,
        debtAmount: debtAmount > 0 ? debtAmount : undefined,
      })
    }
  } catch (error: any) {
    console.error("[ASAAS Sync Client] Error:", error)
    return NextResponse.json(
      {
        success: false,
        error: error.message || "Erro desconhecido",
      },
      { status: 500 }
    )
  }
}
