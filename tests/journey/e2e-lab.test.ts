// N7 — E2E de laboratório (MOCK_ALL_INTEGRATIONS=1, engine stub). Exercita a
// jornada pelas bibliotecas reais com DB em memória e integrações mockadas:
//   auth genérica (CPF e CNPJ) → contexto mascarado → turno stub (ações) →
//   accept/payment.create (guard) → repetir accept = 0 cobrança nova →
//   payment.record recusa pago → 4 docs errados = lock.
// Não sobe servidor Next; valida o encadeamento determinístico das regras.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

process.env.MOCK_ALL_INTEGRATIONS = "1"
process.env.NEGOTIATION_ENGINE = "stub"
process.env.CHAT_JOURNEY_ENABLED = "true"

const CO = "ffffffff-0000-0000-0000-000000000006"
const CPF = "11144477735"
const CNPJ = "11222333000181"
const CUST_CPF = "c0000001-0000-0000-0000-000000000001"
const CUST_CNPJ = "c0000002-0000-0000-0000-000000000002"
const DEBT_CPF = "d0000001-0000-0000-0000-000000000001"
const DEBT_CNPJ = "d0000002-0000-0000-0000-000000000002"

let db: FakeDb
let chargeAdds = 0
let asaasPayments: any[] = []

vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/queue/queues", () => ({
  chargeQueue: { add: async () => { chargeAdds++; return { id: `job_${chargeAdds}` } } },
  n8nQueue: { add: async () => ({ id: "j" }) },
}))
vi.mock("@/lib/asaas", () => ({ getAsaasPaymentsForCustomer: async () => asaasPayments }))
vi.mock("@/lib/journey/events", () => ({
  recordEvent: async () => ({ ok: true, duplicate: false }),
  getTimeline: async () => [],
}))
vi.mock("@/lib/negotiation/sessions", () => ({
  createHandoffSession: async (i: any) => {
    const id = `sess_${Math.random().toString(36).slice(2, 8)}`
    ;(db.negotiation_sessions ??= []).push({
      id, company_id: i.company_id, customer_id: i.customer_id, debt_id: i.debt_id,
      identity_verified_at: i.identity_verified ? new Date().toISOString() : null,
    })
    return { session: { id }, token: "t", deep_link: "x" }
  },
  // reuso real sobre o fake db: só reaproveita sessão 'open' recente do mesmo
  // cliente. Neste lab cada teste autentica UMA vez, então sempre cai no create.
  findReusableOpenSession: async (i: any) => {
    const cutoff = Date.now() - i.ttlMinutes * 60_000
    const rows = (db.negotiation_sessions ?? []).filter(
      (s: any) =>
        s.company_id === i.companyId &&
        s.customer_id === i.customerId &&
        s.status === "open" &&
        s.last_activity_at != null &&
        new Date(s.last_activity_at).getTime() >= cutoff,
    )
    rows.sort((a: any, b: any) => (b.last_activity_at ?? "").localeCompare(a.last_activity_at ?? ""))
    return rows[0] ?? null
  },
  reopenSession: async (i: any) => {
    const sess = (db.negotiation_sessions ?? []).find((s: any) => s.id === i.sessionId)
    if (sess) {
      sess.last_activity_at = new Date().toISOString()
      sess.reopen_count = (i.currentReopenCount ?? 0) + 1
    }
  },
}))
vi.mock("@/lib/negotiation/crypto", () => ({
  signChatJwt: () => "jwt", CHAT_COOKIE_NAME: "alteapay_chat_session",
}))

function seedBase() {
  chargeAdds = 0
  asaasPayments = []
  db = {
    tenant_chat_config: [
      { company_id: CO, branding: { brand_name: "VMAX", slug: "vmax" }, payment_origin: "platform", send_document_to_engine: false, auth_max_attempts: 3, auth_lock_minutes: 30, session_ttl_minutes: 60 },
    ],
    companies: [{ id: CO, name: "VMAX LTDA" }],
    customers: [
      { id: CUST_CPF, company_id: CO, name: "Fabio Silva", document: CPF, phone: "1199", email: "f@x.com" },
      { id: CUST_CNPJ, company_id: CO, name: "Empresa X", document: CNPJ, phone: "1188", email: "e@x.com" },
    ],
    debts: [
      { id: DEBT_CPF, company_id: CO, customer_id: CUST_CPF, status: "pending", amount: 1000, due_date: "2020-01-01" },
      { id: DEBT_CNPJ, company_id: CO, customer_id: CUST_CNPJ, status: "pending", amount: 2000, due_date: "2020-01-01" },
    ],
    vmax_invoices: [
      { id_company: CO, doc: CPF, fatura: "F1", vencimento: "2020-01-01", saldo: 1000 },
      { id_company: CO, doc: CNPJ, fatura: "F2", vencimento: "2020-01-01", saldo: 2000 },
    ],
    negotiation_sessions: [],
    negotiation_offers: [],
    negotiation_acceptances: [],
    negotiation_condition_matrix: [
      { id: "mx", company_id: CO, name: "faixa", priority: 10, active: true, valid_from: null, valid_to: null, aging_min_days: 0, aging_max_days: null, aging_basis: "oldest_due", max_discount_pct: 20, installment_discount_pct: 10, min_entry_pct: 20, max_installments: 3, min_installment_value: 30, allowed_billing_types: ["PIX", "BOLETO"], proposal_validity_days: 7, retry_after_days: null, max_retries: null, min_debt_value: 0 },
    ],
    agreements: [],
  }
}

describe("E2E lab — jornada genérica (CPF e CNPJ)", () => {
  beforeEach(seedBase)

  it.each([
    ["CPF", CPF, CUST_CPF, DEBT_CPF],
    ["CNPJ", CNPJ, CUST_CNPJ, DEBT_CNPJ],
  ])("autentica por %s, gera oferta, aceita e cria UMA cobrança; repetir = 0 nova", async (_l, doc, custId, debtId) => {
    const { authenticateByDocument } = await import("@/lib/journey/generic-auth")
    const auth = await authenticateByDocument({
      companyId: CO, document: doc, consent: true, ip: "1.1.1.1", userAgent: "t", captchaToken: null, channel: "web_generic",
    })
    expect(auth.ok).toBe(true)
    if (!auth.ok) return
    const sessionId = auth.sessionId

    // contexto mascarado (nunca doc em claro)
    const { buildSessionContext } = await import("@/lib/journey/context")
    const ctx = await buildSessionContext(sessionId)
    expect(ctx!.customer.document).toBeNull()
    expect(JSON.stringify(ctx)).not.toContain(doc)

    // gera ofertas da matriz
    const { listOffers } = await import("@/lib/journey/actions")
    const sctx = { sessionId, companyId: CO, customerId: custId, debtId }
    const offers = await listOffers(sctx)
    expect(offers.length).toBeGreaterThan(0)

    // aceita (guard + close + cobrança)
    const { buildAcceptSummary, confirmAccept } = await import("@/lib/journey/closing")
    const pre = await buildAcceptSummary(sctx, offers[0].id)
    expect(pre.ok).toBe(true)
    if (!pre.ok) return
    const r1 = await confirmAccept({ ctx: sctx, offerId: offers[0].id, termsHash: pre.summary.termsHash })
    expect(r1.ok).toBe(true)
    expect(chargeAdds).toBe(1)

    // idempotência: reenviar o mesmo aceite não cria nova cobrança
    const r2 = await confirmAccept({ ctx: sctx, offerId: offers[0].id, termsHash: pre.summary.termsHash })
    expect(r2.ok).toBe(true)
    expect(chargeAdds).toBe(1) // 0 nova
  })

  it("4 documentos errados no mesmo IP → lock", async () => {
    process.env.CHAT_AUTH_IP_MAX_ATTEMPTS = "5"
    const { authenticateByDocument } = await import("@/lib/journey/generic-auth")
    // 4 docs com DV inválido (falham) — o lock por documento dispara em 3.
    for (const bad of ["11144477736", "11144477736", "11144477736", "11144477736"]) {
      await authenticateByDocument({ companyId: CO, document: bad, consent: true, ip: "2.2.2.2", userAgent: "t", captchaToken: null, channel: "web_generic" })
    }
    const locks = db.chat_auth_generic_locks ?? []
    expect(locks.length).toBeGreaterThan(0)
    delete process.env.CHAT_AUTH_IP_MAX_ATTEMPTS
  })

  it("payment.record com status pago 2x → claim (nunca acordo pago)", async () => {
    seedBase()
    db.tenant_chat_config[0].payment_origin = "n8n"
    const sctx = { sessionId: "sX", companyId: CO, customerId: CUST_CPF, debtId: DEBT_CPF }
    db.negotiation_sessions.push({ id: "sX", company_id: CO, agreement_id: null })
    vi.doMock("@/lib/journey/actions", async (orig) => {
      const actual = (await orig()) as any
      return { ...actual, registerPaymentClaim: async () => "case_1", rejectOffer: async () => undefined }
    })
    const { paymentRecord } = await import("@/lib/journey/payment-actions")
    const a = await paymentRecord(sctx, { status: "received" })
    const b = await paymentRecord(sctx, { status: "confirmed" })
    expect(a.ok && a.code).toBe("claim")
    expect(b.ok && b.code).toBe("claim")
    expect((db.agreements ?? []).some((ag) => ag.payment_status && ag.payment_status !== "pending")).toBe(false)
    vi.doUnmock("@/lib/journey/actions")
  })
})
