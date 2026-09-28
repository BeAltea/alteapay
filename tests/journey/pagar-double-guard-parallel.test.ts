// Latência do Pagar (leituras do guard duplo em paralelo): as leituras do guard
// LOCAL (acordos do cliente) e do guard ASAAS (cobranças do cliente) passaram a
// correr numa leva só com as demais leituras do payment.create. Prova, pelas
// bibliotecas REAIS (paymentCreate → confirmAccept → closeAgreement →
// charge-inline) com banco em memória e ASAAS mockado, que:
//  1. o POST /payments NÃO sai antes de a consulta do guard ASAAS terminar;
//  2. cobrança viva no ASAAS bloqueia (already_charged), sem acordo nem POST;
//  3. acordo vivo local bloqueia mesmo com o ASAAS limpo, sem POST;
//  4. com os dois guards livres, exatamente UM POST, depois dos dois.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

const CO = "eeeeeeee-0000-0000-0000-00000000d901"
const SESSION = "5e550000-0000-0000-0000-00000000d901"
const DEBT = "d5000000-0000-4000-8000-00000000d901"
const CUST = "c5000000-0000-0000-0000-00000000d901"
const OFFER = "0ffe0000-0000-0000-0000-00000000d901"
const ctx = { sessionId: SESSION, companyId: CO, customerId: CUST, debtId: DEBT }

let db: FakeDb
const calls: string[] = []
let asaasPayments: any[] = []
let releaseList: (() => void) | null = null
let holdList = false

vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/asaas", () => ({
  getAsaasPaymentsForCustomer: async () => {
    calls.push("list:start")
    if (holdList) await new Promise<void>((r) => { releaseList = r })
    calls.push("list:end")
    return asaasPayments
  },
  getAsaasCustomerByCpfCnpj: async () => ({ id: "cus_known" }),
  updateAsaasCustomer: async () => { calls.push("update_customer"); return { id: "cus_known" } },
  createAsaasCustomer: async () => ({ id: "cus_new" }),
  createAsaasPayment: async (params: any) => {
    calls.push("create_payment")
    return {
      id: `pay_${calls.filter((c) => c === "create_payment").length}`, status: "PENDING",
      billingType: params.billingType, value: params.value, dueDate: params.dueDate,
      externalReference: params.externalReference, invoiceUrl: "https://asaas/i/x", bankSlipUrl: null, pixQrCodeUrl: null,
    }
  },
  getAsaasPaymentByExternalReference: async () => null,
  getAsaasPayment: async () => null,
}))
vi.mock("@/lib/journey/events", () => ({ recordEvent: async () => ({ ok: true, duplicate: false }) }))
vi.mock("@/lib/journey/actions", () => ({
  rejectOffer: async (_c: any, offerId: string, _a: string, reason: string) => {
    const o = db.negotiation_offers!.find((x) => x.id === offerId)
    if (o) { o.status = "rejected"; o.reject_reason = reason }
  },
  registerPaymentClaim: async () => "case",
  debtSummary: async () => ({ agingDays: 40, originalValue: 250 }),
}))
vi.mock("@/lib/journey/settled-state", () => ({ isDebtSettled: async () => false }))
vi.mock("@/lib/negotiation/matrix", () => ({
  resolveMatrixRow: async () => ({ id: "m1", max_discount_pct: 10, max_installments: 3, allowed_billing_types: ["PIX"], proposal_validity_days: 3 }),
}))
vi.mock("@/lib/negotiation/offers", () => ({ validateProposedTerms: () => ({ ok: true }) }))

const TERMS = {
  original_value: 250, discount_pct: 0, discount_value: 0, entry_value: 0, installments: 1,
  installment_value: 250, total_value: 250, billing_type: "PIX", first_due_date: "2026-09-30",
}

function seed(agreements: any[] = []) {
  db = {
    tenant_chat_config: [{ company_id: CO, payment_origin: "platform", acknowledgement_enabled: false, allow_payment_without_acknowledgement: true }],
    companies: [{ id: CO, name: "VMAX" }],
    customers: [{ id: CUST, company_id: CO, name: "Teste", document: "11144477735", email: null, phone: null }],
    debts: [{ id: DEBT, company_id: CO, customer_id: CUST, amount: 250, status: "pending", due_date: "2026-08-15" }],
    negotiation_sessions: [{ id: SESSION, company_id: CO, agreement_id: null }],
    negotiation_offers: [{ id: OFFER, session_id: SESSION, terms: TERMS, status: "presented", valid_until: null }],
    negotiation_acceptances: [],
    agreements,
    debt_acknowledgement_latest: [],
  }
  calls.length = 0
  asaasPayments = []
  releaseList = null
  holdList = false
}

// acordo antigo (cancelado) só para o customer ASAAS ser conhecido → guard ASAAS roda.
const knownCustomerAgreement = () => ({
  id: "ag-old", company_id: CO, customer_id: CUST, debt_id: DEBT, status: "cancelled",
  payment_status: "deleted", asaas_payment_id: "pay_old", asaas_customer_id: "cus_known", created_at: "2026-09-01T00:00:00Z",
})

beforeEach(() => {
  process.env.CHARGE_MODE = "inline"
})

describe("Pagar — guard duplo com leituras em paralelo", () => {
  it("o POST /payments só sai depois que o guard ASAAS terminou (e passou)", async () => {
    seed([knownCustomerAgreement()])
    holdList = true
    const { paymentCreate } = await import("@/lib/journey/payment-actions")
    const run = paymentCreate(ctx, OFFER)
    for (let i = 0; i < 50 && !releaseList; i++) await new Promise((r) => setTimeout(r, 5))
    expect(calls).toContain("list:start")
    // com a consulta do ASAAS pendente, nada foi fechado nem cobrado
    await new Promise((r) => setTimeout(r, 20))
    expect(calls).not.toContain("create_payment")
    expect(db.agreements!.filter((a) => a.id !== "ag-old")).toHaveLength(0)
    releaseList!()
    const r = await run
    expect(r.ok).toBe(true)
    expect(calls.filter((c) => c === "create_payment")).toHaveLength(1)
    expect(calls.indexOf("list:end")).toBeLessThan(calls.indexOf("create_payment"))
  })

  it("cobrança viva no ASAAS bloqueia: already_charged, sem acordo novo e sem POST", async () => {
    seed([knownCustomerAgreement()])
    asaasPayments = [{ id: "pay_live", status: "PENDING", deleted: false, value: 250 }]
    const { paymentCreate } = await import("@/lib/journey/payment-actions")
    const r = await paymentCreate(ctx, OFFER)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.code).toBe("already_charged")
    expect(calls).not.toContain("create_payment")
    expect(db.agreements!.filter((a) => a.id !== "ag-old")).toHaveLength(0)
  })

  it("acordo vivo local bloqueia mesmo com o ASAAS limpo, sem POST", async () => {
    seed([
      knownCustomerAgreement(),
      {
        id: "ag-live", company_id: CO, customer_id: CUST, debt_id: DEBT, status: "active",
        payment_status: "pending", asaas_payment_id: "pay_local", asaas_status: "PENDING", created_at: "2026-09-27T00:00:00Z",
      },
    ])
    const { paymentCreate } = await import("@/lib/journey/payment-actions")
    const r = await paymentCreate(ctx, OFFER)
    expect(!r.ok && r.code).toBe("already_charged")
    expect(calls).not.toContain("create_payment")
  })

  it("dois guards livres → exatamente uma cobrança; repetir não cria outra", async () => {
    seed([knownCustomerAgreement()])
    const { paymentCreate } = await import("@/lib/journey/payment-actions")
    const first = await paymentCreate(ctx, OFFER)
    expect(first.ok && first.status).toBe("created")
    const again = await paymentCreate(ctx, OFFER)
    expect(again.ok && again.status).toBe("created")
    expect(again.ok && (again as { idempotent?: boolean }).idempotent).toBe(true)
    expect(calls.filter((c) => c === "create_payment")).toHaveLength(1)
  })
})
