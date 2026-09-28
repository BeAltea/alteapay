// Guard ASAAS fail-closed: `getAsaasPaymentsForCustomer` devolvia [] quando o
// ASAAS falhava, e o guard ASAAS (fonte da verdade do D7) deixava a cobrança
// passar — só o guard local segurava. Agora a consulta LANÇA
// AsaasGuardUnavailableError e o Pagar/fechamento NÃO cria cobrança: devolve o
// resultado retentável que o chat e o n8n já tratam (503 charge_deferred → o
// chat grava 'erro_cobranca', painel com "tentar de novo"). Ordem do guard duplo
// mantida: local primeiro (bloqueia sem consultar o ASAAS), depois ASAAS.
import { afterEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

const CO = "eeeeeeee-0000-0000-0000-00000000fc01"
const SESSION = "5e550000-0000-0000-0000-00000000fc01"
const DEBT = "d5000000-0000-4000-8000-00000000fc01"
const CUST = "c5000000-0000-0000-0000-00000000fc01"
const OFFER = "0ffe0000-0000-0000-0000-00000000fc01"
const ctx = { sessionId: SESSION, companyId: CO, customerId: CUST, debtId: DEBT }

let db: FakeDb
const calls: string[] = []
let asaasMode: "down" | "ok" = "down"

vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/asaas", async () => {
  const real = await vi.importActual<typeof import("@/lib/asaas")>("@/lib/asaas")
  return {
    AsaasGuardUnavailableError: real.AsaasGuardUnavailableError,
    isAsaasGuardUnavailable: real.isAsaasGuardUnavailable,
    getAsaasPaymentsForCustomer: async (id: string) => {
      calls.push("list")
      if (asaasMode === "down") throw new real.AsaasGuardUnavailableError(id, "Erro ASAAS (status 503)")
      return []
    },
    getAsaasCustomerByCpfCnpj: async () => ({ id: "cus_known" }),
    updateAsaasCustomer: async () => ({ id: "cus_known" }),
    createAsaasCustomer: async () => ({ id: "cus_new" }),
    createAsaasPayment: async (params: any) => {
      calls.push("create_payment")
      return {
        id: "pay_new", status: "PENDING", billingType: params.billingType, value: params.value, dueDate: params.dueDate,
        externalReference: params.externalReference, invoiceUrl: "https://asaas/i/x", bankSlipUrl: null, pixQrCodeUrl: null,
      }
    },
    getAsaasPaymentByExternalReference: async () => null,
    getAsaasPayment: async () => null,
  }
})
vi.mock("@/lib/journey/events", () => ({ recordEvent: async () => ({ ok: true, duplicate: false }) }))
vi.mock("@/lib/journey/actions", () => ({
  rejectOffer: async (_c: any, offerId: string, _a: string, reason: string) => {
    calls.push(`reject:${reason}`)
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
const oldAgreement = {
  id: "ag-old", company_id: CO, customer_id: CUST, debt_id: DEBT, status: "cancelled",
  payment_status: "deleted", asaas_payment_id: "pay_old", asaas_customer_id: "cus_known", created_at: "2026-09-01T00:00:00Z",
}

function seed(agreements: any[] = [oldAgreement]) {
  db = {
    tenant_chat_config: [{ company_id: CO, payment_origin: "platform", acknowledgement_enabled: false, allow_payment_without_acknowledgement: true }],
    companies: [{ id: CO, name: "VMAX" }],
    customers: [{ id: CUST, company_id: CO, name: "Teste", document: "11144477735", email: null, phone: null }],
    debts: [{ id: DEBT, company_id: CO, customer_id: CUST, amount: 250, status: "pending", due_date: "2026-08-15" }],
    negotiation_sessions: [{ id: SESSION, company_id: CO, agreement_id: null }],
    negotiation_offers: [{ id: OFFER, session_id: SESSION, terms: TERMS, status: "presented", valid_until: null }],
    negotiation_acceptances: [],
    agreements: agreements.map((a) => ({ ...a })),
    debt_acknowledgement_latest: [],
  }
  calls.length = 0
}
const newAgreements = () => db.agreements!.filter((a) => a.id !== "ag-old")

afterEach(() => {
  asaasMode = "down"
  delete process.env.ASAAS_API_KEY
  vi.unstubAllGlobals()
})

describe("guard ASAAS fail-closed", () => {
  it("ASAAS fora do ar: Pagar NÃO cria cobrança nem acordo; 503 charge_deferred (retentável); oferta segue presented", async () => {
    process.env.CHARGE_MODE = "inline"
    seed()
    const { paymentCreate } = await import("@/lib/journey/payment-actions")
    const r = await paymentCreate(ctx, OFFER)
    expect(r).toMatchObject({ ok: false, status: 503, code: "charge_deferred" })
    expect(calls).toContain("list")
    expect(calls).not.toContain("create_payment")
    expect(newAgreements()).toHaveLength(0)
    expect(db.negotiation_acceptances).toHaveLength(0)
    expect(db.negotiation_offers![0].status).toBe("presented")
    expect(db.debts![0].status).toBe("pending")
  })

  it("mesmo com a consulta antecipada (prefetch do clique) rejeitada, o confirm relê e continua fail-closed", async () => {
    process.env.CHARGE_MODE = "inline"
    seed()
    const { paymentCreate } = await import("@/lib/journey/payment-actions")
    const { AsaasGuardUnavailableError } = await import("@/lib/asaas")
    const asaasGuard = Promise.reject(new AsaasGuardUnavailableError("cus_known"))
    asaasGuard.catch(() => {})
    const r = await paymentCreate(ctx, OFFER, undefined, { asaasGuard })
    expect(r).toMatchObject({ ok: false, status: 503, code: "charge_deferred" })
    expect(calls).not.toContain("create_payment")
    expect(newAgreements()).toHaveLength(0)
  })

  it("paymentCreateOrExistingLink (entrada do chat e do n8n) devolve o erro retentável, sem link e sem cobrança", async () => {
    process.env.CHARGE_MODE = "inline"
    seed()
    const { paymentCreateOrExistingLink } = await import("@/lib/journey/payment-actions")
    const r = await paymentCreateOrExistingLink(ctx, OFFER)
    expect(r).toMatchObject({ ok: false, status: 503, code: "charge_deferred" })
    expect(calls).not.toContain("create_payment")
  })

  it("ordem do guard duplo mantida: acordo vivo local bloqueia ANTES de consultar o ASAAS", async () => {
    process.env.CHARGE_MODE = "inline"
    seed([
      oldAgreement,
      { id: "ag-live", company_id: CO, customer_id: CUST, debt_id: DEBT, status: "active", payment_status: "pending",
        asaas_payment_id: "pay_local", asaas_status: "PENDING", created_at: "2026-09-27T00:00:00Z" },
    ])
    const { confirmAccept, buildAcceptSummary } = await import("@/lib/journey/closing")
    const pre = await buildAcceptSummary(ctx, OFFER)
    expect(pre.ok).toBe(true)
    const r = await confirmAccept({ ctx, offerId: OFFER, termsHash: pre.ok ? pre.summary.termsHash : "" })
    expect(r).toEqual({ ok: false, error: "ALREADY_CHARGED" })
    expect(calls).not.toContain("list")
    expect(calls).not.toContain("create_payment")
  })

  it("ASAAS de volta: a nova tentativa cobra exatamente uma vez", async () => {
    process.env.CHARGE_MODE = "inline"
    seed()
    const { paymentCreate } = await import("@/lib/journey/payment-actions")
    expect((await paymentCreate(ctx, OFFER)).ok).toBe(false)
    asaasMode = "ok"
    const r = await paymentCreate(ctx, OFFER)
    expect(r.ok && r.status).toBe("created")
    expect(calls.filter((c) => c === "create_payment")).toHaveLength(1)
  })

  it("payment.record (variante B): ASAAS fora do ar → 503 retentável, nada registrado", async () => {
    seed()
    const { paymentRecord } = await import("@/lib/journey/payment-actions")
    const before = db.agreements!.length
    const r = await paymentRecord(ctx, { offer_id: OFFER, status: "PENDING", asaas_payment_id: "pay_ext" })
    expect(r).toMatchObject({ ok: false, status: 503, code: "charge_deferred" })
    expect(db.agreements!.length).toBe(before)
  })
})

describe("getAsaasPaymentsForCustomer (real) — lança em vez de devolver []", () => {
  const withFetch = (impl: () => Promise<Response>) => vi.stubGlobal("fetch", vi.fn(impl))
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

  it("HTTP 500 do ASAAS → AsaasGuardUnavailableError", async () => {
    process.env.ASAAS_API_KEY = "test-key"
    const real = await vi.importActual<typeof import("@/lib/asaas")>("@/lib/asaas")
    withFetch(async () => json(500, { errors: [{ description: "boom" }] }))
    const err = await real.getAsaasPaymentsForCustomer("cus_x").catch((e) => e)
    expect(real.isAsaasGuardUnavailable(err)).toBe(true)
    expect(err).toBeInstanceOf(real.AsaasGuardUnavailableError)
  })

  it("rede caída → AsaasGuardUnavailableError", async () => {
    process.env.ASAAS_API_KEY = "test-key"
    const real = await vi.importActual<typeof import("@/lib/asaas")>("@/lib/asaas")
    withFetch(async () => { throw new TypeError("fetch failed") })
    await expect(real.getAsaasPaymentsForCustomer("cus_x")).rejects.toMatchObject({ code: "ASAAS_GUARD_UNAVAILABLE" })
  })

  it("200 sem lista `data` → AsaasGuardUnavailableError (nunca 'sem cobranças' no escuro)", async () => {
    process.env.ASAAS_API_KEY = "test-key"
    const real = await vi.importActual<typeof import("@/lib/asaas")>("@/lib/asaas")
    withFetch(async () => json(200, { object: "list" }))
    await expect(real.getAsaasPaymentsForCustomer("cus_x")).rejects.toMatchObject({ code: "ASAAS_GUARD_UNAVAILABLE" })
  })

  it("200 com lista → devolve as cobranças", async () => {
    process.env.ASAAS_API_KEY = "test-key"
    const real = await vi.importActual<typeof import("@/lib/asaas")>("@/lib/asaas")
    withFetch(async () => json(200, { data: [{ id: "pay_1", status: "PENDING" }] }))
    await expect(real.getAsaasPaymentsForCustomer("cus_x")).resolves.toEqual([{ id: "pay_1", status: "PENDING" }])
  })

  it("pagina: cobrança viva na 2ª página entra na lista (limit=100 + offset)", async () => {
    process.env.ASAAS_API_KEY = "test-key"
    const real = await vi.importActual<typeof import("@/lib/asaas")>("@/lib/asaas")
    const urls: string[] = []
    vi.stubGlobal("fetch", vi.fn(async (u: string) => {
      urls.push(String(u))
      const first = String(u).includes("offset=0")
      return json(200, first
        ? { data: Array.from({ length: 100 }, (_, i) => ({ id: `pay_old_${i}`, status: "RECEIVED" })), hasMore: true }
        : { data: [{ id: "pay_live", status: "PENDING" }], hasMore: false })
    }))
    const list = await real.getAsaasPaymentsForCustomer("cus_x")
    expect(list).toHaveLength(101)
    expect(list.some((p) => p.id === "pay_live")).toBe(true)
    expect(urls.every((u) => u.includes("limit=100"))).toBe(true)
  })

  it("acima do teto de páginas → falha fechado", async () => {
    process.env.ASAAS_API_KEY = "test-key"
    const real = await vi.importActual<typeof import("@/lib/asaas")>("@/lib/asaas")
    withFetch(async () => json(200, { data: [{ id: "pay", status: "RECEIVED" }], hasMore: true }))
    await expect(real.getAsaasPaymentsForCustomer("cus_x")).rejects.toMatchObject({ code: "ASAAS_GUARD_UNAVAILABLE" })
  })
})
