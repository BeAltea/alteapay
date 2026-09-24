// Trilha PAGAR AGORA (§6.4): payService gera uma oferta INTEGRAL 0% (valor da
// fonte canônica) e cobra pelo caminho canônico (payment.create interno, guard
// D7 + revalidação de matriz + already_charged/D23). Devolve { ok, link, valor,
// vencimento_link (D+3), already_charged? }. NUNCA declara pago; NUNCA 2ª
// cobrança; erro do ASAAS vira rótulo curto (não a mensagem crua).
//
// Só o núcleo do ASAAS (closing/confirmAccept + lib/asaas) é mockado — a oferta
// integral, a matriz, o valor canônico e o roteamento de payment-actions são
// REAIS (integração da trilha).
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

const CO = "eeeeeeee-0000-0000-0000-0000000000d3"
const SID = "s1"
const CUST = "cust1"
const DEBT = "debt1"
const ctx = { sessionId: SID, companyId: CO, customerId: CUST, debtId: DEBT }

let db: FakeDb
let confirmCalls = 0
let confirmMode: "created" | "processing" | "already_charged" | "close_failed" = "created"

vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/asaas", () => ({ getAsaasPaymentsForCustomer: async () => [] }))
vi.mock("@/lib/journey/events", () => ({ recordEvent: async () => ({ ok: true, duplicate: false }) }))

// closing/closeAgreement mockados: confirmAccept representa o caminho canônico
// (closeAgreement → charge-inline). Registra o acordo + acceptance como o real
// faria, para exercitar a idempotência (session,offer) de paymentCreate.
vi.mock("@/lib/journey/closing", () => ({
  buildAcceptSummary: async () => ({ ok: true, summary: { termsHash: "h", terms: {}, validUntil: null } }),
  confirmAccept: async ({ offerId }: { offerId: string }) => {
    confirmCalls += 1
    if (confirmMode === "already_charged") {
      return { ok: false, error: "ALREADY_CHARGED" }
    }
    if (confirmMode === "close_failed") {
      return { ok: false, error: "CLOSE_FAILED" }
    }
    const agId = "agNew"
    if (confirmMode === "created") {
      ;(db.agreements ??= []).push({
        id: agId, company_id: CO, customer_id: CUST, asaas_payment_id: "pay_new",
        asaas_billing_type: "PIX", agreed_amount: 250, installments: 1, due_date: "2026-09-27",
        asaas_pix_qrcode_url: "pixcopy", asaas_boleto_url: null,
        asaas_invoice_url: "https://asaas/checkout/pay_new",
        payment_status: "pending", asaas_status: "PENDING",
      })
    } else {
      // processing: acordo sem asaas_payment_id ainda (worker não gravou).
      ;(db.agreements ??= []).push({
        id: agId, company_id: CO, customer_id: CUST, asaas_payment_id: null,
        agreed_amount: 250, installments: 1, due_date: null, payment_status: "pending",
      })
    }
    ;(db.negotiation_acceptances ??= []).push({ company_id: CO, session_id: SID, offer_id: offerId, agreement_id: agId })
    return { ok: true, agreementId: agId }
  },
}))

const MATRIX = {
  id: "mx-1", company_id: CO, name: "default", priority: 1, active: true,
  valid_from: null, valid_to: null, aging_min_days: 0, aging_max_days: null,
  aging_basis: "oldest_due", max_discount_pct: 30, installment_discount_pct: 10,
  min_entry_pct: 20, max_installments: 3, min_installment_value: 10,
  allowed_billing_types: ["PIX", "BOLETO"], proposal_validity_days: 7,
  retry_after_days: 3, max_retries: 2, min_debt_value: 0,
}

function seed(opts: { matrix?: any[]; amount?: number; live?: boolean } = {}) {
  confirmCalls = 0
  confirmMode = "created"
  const amount = opts.amount ?? 250
  db = {
    tenant_chat_config: [{ company_id: CO, payment_origin: "platform", allow_payment_without_acknowledgement: true, acknowledgement_enabled: true, branding: {} }],
    companies: [{ id: CO, name: "VMAX" }],
    customers: [{ id: CUST, company_id: CO, name: "Fabio Mendes", document: "11144477735" }],
    debts: [{ id: DEBT, company_id: CO, customer_id: CUST, status: "pending", amount, due_date: "2020-01-01" }],
    vmax_invoices: [],
    negotiation_sessions: [{ id: SID, company_id: CO, customer_id: CUST, debt_id: DEBT, agreement_id: null }],
    negotiation_offers: [],
    negotiation_condition_matrix: opts.matrix ?? [MATRIX],
    negotiation_acceptances: [],
    agreements: opts.live
      ? [{
          id: "agLive", company_id: CO, customer_id: CUST, asaas_payment_id: "pay_live",
          payment_status: "pending", asaas_status: "PENDING", asaas_billing_type: "BOLETO",
          agreed_amount: 250, installments: 1, due_date: "2026-11-01",
          asaas_boleto_url: "https://asaas/b/live", asaas_invoice_url: "https://asaas/i/live", asaas_pix_qrcode_url: null,
        }]
      : [],
    debt_acknowledgement_latest: [],
  }
  delete process.env.PAYMENT_ORIGIN
  delete process.env.PAY_LINK_DUE_DAYS
}

describe("payService — Pagar Agora (§6.4)", () => {
  beforeEach(() => seed())

  it("sucesso: gera oferta INTEGRAL 0% e devolve link + valor canônico + vencimento", async () => {
    const { payService } = await import("@/lib/journey/pay")
    const r = await payService(ctx)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.valor).toBe(250) // valor canônico (buildAckContext.updatedValue)
      expect(r.link).toBe("https://asaas/checkout/pay_new")
      expect(r.vencimento_link).toBe("2026-09-27")
      expect(r.already_charged).toBe(false)
      expect(r.processing).toBe(false)
      expect(r.agreement_id).toBe("agNew")
    }
    expect(confirmCalls).toBe(1)
  })

  it("a oferta persistida é INTEGRAL 0% (valor base, 1 parcela, sem desconto)", async () => {
    const { payService } = await import("@/lib/journey/pay")
    await payService(ctx)
    const offers = db.negotiation_offers ?? []
    expect(offers.length).toBe(1)
    const terms = offers[0].terms
    expect(terms.discount_pct).toBe(0)
    expect(terms.discount_value).toBe(0)
    expect(terms.installments).toBe(1)
    expect(terms.total_value).toBe(250)
    expect(terms.original_value).toBe(250)
    // billing à vista da matriz (PIX tem precedência)
    expect(terms.billing_type).toBe("PIX")
  })

  it("vencimento do link = D+3 por padrão (parametrizável)", async () => {
    const { payLinkDueDays } = await import("@/lib/journey/pay")
    expect(payLinkDueDays()).toBe(3)
    process.env.PAY_LINK_DUE_DAYS = "5"
    expect(payLinkDueDays()).toBe(5)
    delete process.env.PAY_LINK_DUE_DAYS
    // a oferta usa D+payLinkDueDays no first_due_date
    const { payService } = await import("@/lib/journey/pay")
    const expected = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10)
    await payService(ctx)
    expect((db.negotiation_offers ?? [])[0].terms.first_due_date).toBe(expected)
  })

  it("already_charged: devolve o LINK EXISTENTE, NUNCA cria 2ª cobrança", async () => {
    seed({ live: true })
    confirmMode = "already_charged"
    const { payService } = await import("@/lib/journey/pay")
    const r = await payService(ctx)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.already_charged).toBe(true)
      expect(r.link).toBe("https://asaas/i/live") // invoice do acordo vivo
      expect(r.valor).toBe(250)
    }
    // só o acordo VIVO pré-existente permanece (nenhuma 2ª cobrança criada)
    expect((db.agreements ?? []).length).toBe(1)
  })

  it("clique repetido em PAGAR reusa a MESMA oferta e NÃO recobra (idempotência)", async () => {
    const { payService } = await import("@/lib/journey/pay")
    const r1 = await payService(ctx)
    const r2 = await payService(ctx)
    expect(r1.ok && r2.ok).toBe(true)
    // 1 só oferta integral persistida (não empilha a cada clique)
    expect((db.negotiation_offers ?? []).length).toBe(1)
    // confirmAccept chamado só 1x: a 2ª chamada bate na idempotência (session,offer)
    expect(confirmCalls).toBe(1)
    if (r1.ok && r2.ok) expect(r2.agreement_id).toBe(r1.agreement_id)
  })

  it("sem linha de matriz → { ok:false, error } com rótulo curto (0 cobrança)", async () => {
    seed({ matrix: [] })
    const { payService } = await import("@/lib/journey/pay")
    const r = await payService(ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe("no_matrix_row")
    expect(confirmCalls).toBe(0)
  })

  it("dívida sem valor em aberto → { ok:false, error:'no_open_amount' }", async () => {
    seed({ amount: 0 })
    const { payService } = await import("@/lib/journey/pay")
    const r = await payService(ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe("no_open_amount")
    expect(confirmCalls).toBe(0)
  })

  it("guard de reconhecimento (409) → rótulo curto debt_not_acknowledged, sem cobrança", async () => {
    // ack desligado por flag → agora exigimos reconhecimento e não há
    db.tenant_chat_config = [{ company_id: CO, payment_origin: "platform", allow_payment_without_acknowledgement: false, acknowledgement_enabled: true, branding: {} }]
    const { payService } = await import("@/lib/journey/pay")
    const r = await payService(ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe("debt_not_acknowledged")
    expect(confirmCalls).toBe(0)
  })

  it("erro do caminho de cobrança vira rótulo curto (não mensagem crua do ASAAS)", async () => {
    // confirmAccept devolve CLOSE_FAILED → paymentCreate mapeia p/ code=CLOSE_FAILED
    confirmMode = "close_failed"
    const { payService } = await import("@/lib/journey/pay")
    const r = await payService(ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      // rótulo curto e estável — nunca uma frase de erro do ASAAS/HTTP
      expect(r.error).toBe("CLOSE_FAILED")
      expect(r.error.length).toBeLessThan(40)
      expect(r.error).not.toMatch(/http|asaas|<|>|\s{2,}/i)
    }
  })

  it("processing (worker off, sem link ainda): NÃO declara pago, marca processing", async () => {
    confirmMode = "processing"
    const { payService } = await import("@/lib/journey/pay")
    const r = await payService(ctx)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.processing).toBe(true)
      expect(r.link).toBeNull()
      expect(r.already_charged).toBe(false)
    }
    // nenhum agreement marcado como pago
    expect((db.agreements ?? []).some((a) => a.payment_status && a.payment_status !== "pending")).toBe(false)
  })
})
