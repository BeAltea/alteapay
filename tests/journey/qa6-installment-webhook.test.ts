// QA rodada 6 (Q4r2-03, ALTO) — webhooks das parcelas 2..N gravavam "Agreement
// not found" e pagar só a parcela 1 marcava o acordo `completed`, a dívida `paid`
// e a VMAX `PAGO`. Agora o webhook casa a parcela pelo id do PARCELAMENTO
// (`payment.installment` → `agreements.asaas_subscription_id`) ou pela
// externalReference da jornada, e só declara pago na ÚLTIMA parcela.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

const SESSION = "5e550000-0000-4000-8000-0000000000a6"
const OFFER = "0ffe0000-0000-4000-8000-0000000000a6"
const EXT_REF = `journey_${SESSION}_${OFFER}`

let db: FakeDb = {}

// A rota legada chama `.catch()` direto no builder (erro de tipo pré-existente:
// o builder real do supabase-js não tem `.catch`). Só para exercitar a guarda nova
// dela, o fake ganha um `.catch` quando `legacyCatch` está ligado.
let legacyCatch = false
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (t: string) => {
      const qb: any = makeFakeSupabase(db).from(t)
      if (legacyCatch) {
        for (const m of ["insert", "update"]) {
          const orig = qb[m].bind(qb)
          qb[m] = (...a: unknown[]) => {
            const b = orig(...a)
            b.catch = () => Promise.resolve(new Promise((r) => b.then(r)))
            return b
          }
        }
      }
      return qb
    },
  }),
}))
vi.mock("@/lib/supabase/url", () => ({ getServerSupabaseUrl: () => "http://fake" }))

function seed(opts: { installments?: number; subscriptionId?: string | null } = {}) {
  db = {
    asaas_webhook_events: [],
    agreements: [{
      id: "ag-3x", company_id: "co", customer_id: "cust", debt_id: "debt-1", user_id: null,
      asaas_payment_id: "pay_1", asaas_customer_id: "cus_1", asaas_subscription_id: opts.subscriptionId ?? null,
      installments: opts.installments ?? 3, installment_amount: 81.25, agreed_amount: 243.75,
      status: "active", payment_status: "pending", asaas_status: "PENDING",
      due_date: "2026-10-03", asaas_invoice_url: "https://asaas/i/pay_1",
      negotiation_session_id: SESSION, offer_id: OFFER, origin: "chat_journey", created_at: "2026-09-26T14:45:00Z",
    }],
    debts: [{ id: "debt-1", status: "in_agreement", external_id: "vmax-1" }],
    VMAX: [{ id: "vmax-1", negotiation_status: "EM_ANDAMENTO" }],
    notifications: [],
  }
}

let seq = 0
function webhook(event: string, payment: Record<string, unknown>) {
  seq += 1
  const body = { id: `evt_${seq}`, event, payment }
  return { headers: { get: () => null }, json: async () => body } as any
}
const parcel = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `pay_${n}`, customer: "cus_1", value: 81.25, installment: "inst_abc", installmentNumber: n,
  externalReference: EXT_REF, billingType: "BOLETO", dueDate: `2026-1${n - 1}-03`, invoiceUrl: `https://asaas/i/pay_${n}`, ...extra,
})
const ag = () => db.agreements[0]

describe("QA rodada 6 — webhook de parcelas (Q4r2-03)", () => {
  beforeEach(() => {
    delete process.env.ASAAS_WEBHOOK_TOKEN
    delete process.env.CHAT_JOURNEY_ENABLED
    seed()
  })

  it("PAYMENT_CREATED da parcela 2 casa pelo externalReference; grava o id do parcelamento; não mexe no espelho da parcela 1", async () => {
    const { POST } = await import("@/app/api/asaas/webhook/payments/route")
    const res = await POST(webhook("PAYMENT_CREATED", parcel(2)))
    expect(res.status).toBe(200)
    const evt = db.asaas_webhook_events[0]
    expect(evt.agreement_id).toBe("ag-3x")
    expect(evt.error_message ?? null).toBeNull()
    expect(ag().asaas_subscription_id).toBe("inst_abc")
    expect(ag().due_date).toBe("2026-10-03") // vencimento exibido = parcela 1
    expect(ag().asaas_invoice_url).toBe("https://asaas/i/pay_1")
    expect(ag().asaas_status).toBe("PENDING")
  })

  it("parcela 2 casa pelo id do parcelamento quando já gravado (sem externalReference)", async () => {
    seed({ subscriptionId: "inst_abc" })
    const { POST } = await import("@/app/api/asaas/webhook/payments/route")
    const res = await POST(webhook("PAYMENT_OVERDUE", parcel(2, { externalReference: null })))
    expect(res.status).toBe(200)
    expect(db.asaas_webhook_events[0].agreement_id).toBe("ag-3x")
    expect(ag().payment_status).toBe("overdue") // atraso de qualquer parcela é atraso do acordo
  })

  it("PAGO da parcela 2 (ou da 1) NÃO quita: acordo aberto, dívida e VMAX intactas; só a ÚLTIMA quita", async () => {
    const { POST } = await import("@/app/api/asaas/webhook/payments/route")
    // parcela 2 paga (fora de ordem)
    expect((await POST(webhook("PAYMENT_RECEIVED", parcel(2)))).status).toBe(200)
    expect(ag().status).toBe("active")
    expect(ag().payment_status).toBe("pending")
    expect(ag().asaas_status).toBe("PENDING")
    expect(ag().payment_received_at).toBeUndefined()
    expect(db.debts[0].status).toBe("in_agreement")
    expect(db.VMAX[0].negotiation_status).toBe("EM_ANDAMENTO")

    // parcela 1 paga (casada pelo asaas_payment_id): 2 de 3 → ainda aberto
    expect((await POST(webhook("PAYMENT_CONFIRMED", parcel(1)))).status).toBe(200)
    expect(ag().status).toBe("active")
    expect(db.debts[0].status).toBe("in_agreement")

    // evento repetido da parcela 1 (outro event id) não conta duas vezes
    expect((await POST(webhook("PAYMENT_RECEIVED", parcel(1)))).status).toBe(200)
    expect(ag().status).toBe("active")

    // parcela 3 paga → quita
    expect((await POST(webhook("PAYMENT_RECEIVED", parcel(3)))).status).toBe(200)
    expect(ag().status).toBe("completed")
    expect(ag().payment_status).toBe("received")
    expect(db.debts[0].status).toBe("paid")
    expect(db.VMAX[0].negotiation_status).toBe("PAGO")
    // nenhum evento ficou sem acordo
    expect(db.asaas_webhook_events.every((e) => e.agreement_id === "ag-3x")).toBe(true)
  })

  it("à vista (1x) continua quitando no PAGO, como antes", async () => {
    seed({ installments: 1 })
    const { POST } = await import("@/app/api/asaas/webhook/payments/route")
    await POST(webhook("PAYMENT_RECEIVED", { id: "pay_1", customer: "cus_1", value: 243.75, externalReference: EXT_REF }))
    expect(ag().status).toBe("completed")
    expect(db.debts[0].status).toBe("paid")
  })

  it("parcelamento cancelado (DELETED de cada parcela) cancela o acordo e devolve a dívida", async () => {
    const { POST } = await import("@/app/api/asaas/webhook/payments/route")
    await POST(webhook("PAYMENT_DELETED", parcel(2, { deleted: true })))
    expect(ag().status).toBe("cancelled")
    expect(db.debts[0].status).toBe("pending")
  })

  it("rota legada /api/webhooks/asaas também não quita na parcela 1 de 3", async () => {
    const { POST } = await import("@/app/api/webhooks/asaas/route")
    legacyCatch = true
    const res = await POST(webhook("PAYMENT_RECEIVED", parcel(1))).finally(() => { legacyCatch = false })
    expect(res.status).toBe(200)
    expect(ag().status).toBe("active")
    expect(db.debts[0].status).toBe("in_agreement")
  })

  it("helpers puros: parse da externalReference e decisão da última parcela", async () => {
    const { parseJourneyExternalReference, isFinalInstallmentPaid } = await import("@/lib/asaas-installments")
    expect(parseJourneyExternalReference(EXT_REF)).toEqual({ sessionId: SESSION, offerId: OFFER })
    expect(parseJourneyExternalReference("agreement_123")).toBeNull()
    expect(isFinalInstallmentPaid({ installments: 3, priorPaidPaymentIds: ["pay_1", "pay_1"], currentPaymentId: "pay_2" })).toBe(false)
    expect(isFinalInstallmentPaid({ installments: 3, priorPaidPaymentIds: ["pay_1", "pay_2"], currentPaymentId: "pay_3" })).toBe(true)
  })
})
