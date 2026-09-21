// §4/H9: prova de idempotência do payment.create por (session_id, offer_id) com
// DUPLA CHAMADA (payload idêntico, ZERO cobrança nova) e o reenvio do link
// existente via payment.status no caso already_charged.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

const CO = "eeeeeeee-0000-0000-0000-00000000000a"
const ctx = { sessionId: "s1", companyId: CO, customerId: "cust1", debtId: "debt1" }

let db: FakeDb
let confirmCalls = 0
let asaasPayments: any[] = []

vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/asaas", () => ({ getAsaasPaymentsForCustomer: async () => asaasPayments }))
vi.mock("@/lib/journey/closing", () => ({
  buildAcceptSummary: async () => ({ ok: true, summary: { termsHash: "h", terms: {}, validUntil: null } }),
  // confirmAccept é a ÚNICA porta para uma cobrança nova. Contar as chamadas
  // prova que a 2ª invocação NÃO gera cobrança.
  confirmAccept: async () => {
    confirmCalls += 1
    // simula o efeito de confirmAccept: registra o aceite e o agreement com link
    db.negotiation_acceptances!.push({ company_id: CO, session_id: "s1", offer_id: "o1", agreement_id: "ag1" })
    db.agreements!.push({
      id: "ag1", company_id: CO, customer_id: "cust1", asaas_payment_id: "pay_1",
      asaas_billing_type: "PIX", agreed_amount: 90, installments: 1, due_date: "2026-10-01",
      asaas_pix_qrcode_url: "pixcode", asaas_boleto_url: null, asaas_invoice_url: "https://asaas/i/1",
      payment_status: "pending", asaas_status: "PENDING",
    })
    return { ok: true, agreementId: "ag1" }
  },
}))
vi.mock("@/lib/journey/actions", () => ({
  registerPaymentClaim: async () => "case1",
  rejectOffer: async () => undefined,
}))
vi.mock("@/lib/journey/events", () => ({ recordEvent: async () => ({ ok: true, duplicate: false }) }))

function reset() {
  db = {
    tenant_chat_config: [{ company_id: CO, payment_origin: "platform", allow_payment_without_acknowledgement: false, acknowledgement_enabled: true }],
    agreements: [],
    debts: [{ id: "debt1", company_id: CO, current_amount: 100, amount: 100 }],
    negotiation_sessions: [{ id: "s1", company_id: CO, agreement_id: null }],
    negotiation_acceptances: [],
    debt_acknowledgement_latest: [{ session_id: "s1", debt_id: "debt1", acknowledged: true, button_id: 1, created_at: new Date().toISOString() }],
  }
  confirmCalls = 0
  asaasPayments = []
  delete process.env.PAYMENT_ORIGIN
}

describe("payment.create — dupla chamada, ZERO cobrança nova (§4/H9)", () => {
  beforeEach(reset)

  it("2ª chamada devolve o MESMO agreement/link, idempotent:true, confirmAccept chamado 1x só", async () => {
    const { paymentCreate } = await import("@/lib/journey/payment-actions")
    const r1 = await paymentCreate(ctx, "o1", "evt-1")
    expect(r1.ok).toBe(true)
    expect(confirmCalls).toBe(1)

    const r2 = await paymentCreate(ctx, "o1", "evt-1")
    expect(r2.ok).toBe(true)
    // NENHUMA cobrança nova: confirmAccept não foi chamado de novo
    expect(confirmCalls).toBe(1)
    if (r2.ok && r2.status === "created") {
      expect(r2.idempotent).toBe(true)
      expect(r2.payment.agreement_id).toBe("ag1")
      expect(r2.payment.payment_id).toBe("pay_1")
    }
    // e só existe UM agreement na base
    expect((db.agreements ?? []).filter((a) => a.id === "ag1").length).toBe(1)
    // payloads idênticos (mesmo agreement/link/valor)
    const { paymentCreateResponseForN8n } = await import("@/lib/journey/payment-actions")
    const p1 = paymentCreateResponseForN8n(r1)
    const p2 = paymentCreateResponseForN8n(r2)
    expect({ ...p2, idempotent: p1.idempotent }).toEqual(p1)
  })
})

describe("payment.status — reenvia o link do acordo VIVO (already_charged, §4)", () => {
  beforeEach(reset)

  it("sessão sem acordo próprio, cliente com cobrança viva → devolve URLs para reenvio", async () => {
    // acordo VIVO do cliente, NÃO vinculado à sessão (session.agreement_id=null)
    db.agreements = [{
      id: "agLive", company_id: CO, customer_id: "cust1", asaas_payment_id: "pay_live",
      payment_status: "pending", asaas_status: "PENDING", asaas_billing_type: "BOLETO",
      agreed_amount: 150, installments: 1, due_date: "2026-11-01",
      asaas_boleto_url: "https://asaas/b/live", asaas_invoice_url: "https://asaas/i/live", asaas_pix_qrcode_url: null,
    }]
    const { paymentStatus } = await import("@/lib/journey/payment-actions")
    const s = await paymentStatus(ctx)
    expect(s.agreement_id).toBe("agLive")
    expect(s.from_live_charge).toBe(true)
    expect(s.payment?.payment_id).toBe("pay_live")
    expect(s.payment?.boleto_url).toBe("https://asaas/b/live")
    expect(s.payment?.invoice_url).toBe("https://asaas/i/live")
    expect(s.payment_status).toBe("pending")
  })

  it("sessão com acordo próprio → usa o acordo da sessão (não busca cobrança viva)", async () => {
    db.negotiation_sessions = [{ id: "s1", company_id: CO, agreement_id: "agSession" }]
    db.agreements = [{
      id: "agSession", company_id: CO, customer_id: "cust1", asaas_payment_id: "pay_sess",
      payment_status: "pending", asaas_status: "PENDING", agreed_amount: 90, installments: 1,
      due_date: "2026-10-01", asaas_pix_qrcode_url: "pix", asaas_invoice_url: "https://asaas/i/sess",
    }]
    const { paymentStatus } = await import("@/lib/journey/payment-actions")
    const s = await paymentStatus(ctx)
    expect(s.agreement_id).toBe("agSession")
    expect(s.from_live_charge).toBeUndefined()
    expect(s.payment?.payment_id).toBe("pay_sess")
  })

  it("nenhum acordo (sessão nem cliente) → payment null", async () => {
    const { paymentStatus } = await import("@/lib/journey/payment-actions")
    const s = await paymentStatus(ctx)
    expect(s.agreement_id).toBeNull()
    expect(s.payment).toBeNull()
  })
})
