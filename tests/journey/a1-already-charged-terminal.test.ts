// A1 / N-D1-2 — `already_charged` só com cobrança VIVA.
//
//  - webhook PAYMENT_DELETED grava asaas_status='DELETED' (REFUNDED → 'REFUNDED');
//  - isBlockingAgreement: payment_status ∈ {deleted, refunded, cancelled} /
//    status='cancelled' são TERMINAIS com precedência sobre asaas_status;
//  - paymentStatus NÃO devolve o acordo terminal da sessão como "a cobrança";
//  - GET /api/chat/payment não devolve 'ready' para acordo cancelado e não grava
//    payment.viewed a cada poll (N-D1-6);
//  - guard local do confirmAccept não bloqueia por acordo cancelado (o ASAAS
//    continua sendo consultado). Cancelada → novo clique cria cobrança nova.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

process.env.CHAT_JOURNEY_ENABLED = "true"
process.env.NEGOTIATION_JWT_SECRET = "test-secret-a1-terminal"
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co"
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key"

const CO = "eeeeeeee-0000-0000-0000-0000000a1tm1"
const SID = "sess-a1-terminal"
const CUST = "cust-a1-terminal"
const DEBT = "debt-a1-terminal"
const ctx = { sessionId: SID, companyId: CO, customerId: CUST, debtId: DEBT }

let db: FakeDb
const events: Array<{ type: string; payload?: Record<string, unknown> }> = []
let closeCalls = 0
let asaasPayments: Array<{ id: string; status: string; deleted?: boolean }> = []

vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
// o webhook cria o client de service role no módulo (createClient direto)
vi.mock("@supabase/supabase-js", () => ({
  // o client é criado no import do módulo: resolve `db` a cada chamada (beforeEach troca o objeto)
  createClient: () => ({ from: (table: string) => makeFakeSupabase(db).from(table) }),
}))
vi.mock("@/lib/asaas", () => ({ getAsaasPaymentsForCustomer: async () => asaasPayments }))
vi.mock("@/lib/journey/reconciliation", () => ({ journeyOnPaymentEvent: async () => {} }))
vi.mock("@/lib/journey/events", () => ({
  recordEvent: async (i: { type: string; payload?: Record<string, unknown> }) => {
    events.push({ type: i.type, payload: i.payload })
    return { ok: true, duplicate: false }
  },
  getTimeline: async () => [],
}))
vi.mock("@/lib/negotiation/close-agreement", () => ({
  closeAgreement: async () => {
    closeCalls += 1
    const agId = `ag-new-${closeCalls}`
    ;(db.agreements ??= []).push({
      id: agId, company_id: CO, customer_id: CUST, asaas_payment_id: `pay_new_${closeCalls}`,
      payment_status: "pending", asaas_status: "PENDING", status: "active", asaas_invoice_url: `https://asaas/i/new_${closeCalls}`,
      agreed_amount: 250, installments: 1, due_date: "2026-09-28",
    })
    return { ok: true, agreement_id: agId, message: "ok", terms: {} }
  },
}))

const OFFER_TERMS = {
  original_value: 250, discount_pct: 0, discount_value: 0, entry_value: 0, installments: 1,
  installment_value: 250, total_value: 250, billing_type: "PIX", first_due_date: "2026-09-28",
}

function seed() {
  events.length = 0
  closeCalls = 0
  asaasPayments = []
  db = {
    tenant_chat_config: [{ company_id: CO, payment_origin: "platform", allow_payment_without_acknowledgement: true, acknowledgement_enabled: true, branding: { brand_name: "VMAX" } }],
    companies: [{ id: CO, name: "VMAX LTDA" }],
    customers: [{ id: CUST, company_id: CO, name: "Fabio Mendes", document: "11144477735" }],
    debts: [{ id: DEBT, company_id: CO, customer_id: CUST, status: "pending", amount: 250, due_date: "2026-08-15", external_id: null }],
    vmax_invoices: [],
    negotiation_sessions: [{ id: SID, company_id: CO, customer_id: CUST, debt_id: DEBT, agreement_id: null }],
    negotiation_offers: [{ id: "off-1", company_id: CO, session_id: SID, customer_id: CUST, debt_id: DEBT, status: "presented", valid_until: null, terms: OFFER_TERMS }],
    negotiation_acceptances: [],
    agreements: [],
    asaas_webhook_events: [],
    chat_messages: [], chat_prompts: [],
  }
}

/** Acordo do usuário de teste após o cancelamento no ASAAS (estado REAL de prod
 *  antes da correção: payment_status deleted, status cancelled, asaas_status PENDING). */
const DEAD = {
  id: "ag-dead", company_id: CO, customer_id: CUST, asaas_payment_id: "pay_dead", asaas_customer_id: "cus_x",
  status: "cancelled", payment_status: "deleted", asaas_status: "PENDING", asaas_billing_type: "PIX",
  asaas_invoice_url: "https://asaas/i/dead", asaas_payment_url: "https://asaas/i/dead", asaas_boleto_url: null, asaas_pix_qrcode_url: null,
  agreed_amount: 250, installments: 1, installment_amount: 250, due_date: "2026-09-28",
}
const LIVE = {
  id: "ag-live", company_id: CO, customer_id: CUST, asaas_payment_id: "pay_live", asaas_customer_id: "cus_x",
  status: "active", payment_status: "pending", asaas_status: "PENDING", asaas_billing_type: "PIX",
  asaas_invoice_url: "https://asaas/i/live", asaas_payment_url: "https://asaas/i/live", asaas_boleto_url: null, asaas_pix_qrcode_url: null,
  agreed_amount: 250, installments: 1, installment_amount: 250, due_date: "2026-10-01",
}

describe("isBlockingAgreement / effectiveAsaasStatusFromWebhook (puros)", () => {
  it("terminal tem precedência sobre asaas_status: cancelled/deleted/refunded NÃO bloqueiam", async () => {
    const { isBlockingAgreement, isTerminalAgreement } = await import("@/lib/asaas-idempotency")
    expect(isBlockingAgreement({ asaas_payment_id: "p", status: "cancelled", payment_status: "deleted", asaas_status: "PENDING" })).toBe(false)
    expect(isBlockingAgreement({ asaas_payment_id: "p", payment_status: "deleted", asaas_status: "PENDING" })).toBe(false)
    expect(isBlockingAgreement({ asaas_payment_id: "p", payment_status: "refunded", asaas_status: "RECEIVED" })).toBe(false)
    expect(isBlockingAgreement({ asaas_payment_id: "p", payment_status: "cancelled", asaas_status: "OVERDUE" })).toBe(false)
    expect(isBlockingAgreement({ asaas_payment_id: "p", status: "cancelled", payment_status: "pending", asaas_status: "PENDING" })).toBe(false)
    expect(isTerminalAgreement({ status: "cancelled" })).toBe(true)
    expect(isTerminalAgreement({ payment_status: "pending" })).toBe(false)
  })

  it("cobrança viva continua bloqueando (pending/overdue/received/confirmed; asaas PENDING)", async () => {
    const { isBlockingAgreement } = await import("@/lib/asaas-idempotency")
    expect(isBlockingAgreement({ asaas_payment_id: "p", status: "active", payment_status: "pending", asaas_status: "PENDING" })).toBe(true)
    expect(isBlockingAgreement({ asaas_payment_id: "p", payment_status: "overdue" })).toBe(true)
    expect(isBlockingAgreement({ asaas_payment_id: "p", payment_status: "received" })).toBe(true)
    expect(isBlockingAgreement({ asaas_payment_id: "p", asaas_status: "PENDING" })).toBe(true)
    expect(isBlockingAgreement({ asaas_payment_id: null, payment_status: "pending" })).toBe(false)
  })

  it("effectiveAsaasStatusFromWebhook: DELETED/REFUNDED explícitos; demais eventos mantêm payment.status", async () => {
    const { effectiveAsaasStatusFromWebhook } = await import("@/lib/asaas-idempotency")
    expect(effectiveAsaasStatusFromWebhook("PAYMENT_DELETED", { status: "PENDING", deleted: true })).toBe("DELETED")
    expect(effectiveAsaasStatusFromWebhook("PAYMENT_UPDATED", { status: "PENDING", deleted: true })).toBe("DELETED")
    expect(effectiveAsaasStatusFromWebhook("PAYMENT_REFUNDED", { status: "REFUNDED" })).toBe("REFUNDED")
    expect(effectiveAsaasStatusFromWebhook("PAYMENT_RECEIVED", { status: "RECEIVED" })).toBe("RECEIVED")
    expect(effectiveAsaasStatusFromWebhook("PAYMENT_CREATED", { status: "PENDING" })).toBe("PENDING")
    expect(effectiveAsaasStatusFromWebhook("PAYMENT_CREATED", null)).toBeNull()
  })
})

describe("webhook ASAAS PAYMENT_DELETED → asaas_status='DELETED'", () => {
  beforeEach(seed)

  async function post(event: string, payment: Record<string, unknown>, eventId = `evt_${Math.random().toString(36).slice(2)}`) {
    const { POST } = await import("@/app/api/asaas/webhook/payments/route")
    const req = {
      headers: { get: () => null },
      json: async () => ({ id: eventId, event, payment }),
    } as any
    return POST(req)
  }

  it("PAYMENT_DELETED (ASAAS mantém status PENDING + deleted:true) grava asaas_status DELETED, payment_status deleted, status cancelled", async () => {
    db.agreements = [{ ...LIVE, id: "ag-1", asaas_payment_id: "pay_1", debt_id: DEBT }]
    const res = await post("PAYMENT_DELETED", { id: "pay_1", status: "PENDING", deleted: true, value: 250, dueDate: "2026-09-28", billingType: "PIX" })
    expect(res.status).toBe(200)
    const ag = db.agreements.find((a) => a.id === "ag-1")!
    expect(ag.asaas_status).toBe("DELETED")
    expect(ag.payment_status).toBe("deleted")
    expect(ag.status).toBe("cancelled")
    // o acordo deixa de bloquear
    const { isBlockingAgreement } = await import("@/lib/asaas-idempotency")
    expect(isBlockingAgreement(ag)).toBe(false)
  })

  it("PAYMENT_REFUNDED grava asaas_status REFUNDED; PAYMENT_CREATED mantém PENDING", async () => {
    db.agreements = [{ ...LIVE, id: "ag-2", asaas_payment_id: "pay_2", debt_id: DEBT }]
    await post("PAYMENT_REFUNDED", { id: "pay_2", status: "REFUNDED", value: 250 })
    expect(db.agreements.find((a) => a.id === "ag-2")!.asaas_status).toBe("REFUNDED")
    db.agreements.push({ ...LIVE, id: "ag-3", asaas_payment_id: "pay_3", debt_id: DEBT, asaas_status: null })
    await post("PAYMENT_CREATED", { id: "pay_3", status: "PENDING", value: 250 })
    expect(db.agreements.find((a) => a.id === "ag-3")!.asaas_status).toBe("PENDING")
  })
})

describe("paymentStatus / GET /api/chat/payment — acordo terminal nunca é 'a cobrança viva'", () => {
  beforeEach(seed)

  it("paymentStatus: acordo da sessão cancelado e nenhum outro → sem link (agreement_id null)", async () => {
    db.agreements = [DEAD]
    db.negotiation_sessions[0].agreement_id = DEAD.id
    const { paymentStatus } = await import("@/lib/journey/payment-actions")
    const s = await paymentStatus(ctx)
    expect(s.agreement_id).toBeNull()
    expect(s.payment).toBeNull()
  })

  it("paymentStatus: acordo da sessão cancelado mas há outro VIVO do cliente → devolve o vivo (from_live_charge)", async () => {
    db.agreements = [DEAD, LIVE]
    db.negotiation_sessions[0].agreement_id = DEAD.id
    const { paymentStatus } = await import("@/lib/journey/payment-actions")
    const s = await paymentStatus(ctx)
    expect(s.agreement_id).toBe("ag-live")
    expect(s.payment?.invoice_url).toBe("https://asaas/i/live")
    expect(s.from_live_charge).toBe(true)
  })

  it("paymentStatus: acordo da sessão VIVO → devolve ele (sem regressão)", async () => {
    db.agreements = [LIVE]
    db.negotiation_sessions[0].agreement_id = LIVE.id
    const { paymentStatus } = await import("@/lib/journey/payment-actions")
    const s = await paymentStatus(ctx)
    expect(s.agreement_id).toBe("ag-live")
    expect(s.payment_status).toBe("pending")
  })

  async function getPayment() {
    const { GET } = await import("@/app/api/chat/payment/route")
    const { signChatJwt } = await import("@/lib/negotiation/crypto")
    const cookie = signChatJwt({ sid: SID, cid: CO }, 3600)
    const res = await GET({ cookies: { get: (n: string) => (n === "alteapay_chat_session" ? { value: cookie } : undefined) } } as any)
    return res.json()
  }

  it("GET /api/chat/payment: acordo cancelado → status 'generating' (nunca 'ready' com link morto)", async () => {
    db.agreements = [DEAD]
    db.negotiation_sessions[0].agreement_id = DEAD.id
    const body = await getPayment()
    expect(body.ok).toBe(true)
    expect(body.status).toBe("generating")
    expect(body.payment).toBeUndefined()
  })

  it("GET /api/chat/payment: acordo vivo → 'ready' com o link; e NÃO grava payment.viewed por poll (N-D1-6)", async () => {
    db.agreements = [LIVE]
    db.negotiation_sessions[0].agreement_id = LIVE.id
    const body = await getPayment()
    expect(body.status).toBe("ready")
    expect(body.payment.invoiceUrl).toBe("https://asaas/i/live")
    await getPayment()
    expect(events.filter((e) => e.type === "payment.viewed").length).toBe(0)
  })
})

describe("guard duplo do confirmAccept: cancelada localmente não bloqueia; ASAAS continua a fonte", () => {
  beforeEach(seed)

  it("acordo cancelado (asaas_status ainda PENDING) + ASAAS sem cobrança viva → cobra de novo (closeAgreement 1x)", async () => {
    db.agreements = [DEAD]
    asaasPayments = [{ id: "pay_dead", status: "PENDING", deleted: true }]
    const { confirmAccept, buildAcceptSummary } = await import("@/lib/journey/closing")
    const pre = await buildAcceptSummary(ctx, "off-1")
    if (!pre.ok) throw new Error("seed")
    const r = await confirmAccept({ ctx, offerId: "off-1", termsHash: pre.summary.termsHash })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.agreementId).toBe("ag-new-1")
    expect(closeCalls).toBe(1)
    expect(events.filter((e) => e.type === "offer.rejected").length).toBe(0)
  })

  it("acordo VIVO → ALREADY_CHARGED (0 closeAgreement)", async () => {
    db.agreements = [LIVE]
    const { confirmAccept, buildAcceptSummary } = await import("@/lib/journey/closing")
    const pre = await buildAcceptSummary(ctx, "off-1")
    if (!pre.ok) throw new Error("seed")
    const r = await confirmAccept({ ctx, offerId: "off-1", termsHash: pre.summary.termsHash })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe("ALREADY_CHARGED")
    expect(closeCalls).toBe(0)
  })

  it("acordo cancelado localmente mas ASAAS ainda com cobrança viva (não deletada) → ALREADY_CHARGED (guard nível-ASAAS continua)", async () => {
    db.agreements = [DEAD]
    asaasPayments = [{ id: "pay_other", status: "PENDING", deleted: false }]
    const { confirmAccept, buildAcceptSummary } = await import("@/lib/journey/closing")
    const pre = await buildAcceptSummary(ctx, "off-1")
    if (!pre.ok) throw new Error("seed")
    const r = await confirmAccept({ ctx, offerId: "off-1", termsHash: pre.summary.termsHash })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe("ALREADY_CHARGED")
    expect(closeCalls).toBe(0)
  })

  it("`pre` já montado pelo chamador é reusado (0 leitura extra de buildAcceptSummary, N-D1-1)", async () => {
    const closing = await import("@/lib/journey/closing")
    const pre = await closing.buildAcceptSummary(ctx, "off-1")
    if (!pre.ok) throw new Error("seed")
    // remove a oferta: se confirmAccept refizesse buildAcceptSummary, falharia com OFFER_NOT_AVAILABLE
    const saved = db.negotiation_offers
    db.negotiation_offers = []
    const r = await closing.confirmAccept({ ctx, offerId: "off-1", termsHash: pre.summary.termsHash, pre: pre.summary })
    db.negotiation_offers = saved
    expect(r.ok).toBe(true)
    expect(closeCalls).toBe(1)
  })
})
