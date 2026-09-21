// N7: papel B — payment.create (guard sempre), payment.record recusa status
// pago (D6 → claim) e already_charged.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

const CO = "eeeeeeee-0000-0000-0000-000000000005"
const ctx = { sessionId: "s1", companyId: CO, customerId: "cust1", debtId: "debt1" }

let db: FakeDb
let confirmResult: any
let claimId = "case_claim_1"
let asaasPayments: any[] = []

vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/asaas", () => ({ getAsaasPaymentsForCustomer: async () => asaasPayments }))
vi.mock("@/lib/journey/closing", () => ({
  buildAcceptSummary: async () => ({ ok: true, summary: { termsHash: "h", terms: {}, validUntil: null } }),
  confirmAccept: async () => confirmResult,
}))
vi.mock("@/lib/journey/actions", () => ({
  registerPaymentClaim: async () => claimId,
  rejectOffer: async () => undefined,
}))
vi.mock("@/lib/journey/events", () => ({ recordEvent: async () => ({ ok: true, duplicate: false }) }))

function reset(paymentOrigin = "platform", opts: { acknowledged?: boolean; allowWithoutAck?: boolean } = {}) {
  const allowWithoutAck = opts.allowWithoutAck ?? true // default: guard não bloqueia (foca no caminho de cobrança)
  db = {
    tenant_chat_config: [{
      company_id: CO,
      payment_origin: paymentOrigin,
      allow_payment_without_acknowledgement: allowWithoutAck,
      acknowledgement_enabled: true,
    }],
    agreements: [],
    debts: [{ id: "debt1", company_id: CO, current_amount: 100, amount: 100 }],
    negotiation_sessions: [{ id: "s1", company_id: CO, agreement_id: null }],
    negotiation_acceptances: [],
    debt_acknowledgement_latest: opts.acknowledged
      ? [{ session_id: "s1", debt_id: "debt1", acknowledged: true, button_id: 1, created_at: new Date().toISOString() }]
      : [],
  }
  confirmResult = { ok: true, agreementId: "ag1" }
  asaasPayments = []
  delete process.env.PAYMENT_ORIGIN
}

describe("paymentCreate (papel A)", () => {
  beforeEach(() => reset())

  it("sem link do worker ainda → processing (idempotent:false na 1ª chamada)", async () => {
    const { paymentCreate } = await import("@/lib/journey/payment-actions")
    const r = await paymentCreate(ctx, "o1")
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.status).toBe("processing")
      expect(r.idempotent).toBe(false)
    }
  })

  it("com cobrança pronta → created com detalhes reais", async () => {
    db.agreements = [{ id: "ag1", company_id: CO, asaas_payment_id: "pay_1", asaas_billing_type: "PIX", agreed_amount: 90, installments: 1, due_date: "2026-10-01", asaas_pix_qrcode_url: "pix", asaas_boleto_url: null, asaas_invoice_url: "inv" }]
    const { paymentCreate } = await import("@/lib/journey/payment-actions")
    const r = await paymentCreate(ctx, "o1")
    expect(r.ok).toBe(true)
    if (r.ok && r.status === "created") {
      expect(r.payment.payment_id).toBe("pay_1")
      expect(r.payment.billing_type).toBe("PIX")
      expect(r.idempotent).toBe(false)
    }
  })

  it("guard: confirmAccept ALREADY_CHARGED → 409 already_charged", async () => {
    confirmResult = { ok: false, error: "ALREADY_CHARGED" }
    const { paymentCreate } = await import("@/lib/journey/payment-actions")
    const r = await paymentCreate(ctx, "o1")
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.status).toBe(409)
      expect(r.code).toBe("already_charged")
    }
  })

  it("payment_origin != platform → 501 not_implemented (variante B fora do escopo)", async () => {
    reset("n8n")
    const { paymentCreate } = await import("@/lib/journey/payment-actions")
    const r = await paymentCreate(ctx, "o1")
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.status).toBe(501)
      expect(r.code).toBe("not_implemented")
    }
  })

  it("sem reconhecimento e sem flag → 409 debt_not_acknowledged", async () => {
    reset("platform", { acknowledged: false, allowWithoutAck: false })
    const { paymentCreate } = await import("@/lib/journey/payment-actions")
    const r = await paymentCreate(ctx, "o1")
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.status).toBe(409)
      expect(r.code).toBe("debt_not_acknowledged")
    }
  })

  it("reconhecido (button 1) → cobra normalmente", async () => {
    reset("platform", { acknowledged: true, allowWithoutAck: false })
    const { paymentCreate } = await import("@/lib/journey/payment-actions")
    const r = await paymentCreate(ctx, "o1")
    expect(r.ok).toBe(true)
  })

  it("idempotência (session,offer): 2ª chamada = mesmo agreement, idempotent:true, 0 cobrança nova", async () => {
    reset("platform", { acknowledged: true, allowWithoutAck: false })
    // 1ª chamada registra o aceite (fake: usamos a acceptances pré-semeada)
    db.negotiation_acceptances = [{ company_id: CO, session_id: "s1", offer_id: "o1", agreement_id: "ag1" }]
    db.agreements = [{ id: "ag1", company_id: CO, asaas_payment_id: "pay_1", asaas_billing_type: "PIX", agreed_amount: 90, installments: 1, due_date: "2026-10-01", asaas_pix_qrcode_url: "pix", asaas_invoice_url: "inv" }]
    const { paymentCreate } = await import("@/lib/journey/payment-actions")
    const r = await paymentCreate(ctx, "o1")
    expect(r.ok).toBe(true)
    if (r.ok && r.status === "created") {
      expect(r.idempotent).toBe(true)
      expect(r.payment.agreement_id).toBe("ag1")
      expect(r.payment.payment_id).toBe("pay_1")
    }
  })
})

describe("paymentRecord (papel B)", () => {
  beforeEach(() => reset("n8n"))

  it("status pago NUNCA muda o acordo → vira claim (D6)", async () => {
    const { paymentRecord } = await import("@/lib/journey/payment-actions")
    const r = await paymentRecord(ctx, { status: "received", asaas_payment_id: "pay_x" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.code).toBe("claim")
    // nenhum agreement pago foi criado
    expect((db.agreements ?? []).some((a) => a.payment_status && a.payment_status !== "pending")).toBe(false)
  })

  it("dívida com cobrança viva → already_charged", async () => {
    db.agreements = [{ id: "agX", company_id: CO, customer_id: "cust1", asaas_payment_id: "pay_live", payment_status: "pending", asaas_status: "PENDING" }]
    const { paymentRecord } = await import("@/lib/journey/payment-actions")
    const r = await paymentRecord(ctx, { status: "pending", offer_id: "o1" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("already_charged")
  })

  it("registro pending válido cria agreement com payment_status=pending", async () => {
    const { paymentRecord } = await import("@/lib/journey/payment-actions")
    const r = await paymentRecord(ctx, { status: "pending", asaas_payment_id: "pay_new", billing_type: "BOLETO", total_value: 90, installments: 1, boleto_url: "b" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.code).toBe("recorded")
    const created = (db.agreements ?? []).find((a) => a.asaas_payment_id === "pay_new")
    expect(created?.payment_status).toBe("pending")
    expect(created?.origin).toBe("chat_journey")
  })
})
