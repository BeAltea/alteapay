// F8-01 (corrida residual): depois da quitação, dois PAGOs tardios simultâneos
// (cartão: CONFIRMED e RECEIVED; ou um CONFIRMED reenviado com outro event id)
// podiam gravar `confirmed` por cima de `received`: o caminho tardio relia o
// acordo e DEPOIS gravava (não atômico). Agora payment_status/asaas_status são
// gravados por UPDATE condicional cujo WHERE exclui os status de posto maior
// (mesma escada de isPaymentStatusRegression), com NULL tratado explicitamente.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

let db: FakeDb = {}
const events: string[] = []
// Injeta a escrita de um webhook CONCORRENTE entre a leitura e a escrita deste:
// dispara quando o caminho tardio chama update() com payment_status/asaas_status
// "confirmed" (antes de o UPDATE ser avaliado).
let concurrentWriter: (() => void) | null = null

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (t: string) => {
      const qb: any = makeFakeSupabase(db).from(t)
      if (t === "agreements") {
        const orig = qb.update.bind(qb)
        qb.update = (patch: Record<string, unknown>) => {
          const lateStatusWrite =
            !("status" in patch) &&
            (String(patch.payment_status ?? "").toLowerCase() === "confirmed" ||
              String(patch.asaas_status ?? "").toUpperCase() === "CONFIRMED")
          if (concurrentWriter && lateStatusWrite) {
            const w = concurrentWriter
            concurrentWriter = null
            w()
          }
          return orig(patch)
        }
      }
      return qb
    },
  }),
}))
vi.mock("@/lib/supabase/url", () => ({ getServerSupabaseUrl: () => "http://fake" }))
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/asaas", () => ({ getAsaasInstallmentPayments: async () => null }))
vi.mock("@/lib/journey/events", () => ({ recordEvent: async (i: { type: string }) => { events.push(i.type); return { ok: true, duplicate: false } } }))
vi.mock("@/lib/journey/suppressions", () => ({ addSuppression: async () => {} }))
vi.mock("@/lib/journey/tokens", () => ({ revokeTokens: async () => {} }))
vi.mock("@/lib/notifications/email", () => ({ sendEmail: async () => ({ ok: true }) }))

function seed(agreement: Record<string, unknown> = {}) {
  db = {
    asaas_webhook_events: [],
    agreements: [{
      id: "ag-race", company_id: "co", customer_id: "cust", debt_id: "debt-1", user_id: null,
      asaas_payment_id: "pay_1", asaas_customer_id: "cus_1", installments: 1, agreed_amount: 250,
      status: "active", payment_status: "pending", asaas_status: "PENDING", created_at: "2026-09-26T14:45:00Z",
      negotiation_session_id: "5e550000-0000-4000-8000-0000000000e1", offer_id: "0ffe0000-0000-4000-8000-0000000000e1",
      ...agreement,
    }],
    debts: [{ id: "debt-1", status: "in_negotiation", external_id: "vmax-1" }],
    VMAX: [{ id: "vmax-1", negotiation_status: "EM_ANDAMENTO" }],
    notifications: [],
    negotiation_sessions: [{ id: "5e550000-0000-4000-8000-0000000000e1", outcome: "in_progress" }],
    tenant_chat_config: [],
  }
}

let seq = 0
const webhook = (event: string, status: string) => {
  seq += 1
  const body = { id: `evt_race_${seq}`, event, payment: { id: "pay_1", customer: "cus_1", value: 250, billingType: "CREDIT_CARD", status } }
  return { headers: { get: () => null }, json: async () => body } as any
}
const ag = () => db.agreements[0]
const count = (t: string) => events.filter((e) => e === t).length

describe("F8-01 — PAGOs tardios concorrentes não regridem received → confirmed", () => {
  beforeEach(() => {
    delete process.env.ASAAS_WEBHOOK_TOKEN
    process.env.CHAT_JOURNEY_ENABLED = "true"
    events.length = 0
    concurrentWriter = null
    seed()
  })

  it("RECEIVED concorrente grava entre a leitura e a escrita do CONFIRMED tardio: fica received/RECEIVED", async () => {
    const { POST } = await import("@/app/api/asaas/webhook/payments/route")
    await POST(webhook("PAYMENT_CONFIRMED", "CONFIRMED")) // quita (cartão)
    expect(ag()).toMatchObject({ status: "completed", payment_status: "confirmed", asaas_status: "CONFIRMED" })
    const receivedAt = ag().payment_received_at

    // o outro webhook (RECEIVED) confirma a escrita dele no meio do nosso
    concurrentWriter = () => Object.assign(ag(), { payment_status: "received", asaas_status: "RECEIVED" })
    const res = await POST(webhook("PAYMENT_CONFIRMED", "CONFIRMED")) // CONFIRMED reenviado, outro event id
    expect(res.status).toBe(200)
    expect(concurrentWriter).toBeNull() // a injeção aconteceu
    expect(ag().payment_status).toBe("received")
    expect(ag().asaas_status).toBe("RECEIVED")
    expect(ag().status).toBe("completed")
    expect(ag().payment_received_at).toBe(receivedAt)
    expect(count("session.closed")).toBe(1)
    expect(count("receipt.issued")).toBe(1)
  })

  it("três PAGOs tardios simultâneos (RECEIVED + 2× CONFIRMED) depois da quitação: termina received, uma quitação", async () => {
    const { POST } = await import("@/app/api/asaas/webhook/payments/route")
    await POST(webhook("PAYMENT_CONFIRMED", "CONFIRMED"))
    const receivedAt = ag().payment_received_at
    await Promise.all([
      POST(webhook("PAYMENT_CONFIRMED", "CONFIRMED")),
      POST(webhook("PAYMENT_RECEIVED", "RECEIVED")),
      POST(webhook("PAYMENT_CONFIRMED", "CONFIRMED")),
    ])
    expect(ag()).toMatchObject({ status: "completed", payment_status: "received", asaas_status: "RECEIVED" })
    expect(ag().payment_received_at).toBe(receivedAt)
    expect(count("session.closed")).toBe(1)
  })

  it("ordem inversa também: RECEIVED quita, CONFIRMED tardio não regride", async () => {
    const { POST } = await import("@/app/api/asaas/webhook/payments/route")
    await POST(webhook("PAYMENT_RECEIVED", "RECEIVED"))
    await Promise.all([POST(webhook("PAYMENT_CONFIRMED", "CONFIRMED")), POST(webhook("PAYMENT_CONFIRMED", "CONFIRMED"))])
    expect(ag()).toMatchObject({ payment_status: "received", asaas_status: "RECEIVED" })
  })

  it("NULL: acordo quitado por outro caminho sem payment_status/asaas_status recebe o status do PAGO tardio", async () => {
    seed({ status: "completed", payment_status: null, asaas_status: null, payment_received_at: null })
    const { POST } = await import("@/app/api/asaas/webhook/payments/route")
    await POST(webhook("PAYMENT_CONFIRMED", "CONFIRMED"))
    expect(ag()).toMatchObject({ status: "completed", payment_status: "confirmed", asaas_status: "CONFIRMED" })
    expect(ag().payment_received_at).toBeTruthy() // preenchido uma vez
    // e o RECEIVED seguinte sobe na escada normalmente
    await POST(webhook("PAYMENT_RECEIVED", "RECEIVED"))
    expect(ag()).toMatchObject({ payment_status: "received", asaas_status: "RECEIVED" })
  })

  it("status fora da escada (estorno) continua aplicando depois de received", async () => {
    const { POST } = await import("@/app/api/asaas/webhook/payments/route")
    await POST(webhook("PAYMENT_RECEIVED", "RECEIVED"))
    await POST(webhook("PAYMENT_REFUNDED", "REFUNDED"))
    expect(ag()).toMatchObject({ status: "cancelled", payment_status: "refunded", asaas_status: "REFUNDED" })
  })

  it("paymentStatusesRankedAbove: mesma escada de isPaymentStatusRegression, nos dois casos de letra", async () => {
    const { paymentStatusesRankedAbove, isPaymentStatusRegression } = await import("@/lib/constants/payment-status")
    expect(paymentStatusesRankedAbove("confirmed").sort()).toEqual(
      ["DUNNING_RECEIVED", "RECEIVED", "RECEIVED_IN_CASH", "dunning_received", "received", "received_in_cash"].sort(),
    )
    expect(paymentStatusesRankedAbove("RECEIVED")).toEqual([])
    expect(paymentStatusesRankedAbove("refunded")).toEqual([])
    expect(paymentStatusesRankedAbove(null)).toEqual([])
    for (const cur of ["received", "RECEIVED_IN_CASH", "confirmed", "pending", "overdue"]) {
      for (const next of ["received", "confirmed", "pending", "OVERDUE"]) {
        const excluded = paymentStatusesRankedAbove(next).includes(cur)
        expect(excluded).toBe(isPaymentStatusRegression(cur, next))
      }
    }
  })
})
