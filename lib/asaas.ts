/**
 * Asaas Payment Gateway
 *
 * Two modes of operation:
 * 1. Direct mode: When ASAAS_API_KEY is available (workers, API routes)
 *    Calls ASAAS API directly for better performance.
 *
 * 2. Proxy mode: When ASAAS_API_KEY is NOT available (Server Actions in v0 preview)
 *    Calls /api/asaas which forwards requests to ASAAS.
 *
 * Workers MUST use direct mode because there's no Next.js server to proxy through.
 */

import { isMockMode } from "./integrations/mock-mode"
import { mockAsaasRequest } from "./integrations/asaas-mock"

let headersModule: typeof import("next/headers") | null = null
try {
  // Dynamic import to avoid errors in worker context
  headersModule = require("next/headers")
} catch {
  // Not in Next.js context (e.g., worker)
}

// ====== Types ======

export interface AsaasCustomer {
  id: string
  name: string
  email?: string
  phone?: string
  mobilePhone?: string
  cpfCnpj: string
  postalCode?: string
  address?: string
  addressNumber?: string
  complement?: string
  province?: string
  notificationDisabled?: boolean
}

export interface AsaasPayment {
  id: string
  customer: string
  billingType: "BOLETO" | "CREDIT_CARD" | "PIX" | "UNDEFINED"
  value: number
  dueDate: string
  description?: string
  externalReference?: string
  installmentCount?: number
  installmentValue?: number
  /** id do parcelamento (presente em cada parcela de uma cobrança parcelada). */
  installment?: string | null
  invoiceUrl?: string
  bankSlipUrl?: string
  transactionReceiptUrl?: string
  pixQrCodeUrl?: string
  status: string
}

export interface CreatePaymentParams {
  customer: string
  billingType: "BOLETO" | "CREDIT_CARD" | "PIX" | "UNDEFINED"
  value: number
  dueDate: string
  description?: string
  externalReference?: string
  installmentCount?: number
  installmentValue?: number
  postalService?: boolean
}

// ====== Core: Direct or Proxy mode ======

const ASAAS_API_URL = process.env.ASAAS_API_URL || "https://api.asaas.com/v3"

function canUseDirectMode(): boolean {
  return !!process.env.ASAAS_API_KEY
}

async function getBaseUrl(): Promise<string> {
  try {
    if (headersModule) {
      const h = await headersModule.headers()
      const host = h.get("host")
      const proto = h.get("x-forwarded-proto") || "https"
      if (host) {
        return `${proto}://${host}`
      }
    }
  } catch {
    // headers() not available (e.g. called outside request context)
  }

  if (process.env.NEXT_PUBLIC_APP_URL) {
    return process.env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`
  }
  return "http://localhost:3000"
}

const MAX_RATE_LIMIT_RETRIES = 3
const DEFAULT_RATE_LIMIT_WAIT_MS = 30000 // 30 seconds default

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function asaasRequestDirect(endpoint: string, method = "GET", body?: unknown): Promise<any> {
  const apiKey = process.env.ASAAS_API_KEY!
  const url = `${ASAAS_API_URL}${endpoint}`

  let attempt = 0

  while (attempt < MAX_RATE_LIMIT_RETRIES) {
    attempt++
    console.log("[ASAAS-DIRECT]", method, endpoint, attempt > 1 ? `(attempt ${attempt})` : "")

    const res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        "access_token": apiKey,
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    })

    // Handle rate limiting (HTTP 429)
    if (res.status === 429) {
      // Get wait time from headers or use default
      const retryAfter = res.headers.get("Retry-After")
      const rateLimitReset = res.headers.get("RateLimit-Reset")

      let waitMs = DEFAULT_RATE_LIMIT_WAIT_MS
      if (retryAfter) {
        waitMs = parseInt(retryAfter, 10) * 1000
      } else if (rateLimitReset) {
        waitMs = parseInt(rateLimitReset, 10) * 1000
      }

      // Add small buffer
      waitMs += 2000

      console.warn(`[ASAAS-DIRECT] Rate limited (429). Waiting ${waitMs}ms before retry ${attempt}/${MAX_RATE_LIMIT_RETRIES}`)

      if (attempt < MAX_RATE_LIMIT_RETRIES) {
        await sleep(waitMs)
        continue
      } else {
        const error: any = new Error(`ASAAS rate limit exceeded after ${MAX_RATE_LIMIT_RETRIES} retries`)
        error.response = { status: 429, data: { errors: [{ description: "Rate limit exceeded" }] } }
        error.rateLimited = true
        throw error
      }
    }

    const contentType = res.headers.get("content-type") || ""
    if (!contentType.includes("application/json")) {
      const text = await res.text()
      console.error("[ASAAS-DIRECT] Non-JSON response:", res.status, text.substring(0, 300))
      throw new Error(`Erro ASAAS (status ${res.status})`)
    }

    const json = await res.json()

    if (!res.ok) {
      const msg = json.errors?.[0]?.description || json.error || `Erro Asaas (${res.status})`
      console.error("[ASAAS-DIRECT] Error:", res.status, JSON.stringify(json))
      const error: any = new Error(msg)
      error.response = { status: res.status, data: json }
      throw error
    }

    // Log rate limit headers for monitoring (optional)
    const rateLimitRemaining = res.headers.get("RateLimit-Remaining")
    if (rateLimitRemaining && parseInt(rateLimitRemaining, 10) < 100) {
      console.warn(`[ASAAS-DIRECT] Rate limit low: ${rateLimitRemaining} requests remaining`)
    }

    return json
  }

  // Should never reach here, but just in case
  throw new Error("ASAAS request failed: max retries exceeded")
}

async function asaasRequestProxy(endpoint: string, method = "GET", body?: unknown): Promise<any> {
  const baseUrl = await getBaseUrl()
  const url = `${baseUrl}/api/asaas`

  console.log("[ASAAS-PROXY]", method, endpoint, "baseUrl:", baseUrl)

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      endpoint,
      method,
      data: body,
    }),
    cache: "no-store",
  })

  const contentType = res.headers.get("content-type") || ""
  if (!contentType.includes("application/json")) {
    const text = await res.text()
    console.error("[ASAAS-PROXY] Non-JSON response:", res.status, text.substring(0, 300))
    throw new Error(`Erro interno do servidor ao acessar Asaas (status ${res.status}). Verifique se o projeto foi deployado corretamente.`)
  }

  const json = await res.json()

  if (!res.ok) {
    const msg = json.error || json.errors?.[0]?.description || `Erro Asaas (${res.status})`
    console.error("[ASAAS-PROXY] Error:", res.status, JSON.stringify(json))
    throw new Error(msg)
  }

  return json
}

async function asaasRequest(endpoint: string, method = "GET", body?: unknown): Promise<any> {
  if (isMockMode("asaas")) {
    return mockAsaasRequest(endpoint, method, body)
  }
  if (canUseDirectMode()) {
    return asaasRequestDirect(endpoint, method, body)
  }
  return asaasRequestProxy(endpoint, method, body)
}

// ====== Customer Functions ======

export async function createAsaasCustomer(params: {
  name: string
  cpfCnpj: string
  email?: string
  phone?: string
  mobilePhone?: string
  postalCode?: string
  address?: string
  addressNumber?: string
  province?: string
  notificationDisabled?: boolean
  externalReference?: string
}): Promise<AsaasCustomer> {
  // POLÍTICA DE COMUNICAÇÃO: o ASAAS NÃO envia NENHUMA comunicação ao devedor
  // (e-mail/SMS/WhatsApp). Toda comunicação é feita pela AlteaPay (SendGrid +
  // WhatsApp/Voxuy). `notificationDisabled: true` na criação do cliente é a
  // chave-mestra que suprime todas as notificações do ASAAS — forçado aqui,
  // ignorando o valor do caller, para não haver janela de corrida nem canal solto.
  const cleanParams = Object.fromEntries(
    Object.entries({ ...params, notificationDisabled: true }).filter(([_, v]) => v !== undefined && v !== "")
  )
  return asaasRequest("/customers", "POST", cleanParams)
}

export async function getAsaasCustomerByCpfCnpj(
  cpfCnpj: string
): Promise<AsaasCustomer | null> {
  const data: any = await asaasRequest(`/customers?cpfCnpj=${cpfCnpj}`)
  return data.data?.[0] || null
}

export async function updateAsaasCustomer(
  customerId: string,
  params: {
    name?: string
    email?: string
    phone?: string
    mobilePhone?: string
    postalCode?: string
    address?: string
    addressNumber?: string
    province?: string
    notificationDisabled?: boolean
    externalReference?: string
  }
): Promise<AsaasCustomer> {
  // Mesma política do create: o ASAAS não comunica o devedor. Forçamos
  // notificationDisabled=true também no update, para reforçar a supressão em
  // clientes que já existiam no ASAAS (criados antes desta política) sempre que
  // passam por uma atualização no fluxo de cobrança.
  const cleanParams = Object.fromEntries(
    Object.entries({ ...params, notificationDisabled: true }).filter(([_, v]) => v !== undefined && v !== "")
  )
  return asaasRequest(`/customers/${customerId}`, "PUT", cleanParams)
}

// ====== Payment Functions ======

export async function createAsaasPayment(
  params: CreatePaymentParams
): Promise<AsaasPayment> {
  return asaasRequest("/payments", "POST", params)
}

export async function getAsaasPayment(paymentId: string): Promise<AsaasPayment> {
  return asaasRequest(`/payments/${paymentId}`)
}

export async function getAsaasPaymentByExternalReference(
  externalReference: string
): Promise<AsaasPayment | null> {
  const data: any = await asaasRequest(
    `/payments?externalReference=${externalReference}`
  )
  return data.data?.[0] || null
}

// ====== Notification Functions ======

export async function getAsaasCustomerNotifications(
  customerId: string
): Promise<any[]> {
  const data: any = await asaasRequest(`/customers/${customerId}/notifications`)
  return data.data || []
}

export async function updateAsaasNotification(
  notificationId: string,
  params: {
    enabled?: boolean
    emailEnabledForCustomer?: boolean
    smsEnabledForCustomer?: boolean
    whatsappEnabledForCustomer?: boolean
  }
): Promise<any> {
  return asaasRequest(`/notifications/${notificationId}`, "PUT", params)
}

export async function sendAsaasNotification(
  customerId: string,
  channel: "email" | "sms" | "whatsapp"
): Promise<void> {
  const notifications = await getAsaasCustomerNotifications(customerId)

  const paymentCreatedNotification = notifications.find(
    (n: any) => n.event === "PAYMENT_CREATED"
  )

  if (paymentCreatedNotification) {
    await updateAsaasNotification(paymentCreatedNotification.id, {
      enabled: true,
      emailEnabledForCustomer: channel === "email",
      smsEnabledForCustomer: channel === "sms",
      whatsappEnabledForCustomer: channel === "whatsapp",
    })
  }
}

export async function resendAsaasPaymentNotification(
  paymentId: string
): Promise<any> {
  return asaasRequest(`/payments/${paymentId}/resendNotification`, "POST", {})
}

// ====== Payment Viewing Info ======

export interface PaymentViewingInfo {
  viewed: boolean
  viewDate: string | null
  channel: "invoice" | "boleto" | null
}

/**
 * Get viewing information for a payment.
 * Returns whether the customer has viewed/opened the charge.
 * ASAAS returns invoiceViewedDate and/or boletoViewedDate.
 */
export async function getAsaasPaymentViewingInfo(
  paymentId: string
): Promise<PaymentViewingInfo> {
  try {
    const data = await asaasRequest(`/payments/${paymentId}/viewingInfo`, "GET")
    const invoiceViewedDate = data.invoiceViewedDate || null
    const boletoViewedDate = data.boletoViewedDate || null
    const viewed = !!(invoiceViewedDate || boletoViewedDate)

    return {
      viewed,
      viewDate: invoiceViewedDate || boletoViewedDate || null,
      channel: invoiceViewedDate ? "invoice" : boletoViewedDate ? "boleto" : null,
    }
  } catch (error: any) {
    // If 404 or error, return not viewed
    console.error(`[ASAAS] Error fetching viewing info for ${paymentId}:`, error.message)
    return { viewed: false, viewDate: null, channel: null }
  }
}

/**
 * Get payments for a customer from ASAAS.
 */
export async function getAsaasPaymentsForCustomer(
  customerId: string
): Promise<AsaasPayment[]> {
  try {
    const data = await asaasRequest(`/payments?customer=${customerId}`, "GET")
    return data.data || []
  } catch (error: any) {
    console.error(`[ASAAS] Error fetching payments for customer ${customerId}:`, error.message)
    return []
  }
}

// ====== Notification Batch Update ======

export interface NotificationConfig {
  id: string
  enabled: boolean
  emailEnabledForProvider: boolean
  smsEnabledForProvider: boolean
  emailEnabledForCustomer: boolean
  smsEnabledForCustomer: boolean
  phoneCallEnabledForCustomer: boolean
  whatsappEnabledForCustomer: boolean
}

export async function updateAsaasNotificationsBatch(
  customerId: string,
  notifications: NotificationConfig[]
): Promise<any> {
  return asaasRequest("/notifications/batch", "PUT", {
    customer: customerId,
    notifications,
  })
}

/**
 * Optimized notification configuration to save costs.
 * - Disables email for PAYMENT_CREATED (we send via Resend)
 * - Disables PAYMENT_UPDATED, PAYMENT_DUEDATE_WARNING (10 days), SEND_LINHA_DIGITAVEL
 * - Keeps SMS/WhatsApp for important events
 */
export const OPTIMIZED_NOTIFICATION_CONFIG: Record<string, {
  enabled: boolean
  emailEnabledForProvider: boolean
  smsEnabledForProvider: boolean
  emailEnabledForCustomer: boolean
  smsEnabledForCustomer: boolean
  phoneCallEnabledForCustomer: boolean
  whatsappEnabledForCustomer: boolean
}> = {
  // PAYMENT_CREATED (scheduleOffset: 0) — We send our own email via Resend
  "PAYMENT_CREATED:0": {
    enabled: true,
    emailEnabledForProvider: false,
    smsEnabledForProvider: false,
    emailEnabledForCustomer: false, // We handle this via Resend
    smsEnabledForCustomer: false,
    phoneCallEnabledForCustomer: false,
    whatsappEnabledForCustomer: false,
  },
  // PAYMENT_UPDATED (scheduleOffset: 0) — Only if value/date changes
  "PAYMENT_UPDATED:0": {
    enabled: false, // Turn off entirely
    emailEnabledForProvider: false,
    smsEnabledForProvider: false,
    emailEnabledForCustomer: false,
    smsEnabledForCustomer: false,
    phoneCallEnabledForCustomer: false,
    whatsappEnabledForCustomer: false,
  },
  // PAYMENT_DUEDATE_WARNING (scheduleOffset: 10) — 10 days before due date
  "PAYMENT_DUEDATE_WARNING:10": {
    enabled: false, // Turn off (too early, spammy)
    emailEnabledForProvider: false,
    smsEnabledForProvider: false,
    emailEnabledForCustomer: false,
    smsEnabledForCustomer: false,
    phoneCallEnabledForCustomer: false,
    whatsappEnabledForCustomer: false,
  },
  // PAYMENT_DUEDATE_WARNING (scheduleOffset: 0) — Due date day
  "PAYMENT_DUEDATE_WARNING:0": {
    enabled: true, // Keep (important reminder)
    emailEnabledForProvider: false,
    smsEnabledForProvider: false,
    emailEnabledForCustomer: false,
    smsEnabledForCustomer: false,
    phoneCallEnabledForCustomer: false,
    whatsappEnabledForCustomer: false,
  },
  // SEND_LINHA_DIGITAVEL (scheduleOffset: 0) — Boleto digital line
  "SEND_LINHA_DIGITAVEL:0": {
    enabled: false, // Turn off (edge case, not worth the cost)
    emailEnabledForProvider: false,
    smsEnabledForProvider: false,
    emailEnabledForCustomer: false,
    smsEnabledForCustomer: false,
    phoneCallEnabledForCustomer: false,
    whatsappEnabledForCustomer: false,
  },
  // PAYMENT_OVERDUE (scheduleOffset: 0) — First overdue alert
  "PAYMENT_OVERDUE:0": {
    enabled: true, // Keep
    emailEnabledForProvider: true, // Provider needs to know
    smsEnabledForProvider: false,
    emailEnabledForCustomer: false,
    smsEnabledForCustomer: false,
    phoneCallEnabledForCustomer: false,
    whatsappEnabledForCustomer: false,
  },
  // PAYMENT_OVERDUE (scheduleOffset: 7) — Every 7 days overdue reminder
  "PAYMENT_OVERDUE:7": {
    enabled: true, // Keep (great for collections)
    emailEnabledForProvider: false,
    smsEnabledForProvider: false,
    emailEnabledForCustomer: false,
    smsEnabledForCustomer: false,
    phoneCallEnabledForCustomer: false,
    whatsappEnabledForCustomer: false,
  },
  // PAYMENT_RECEIVED (scheduleOffset: 0) — Payment confirmed
  "PAYMENT_RECEIVED:0": {
    enabled: true, // Keep
    emailEnabledForProvider: true,
    smsEnabledForProvider: false,
    emailEnabledForCustomer: false,
    smsEnabledForCustomer: false,
    phoneCallEnabledForCustomer: false,
    whatsappEnabledForCustomer: false,
  },
}

/**
 * Get customer details from ASAAS to check contact info availability.
 */
async function getAsaasCustomerDetails(
  customerId: string
): Promise<{ hasEmail: boolean; hasPhone: boolean }> {
  try {
    const data = await asaasRequest(`/customers/${customerId}`)
    return {
      hasEmail: !!data.email,
      hasPhone: !!(data.phone || data.mobilePhone),
    }
  } catch {
    // If we can't get details, assume they have both
    return { hasEmail: true, hasPhone: true }
  }
}

/**
 * Configure optimized notifications for a customer.
 * Fetches current notifications, maps by event+scheduleOffset, and applies optimized config.
 * Automatically disables channels the customer doesn't have (email/phone).
 */
export async function configureOptimizedNotifications(
  customerId: string
): Promise<{ success: boolean; updated: number; error?: string }> {
  try {
    // Get current notifications for this customer
    const notifications = await getAsaasCustomerNotifications(customerId)

    if (!notifications || notifications.length === 0) {
      return { success: true, updated: 0 }
    }

    // Check what contact info the customer has
    const { hasEmail, hasPhone } = await getAsaasCustomerDetails(customerId)

    // Build the batch update payload
    const notificationsToUpdate: NotificationConfig[] = []

    for (const notification of notifications) {
      const key = `${notification.event}:${notification.scheduleOffset ?? 0}`
      const config = OPTIMIZED_NOTIFICATION_CONFIG[key]

      if (config) {
        // Clone the config and disable channels the customer doesn't have
        const adjustedConfig = { ...config }

        if (!hasEmail) {
          adjustedConfig.emailEnabledForCustomer = false
          adjustedConfig.emailEnabledForProvider = false
        }

        if (!hasPhone) {
          adjustedConfig.smsEnabledForCustomer = false
          adjustedConfig.smsEnabledForProvider = false
          adjustedConfig.phoneCallEnabledForCustomer = false
          adjustedConfig.whatsappEnabledForCustomer = false
        }

        notificationsToUpdate.push({
          id: notification.id,
          ...adjustedConfig,
        })
      }
    }

    if (notificationsToUpdate.length === 0) {
      return { success: true, updated: 0 }
    }

    // Update notifications in batch
    await updateAsaasNotificationsBatch(customerId, notificationsToUpdate)

    return { success: true, updated: notificationsToUpdate.length }
  } catch (error: any) {
    return { success: false, updated: 0, error: error.message }
  }
}
