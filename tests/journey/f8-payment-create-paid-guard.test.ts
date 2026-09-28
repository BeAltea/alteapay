// F8-02 — guard de dívida QUITADA no payment.create (n8n, assistido e Pagar).
// Antes: o guard de cobrança viva contava o acordo PAGO como "já cobrado" e
// reentregava o link da cobrança paga ("cobrança ativa"). Agora a dívida paga
// para o fluxo com 409 debt_paid, antes de qualquer cobrança/idempotência.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

const CO = "eeeeeeee-0000-0000-0000-00000000f8c2"
const SID = "s1"
const CUST = "cust1"
const DEBT = "debt1"
const ctx = { sessionId: SID, companyId: CO, customerId: CUST, debtId: DEBT }

let db: FakeDb
let confirmCalls = 0

vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/asaas", () => ({ getAsaasPaymentsForCustomer: async () => [] }))
vi.mock("@/lib/journey/events", () => ({ recordEvent: async () => ({ ok: true, duplicate: false }) }))
vi.mock("@/lib/journey/actions", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>)
  return { ...actual, rejectOffer: async () => {}, registerPaymentClaim: async () => "case1" }
})
// confirmAccept SEMPRE recusa already_charged (dívida já tem cobrança viva).
vi.mock("@/lib/journey/closing", () => ({
  buildAcceptSummary: async () => ({ ok: true, summary: { termsHash: "h", terms: {}, validUntil: null } }),
  confirmAccept: async () => {
    confirmCalls += 1
    return { ok: false, error: "ALREADY_CHARGED" }
  },
}))

const MATRIX = {
  id: "mx-1", company_id: CO, name: "d", priority: 1, active: true, valid_from: null, valid_to: null,
  aging_min_days: 0, aging_max_days: null, aging_basis: "oldest_due", max_discount_pct: 30,
  installment_discount_pct: 10, min_entry_pct: 20, max_installments: 3, min_installment_value: 10,
  allowed_billing_types: ["PIX", "BOLETO"], proposal_validity_days: 7, retry_after_days: 3, max_retries: 2, min_debt_value: 0,
}
const OFFER_TERMS = {
  original_value: 100, discount_pct: 20, discount_value: 20, entry_value: 0,
  total_value: 80, installments: 1, installment_value: 80, billing_type: "PIX", first_due_date: "2026-10-01",
}

function seed() {
  confirmCalls = 0
  db = {
    tenant_chat_config: [{ company_id: CO, payment_origin: "platform", allow_payment_without_acknowledgement: true, acknowledgement_enabled: true }],
    companies: [{ id: CO, name: "VMAX" }],
    customers: [{ id: CUST, company_id: CO, name: "Fabio", document: "11144477735" }],
    debts: [{ id: DEBT, company_id: CO, customer_id: CUST, status: "pending", amount: 100, due_date: "2020-01-01" }],
    vmax_invoices: [],
    // sessão SEM acordo próprio → paymentStatus cai no acordo VIVO do cliente.
    negotiation_sessions: [{ id: SID, company_id: CO, customer_id: CUST, debt_id: DEBT, agreement_id: null }],
    negotiation_offers: [{ id: "off-1", company_id: CO, session_id: SID, customer_id: CUST, debt_id: DEBT, status: "presented", valid_until: null, terms: OFFER_TERMS }],
    negotiation_condition_matrix: [MATRIX],
    negotiation_acceptances: [],
    // acordo VIVO do cliente (cobrança viva) — não vinculado à sessão.
    agreements: [{
      id: "agLive", company_id: CO, customer_id: CUST, asaas_payment_id: "pay_live",
      payment_status: "pending", asaas_status: "PENDING", asaas_billing_type: "BOLETO",
      agreed_amount: 150, installments: 1, due_date: "2026-11-01",
      asaas_boleto_url: "https://asaas/b/live", asaas_invoice_url: "https://asaas/i/live", asaas_pix_qrcode_url: null,
    }],
    debt_acknowledgement_latest: [],
  }
  delete process.env.PAYMENT_ORIGIN
}

describe("paymentCreate — dívida quitada (F8-02)", () => {
  beforeEach(seed)

  it("dívida paga → 409 debt_paid, sem cobrança e sem reentregar o link pago", async () => {
    db.debts![0].status = "paid"
    Object.assign(db.agreements![0], { status: "completed", payment_status: "received", asaas_status: "RECEIVED" })
    const { paymentCreateOrExistingLink, paymentCreateOrLinkResponseForN8n } = await import("@/lib/journey/payment-actions")
    const r = await paymentCreateOrExistingLink(ctx, "off-1")
    expect(r).toMatchObject({ ok: false, status: 409, code: "debt_paid" })
    expect(confirmCalls).toBe(0)
    expect(paymentCreateOrLinkResponseForN8n(r)).toMatchObject({ ok: false, code: "debt_paid" })
  })

  it("acordo DA SESSÃO quitado (dívida ainda não atualizada) → 409 debt_paid", async () => {
    db.agreements!.push({ id: "agSess", company_id: CO, customer_id: CUST, debt_id: DEBT, negotiation_session_id: SID, status: "completed", payment_status: "confirmed" })
    const { paymentCreate } = await import("@/lib/journey/payment-actions")
    const r = await paymentCreate(ctx, "off-1")
    expect(r).toMatchObject({ ok: false, code: "debt_paid" })
    expect(confirmCalls).toBe(0)
  })

  it("dívida paga em OUTRO tenant com o mesmo id não bloqueia (company_id)", async () => {
    db.debts!.push({ id: DEBT, company_id: "outro", customer_id: CUST, status: "paid", amount: 1 })
    const { paymentCreateOrExistingLink } = await import("@/lib/journey/payment-actions")
    const r = await paymentCreateOrExistingLink(ctx, "off-1")
    expect(r.ok && r.status).toBe("already_charged")
    expect(confirmCalls).toBe(1)
  })
})
