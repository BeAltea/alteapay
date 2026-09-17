import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { headers } from "next/headers"
import { getServerSupabaseUrl } from "@/lib/supabase/url"

/**
 * ASAAS Payment Sync Endpoint (Polling Fallback)
 *
 * This endpoint checks ASAAS for status updates on all pending/active charges.
 * Use as a fallback when webhooks fail or are delayed.
 *
 * NEW: Also detects and fixes "stuck" clients - those that exist in ASAAS
 * but AlteaPay doesn't know about (e.g., ASAAS customer created but charge
 * creation failed, leaving the client in a half-synced state).
 *
 * Can be triggered by:
 * 1. Manual "Sincronizar com ASAAS" button in admin
 * 2. Cron job (e.g., every 15 minutes via Vercel Cron)
 */

const supabase = createClient(
  getServerSupabaseUrl(),
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const ASAAS_BASE_URL = process.env.ASAAS_API_URL || "https://api.asaas.com/v3"

// Status that indicate the payment is still pending/active and should be synced
const SYNC_STATUSES = ["pending", "confirmed", "overdue"]

// Minimum time between syncs for the same agreement (5 minutes)
const MIN_SYNC_INTERVAL_MS = 5 * 60 * 1000

// Rate limiting: max payments to sync per request
const MAX_PAYMENTS_PER_SYNC = 50

async function getBaseUrl(): Promise<string> {
  try {
    const h = await headers()
    const host = h.get("host")
    const proto = h.get("x-forwarded-proto") || "https"
    if (host) return `${proto}://${host}`
  } catch {}
  return process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"
}

interface AsaasPaymentResult {
  status: "found" | "deleted" | "error"
  data?: any
  error?: string
}

async function fetchAsaasPaymentStatus(paymentId: string): Promise<AsaasPaymentResult> {
  const baseUrl = await getBaseUrl()

  const response = await fetch(`${baseUrl}/api/asaas`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      endpoint: `/payments/${paymentId}`,
      method: "GET",
    }),
  })

  // Check for 404 - payment was deleted from ASAAS
  if (response.status === 404) {
    return { status: "deleted" }
  }

  if (!response.ok) {
    // Try to get error details - might be HTML error page
    let errorText: string
    try {
      const contentType = response.headers.get("content-type") || ""
      if (contentType.includes("application/json")) {
        const errorData = await response.json()
        errorText = JSON.stringify(errorData)
      } else {
        const text = await response.text()
        errorText = text.substring(0, 200)
      }
    } catch {
      errorText = `HTTP ${response.status}`
    }
    return { status: "error", error: `Failed to fetch payment ${paymentId}: ${errorText}` }
  }

  // Safe JSON parsing - validates content-type first
  const data = await safeJsonParse(response, `fetch_payment_${paymentId}`)

  // Also check if ASAAS returns an error in the response body indicating not found
  if (data?.errors?.some((e: any) => e.code === "invalid_action" || e.description?.includes("not found"))) {
    return { status: "deleted" }
  }

  return { status: "found", data }
}

// Normalize CPF/CNPJ - strip all non-digits for comparison
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

// Create a charge in ASAAS for an existing customer
async function createAsaasCharge(
  asaasCustomerId: string,
  customerName: string,
  debtAmount: number
): Promise<{ success: boolean; chargeId?: string; invoiceUrl?: string; error?: string }> {
  const baseUrl = await getBaseUrl()
  const dueDate = formatDateForAsaas()

  try {
    const response = await fetch(`${baseUrl}/api/asaas`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        endpoint: "/payments",
        method: "POST",
        data: {
          customer: asaasCustomerId,
          billingType: "UNDEFINED",
          value: debtAmount,
          dueDate,
          description: `Cobrança de dívida - ${customerName}`,
          postalService: false,
        },
      }),
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error")
      return { success: false, error: `HTTP ${response.status}: ${errorText.substring(0, 200)}` }
    }

    const data = await safeJsonParse(response, `create_charge_${asaasCustomerId}`)

    if (data.errors) {
      return { success: false, error: JSON.stringify(data.errors) }
    }

    return {
      success: true,
      chargeId: data.id,
      invoiceUrl: data.invoiceUrl,
    }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

// Safe JSON parser that validates content-type before parsing
// Prevents "Unexpected token '<'" errors when server returns HTML error pages
async function safeJsonParse(response: Response, context: string): Promise<any> {
  const contentType = response.headers.get("content-type") || ""

  if (!contentType.includes("application/json")) {
    const text = await response.text().catch(() => "Unable to read response body")
    const preview = text.substring(0, 200)
    console.error(`[ASAAS Sync] ${context} - Expected JSON but got ${contentType}: ${preview}`)

    throw new AsaasSyncError(
      `Resposta inesperada do servidor: esperava JSON mas recebeu ${contentType || "unknown"}. ` +
      `Isso geralmente indica timeout do servidor ou erro de configuração.`,
      context,
      response.status,
      { contentType, preview }
    )
  }

  return response.json()
}

// Custom error class with ASAAS details
class AsaasSyncError extends Error {
  step: string
  httpStatus?: number
  asaasResponse?: any

  constructor(message: string, step: string, httpStatus?: number, asaasResponse?: any) {
    super(message)
    this.name = "AsaasSyncError"
    this.step = step
    this.httpStatus = httpStatus
    this.asaasResponse = asaasResponse
  }
}

// Fetch ASAAS customer by CPF/CNPJ
async function fetchAsaasCustomerByCpfCnpj(cpfCnpj: string): Promise<any | null> {
  const baseUrl = await getBaseUrl()
  const normalizedCpf = normalizeCpfCnpj(cpfCnpj)

  if (!normalizedCpf) return null

  try {
    const response = await fetch(`${baseUrl}/api/asaas`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        endpoint: `/customers?cpfCnpj=${normalizedCpf}`,
        method: "GET",
      }),
    })

    if (!response.ok) {
      // Try to get error details - might be HTML error page
      let errorText: string
      try {
        const contentType = response.headers.get("content-type") || ""
        if (contentType.includes("application/json")) {
          const errorData = await response.json()
          errorText = JSON.stringify(errorData)
        } else {
          const text = await response.text()
          errorText = text.substring(0, 200)
        }
      } catch {
        errorText = `HTTP ${response.status}`
      }
      console.error(`[ASAAS Sync] API error fetching customer ${normalizedCpf}: ${response.status} - ${errorText}`)
      // Don't throw, just return null - this customer doesn't exist in ASAAS
      return null
    }

    // Safe JSON parsing - validates content-type first
    const data = await safeJsonParse(response, `fetch_customer_${normalizedCpf}`)

    // Check for ASAAS API errors in response
    if (data.errors && data.errors.length > 0) {
      console.error(`[ASAAS Sync] ASAAS error for ${normalizedCpf}:`, data.errors)
      return null
    }

    // Return first matching customer
    if (data.data && data.data.length > 0) {
      return data.data[0]
    }

    return null
  } catch (error: any) {
    console.error(`[ASAAS Sync] Error fetching customer by CPF/CNPJ ${normalizedCpf}:`, error)
    // Re-throw if it's our custom error (includes HTML response errors)
    if (error instanceof AsaasSyncError) {
      throw error
    }
    // Re-throw with context if it's a network/timeout error
    if (error.name === "AbortError" || error.message?.includes("timeout")) {
      throw new AsaasSyncError(
        `Timeout ao buscar cliente ${normalizedCpf} no ASAAS`,
        "fetch_asaas_customer",
        undefined,
        undefined
      )
    }
    return null
  }
}

// Fetch payments for a specific ASAAS customer
async function fetchAsaasPaymentsForCustomer(customerId: string): Promise<any[]> {
  const baseUrl = await getBaseUrl()

  try {
    const response = await fetch(`${baseUrl}/api/asaas`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        endpoint: `/payments?customer=${customerId}`,
        method: "GET",
      }),
    })

    if (!response.ok) {
      console.error(`[ASAAS Sync] API error fetching payments for ${customerId}: ${response.status}`)
      return []
    }

    // Safe JSON parsing - validates content-type first
    const data = await safeJsonParse(response, `fetch_payments_${customerId}`)
    return data.data || []
  } catch (error: any) {
    console.error(`[ASAAS Sync] Error fetching payments for customer ${customerId}:`, error)
    // Re-throw if it's our custom error (includes HTML response errors)
    if (error instanceof AsaasSyncError) {
      throw error
    }
    return []
  }
}

// Fetch all payments from ASAAS (paginated)
async function fetchAllAsaasPayments(): Promise<any[]> {
  const baseUrl = await getBaseUrl()
  const allPayments: any[] = []
  let offset = 0
  const limit = 100

  try {
    while (true) {
      const response = await fetch(`${baseUrl}/api/asaas`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: `/payments?offset=${offset}&limit=${limit}`,
          method: "GET",
        }),
      })

      if (!response.ok) {
        console.error(`[ASAAS Sync] API error fetching payments at offset ${offset}: ${response.status}`)
        break
      }

      // Safe JSON parsing - validates content-type first
      const data = await safeJsonParse(response, `fetch_all_payments_offset_${offset}`)
      if (!data.data || data.data.length === 0) break

      allPayments.push(...data.data)

      if (!data.hasMore) break
      offset += limit

      // Safety limit
      if (offset > 1000) break
    }
  } catch (error: any) {
    console.error("[ASAAS Sync] Error fetching payments:", error)
    // Re-throw if it's our custom error (includes HTML response errors)
    if (error instanceof AsaasSyncError) {
      throw error
    }
  }

  return allPayments
}

// Fetch ALL customers from ASAAS (paginated) - used for comprehensive sync
async function fetchAllAsaasCustomers(): Promise<any[]> {
  const baseUrl = await getBaseUrl()
  const allCustomers: any[] = []
  let offset = 0
  const limit = 100 // ASAAS max per page

  console.log("[ASAAS Sync] Fetching ALL customers from ASAAS...")

  try {
    while (true) {
      const response = await fetch(`${baseUrl}/api/asaas`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: `/customers?offset=${offset}&limit=${limit}`,
          method: "GET",
        }),
      })

      if (!response.ok) {
        console.error(`[ASAAS Sync] API error fetching customers at offset ${offset}: ${response.status}`)
        break
      }

      // Safe JSON parsing - validates content-type first
      const data = await safeJsonParse(response, `fetch_all_customers_offset_${offset}`)
      if (!data.data || data.data.length === 0) break

      allCustomers.push(...data.data)
      console.log(`[ASAAS Sync] Fetched ${allCustomers.length} customers so far...`)

      if (!data.hasMore) break
      offset += limit

      // Safety limit - max 2000 customers
      if (offset > 2000) {
        console.log("[ASAAS Sync] Reached safety limit of 2000 customers")
        break
      }
    }
  } catch (error: any) {
    console.error("[ASAAS Sync] Error fetching customers:", error)
    if (error instanceof AsaasSyncError) {
      throw error
    }
  }

  console.log(`[ASAAS Sync] Total customers fetched from ASAAS: ${allCustomers.length}`)
  return allCustomers
}

// Comprehensive sync: ASAAS → Local records
// This function fetches ALL customers from ASAAS and syncs them to local records
async function syncFromAsaas(
  companyId: string,
  createCharges: boolean,
  startTime: number
): Promise<{
  asaasCustomerCount: number
  matched: number
  unmatched: number
  synced: number
  chargesCreated: number
  errors: string[]
  unmatchedCustomers: Array<{ id: string; name: string; cpfCnpj: string; email?: string }>
  syncedDetails: Array<{ name: string; cpfCnpj: string; action: string; asaasPaymentId?: string }>
}> {
  const results = {
    asaasCustomerCount: 0,
    matched: 0,
    unmatched: 0,
    synced: 0,
    chargesCreated: 0,
    errors: [] as string[],
    unmatchedCustomers: [] as Array<{ id: string; name: string; cpfCnpj: string; email?: string }>,
    syncedDetails: [] as Array<{ name: string; cpfCnpj: string; action: string; asaasPaymentId?: string }>,
  }

  const MAX_SYNC_TIME_MS = 25000 // 25 seconds max for processing loop

  try {
    // STEP 1: Fetch ALL customers from ASAAS
    const dataLoadStart = Date.now()
    const asaasCustomers = await fetchAllAsaasCustomers()
    console.log(`[ASAAS Sync] ASAAS customers fetched in ${Date.now() - dataLoadStart}ms`)
    results.asaasCustomerCount = asaasCustomers.length

    if (asaasCustomers.length === 0) {
      console.log("[ASAAS Sync] No customers found in ASAAS")
      return results
    }

    // STEP 2: Load all VMAX records for this company (for matching)
    const { data: vmaxRecords } = await supabase
      .from("VMAX")
      .select("id, Cliente, \"CPF/CNPJ\", Vencido, negotiation_status")
      .eq("id_company", companyId)

    // Build map: normalized CPF/CNPJ -> VMAX record
    const vmaxByCpf = new Map<string, any>()
    for (const vmax of vmaxRecords || []) {
      const cpf = normalizeCpfCnpj(vmax["CPF/CNPJ"])
      if (cpf) vmaxByCpf.set(cpf, vmax)
    }

    // STEP 3: Load all existing agreements for this company (with pagination)
    // Supabase has a default limit of 1000 rows, so we need to paginate
    const agreementByAsaasCustomerId = new Map<string, any>()
    const agreementByCpf = new Map<string, any>()
    let agreementOffset = 0
    const agreementPageSize = 1000

    while (true) {
      // Include all valid agreement statuses - pago_ao_cliente are customers who paid directly to provider
      const { data: agreementPage } = await supabase
        .from("agreements")
        .select("id, customer_id, asaas_customer_id, asaas_payment_id, status, customers(document)")
        .eq("company_id", companyId)
        .in("status", ["active", "draft", "pending", "completed", "paid", "pago_ao_cliente", "broken", "cancelled"])
        .range(agreementOffset, agreementOffset + agreementPageSize - 1)

      if (!agreementPage || agreementPage.length === 0) break

      for (const ag of agreementPage) {
        if (ag.asaas_customer_id) {
          agreementByAsaasCustomerId.set(ag.asaas_customer_id, ag)
        }
        const customer = ag.customers as any
        if (customer?.document) {
          const cpf = normalizeCpfCnpj(customer.document)
          if (cpf) agreementByCpf.set(cpf, ag)
        }
      }

      if (agreementPage.length < agreementPageSize) break
      agreementOffset += agreementPageSize
    }

    // STEP 4: Load all local customers for this company (with pagination)
    const localCustomerByCpf = new Map<string, any>()
    let customerOffset = 0
    const customerPageSize = 1000

    while (true) {
      const { data: customerPage } = await supabase
        .from("customers")
        .select("id, document, name")
        .eq("company_id", companyId)
        .range(customerOffset, customerOffset + customerPageSize - 1)

      if (!customerPage || customerPage.length === 0) break

      for (const c of customerPage) {
        const cpf = normalizeCpfCnpj(c.document)
        if (cpf) localCustomerByCpf.set(cpf, c)
      }

      if (customerPage.length < customerPageSize) break
      customerOffset += customerPageSize
    }

    console.log(`[ASAAS Sync] Matching ${asaasCustomers.length} ASAAS customers against ${vmaxByCpf.size} VMAX, ${agreementByCpf.size} agreements, ${localCustomerByCpf.size} local customers`)

    // Reset startTime for processing loop - data loading time shouldn't count against processing timeout
    const processingStartTime = Date.now()

    // STEP 5: Process each ASAAS customer
    for (let i = 0; i < asaasCustomers.length; i++) {
      // Check timeout (25 seconds for processing loop only)
      if (Date.now() - processingStartTime > MAX_SYNC_TIME_MS) {
        console.log(`[ASAAS Sync] Stopping at customer ${i + 1}/${asaasCustomers.length} due to timeout`)
        results.errors.push(`Sync parado por timeout após ${i + 1} clientes`)
        break
      }

      const asaasCustomer = asaasCustomers[i]
      const asaasCpf = normalizeCpfCnpj(asaasCustomer.cpfCnpj)

      if (!asaasCpf) {
        results.errors.push(`Cliente ASAAS ${asaasCustomer.name} sem CPF/CNPJ`)
        continue
      }

      // Check if already has agreement (by ASAAS customer ID or CPF/CNPJ)
      const existingAgreementById = agreementByAsaasCustomerId.get(asaasCustomer.id)
      const existingAgreementByCpf = agreementByCpf.get(asaasCpf)

      if (existingAgreementById || existingAgreementByCpf) {
        results.matched++
        continue // Already synced
      }

      // Check if has VMAX record (potential customer, not yet sent)
      const vmaxRecord = vmaxByCpf.get(asaasCpf)

      if (!vmaxRecord) {
        // ASAAS customer exists but no VMAX record - might be orphaned
        results.unmatched++
        results.unmatchedCustomers.push({
          id: asaasCustomer.id,
          name: asaasCustomer.name,
          cpfCnpj: asaasCustomer.cpfCnpj,
          email: asaasCustomer.email,
        })
        continue
      }

      // VMAX record exists but no agreement - need to sync
      // Check if VMAX already marked as sent
      if (vmaxRecord.negotiation_status && ["sent", "active", "PAGO"].includes(vmaxRecord.negotiation_status)) {
        // Already marked as sent but no agreement found - might be data inconsistency
        // Let's try to find payment in ASAAS and create agreement
      }

      // Fetch payments for this ASAAS customer
      const payments = await fetchAsaasPaymentsForCustomer(asaasCustomer.id)

      if (payments.length > 0) {
        // Has payments - create/update agreement
        const latestPayment = payments[0]

        // Get or create local customer
        let localCustomer = localCustomerByCpf.get(asaasCpf)
        if (!localCustomer) {
          const { data: newCustomer, error: customerError } = await supabase
            .from("customers")
            .insert({
              name: asaasCustomer.name,
              document: asaasCpf,
              document_type: asaasCpf.length === 11 ? "CPF" : "CNPJ",
              phone: asaasCustomer.mobilePhone || asaasCustomer.phone || null,
              email: asaasCustomer.email || null,
              company_id: companyId,
              source_system: "ASAAS_SYNC",
              asaas_customer_id: asaasCustomer.id,
            })
            .select("id")
            .single()

          if (customerError || !newCustomer) {
            results.errors.push(`Erro ao criar cliente ${asaasCustomer.name}: ${customerError?.message}`)
            continue
          }
          localCustomer = newCustomer
        }

        // Create debt
        const debtAmount = latestPayment.value || parseDebtAmount(vmaxRecord.Vencido)
        const { data: newDebt, error: debtError } = await supabase
          .from("debts")
          .insert({
            customer_id: localCustomer.id,
            company_id: companyId,
            amount: debtAmount,
            due_date: latestPayment.dueDate || new Date().toISOString().split("T")[0],
            description: `Dívida de ${asaasCustomer.name}`,
            status: "in_negotiation",
            source_system: "ASAAS_SYNC",
            external_id: vmaxRecord.id,
          })
          .select("id")
          .single()

        if (debtError || !newDebt) {
          results.errors.push(`Erro ao criar dívida para ${asaasCustomer.name}: ${debtError?.message}`)
          continue
        }

        // Create agreement
        const { error: agreementError } = await supabase.from("agreements").insert({
          debt_id: newDebt.id,
          customer_id: localCustomer.id,
          company_id: companyId,
          original_amount: debtAmount,
          agreed_amount: latestPayment.value || debtAmount,
          discount_amount: 0,
          discount_percentage: 0,
          installments: 1,
          installment_amount: latestPayment.value || debtAmount,
          due_date: latestPayment.dueDate || new Date().toISOString().split("T")[0],
          status: "active",
          payment_status: latestPayment.status?.toLowerCase() || "pending",
          asaas_customer_id: asaasCustomer.id,
          asaas_payment_id: latestPayment.id,
          asaas_payment_url: latestPayment.invoiceUrl || null,
        })

        if (agreementError) {
          results.errors.push(`Erro ao criar acordo para ${asaasCustomer.name}: ${agreementError.message}`)
          continue
        }

        // Update VMAX
        await supabase.from("VMAX").update({ negotiation_status: "sent" }).eq("id", vmaxRecord.id)

        results.synced++
        results.syncedDetails.push({
          name: asaasCustomer.name,
          cpfCnpj: asaasCpf,
          action: "Acordo criado a partir do ASAAS",
          asaasPaymentId: latestPayment.id,
        })
      } else if (createCharges) {
        // No payments but createCharges is enabled - create one
        const debtAmount = parseDebtAmount(vmaxRecord.Vencido)

        if (debtAmount <= 0) {
          results.errors.push(`${asaasCustomer.name}: valor da dívida inválido`)
          continue
        }

        const chargeResult = await createAsaasCharge(asaasCustomer.id, asaasCustomer.name, debtAmount)

        if (!chargeResult.success) {
          results.errors.push(`${asaasCustomer.name}: ${chargeResult.error}`)
          continue
        }

        // Get or create local customer
        let localCustomer = localCustomerByCpf.get(asaasCpf)
        if (!localCustomer) {
          const { data: newCustomer, error: customerError } = await supabase
            .from("customers")
            .insert({
              name: asaasCustomer.name,
              document: asaasCpf,
              document_type: asaasCpf.length === 11 ? "CPF" : "CNPJ",
              phone: asaasCustomer.mobilePhone || asaasCustomer.phone || null,
              email: asaasCustomer.email || null,
              company_id: companyId,
              source_system: "ASAAS_SYNC",
              asaas_customer_id: asaasCustomer.id,
            })
            .select("id")
            .single()

          if (customerError || !newCustomer) {
            results.errors.push(`Erro ao criar cliente ${asaasCustomer.name}: ${customerError?.message}`)
            continue
          }
          localCustomer = newCustomer
        }

        // Create debt and agreement
        const dueDate = formatDateForAsaas()
        const { data: newDebt, error: debtError } = await supabase
          .from("debts")
          .insert({
            customer_id: localCustomer.id,
            company_id: companyId,
            amount: debtAmount,
            due_date: dueDate,
            description: `Dívida de ${asaasCustomer.name}`,
            status: "in_negotiation",
            source_system: "ASAAS_SYNC",
            external_id: vmaxRecord.id,
          })
          .select("id")
          .single()

        if (debtError || !newDebt) {
          results.errors.push(`Erro ao criar dívida para ${asaasCustomer.name}: ${debtError?.message}`)
          continue
        }

        const { error: agreementError } = await supabase.from("agreements").insert({
          debt_id: newDebt.id,
          customer_id: localCustomer.id,
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
          asaas_payment_id: chargeResult.chargeId,
          asaas_payment_url: chargeResult.invoiceUrl || null,
        })

        if (agreementError) {
          results.errors.push(`Erro ao criar acordo para ${asaasCustomer.name}: ${agreementError.message}`)
          continue
        }

        // Update VMAX
        await supabase.from("VMAX").update({ negotiation_status: "sent" }).eq("id", vmaxRecord.id)

        results.synced++
        results.chargesCreated++
        results.syncedDetails.push({
          name: asaasCustomer.name,
          cpfCnpj: asaasCpf,
          action: `Cobrança criada (${chargeResult.chargeId})`,
          asaasPaymentId: chargeResult.chargeId,
        })
      } else {
        // No payments and createCharges is disabled - just report
        results.unmatched++
        results.unmatchedCustomers.push({
          id: asaasCustomer.id,
          name: asaasCustomer.name,
          cpfCnpj: asaasCustomer.cpfCnpj,
          email: asaasCustomer.email,
        })
      }
    }

    console.log(`[ASAAS Sync] syncFromAsaas completed: ${results.synced} synced, ${results.unmatched} unmatched, ${results.errors.length} errors`)
  } catch (error: any) {
    console.error("[ASAAS Sync] Error in syncFromAsaas:", error)
    results.errors.push(error.message || "Erro desconhecido")
  }

  return results
}

// Process a single client sync (used by both individual and bulk sync)
async function syncSingleClient(
  vmax: { id: string; Cliente: string; "CPF/CNPJ": string; Vencido?: string | number },
  companyId: string,
  createCharges = false // If true, creates charges for customers without them
): Promise<{
  status: "synced" | "customer_only" | "not_found" | "already_synced" | "error" | "charge_created"
  name: string
  cpfCnpj: string
  asaasCustomerId?: string
  asaasPaymentId?: string
  action?: string
  error?: string
}> {
  const cpfCnpj = normalizeCpfCnpj(vmax["CPF/CNPJ"])
  if (!cpfCnpj) {
    return { status: "error", name: vmax.Cliente, cpfCnpj: "", error: "CPF/CNPJ inválido" }
  }

  try {
    // STEP 1: Query ASAAS directly for this CPF/CNPJ
    const asaasCustomer = await fetchAsaasCustomerByCpfCnpj(cpfCnpj)

    if (!asaasCustomer) {
      return { status: "not_found", name: vmax.Cliente, cpfCnpj }
    }

    // STEP 2: Get payments for this ASAAS customer
    const asaasPayments = await fetchAsaasPaymentsForCustomer(asaasCustomer.id)

    // STEP 3: Check if AlteaPay has this customer
    const { data: alteaCustomers } = await supabase
      .from("customers")
      .select("id")
      .eq("document", cpfCnpj)
      .eq("company_id", companyId)
      .limit(1)

    let customerId: string | null = alteaCustomers?.[0]?.id || null

    // STEP 4: Create customer if not exists
    if (!customerId) {
      const { data: newCustomer, error: customerError } = await supabase
        .from("customers")
        .insert({
          name: vmax.Cliente,
          document: cpfCnpj,
          document_type: cpfCnpj.length === 11 ? "CPF" : "CNPJ",
          phone: asaasCustomer.mobilePhone || asaasCustomer.phone || null,
          email: asaasCustomer.email || null,
          company_id: companyId,
          source_system: "VMAX",
          external_id: vmax.id,
        })
        .select("id")
        .single()

      if (customerError || !newCustomer) {
        return {
          status: "error",
          name: vmax.Cliente,
          cpfCnpj,
          asaasCustomerId: asaasCustomer.id,
          error: `Falha ao criar cliente: ${customerError?.message}`,
        }
      }
      customerId = newCustomer.id
    }

    // STEP 5: Check for existing agreements
    const { data: existingAgreements } = await supabase
      .from("agreements")
      .select("id, asaas_payment_id, asaas_customer_id, status")
      .eq("customer_id", customerId)
      .eq("company_id", companyId)
      .order("created_at", { ascending: false })
      .limit(1)

    const existingAgreement = existingAgreements?.[0] || null

    // STEP 6: Handle based on ASAAS state
    if (asaasPayments.length > 0) {
      const latestPayment = asaasPayments[0]

      if (existingAgreement && existingAgreement.asaas_payment_id) {
        // Already synced - just update VMAX
        await supabase.from("VMAX").update({ negotiation_status: "sent" }).eq("id", vmax.id)
        return {
          status: "already_synced",
          name: vmax.Cliente,
          cpfCnpj,
          asaasCustomerId: asaasCustomer.id,
          asaasPaymentId: existingAgreement.asaas_payment_id,
          action: "VMAX atualizado (acordo existente)",
        }
      } else if (existingAgreement && !existingAgreement.asaas_payment_id) {
        // Update agreement with ASAAS data
        await supabase
          .from("agreements")
          .update({
            asaas_customer_id: asaasCustomer.id,
            asaas_payment_id: latestPayment.id,
            asaas_payment_url: latestPayment.invoiceUrl || null,
            status: "active",
            payment_status: latestPayment.status?.toLowerCase() || "pending",
          })
          .eq("id", existingAgreement.id)

        await supabase.from("VMAX").update({ negotiation_status: "sent" }).eq("id", vmax.id)
        return {
          status: "synced",
          name: vmax.Cliente,
          cpfCnpj,
          asaasCustomerId: asaasCustomer.id,
          asaasPaymentId: latestPayment.id,
          action: "Acordo atualizado com dados do ASAAS",
        }
      } else {
        // Create new agreement
        const vencidoStr = String(vmax.Vencido || "0")
        const originalAmount = Number(vencidoStr.replace(/R\$/g, "").replace(/\s/g, "").replace(/\./g, "").replace(",", ".")) || latestPayment.value || 0

        const { data: newDebt } = await supabase
          .from("debts")
          .insert({
            customer_id: customerId,
            company_id: companyId,
            amount: originalAmount,
            due_date: latestPayment.dueDate || new Date().toISOString().split("T")[0],
            description: `Dívida de ${vmax.Cliente}`,
            status: "in_negotiation",
            source_system: "VMAX",
            external_id: vmax.id,
          })
          .select("id")
          .single()

        if (newDebt) {
          const { error: agreementError } = await supabase.from("agreements").insert({
            debt_id: newDebt.id,
            customer_id: customerId,
            company_id: companyId,
            original_amount: originalAmount,
            agreed_amount: latestPayment.value || originalAmount,
            discount_amount: 0,
            discount_percentage: 0,
            installments: 1,
            installment_amount: latestPayment.value || originalAmount,
            due_date: latestPayment.dueDate || new Date().toISOString().split("T")[0],
            status: "active",
            payment_status: latestPayment.status?.toLowerCase() || "pending",
            asaas_customer_id: asaasCustomer.id,
            asaas_payment_id: latestPayment.id,
            asaas_payment_url: latestPayment.invoiceUrl || null,
          })

          if (!agreementError) {
            await supabase.from("VMAX").update({ negotiation_status: "sent" }).eq("id", vmax.id)
            return {
              status: "synced",
              name: vmax.Cliente,
              cpfCnpj,
              asaasCustomerId: asaasCustomer.id,
              asaasPaymentId: latestPayment.id,
              action: "Acordo criado a partir do ASAAS",
            }
          } else {
            return {
              status: "error",
              name: vmax.Cliente,
              cpfCnpj,
              asaasCustomerId: asaasCustomer.id,
              error: `Falha ao criar acordo: ${agreementError.message}`,
            }
          }
        }
      }
    }

    // Customer exists in ASAAS but no payment
    // If createCharges is enabled, create the charge now
    if (createCharges) {
      const debtAmount = parseDebtAmount(vmax.Vencido)

      if (debtAmount <= 0) {
        return {
          status: "customer_only",
          name: vmax.Cliente,
          cpfCnpj,
          asaasCustomerId: asaasCustomer.id,
          action: "Cliente no ASAAS sem cobrança (valor da dívida zero)",
        }
      }

      console.log(`[ASAAS Sync] Creating charge for ${vmax.Cliente} (${debtAmount})...`)

      const chargeResult = await createAsaasCharge(asaasCustomer.id, vmax.Cliente, debtAmount)

      if (!chargeResult.success) {
        return {
          status: "error",
          name: vmax.Cliente,
          cpfCnpj,
          asaasCustomerId: asaasCustomer.id,
          error: `Falha ao criar cobrança: ${chargeResult.error}`,
        }
      }

      // Charge created - now create/update AlteaPay records
      const dueDate = formatDateForAsaas()

      // Ensure customer exists
      if (!customerId) {
        const { data: newCustomer, error: customerError } = await supabase
          .from("customers")
          .insert({
            name: vmax.Cliente,
            document: cpfCnpj,
            document_type: cpfCnpj.length === 11 ? "CPF" : "CNPJ",
            phone: asaasCustomer.mobilePhone || asaasCustomer.phone || null,
            email: asaasCustomer.email || null,
            company_id: companyId,
            source_system: "VMAX",
            external_id: vmax.id,
          })
          .select("id")
          .single()

        if (customerError || !newCustomer) {
          return {
            status: "error",
            name: vmax.Cliente,
            cpfCnpj,
            asaasCustomerId: asaasCustomer.id,
            asaasPaymentId: chargeResult.chargeId,
            error: `Cobrança criada mas falha ao criar cliente: ${customerError?.message}`,
          }
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
          description: `Dívida de ${vmax.Cliente}`,
          status: "in_negotiation",
          source_system: "VMAX",
          external_id: vmax.id,
        })
        .select("id")
        .single()

      if (debtError || !newDebt) {
        return {
          status: "error",
          name: vmax.Cliente,
          cpfCnpj,
          asaasCustomerId: asaasCustomer.id,
          asaasPaymentId: chargeResult.chargeId,
          error: `Cobrança criada mas falha ao criar dívida: ${debtError?.message}`,
        }
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
        asaas_payment_id: chargeResult.chargeId,
        asaas_payment_url: chargeResult.invoiceUrl || null,
      })

      if (agreementError) {
        return {
          status: "error",
          name: vmax.Cliente,
          cpfCnpj,
          asaasCustomerId: asaasCustomer.id,
          asaasPaymentId: chargeResult.chargeId,
          error: `Cobrança criada mas falha ao criar acordo: ${agreementError.message}`,
        }
      }

      // Update VMAX
      await supabase.from("VMAX").update({ negotiation_status: "sent" }).eq("id", vmax.id)

      return {
        status: "charge_created",
        name: vmax.Cliente,
        cpfCnpj,
        asaasCustomerId: asaasCustomer.id,
        asaasPaymentId: chargeResult.chargeId,
        action: `Cobrança criada (${chargeResult.chargeId})`,
      }
    }

    return {
      status: "customer_only",
      name: vmax.Cliente,
      cpfCnpj,
      asaasCustomerId: asaasCustomer.id,
      action: "Cliente no ASAAS sem cobrança",
    }
  } catch (error: any) {
    return {
      status: "error",
      name: vmax.Cliente,
      cpfCnpj,
      error: error.message || "Erro desconhecido",
    }
  }
}

// Sync stuck clients: exist in ASAAS but AlteaPay shows "Sem negociação"
// OPTIMIZED: Process in parallel chunks to avoid timeout
async function syncStuckClients(companyId: string, results: any, startTime: number, createCharges = false) {
  console.log(`[ASAAS Sync] Checking for stuck clients in company ${companyId}...`)

  // TIMEOUT PROTECTION: Max 8 seconds for stuck client sync (leave buffer for main sync)
  const MAX_STUCK_SYNC_MS = 8000
  const elapsed = Date.now() - startTime
  if (elapsed > MAX_STUCK_SYNC_MS) {
    console.log(`[ASAAS Sync] Skipping stuck client sync - already at ${elapsed}ms`)
    return
  }

  // Get total count of unsynced VMAX records
  const { count: totalUnsynced } = await supabase
    .from("VMAX")
    .select("id", { count: "exact", head: true })
    .eq("company_id", companyId)
    .is("negotiation_status", null)

  results.totalUnsynced = totalUnsynced || 0

  // INCREASED LIMIT: Check more clients per sync (was 20, now 50)
  const BATCH_LIMIT = 50
  const CHUNK_SIZE = 10 // Process 10 in parallel

  const { data: vmaxRecords, error: vmaxError } = await supabase
    .from("VMAX")
    .select("id, Cliente, \"CPF/CNPJ\", Vencido, negotiation_status")
    .eq("company_id", companyId)
    .is("negotiation_status", null)
    .limit(BATCH_LIMIT)

  if (vmaxError || !vmaxRecords || vmaxRecords.length === 0) {
    console.log("[ASAAS Sync] No VMAX records without negotiation found")
    return
  }

  results.checkedCount = vmaxRecords.length
  results.remainingCount = Math.max(0, (totalUnsynced || 0) - vmaxRecords.length)

  console.log(`[ASAAS Sync] Checking ${vmaxRecords.length} of ${totalUnsynced} unsynced clients (parallel chunks of ${CHUNK_SIZE})`)

  // Process in parallel chunks
  for (let i = 0; i < vmaxRecords.length; i += CHUNK_SIZE) {
    // Check timeout before each chunk
    const chunkElapsed = Date.now() - startTime
    if (chunkElapsed > MAX_STUCK_SYNC_MS) {
      console.log(`[ASAAS Sync] Stopping stuck sync at ${i} clients due to time limit (${chunkElapsed}ms)`)
      results.stoppedEarly = true
      break
    }

    const chunk = vmaxRecords.slice(i, i + CHUNK_SIZE)
    console.log(`[ASAAS Sync] Processing chunk ${Math.floor(i / CHUNK_SIZE) + 1}/${Math.ceil(vmaxRecords.length / CHUNK_SIZE)}...`)

    // Process chunk in parallel
    const chunkResults = await Promise.allSettled(
      chunk.map((vmax) => syncSingleClient(vmax, companyId, createCharges))
    )

    // Collect results
    for (const result of chunkResults) {
      if (result.status === "fulfilled") {
        const syncResult = result.value

        if (syncResult.status === "synced" || syncResult.status === "already_synced" || syncResult.status === "charge_created") {
          results.stuckFixed = (results.stuckFixed || 0) + 1
          if (syncResult.status === "charge_created") {
            results.chargesCreated = (results.chargesCreated || 0) + 1
          }
          if (!results.stuckDetails) results.stuckDetails = []
          results.stuckDetails.push({
            name: syncResult.name,
            cpfCnpj: syncResult.cpfCnpj,
            action: syncResult.action || "Sincronizado",
            asaasPaymentId: syncResult.asaasPaymentId,
          })
        } else if (syncResult.status === "customer_only") {
          if (!results.incompleteAgreements) results.incompleteAgreements = []
          results.incompleteAgreements.push({
            agreementId: "",
            customerName: syncResult.name,
            cpfCnpj: syncResult.cpfCnpj,
            asaasCustomerId: syncResult.asaasCustomerId || "",
            issue: "Cliente existe no ASAAS mas não tem cobrança. Envie uma nova negociação.",
          })
        } else if (syncResult.status === "error") {
          results.errors.push(`${syncResult.name}: ${syncResult.error}`)
        }
        // "not_found" status is ignored (most common case)
      } else {
        results.errors.push(`Erro ao processar cliente: ${result.reason?.message}`)
      }
    }
  }

  console.log(`[ASAAS Sync] Stuck client sync completed: ${results.stuckFixed || 0} fixed, ${results.incompleteAgreements?.length || 0} incomplete`)

  // Also check AlteaPay agreements that have asaas_customer_id but no asaas_payment_id
  const { data: incompleteAgreements } = await supabase
    .from("agreements")
    .select("id, customer_id, asaas_customer_id, status, customers(name, document)")
    .eq("company_id", companyId)
    .eq("status", "draft")
    .not("asaas_customer_id", "is", null)
    .is("asaas_payment_id", null)
    .limit(50)

  if (incompleteAgreements && incompleteAgreements.length > 0) {
    console.log(`[ASAAS Sync] Found ${incompleteAgreements.length} AlteaPay agreements with ASAAS customer but no payment`)

    for (const agreement of incompleteAgreements) {
      const customer = agreement.customers as any
      // Check if there are now payments in ASAAS for this customer
      const payments = await fetchAsaasPaymentsForCustomer(agreement.asaas_customer_id)

      if (payments.length > 0) {
        // Payment now exists - update the agreement
        const latestPayment = payments[0]
        await supabase
          .from("agreements")
          .update({
            asaas_payment_id: latestPayment.id,
            asaas_payment_url: latestPayment.invoiceUrl || null,
            status: "active",
            payment_status: latestPayment.status?.toLowerCase() || "pending",
          })
          .eq("id", agreement.id)

        results.stuckFixed = (results.stuckFixed || 0) + 1
        if (!results.stuckDetails) results.stuckDetails = []
        results.stuckDetails.push({
          name: customer?.name || "Desconhecido",
          cpfCnpj: customer?.document || "",
          action: "Acordo atualizado - cobrança encontrada no ASAAS",
          asaasPaymentId: latestPayment.id,
        })
      } else {
        // Still no payment
        if (!results.incompleteAgreements) results.incompleteAgreements = []
        const alreadyReported = results.incompleteAgreements.some((r: any) => r.agreementId === agreement.id)
        if (!alreadyReported) {
          results.incompleteAgreements.push({
            agreementId: agreement.id,
            customerName: customer?.name || "Desconhecido",
            cpfCnpj: customer?.document || "",
            asaasCustomerId: agreement.asaas_customer_id,
            issue: "Cliente criado no ASAAS mas cobrança não foi criada",
          })
        }
      }
    }
  }
}

// Sync viewing info for all agreements with ASAAS payment IDs
async function syncViewingInfo(
  companyId: string,
  startTime: number
): Promise<{
  checked: number
  viewed: number
  notViewed: number
  errors: number
}> {
  const results = {
    checked: 0,
    viewed: 0,
    notViewed: 0,
    errors: 0,
  }

  // Max time for viewing sync (leave buffer for main sync)
  const MAX_VIEWING_SYNC_MS = 15000
  const elapsed = Date.now() - startTime
  if (elapsed > MAX_VIEWING_SYNC_MS) {
    console.log(`[ASAAS Sync] Skipping viewing sync - already at ${elapsed}ms`)
    return results
  }

  console.log(`[ASAAS Sync] Starting viewing info sync for company ${companyId}...`)

  // Get all agreements with ASAAS payment IDs that are PENDING or OVERDUE
  const { data: agreements, error: queryError } = await supabase
    .from("agreements")
    .select("id, asaas_payment_id, notification_viewed, customers(name)")
    .eq("company_id", companyId)
    .not("asaas_payment_id", "is", null)
    .in("status", ["active", "draft", "pending"])
    .in("payment_status", ["pending", "overdue", "confirmed"])

  if (queryError || !agreements) {
    console.error("[ASAAS Sync] Error fetching agreements for viewing sync:", queryError)
    return results
  }

  console.log(`[ASAAS Sync] Found ${agreements.length} agreements to check viewing info`)

  const baseUrl = await getBaseUrl()
  const totalAgreements = agreements.length

  // Process each agreement with rate limiting
  for (let i = 0; i < agreements.length; i++) {
    // Check timeout
    if (Date.now() - startTime > MAX_VIEWING_SYNC_MS + 10000) {
      console.log(`[ASAAS Sync] Stopping viewing sync at ${i + 1}/${totalAgreements} due to timeout`)
      break
    }

    const agreement = agreements[i]
    const customerName = (agreement.customers as any)?.name || "Unknown"

    try {
      // Log progress
      console.log(`[ASAAS Sync] Fetching viewing info ${i + 1}/${totalAgreements}: ${customerName}`)

      // Fetch viewing info from ASAAS
      const response = await fetch(`${baseUrl}/api/asaas`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: `/payments/${agreement.asaas_payment_id}/viewingInfo`,
          method: "GET",
        }),
      })

      results.checked++

      if (!response.ok) {
        // 404 means the endpoint doesn't exist or payment not found - not an error
        if (response.status === 404) {
          results.notViewed++
        } else {
          console.error(`[ASAAS Sync] Error fetching viewing info for ${agreement.asaas_payment_id}: ${response.status}`)
          results.errors++
        }
        continue
      }

      const contentType = response.headers.get("content-type") || ""
      if (!contentType.includes("application/json")) {
        results.errors++
        continue
      }

      const viewingInfo = await response.json()

      // Check if viewed - ASAAS returns invoiceViewedDate and/or boletoViewedDate
      const invoiceViewedDate = viewingInfo.invoiceViewedDate || null
      const boletoViewedDate = viewingInfo.boletoViewedDate || null
      const isViewed = !!(invoiceViewedDate || boletoViewedDate)
      const viewDate = invoiceViewedDate || boletoViewedDate || null
      const viewChannel = invoiceViewedDate ? "invoice" : boletoViewedDate ? "boleto" : "payment_link"

      if (isViewed) {
        // Update the agreement if not already marked as viewed
        if (!agreement.notification_viewed) {
          const { error: updateError } = await supabase
            .from("agreements")
            .update({
              notification_viewed: true,
              notification_viewed_at: viewDate || new Date().toISOString(),
              notification_viewed_channel: viewChannel,
            })
            .eq("id", agreement.id)

          if (updateError) {
            console.error(`[ASAAS Sync] Failed to update viewing status for ${agreement.id}:`, updateError)
            results.errors++
          } else {
            results.viewed++
          }
        } else {
          results.viewed++
        }
      } else {
        results.notViewed++
      }

      // Rate limiting: 250ms delay between requests
      if (i < agreements.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 250))
      }
    } catch (error: any) {
      console.error(`[ASAAS Sync] Error processing viewing info for ${agreement.id}:`, error.message)
      results.errors++
    }
  }

  console.log(`[ASAAS Sync] Viewing info sync completed: ${results.viewed} viewed, ${results.notViewed} not viewed, ${results.errors} errors`)

  return results
}

export async function POST(request: NextRequest) {
  const startTime = Date.now()
  let currentStep = "initialization"

  const results: {
    total: number
    synced: number
    updated: number
    skipped: number
    errors: string[]
    stuckFixed?: number
    stuckDetails?: Array<{ name: string; cpfCnpj: string; action: string; asaasPaymentId?: string }>
    incompleteAgreements?: Array<{ agreementId: string; customerName: string; cpfCnpj: string; asaasCustomerId: string; issue: string }>
  } = {
    total: 0,
    synced: 0,
    updated: 0,
    skipped: 0,
    errors: [],
  }

  try {
    // Check ASAAS configuration
    currentStep = "config_check"
    if (!process.env.ASAAS_API_KEY) {
      return NextResponse.json(
        {
          success: false,
          error: "Chave da API do ASAAS não configurada",
          details: {
            message: "A variável de ambiente ASAAS_API_KEY não está definida",
            step: "config_check",
          },
        },
        { status: 500 }
      )
    }

    // Optional: Check for cron secret or admin auth
    const cronSecret = process.env.CRON_SECRET
    const authHeader = request.headers.get("authorization")
    const isCron = authHeader === `Bearer ${cronSecret}`

    // Parse optional filters from request body
    currentStep = "parse_request"
    let filters: {
      companyId?: string
      agreementId?: string
      createChargesForCustomerOnly?: boolean
      fullSync?: boolean  // NEW: Comprehensive sync from ASAAS → local
    } = {}
    try {
      const body = await request.json()
      filters = body
    } catch {
      // No body or invalid JSON - that's fine
    }

    console.log("[ASAAS Sync] Starting payment sync...", filters)

    // NEW: Handle fullSync mode - comprehensive ASAAS → local sync
    if (filters.fullSync && filters.companyId) {
      console.log("[ASAAS Sync] FULL SYNC MODE - fetching all ASAAS customers...")
      currentStep = "full_sync"

      const fullSyncResults = await syncFromAsaas(
        filters.companyId,
        filters.createChargesForCustomerOnly || false,
        startTime
      )

      // Also sync viewing info for all existing agreements
      const viewingResults = await syncViewingInfo(filters.companyId, startTime)

      const duration = Date.now() - startTime
      console.log(`[ASAAS Sync] Full sync completed in ${duration}ms`)

      return NextResponse.json({
        success: true,
        message: "Sincronização completa finalizada",
        fullSync: true,
        duration,
        results: {
          asaasCustomerCount: fullSyncResults.asaasCustomerCount,
          matched: fullSyncResults.matched,
          unmatched: fullSyncResults.unmatched,
          synced: fullSyncResults.synced,
          chargesCreated: fullSyncResults.chargesCreated,
          errors: fullSyncResults.errors,
          unmatchedCustomers: fullSyncResults.unmatchedCustomers,
          syncedDetails: fullSyncResults.syncedDetails,
          viewingInfo: viewingResults,
        },
      })
    }

    currentStep = "fetch_agreements"

    // Build query for pending/active agreements
    let query = supabase
      .from("agreements")
      .select("id, asaas_payment_id, payment_status, status, asaas_last_synced_at, company_id, debt_id, user_id, agreed_amount")
      .not("asaas_payment_id", "is", null) // Must have ASAAS payment ID
      .in("payment_status", SYNC_STATUSES)
      .order("asaas_last_synced_at", { ascending: true, nullsFirst: true })
      .limit(MAX_PAYMENTS_PER_SYNC)

    // Apply optional filters
    if (filters.companyId) {
      query = query.eq("company_id", filters.companyId)
    }
    if (filters.agreementId) {
      query = query.eq("id", filters.agreementId)
    }

    const { data: agreements, error: fetchError } = await query

    if (fetchError) {
      console.error("[ASAAS Sync] Error fetching agreements:", fetchError)
      return NextResponse.json({ error: fetchError.message }, { status: 500 })
    }

    if (!agreements || agreements.length === 0) {
      console.log("[ASAAS Sync] No pending agreements to sync")
      return NextResponse.json({
        success: true,
        message: "No pending agreements to sync",
        results,
      })
    }

    results.total = agreements.length
    console.log(`[ASAAS Sync] Found ${agreements.length} agreements to check`)

    // Process each agreement
    for (const agreement of agreements) {
      try {
        // Skip if recently synced (unless explicitly requested by agreementId)
        if (!filters.agreementId && agreement.asaas_last_synced_at) {
          const lastSynced = new Date(agreement.asaas_last_synced_at).getTime()
          const timeSinceSync = Date.now() - lastSynced
          if (timeSinceSync < MIN_SYNC_INTERVAL_MS) {
            results.skipped++
            continue
          }
        }

        // Fetch current status from ASAAS
        const asaasResult = await fetchAsaasPaymentStatus(agreement.asaas_payment_id)
        results.synced++

        // Handle deleted payments (404 from ASAAS)
        if (asaasResult.status === "deleted") {
          console.log(`[ASAAS Sync] Payment ${agreement.asaas_payment_id} was DELETED from ASAAS`)

          // Mark agreement as cancelled
          const { error: cancelError } = await supabase
            .from("agreements")
            .update({
              status: "cancelled",
              payment_status: "cancelled",
              asaas_status: "DELETED",
              asaas_last_synced_at: new Date().toISOString(),
            })
            .eq("id", agreement.id)

          if (cancelError) {
            console.error(`[ASAAS Sync] Failed to cancel agreement ${agreement.id}:`, cancelError)
            results.errors.push(`${agreement.id}: ${cancelError.message}`)
          } else {
            console.log(`[ASAAS Sync] Agreement ${agreement.id} marked as cancelled (ASAAS deleted)`)
            results.updated++
          }

          // Update debt to pending (reopens the debt)
          if (agreement.debt_id) {
            await supabase
              .from("debts")
              .update({ status: "pending" })
              .eq("id", agreement.debt_id)

            // Clear VMAX negotiation_status
            const { data: debt } = await supabase
              .from("debts")
              .select("external_id")
              .eq("id", agreement.debt_id)
              .single()

            if (debt?.external_id) {
              const { error: vmaxError } = await supabase
                .from("VMAX")
                .update({ negotiation_status: null })
                .eq("id", debt.external_id)

              if (vmaxError) {
                console.error(`[ASAAS Sync] Failed to clear VMAX ${debt.external_id}:`, vmaxError)
              } else {
                console.log(`[ASAAS Sync] VMAX ${debt.external_id} negotiation_status cleared`)
              }
            }
          }

          continue // Move to next agreement
        }

        // Handle error fetching payment
        if (asaasResult.status === "error") {
          console.error(`[ASAAS Sync] Error fetching payment ${agreement.asaas_payment_id}:`, asaasResult.error)
          results.errors.push(`${agreement.id}: ${asaasResult.error}`)
          continue
        }

        const asaasPayment = asaasResult.data

        // Map ASAAS status to our payment_status
        const statusMap: Record<string, string> = {
          PENDING: "pending",
          AWAITING_RISK_ANALYSIS: "pending",
          CONFIRMED: "confirmed",
          RECEIVED: "received",
          OVERDUE: "overdue",
          REFUNDED: "refunded",
          REFUND_REQUESTED: "refund_requested",
          CHARGEBACK_REQUESTED: "chargeback_requested",
          CHARGEBACK_DISPUTE: "chargeback_dispute",
          DUNNING_RECEIVED: "received",
          DUNNING_REQUESTED: "overdue",
        }

        const newPaymentStatus = statusMap[asaasPayment.status] || agreement.payment_status

        // Check if status changed
        if (newPaymentStatus !== agreement.payment_status) {
          console.log(`[ASAAS Sync] Status changed for ${agreement.id}: ${agreement.payment_status} -> ${newPaymentStatus}`)

          // Build update object
          const agreementUpdate: Record<string, any> = {
            payment_status: newPaymentStatus,
            asaas_status: asaasPayment.status,
            asaas_last_synced_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }

          // Add ASAAS details
          if (asaasPayment.billingType) agreementUpdate.asaas_billing_type = asaasPayment.billingType
          if (asaasPayment.netValue) agreementUpdate.asaas_net_value = asaasPayment.netValue
          if (asaasPayment.invoiceUrl) agreementUpdate.asaas_invoice_url = asaasPayment.invoiceUrl
          if (asaasPayment.paymentDate) agreementUpdate.asaas_payment_date = asaasPayment.paymentDate

          // Handle payment received or confirmed (both are "paid" states)
          if (newPaymentStatus === "received" || newPaymentStatus === "confirmed") {
            agreementUpdate.status = "completed"  // Use "completed" - it's in the DB constraint
            agreementUpdate.payment_received_at = new Date().toISOString()

            console.log(`[ASAAS Sync] Payment ${newPaymentStatus.toUpperCase()} for agreement ${agreement.id}, updating debt and VMAX...`)

            // Update debt to paid
            if (agreement.debt_id) {
              const { data: debtResult, error: debtError } = await supabase
                .from("debts")
                .update({ status: "paid", updated_at: new Date().toISOString() })
                .eq("id", agreement.debt_id)
                .select()

              if (debtError) {
                console.error(`[ASAAS Sync] Failed to update debt ${agreement.debt_id}:`, debtError)
              } else {
                console.log(`[ASAAS Sync] Debt ${agreement.debt_id} updated to paid:`, debtResult)
              }

              // Also update VMAX negotiation_status to reflect payment
              // Get the debt's external_id which links to VMAX
              const { data: debt } = await supabase
                .from("debts")
                .select("external_id")
                .eq("id", agreement.debt_id)
                .single()

              if (debt?.external_id) {
                const { error: vmaxError } = await supabase
                  .from("VMAX")
                  .update({ negotiation_status: "PAGO" })
                  .eq("id", debt.external_id)

                if (vmaxError) {
                  console.error(`[ASAAS Sync] Failed to update VMAX ${debt.external_id}:`, vmaxError)
                } else {
                  console.log(`[ASAAS Sync] VMAX ${debt.external_id} updated to PAGO`)
                }
              }
            }

            // Create notification
            if (agreement.user_id) {
              await supabase.from("notifications").insert({
                user_id: agreement.user_id,
                company_id: agreement.company_id,
                type: "payment",
                title: "Pagamento Confirmado",
                description: `Seu pagamento de R$ ${asaasPayment.value?.toFixed(2) || agreement.agreed_amount?.toFixed(2)} foi confirmado!`,
              })
            }
          }

          // Handle refund/delete - revert debt to open
          if (newPaymentStatus === "refunded" || asaasPayment.status === "DELETED") {
            agreementUpdate.status = "cancelled"
            if (agreement.debt_id) {
              const { error: debtError } = await supabase
                .from("debts")
                .update({ status: "pending", updated_at: new Date().toISOString() })
                .eq("id", agreement.debt_id)

              if (debtError) {
                console.error(`[ASAAS Sync] Failed to revert debt ${agreement.debt_id}:`, debtError)
              }

              // Update VMAX negotiation_status
              const { data: debt } = await supabase
                .from("debts")
                .select("external_id")
                .eq("id", agreement.debt_id)
                .single()

              if (debt?.external_id) {
                await supabase
                  .from("VMAX")
                  .update({ negotiation_status: "CANCELADA" })
                  .eq("id", debt.external_id)
              }
            }
          }

          // Update agreement
          console.log(`[ASAAS Sync] Updating agreement ${agreement.id}:`, agreementUpdate)
          const { data: updateResult, error: updateError } = await supabase
            .from("agreements")
            .update(agreementUpdate)
            .eq("id", agreement.id)
            .select()

          if (updateError) {
            console.error(`[ASAAS Sync] Failed to update agreement ${agreement.id}:`, updateError)
            results.errors.push(`${agreement.id}: ${updateError.message}`)
          } else {
            console.log(`[ASAAS Sync] Agreement ${agreement.id} updated successfully:`, updateResult)
            results.updated++
          }
        } else {
          // Status unchanged, just update sync timestamp
          await supabase
            .from("agreements")
            .update({ asaas_last_synced_at: new Date().toISOString() })
            .eq("id", agreement.id)
        }
      } catch (error: any) {
        console.error(`[ASAAS Sync] Error syncing agreement ${agreement.id}:`, error)
        results.errors.push(`${agreement.id}: ${error.message}`)
      }
    }

    // Also sync stuck clients if a company filter is provided
    if (filters.companyId) {
      await syncStuckClients(filters.companyId, results, startTime, filters.createChargesForCustomerOnly || false)
    }

    // Sync viewing info for all agreements with ASAAS payment IDs
    if (filters.companyId) {
      const viewingResults = await syncViewingInfo(filters.companyId, startTime)
      ;(results as any).viewingInfo = viewingResults
    }

    const duration = Date.now() - startTime
    console.log(`[ASAAS Sync] Completed in ${duration}ms:`, results)

    // Build message
    let message = `Sincronizado! ${results.updated} cobranca(s) atualizada(s)`
    if (results.stuckFixed && results.stuckFixed > 0) {
      message += `, ${results.stuckFixed} cliente(s) corrigido(s)`
    }
    if (results.incompleteAgreements && results.incompleteAgreements.length > 0) {
      message += `, ${results.incompleteAgreements.length} acordo(s) incompleto(s) detectado(s)`
    }
    if ((results as any).viewingInfo) {
      const vi = (results as any).viewingInfo
      message += `. Visualizações: ${vi.viewed} visualizada(s), ${vi.notViewed} não visualizada(s)`
    }
    if ((results as any).remainingCount && (results as any).remainingCount > 0) {
      message += `. Restam ${(results as any).remainingCount} cliente(s) para verificar.`
    }

    return NextResponse.json({
      success: true,
      message,
      results,
      duration,
    })
  } catch (error: any) {
    console.error("[ASAAS Sync] Fatal error:", error)

    // Extract detailed error information
    const errorDetails: {
      message: string
      step: string
      httpStatus?: number
      asaasResponse?: any
      stack?: string[]
    } = {
      message: error.message || "Erro interno do servidor",
      step: error.step || currentStep,
    }

    // Try to extract HTTP status and ASAAS response
    if (error.response) {
      errorDetails.httpStatus = error.response.status
      errorDetails.asaasResponse = error.response.data
    } else if (error.httpStatus) {
      errorDetails.httpStatus = error.httpStatus
      errorDetails.asaasResponse = error.asaasResponse
    }

    // Include stack trace (first 5 lines) for debugging
    if (error.stack) {
      errorDetails.stack = error.stack.split("\n").slice(0, 5)
    }

    // Map step to Portuguese for display
    const stepLabels: Record<string, string> = {
      initialization: "Inicialização",
      config_check: "Verificar configuração",
      parse_request: "Processar requisição",
      fetch_agreements: "Buscar acordos",
      fetch_asaas_customer: "Buscar cliente no ASAAS",
      fetch_asaas_payments: "Buscar cobranças no ASAAS",
      sync_stuck_clients: "Sincronizar clientes pendentes",
      update_agreement: "Atualizar acordo",
    }

    return NextResponse.json(
      {
        success: false,
        error: errorDetails.message,
        details: {
          ...errorDetails,
          stepLabel: stepLabels[errorDetails.step] || errorDetails.step,
        },
      },
      { status: 500 }
    )
  }
}

// GET endpoint for health check
export async function GET() {
  return NextResponse.json({
    status: "ok",
    message: "ASAAS payment sync endpoint is active",
  })
}
