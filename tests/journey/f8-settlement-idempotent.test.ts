// F8-01 (MÉDIO) — um 2º evento PAGO da mesma cobrança depois da quitação (cartão:
// PAYMENT_CONFIRMED e depois PAYMENT_RECEIVED, event ids diferentes) refazia a
// quitação: session.closed/receipt.issued duplicados, e-mail ao credor 2x,
// payment_status regredindo received → confirmed e payment_received_at reescrito.
// Agora o UPDATE condicional do webhook (status fora de PAID_AGREEMENT_STATUSES)
// é o portão: só quem quita executa os efeitos, e o status nunca regride.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

let db: FakeDb = {}
const events: string[] = []
const emails: unknown[] = []
const suppressions: unknown[] = []
const revoked: unknown[] = []

vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: (t: string) => makeFakeSupabase(db).from(t) }) }))
vi.mock("@/lib/supabase/url", () => ({ getServerSupabaseUrl: () => "http://fake" }))
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/asaas", () => ({ getAsaasInstallmentPayments: async () => null }))
vi.mock("@/lib/journey/events", () => ({ recordEvent: async (i: { type: string }) => { events.push(i.type); return { ok: true, duplicate: false } } }))
vi.mock("@/lib/journey/suppressions", () => ({ addSuppression: async (i: unknown) => { suppressions.push(i) } }))
vi.mock("@/lib/journey/tokens", () => ({ revokeTokens: async (i: unknown) => { revoked.push(i) } }))
vi.mock("@/lib/notifications/email", () => ({ sendEmail: async (i: unknown) => { emails.push(i); return { ok: true } } }))

const SESSION = "5e550000-0000-4000-8000-0000000000f8"
const OFFER = "0ffe0000-0000-4000-8000-0000000000f8"

function seed(installments = 1) {
  db = {
    asaas_webhook_events: [],
    agreements: [{
      id: "ag-f8", company_id: "co", customer_id: "cust", debt_id: "debt-1", user_id: null,
      asaas_payment_id: "pay_1", asaas_customer_id: "cus_1", asaas_subscription_id: installments > 1 ? "inst_f8" : null,
      installments, agreed_amount: 243.75, status: "active", payment_status: "pending", asaas_status: "PENDING",
      negotiation_session_id: SESSION, offer_id: OFFER, created_at: "2026-09-26T14:45:00Z",
    }],
    debts: [{ id: "debt-1", status: "in_agreement", external_id: "vmax-1" }],
    VMAX: [{ id: "vmax-1", negotiation_status: "EM_ANDAMENTO" }],
    notifications: [],
    negotiation_sessions: [{ id: SESSION, outcome: "in_progress" }],
    tenant_chat_config: [{ company_id: "co", creditor_notification_emails: ["credor@example.com"] }],
  }
}

let seq = 0
const webhook = (event: string, payment: Record<string, unknown>, id?: string) => {
  seq += 1
  const body = { id: id ?? `evtf8_${seq}`, event, payment }
  return { headers: { get: () => null }, json: async () => body } as any
}
const card = (status: string) => ({ id: "pay_1", customer: "cus_1", value: 243.75, billingType: "CREDIT_CARD", status })
const parcel = (n: number, status = "RECEIVED") => ({
  id: `pay_${n}`, customer: "cus_1", value: 81.25, installment: "inst_f8", installmentNumber: n,
  externalReference: `journey_${SESSION}_${OFFER}`, billingType: "CREDIT_CARD", status,
})
const ag = () => db.agreements[0]
const count = (t: string) => events.filter((e) => e === t).length
const settlementEffects = () => ({
  paid: count("payment.paid"), closed: count("session.closed"), receipt: count("receipt.issued"),
  creditor: count("creditor.notified"), emails: emails.length, suppressions: suppressions.length, revoked: revoked.length,
})

describe("F8-01 — quitação idempotente e status sem regressão", () => {
  beforeEach(() => {
    delete process.env.ASAAS_WEBHOOK_TOKEN
    process.env.CHAT_JOURNEY_ENABLED = "true"
    events.length = 0; emails.length = 0; suppressions.length = 0; revoked.length = 0
    seed()
  })

  it("cartão à vista CONFIRMED → RECEIVED: uma quitação, termina received, received_at intacto", async () => {
    const { POST } = await import("@/app/api/asaas/webhook/payments/route")
    expect((await POST(webhook("PAYMENT_CONFIRMED", card("CONFIRMED")))).status).toBe(200)
    expect(ag().status).toBe("completed")
    expect(ag().payment_status).toBe("confirmed")
    const receivedAt = ag().payment_received_at
    expect(receivedAt).toBeTruthy()
    expect(db.debts[0].status).toBe("paid")
    expect(db.VMAX[0].negotiation_status).toBe("PAGO")

    db.debts[0].status = "sentinel" // uma 2ª escrita de "paid" seria visível
    db.VMAX[0].negotiation_status = "sentinel"
    await new Promise((r) => setTimeout(r, 5))
    expect((await POST(webhook("PAYMENT_RECEIVED", card("RECEIVED")))).status).toBe(200)
    expect(ag().status).toBe("completed")
    expect(ag().payment_status).toBe("received")
    expect(ag().asaas_status).toBe("RECEIVED")
    expect(ag().payment_received_at).toBe(receivedAt)
    expect(db.debts[0].status).toBe("sentinel")
    expect(db.VMAX[0].negotiation_status).toBe("sentinel")
    expect(settlementEffects()).toEqual({ paid: 2, closed: 1, receipt: 1, creditor: 1, emails: 1, suppressions: 1, revoked: 1 })
    // payment.paid do 2º evento é gravado (dedup pelo event_id journey-paid-{pay}
    // na tabela), mas nada além dele.
  })

  it("RECEIVED → CONFIRMED tardio: sem regressão e sem 2ª quitação", async () => {
    const { POST } = await import("@/app/api/asaas/webhook/payments/route")
    await POST(webhook("PAYMENT_RECEIVED", card("RECEIVED")))
    const receivedAt = ag().payment_received_at
    await new Promise((r) => setTimeout(r, 5))
    await POST(webhook("PAYMENT_CONFIRMED", card("CONFIRMED")))
    expect(ag().status).toBe("completed")
    expect(ag().payment_status).toBe("received")
    expect(ag().asaas_status).toBe("RECEIVED")
    expect(ag().payment_received_at).toBe(receivedAt)
    expect(settlementEffects()).toMatchObject({ closed: 1, receipt: 1, creditor: 1, emails: 1, suppressions: 1, revoked: 1 })
  })

  it("CONFIRMED e RECEIVED concorrentes: exatamente uma quitação", async () => {
    const { POST } = await import("@/app/api/asaas/webhook/payments/route")
    await Promise.all([
      POST(webhook("PAYMENT_CONFIRMED", card("CONFIRMED"))),
      POST(webhook("PAYMENT_RECEIVED", card("RECEIVED"))),
    ])
    expect(ag().status).toBe("completed")
    expect(settlementEffects()).toMatchObject({ closed: 1, receipt: 1, emails: 1, suppressions: 1, revoked: 1 })
  })

  it("mesmo event id reenviado: ignorado pelo dedup de asaas_webhook_events", async () => {
    const { POST } = await import("@/app/api/asaas/webhook/payments/route")
    await POST(webhook("PAYMENT_RECEIVED", card("RECEIVED"), "evt_same"))
    const res = await POST(webhook("PAYMENT_RECEIVED", card("RECEIVED"), "evt_same"))
    expect(await res.json()).toMatchObject({ message: "Duplicate event - already processed" })
    expect(db.asaas_webhook_events).toHaveLength(1)
    expect(settlementEffects()).toEqual({ paid: 1, closed: 1, receipt: 1, creditor: 1, emails: 1, suppressions: 1, revoked: 1 })
  })

  it("parcelado 3x: parcelas 1 e 2 seguram; a 3 quita uma vez; CONFIRMED tardio da 3 e da 1 não requitam", async () => {
    seed(3)
    const { POST } = await import("@/app/api/asaas/webhook/payments/route")
    await POST(webhook("PAYMENT_RECEIVED", parcel(1)))
    await POST(webhook("PAYMENT_RECEIVED", parcel(2)))
    expect(ag().status).toBe("active")
    expect(ag().payment_status).toBe("pending")
    expect(ag().payment_received_at).toBeUndefined()
    expect(db.debts[0].status).toBe("in_agreement")
    expect(count("payment.installment_paid")).toBe(2)
    expect(settlementEffects()).toMatchObject({ paid: 0, closed: 0, receipt: 0 })

    await POST(webhook("PAYMENT_RECEIVED", parcel(3)))
    expect(ag().status).toBe("completed")
    expect(ag().payment_status).toBe("received")
    expect(db.debts[0].status).toBe("paid")
    const receivedAt = ag().payment_received_at
    expect(settlementEffects()).toEqual({ paid: 1, closed: 1, receipt: 1, creditor: 1, emails: 1, suppressions: 1, revoked: 1 })

    await new Promise((r) => setTimeout(r, 5))
    await POST(webhook("PAYMENT_CONFIRMED", parcel(3, "CONFIRMED")))
    await POST(webhook("PAYMENT_CONFIRMED", parcel(1, "CONFIRMED")))
    expect(ag().payment_status).toBe("received")
    expect(ag().asaas_status).toBe("RECEIVED")
    expect(ag().payment_received_at).toBe(receivedAt)
    expect(settlementEffects()).toMatchObject({ closed: 1, receipt: 1, creditor: 1, emails: 1, suppressions: 1, revoked: 1 })
  })

  it("estorno depois da quitação continua aplicando (cancelled/refunded, dívida reaberta)", async () => {
    const { POST } = await import("@/app/api/asaas/webhook/payments/route")
    await POST(webhook("PAYMENT_RECEIVED", card("RECEIVED")))
    await POST(webhook("PAYMENT_REFUNDED", card("REFUNDED")))
    expect(ag().status).toBe("cancelled")
    expect(ag().payment_status).toBe("refunded")
    expect(ag().asaas_status).toBe("REFUNDED")
    expect(db.debts[0].status).toBe("pending")
  })

  it("isPaymentStatusRegression: ordem RECEIVED > CONFIRMED > PENDING/OVERDUE; fora da escada nunca regride", async () => {
    const { isPaymentStatusRegression } = await import("@/lib/constants/payment-status")
    expect(isPaymentStatusRegression("received", "confirmed")).toBe(true)
    expect(isPaymentStatusRegression("RECEIVED_IN_CASH", "CONFIRMED")).toBe(true)
    expect(isPaymentStatusRegression("confirmed", "overdue")).toBe(true)
    expect(isPaymentStatusRegression("confirmed", "received")).toBe(false)
    expect(isPaymentStatusRegression("pending", "overdue")).toBe(false)
    expect(isPaymentStatusRegression("received", "refunded")).toBe(false)
    expect(isPaymentStatusRegression("received", "deleted")).toBe(false)
    expect(isPaymentStatusRegression(null, "pending")).toBe(false)
  })
})
