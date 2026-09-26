// Correção B10 (M1 + M4) — webhook de parcelas:
//  M1: a contagem das parcelas pagas NÃO depende de agreement_id (gravado só no
//      fim): conta pelo id do parcelamento no payload + payment_id distintos.
//      PAGOs em rajada das últimas parcelas quitam o acordo; eventos antigos com
//      agreement_id=null também contam.
//  M4: DELETED/REFUNDED de uma parcela com outra já paga não cancela o acordo
//      nem reabre a dívida; fica sinalizado para conciliação.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

let db: FakeDb = {}
let installmentList: Array<{ id: string; status: string }> | null = null
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: (t: string) => makeFakeSupabase(db).from(t) }) }))
vi.mock("@/lib/supabase/url", () => ({ getServerSupabaseUrl: () => "http://fake" }))
vi.mock("@/lib/asaas", () => ({ getAsaasInstallmentPayments: async () => installmentList }))

const SESSION = "5e550000-0000-4000-8000-0000000000b1"
const OFFER = "0ffe0000-0000-4000-8000-0000000000b1"

function seed() {
  db = {
    asaas_webhook_events: [],
    agreements: [{
      id: "ag-3x", company_id: "co", customer_id: "cust", debt_id: "debt-1", user_id: null,
      asaas_payment_id: "pay_1", asaas_customer_id: "cus_1", asaas_subscription_id: "inst_abc",
      installments: 3, agreed_amount: 243.75, status: "active", payment_status: "pending", asaas_status: "PENDING",
      negotiation_session_id: SESSION, offer_id: OFFER, created_at: "2026-09-26T14:45:00Z",
    }],
    debts: [{ id: "debt-1", status: "in_agreement", external_id: "vmax-1" }],
    VMAX: [{ id: "vmax-1", negotiation_status: "EM_ANDAMENTO" }],
    notifications: [],
  }
}
let seq = 0
const webhook = (event: string, payment: Record<string, unknown>) => {
  seq += 1
  const body = { id: `evtb_${seq}`, event, payment }
  return { headers: { get: () => null }, json: async () => body } as any
}
const parcel = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `pay_${n}`, customer: "cus_1", value: 81.25, installment: "inst_abc", installmentNumber: n,
  externalReference: `journey_${SESSION}_${OFFER}`, ...extra,
})
const ag = () => db.agreements[0]

describe("Correção B10 — contagem por parcelamento (M1) e cancelamento parcial (M4)", () => {
  beforeEach(() => {
    delete process.env.ASAAS_WEBHOOK_TOKEN
    delete process.env.CHAT_JOURNEY_ENABLED
    installmentList = null // ASAAS indisponível: só a contagem local decide
    seed()
  })

  it("M1: PAGOs das parcelas 2 e 3 em RAJADA (concorrentes) quitam o acordo", async () => {
    const { POST } = await import("@/app/api/asaas/webhook/payments/route")
    await POST(webhook("PAYMENT_RECEIVED", parcel(1)))
    expect(ag().status).toBe("active")
    const [r2, r3] = await Promise.all([
      POST(webhook("PAYMENT_CONFIRMED", parcel(2))),
      POST(webhook("PAYMENT_CONFIRMED", parcel(3))),
    ])
    expect(r2.status).toBe(200)
    expect(r3.status).toBe(200)
    expect(ag().status).toBe("completed")
    expect(db.debts[0].status).toBe("paid")
  })

  it("M1: eventos PAGOs antigos gravados sem agreement_id também contam", async () => {
    db.asaas_webhook_events.push(
      { id: "old1", event_id: "old1", event_type: "PAYMENT_RECEIVED", payment_id: "pay_1", customer_id: "cus_1", agreement_id: null, payload: { payment: parcel(1) }, created_at: "2026-09-26T15:00:00Z" },
      { id: "old2", event_id: "old2", event_type: "PAYMENT_RECEIVED", payment_id: "pay_2", customer_id: "cus_1", agreement_id: null, payload: { payment: parcel(2) }, created_at: "2026-09-26T15:01:00Z" },
    )
    const { POST } = await import("@/app/api/asaas/webhook/payments/route")
    await POST(webhook("PAYMENT_RECEIVED", parcel(3)))
    expect(ag().status).toBe("completed")
  })

  it("M1: PAGO de parcela de OUTRO parcelamento do mesmo cliente não conta", async () => {
    db.asaas_webhook_events.push(
      { id: "x1", event_id: "x1", event_type: "PAYMENT_RECEIVED", payment_id: "pay_x1", customer_id: "cus_1", agreement_id: null, payload: { payment: { id: "pay_x1", installment: "inst_other" } }, created_at: "2026-09-26T15:00:00Z" },
      { id: "x2", event_id: "x2", event_type: "PAYMENT_RECEIVED", payment_id: "pay_x2", customer_id: "cus_1", agreement_id: null, payload: { payment: { id: "pay_x2", installment: "inst_other" } }, created_at: "2026-09-26T15:00:00Z" },
    )
    const { POST } = await import("@/app/api/asaas/webhook/payments/route")
    await POST(webhook("PAYMENT_RECEIVED", parcel(3)))
    expect(ag().status).toBe("active")
  })

  it("M1: o ASAAS (parcelamento inteiro pago) também quita, mesmo sem eventos locais", async () => {
    installmentList = [{ id: "pay_1", status: "RECEIVED" }, { id: "pay_2", status: "RECEIVED" }, { id: "pay_3", status: "RECEIVED" }]
    const { POST } = await import("@/app/api/asaas/webhook/payments/route")
    await POST(webhook("PAYMENT_RECEIVED", parcel(3)))
    expect(ag().status).toBe("completed")
  })

  it("M4: DELETED da parcela 2 com a parcela 1 já paga → acordo mantido, dívida intacta, evento sinalizado", async () => {
    const { POST } = await import("@/app/api/asaas/webhook/payments/route")
    await POST(webhook("PAYMENT_RECEIVED", parcel(1)))
    const res = await POST(webhook("PAYMENT_DELETED", parcel(2, { deleted: true })))
    expect(res.status).toBe(200)
    expect(ag().status).toBe("active")
    expect(db.debts[0].status).toBe("in_agreement")
    const evt = db.asaas_webhook_events.find((e) => e.event_type === "PAYMENT_DELETED")!
    expect(evt.agreement_id).toBe("ag-3x")
    expect(evt.error_message).toMatch(/installment_partial_cancel/)
  })

  it("M4: DELETED sem nenhuma parcela paga continua cancelando (parcelamento inteiro cancelado)", async () => {
    const { POST } = await import("@/app/api/asaas/webhook/payments/route")
    await POST(webhook("PAYMENT_DELETED", parcel(2, { deleted: true })))
    expect(ag().status).toBe("cancelled")
    expect(db.debts[0].status).toBe("pending")
  })
})
