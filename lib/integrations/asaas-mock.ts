/**
 * In-process mock for the ASAAS API.
 *
 * Returns the same raw JSON shapes the real API returns, so it can be plugged
 * in at the lowest-level request functions (`asaasRequest` in lib/asaas.ts,
 * lib/queue/workers/asaas-api.ts and lib/queue/workers/charge.worker.ts)
 * without changing any caller.
 *
 * Ids are deterministic (hash of the input) and created entities are kept in
 * in-memory Maps so a payment created earlier can be fetched/updated/cancelled
 * coherently within the same process.
 */

import { mockHex } from "./mock-mode"

const customersById = new Map<string, Record<string, any>>()
const customersByCpfCnpj = new Map<string, Record<string, any>>()
const paymentsById = new Map<string, Record<string, any>>()

let paymentSeq = 0

function log(operation: string, summary: string): void {
  console.log(`[mock:asaas] ${operation}`, summary)
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function maskDoc(doc: string): string {
  return doc ? `***${doc.slice(-4)}` : "(empty)"
}

function buildCustomer(body: Record<string, any>): Record<string, any> {
  const cpfCnpj = String(body.cpfCnpj || "")
  return {
    object: "customer",
    id: `cus_mock_${mockHex(cpfCnpj || JSON.stringify(body))}`,
    dateCreated: today(),
    name: body.name || "Mock Customer",
    email: body.email ?? null,
    phone: body.phone ?? null,
    mobilePhone: body.mobilePhone ?? null,
    cpfCnpj,
    postalCode: body.postalCode ?? null,
    address: body.address ?? null,
    addressNumber: body.addressNumber ?? null,
    complement: body.complement ?? null,
    province: body.province ?? null,
    externalReference: body.externalReference ?? null,
    notificationDisabled: body.notificationDisabled ?? false,
    deleted: false,
  }
}

function storeCustomer(customer: Record<string, any>): void {
  customersById.set(customer.id, customer)
  if (customer.cpfCnpj) {
    customersByCpfCnpj.set(customer.cpfCnpj, customer)
  }
}

// Mirrors the default ASAAS notification set (event + scheduleOffset pairs)
// so configureOptimizedNotifications() and the charge workers find what they
// expect (e.g. PAYMENT_CREATED with scheduleOffset 0).
const NOTIFICATION_EVENTS: Array<{ event: string; scheduleOffset: number }> = [
  { event: "PAYMENT_CREATED", scheduleOffset: 0 },
  { event: "PAYMENT_UPDATED", scheduleOffset: 0 },
  { event: "PAYMENT_DUEDATE_WARNING", scheduleOffset: 10 },
  { event: "PAYMENT_DUEDATE_WARNING", scheduleOffset: 0 },
  { event: "SEND_LINHA_DIGITAVEL", scheduleOffset: 0 },
  { event: "PAYMENT_OVERDUE", scheduleOffset: 0 },
  { event: "PAYMENT_OVERDUE", scheduleOffset: 7 },
  { event: "PAYMENT_RECEIVED", scheduleOffset: 0 },
]

function buildNotifications(customerId: string): Record<string, any>[] {
  return NOTIFICATION_EVENTS.map(({ event, scheduleOffset }) => ({
    object: "notification",
    id: `not_mock_${mockHex(`${customerId}:${event}:${scheduleOffset}`)}`,
    customer: customerId,
    event,
    scheduleOffset,
    enabled: true,
    emailEnabledForProvider: false,
    smsEnabledForProvider: false,
    emailEnabledForCustomer: true,
    smsEnabledForCustomer: true,
    phoneCallEnabledForCustomer: false,
    whatsappEnabledForCustomer: true,
    deleted: false,
  }))
}

function buildPayment(id: string, body: Record<string, any>): Record<string, any> {
  const value = typeof body.value === "number" ? body.value : 0
  const billingType = body.billingType || "UNDEFINED"
  const dueDate = body.dueDate || today()

  const payment: Record<string, any> = {
    object: "payment",
    id,
    dateCreated: today(),
    customer: body.customer || `cus_mock_${mockHex(id)}`,
    paymentLink: null,
    value,
    netValue: Math.round(value * 99) / 100,
    originalValue: null,
    interestValue: null,
    description: body.description ?? null,
    billingType,
    status: "PENDING",
    dueDate,
    originalDueDate: dueDate,
    paymentDate: null,
    clientPaymentDate: null,
    confirmedDate: null,
    externalReference: body.externalReference ?? null,
    invoiceUrl: `https://mock.asaas.invalid/i/${id}`,
    bankSlipUrl: billingType === "PIX" ? null : `https://mock.asaas.invalid/b/pdf/${id}`,
    pixQrCodeUrl: billingType === "BOLETO" ? null : `https://mock.asaas.invalid/pix/${id}`,
    invoiceNumber: String(parseInt(mockHex(id, 8), 16) % 100000000).padStart(8, "0"),
    transactionReceiptUrl: null,
    nossoNumero: String(parseInt(mockHex(`nn:${id}`, 8), 16) % 100000000).padStart(8, "0"),
    deleted: false,
    anticipated: false,
    postalService: false,
  }

  if (typeof body.installmentCount === "number" && body.installmentCount > 1) {
    payment.installmentCount = body.installmentCount
    payment.installmentValue = body.installmentValue ?? Math.round((value / body.installmentCount) * 100) / 100
    payment.installment = `ins_mock_${mockHex(`ins:${id}`)}`
  }

  return payment
}

function getOrSynthesizePayment(id: string): Record<string, any> {
  let payment = paymentsById.get(id)
  if (!payment) {
    // Unknown id (e.g. a real payment id seeded from production data):
    // synthesize a coherent PENDING payment so sync/notify flows still work.
    payment = buildPayment(id, { value: 100 })
    paymentsById.set(id, payment)
  }
  return payment
}

function list(data: Record<string, any>[]): Record<string, any> {
  return { object: "list", hasMore: false, totalCount: data.length, data }
}

/**
 * Route a would-be ASAAS HTTP request to an in-memory mock implementation.
 * Returns the raw JSON body the real API would return.
 */
export function mockAsaasRequest(endpoint: string, method = "GET", body?: unknown): any {
  const [path, queryString] = endpoint.split("?")
  const query = new URLSearchParams(queryString || "")
  const payload = (body || {}) as Record<string, any>
  const m = method.toUpperCase()

  // ---- Customers ----

  if (path === "/customers" && m === "GET") {
    const cpfCnpj = query.get("cpfCnpj") || ""
    const found = customersByCpfCnpj.get(cpfCnpj)
    log("customer.search", `cpfCnpj=${maskDoc(cpfCnpj)} found=${!!found}`)
    return list(found ? [found] : [])
  }

  if (path === "/customers" && m === "POST") {
    const customer = buildCustomer(payload)
    storeCustomer(customer)
    log("customer.create", `id=${customer.id}`)
    return customer
  }

  const customerNotifications = path.match(/^\/customers\/([^/]+)\/notifications$/)
  if (customerNotifications && m === "GET") {
    const customerId = customerNotifications[1]
    log("customer.notifications.list", `customer=${customerId}`)
    return list(buildNotifications(customerId))
  }

  const customerMatch = path.match(/^\/customers\/([^/]+)$/)
  if (customerMatch && m === "GET") {
    const id = customerMatch[1]
    const customer = customersById.get(id) || buildCustomer({ cpfCnpj: "", externalReference: id })
    log("customer.get", `id=${id}`)
    return { ...customer, id }
  }
  if (customerMatch && m === "PUT") {
    const id = customerMatch[1]
    const existing = customersById.get(id) || buildCustomer({ cpfCnpj: "" })
    const updated = { ...existing, ...payload, id }
    storeCustomer(updated)
    log("customer.update", `id=${id}`)
    return updated
  }

  // ---- Payments ----

  if (path === "/payments" && m === "POST") {
    const id = `pay_mock_${mockHex(`${paymentSeq++}:${JSON.stringify(payload)}`)}`
    const payment = buildPayment(id, payload)
    paymentsById.set(id, payment)
    log(
      "payment.create",
      `id=${id} customer=${payment.customer} type=${payment.billingType} value=${payment.value} due=${payment.dueDate} status=${payment.status}`
    )
    return payment
  }

  if (path === "/payments" && m === "GET") {
    const externalReference = query.get("externalReference")
    const customer = query.get("customer")
    const data = Array.from(paymentsById.values()).filter((p) => {
      if (externalReference) return p.externalReference === externalReference
      if (customer) return p.customer === customer
      return true
    })
    log("payment.search", `filters=${externalReference ? "externalReference" : customer ? "customer" : "none"} found=${data.length}`)
    return list(data)
  }

  const viewingInfo = path.match(/^\/payments\/([^/]+)\/viewingInfo$/)
  if (viewingInfo && m === "GET") {
    log("payment.viewingInfo", `id=${viewingInfo[1]}`)
    return { invoiceViewedDate: null, boletoViewedDate: null }
  }

  const resendNotification = path.match(/^\/payments\/([^/]+)\/resendNotification$/)
  if (resendNotification && m === "POST") {
    log("payment.resendNotification", `id=${resendNotification[1]}`)
    return {}
  }

  const paymentMatch = path.match(/^\/payments\/([^/]+)$/)
  if (paymentMatch && m === "GET") {
    const payment = getOrSynthesizePayment(paymentMatch[1])
    log("payment.get", `id=${payment.id} status=${payment.status}`)
    return payment
  }
  if (paymentMatch && m === "PUT") {
    const existing = getOrSynthesizePayment(paymentMatch[1])
    const updated = { ...existing, ...payload, id: existing.id }
    paymentsById.set(updated.id, updated)
    log("payment.update", `id=${updated.id} fields=${Object.keys(payload).join(",")}`)
    return updated
  }
  if (paymentMatch && m === "DELETE") {
    const existing = getOrSynthesizePayment(paymentMatch[1])
    existing.deleted = true
    paymentsById.set(existing.id, existing)
    log("payment.cancel", `id=${existing.id}`)
    return { deleted: true, id: existing.id }
  }

  // ---- Notifications ----

  if (path === "/notifications/batch" && m === "PUT") {
    const count = Array.isArray(payload.notifications) ? payload.notifications.length : 0
    log("notification.batchUpdate", `customer=${payload.customer} count=${count}`)
    return list(Array.isArray(payload.notifications) ? payload.notifications : [])
  }

  const notificationMatch = path.match(/^\/notifications\/([^/]+)$/)
  if (notificationMatch && m === "PUT") {
    log("notification.update", `id=${notificationMatch[1]}`)
    return { object: "notification", id: notificationMatch[1], ...payload }
  }

  // ---- Fallback: unhandled endpoint, return an empty list (safe default) ----
  log("unhandled", `${m} ${path}`)
  return list([])
}
