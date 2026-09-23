// Frente C: revalidação de matriz do payment.create (§3). A oferta é gerada da
// matriz, mas a matriz pode mudar; antes de cobrar, os termos persistidos TÊM que
// caber na faixa VIGENTE. Fora da matriz → 422 offer_outside_matrix; sem linha de
// matriz para o (aging, valor) → 422 no_matrix_row. Dentro da matriz → cobra.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

const CO = "eeeeeeee-0000-0000-0000-0000000000c1"
const SID = "s1"
const CUST = "cust1"
const DEBT = "debt1"
const ctx = { sessionId: SID, companyId: CO, customerId: CUST, debtId: DEBT }

let db: FakeDb
let confirmCalls = 0

vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/asaas", () => ({ getAsaasPaymentsForCustomer: async () => [] }))
vi.mock("@/lib/journey/events", () => ({ recordEvent: async () => ({ ok: true, duplicate: false }) }))
// closing/closeAgreement mockados: confirmAccept só conta chamadas e cria o link.
vi.mock("@/lib/journey/closing", () => ({
  buildAcceptSummary: async () => ({ ok: true, summary: { termsHash: "h", terms: {}, validUntil: null } }),
  confirmAccept: async () => {
    confirmCalls += 1
    ;(db.agreements ??= []).push({
      id: "ag1", company_id: CO, customer_id: CUST, asaas_payment_id: "pay_1",
      asaas_billing_type: "PIX", agreed_amount: 80, installments: 1, due_date: "2026-10-01",
      asaas_pix_qrcode_url: "pix", asaas_invoice_url: "inv", payment_status: "pending", asaas_status: "PENDING",
    })
    ;(db.negotiation_acceptances ??= []).push({ company_id: CO, session_id: SID, offer_id: "off-1", agreement_id: "ag1" })
    return { ok: true, agreementId: "ag1" }
  },
}))

const MATRIX_OK = {
  id: "mx-1", company_id: CO, name: "default", priority: 1, active: true,
  valid_from: null, valid_to: null, aging_min_days: 0, aging_max_days: null,
  aging_basis: "oldest_due", max_discount_pct: 30, installment_discount_pct: 10,
  min_entry_pct: 20, max_installments: 3, min_installment_value: 10,
  allowed_billing_types: ["PIX", "BOLETO"], proposal_validity_days: 7,
  retry_after_days: 3, max_retries: 2, min_debt_value: 0,
}

// Oferta à vista de 20% (100 → 80) em PIX — dentro de MATRIX_OK.
const OFFER_TERMS = {
  original_value: 100, discount_pct: 20, discount_value: 20, entry_value: 0,
  total_value: 80, installments: 1, installment_value: 80, billing_type: "PIX",
  first_due_date: "2026-10-01",
}

function seed(matrix: any[] = [MATRIX_OK], offerTerms: any = OFFER_TERMS) {
  confirmCalls = 0
  db = {
    tenant_chat_config: [{ company_id: CO, payment_origin: "platform", allow_payment_without_acknowledgement: true, acknowledgement_enabled: true }],
    companies: [{ id: CO, name: "VMAX" }],
    customers: [{ id: CUST, company_id: CO, name: "Fabio", document: "11144477735" }],
    debts: [{ id: DEBT, company_id: CO, customer_id: CUST, status: "pending", amount: 100, due_date: "2020-01-01" }],
    vmax_invoices: [],
    negotiation_sessions: [{ id: SID, company_id: CO, customer_id: CUST, debt_id: DEBT, agreement_id: null }],
    negotiation_offers: [{ id: "off-1", company_id: CO, session_id: SID, customer_id: CUST, debt_id: DEBT, status: "presented", valid_until: null, terms: offerTerms }],
    negotiation_condition_matrix: matrix,
    negotiation_acceptances: [],
    agreements: [],
    debt_acknowledgement_latest: [],
  }
  delete process.env.PAYMENT_ORIGIN
}

describe("payment.create — revalidação de matriz (§3)", () => {
  beforeEach(() => seed())

  it("dentro da matriz → cobra (created)", async () => {
    const { paymentCreate } = await import("@/lib/journey/payment-actions")
    const r = await paymentCreate(ctx, "off-1")
    expect(r.ok).toBe(true)
    expect(confirmCalls).toBe(1)
  })

  it("sem linha de matriz vigente → 422 no_matrix_row (0 cobrança)", async () => {
    seed([]) // nenhuma linha ativa
    const { paymentCreate } = await import("@/lib/journey/payment-actions")
    const r = await paymentCreate(ctx, "off-1")
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.status).toBe(422)
      expect(r.code).toBe("no_matrix_row")
    }
    expect(confirmCalls).toBe(0)
  })

  it("oferta com desconto ACIMA do máximo da matriz → 422 offer_outside_matrix (0 cobrança)", async () => {
    // matriz aperta o teto para 5%; a oferta de 20% agora está fora.
    seed([{ ...MATRIX_OK, max_discount_pct: 5 }])
    const { paymentCreate } = await import("@/lib/journey/payment-actions")
    const r = await paymentCreate(ctx, "off-1")
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.status).toBe(422)
      expect(r.code).toBe("offer_outside_matrix")
    }
    expect(confirmCalls).toBe(0)
  })

  it("billing_type não permitido pela matriz → 422 offer_outside_matrix", async () => {
    // matriz só permite BOLETO; a oferta é PIX → fora.
    seed([{ ...MATRIX_OK, allowed_billing_types: ["BOLETO"] }])
    const { paymentCreate } = await import("@/lib/journey/payment-actions")
    const r = await paymentCreate(ctx, "off-1")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("offer_outside_matrix")
    expect(confirmCalls).toBe(0)
  })
})
