// Notificação in-app ao devedor: era gravada uma vez POR EVENTO PAGO — o cartão
// (PAYMENT_CONFIRMED e depois PAYMENT_RECEIVED) gerava duas, e cada parcela paga
// de um parcelamento gerava uma. Agora o PAGO notifica UMA vez por acordo: só o
// evento que vence o portão da quitação (settledNow). Parcela que não quita e
// PAGO tardio não notificam. Atraso (OVERDUE) continua por evento.
// Também cobre a rota legada /api/webhooks/asaas, que agora delega à canônica.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

let db: FakeDb = {}

vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: (t: string) => makeFakeSupabase(db).from(t) }) }))
vi.mock("@/lib/supabase/url", () => ({ getServerSupabaseUrl: () => "http://fake" }))
vi.mock("@/lib/asaas", () => ({ getAsaasInstallmentPayments: async () => null }))

const SESSION = "5e550000-0000-4000-8000-0000000000b3"
const OFFER = "0ffe0000-0000-4000-8000-0000000000b3"

function seed(installments = 1) {
  db = {
    asaas_webhook_events: [],
    agreements: [{
      id: "ag-n", company_id: "co", customer_id: "cust", debt_id: "debt-1", user_id: "user-1",
      asaas_payment_id: "pay_1", asaas_customer_id: "cus_1", asaas_subscription_id: installments > 1 ? "inst_n" : null,
      installments, agreed_amount: 243.75, status: "active", payment_status: "pending", asaas_status: "PENDING",
      negotiation_session_id: SESSION, offer_id: OFFER, created_at: "2026-09-26T14:45:00Z",
    }],
    debts: [{ id: "debt-1", status: "in_negotiation", external_id: "vmax-1" }],
    VMAX: [{ id: "vmax-1", negotiation_status: "EM_ANDAMENTO" }],
    notifications: [],
  }
}

let seq = 0
const webhook = (event: string, payment: Record<string, unknown>, token?: string) => {
  seq += 1
  const body = { id: `evtn_${seq}`, event, payment }
  return { headers: { get: (h: string) => (h === "asaas-access-token" ? token ?? null : null) }, json: async () => body } as any
}
const card = (status: string) => ({ id: "pay_1", customer: "cus_1", value: 243.75, billingType: "CREDIT_CARD", status })
const parcel = (n: number, status = "RECEIVED") => ({
  id: `pay_${n}`, customer: "cus_1", value: 81.25, installment: "inst_n", installmentNumber: n,
  externalReference: `journey_${SESSION}_${OFFER}`, billingType: "CREDIT_CARD", status,
})
const notes = () => db.notifications
const ag = () => db.agreements[0]

describe("notificação in-app do PAGO: uma por acordo", () => {
  beforeEach(() => {
    delete process.env.ASAAS_WEBHOOK_TOKEN
    delete process.env.CHAT_JOURNEY_ENABLED
    seed()
  })

  it("cartão CONFIRMED → RECEIVED: exatamente uma notificação 'Pagamento Confirmado'", async () => {
    const { POST } = await import("@/app/api/asaas/webhook/payments/route")
    await POST(webhook("PAYMENT_CONFIRMED", card("CONFIRMED")))
    await POST(webhook("PAYMENT_RECEIVED", card("RECEIVED")))
    expect(notes()).toHaveLength(1)
    expect(notes()[0]).toMatchObject({
      user_id: "user-1", company_id: "co", type: "payment", title: "Pagamento Confirmado",
      description: "Seu pagamento de R$ 243.75 foi confirmado com sucesso!",
    })
  })

  it("CONFIRMED e RECEIVED concorrentes: uma notificação", async () => {
    const { POST } = await import("@/app/api/asaas/webhook/payments/route")
    await Promise.all([POST(webhook("PAYMENT_CONFIRMED", card("CONFIRMED"))), POST(webhook("PAYMENT_RECEIVED", card("RECEIVED")))])
    expect(notes()).toHaveLength(1)
  })

  it("parcelado 3x: parcelas 1 e 2 não notificam; a 3 (quita) notifica uma vez com o total; CONFIRMED tardio não repete", async () => {
    seed(3)
    const { POST } = await import("@/app/api/asaas/webhook/payments/route")
    await POST(webhook("PAYMENT_CONFIRMED", parcel(1, "CONFIRMED")))
    await POST(webhook("PAYMENT_RECEIVED", parcel(1)))
    await POST(webhook("PAYMENT_RECEIVED", parcel(2)))
    expect(notes()).toHaveLength(0)
    await POST(webhook("PAYMENT_RECEIVED", parcel(3)))
    expect(ag().status).toBe("completed")
    expect(notes()).toHaveLength(1)
    expect(notes()[0].description).toBe("Seu pagamento de R$ 243.75 foi confirmado com sucesso!")
    await POST(webhook("PAYMENT_CONFIRMED", parcel(3, "CONFIRMED")))
    expect(notes()).toHaveLength(1)
  })

  it("atraso continua notificando por evento", async () => {
    const { POST } = await import("@/app/api/asaas/webhook/payments/route")
    await POST(webhook("PAYMENT_OVERDUE", card("OVERDUE")))
    expect(notes()).toHaveLength(1)
    expect(notes()[0].title).toBe("Pagamento em Atraso")
  })

  it("sem user_id no acordo: nenhuma notificação", async () => {
    ag().user_id = null
    const { POST } = await import("@/app/api/asaas/webhook/payments/route")
    await POST(webhook("PAYMENT_RECEIVED", card("RECEIVED")))
    expect(notes()).toHaveLength(0)
  })
})

describe("rota legada /api/webhooks/asaas delega à canônica", () => {
  beforeEach(() => {
    delete process.env.ASAAS_WEBHOOK_TOKEN
    delete process.env.CHAT_JOURNEY_ENABLED
    seed()
  })

  it("mesmo portão de quitação: CONFIRMED → RECEIVED quita uma vez, sem regressão, uma notificação, eventos gravados", async () => {
    const { POST } = await import("@/app/api/webhooks/asaas/route")
    expect((await POST(webhook("PAYMENT_CONFIRMED", card("CONFIRMED")))).status).toBe(200)
    const receivedAt = ag().payment_received_at
    db.debts[0].status = "sentinel"
    await new Promise((r) => setTimeout(r, 5))
    expect((await POST(webhook("PAYMENT_RECEIVED", card("RECEIVED")))).status).toBe(200)
    expect(ag()).toMatchObject({ status: "completed", payment_status: "received", asaas_status: "RECEIVED" })
    expect(ag().payment_received_at).toBe(receivedAt)
    expect(db.debts[0].status).toBe("sentinel") // 2º PAGO não refaz a quitação
    expect(notes()).toHaveLength(1)
    expect(db.asaas_webhook_events).toHaveLength(2)
    expect(db.asaas_webhook_events.every((e) => e.processed === true && e.agreement_id === "ag-n")).toBe(true)
  })

  it("RECEIVED → CONFIRMED tardio pela legada: não regride", async () => {
    const { POST } = await import("@/app/api/webhooks/asaas/route")
    await POST(webhook("PAYMENT_RECEIVED", card("RECEIVED")))
    await POST(webhook("PAYMENT_CONFIRMED", card("CONFIRMED")))
    expect(ag()).toMatchObject({ status: "completed", payment_status: "received", asaas_status: "RECEIVED" })
  })

  it("mesmo token: sem asaas-access-token válido → 401", async () => {
    process.env.ASAAS_WEBHOOK_TOKEN = "tok"
    const { POST } = await import("@/app/api/webhooks/asaas/route")
    expect((await POST(webhook("PAYMENT_RECEIVED", card("RECEIVED")))).status).toBe(401)
    expect((await POST(webhook("PAYMENT_RECEIVED", card("RECEIVED"), "tok"))).status).toBe(200)
    expect(ag().status).toBe("completed")
  })
})
