// QA rodada 6 (Q2r2-01 / Q3r2-01, ALTO) — o 1º Pagar do menu dava
// `charge_deferred` em 3/3 porque `ensureIntegralOffer` percorria EM SÉRIE as
// ~60 ofertas integrais `accepted` da sessão (2 consultas cada; offer;dur 19–21 s).
// Agora: no máximo duas rodadas de leitura, sem laço de I/O por oferta. Prova com
// 120 ofertas históricas e um banco que custa 40 ms por consulta: < 500 ms e
// contagem de consultas constante.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

const CO = "eeeeeeee-0000-0000-0000-0000000qa6p1"
const SID = "sess-qa6-offer"
const CUST = "cust-qa6-offer"
const DEBT = "debt-qa6-offer"
const ctx = { sessionId: SID, companyId: CO, customerId: CUST, debtId: DEBT }
const QUERY_MS = 40

let db: FakeDb
let counts: Record<string, number> = {}

function delayed(dbRef: () => FakeDb) {
  return {
    from(table: string) {
      counts[table] = (counts[table] ?? 0) + 1
      const qb: any = makeFakeSupabase(dbRef()).from(table)
      const wait = () => new Promise((r) => setTimeout(r, QUERY_MS))
      const origThen = qb.then.bind(qb)
      qb.then = (res: any, rej: any) =>
        wait().then(() => new Promise((r) => origThen(r))).then(res, rej)
      const ms = qb.maybeSingle.bind(qb)
      qb.maybeSingle = async () => { await wait(); return ms() }
      const sg = qb.single.bind(qb)
      qb.single = async () => { await wait(); return sg() }
      return qb
    },
  }
}

vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => delayed(() => db) }))
vi.mock("@/lib/journey/events", () => ({ recordEvent: async () => ({ ok: true, duplicate: false }), getTimeline: async () => [] }))
vi.mock("@/lib/journey/acknowledgement", () => ({
  buildAckContext: async () => ({ updatedValue: 250, creditorName: "VMAX" }),
  persistAssistantMessage: async () => null,
  reopenThreeOptions: async () => ({ ok: true }),
  REOPEN_MENU_QUESTION: "Como prefere seguir?",
}))
vi.mock("@/lib/journey/actions", async (orig) => ({
  ...(await orig<typeof import("@/lib/journey/actions")>()),
  debtSummary: async () => ({ agingDays: 42, originalValue: 250 }),
}))
vi.mock("@/lib/negotiation/matrix", async (orig) => ({
  ...(await orig<typeof import("@/lib/negotiation/matrix")>()),
  resolveMatrixRow: async () => ({
    id: "mx-qa6", company_id: CO, name: "VMAX 0-89", priority: 1, active: true,
    valid_from: null, valid_to: null, aging_min_days: 0, aging_max_days: 89,
    aging_basis: "oldest_due", max_discount_pct: 5, installment_discount_pct: 2.5,
    min_entry_pct: 0, max_installments: 3, min_installment_value: 30,
    allowed_billing_types: ["PIX", "BOLETO", "CREDIT_CARD"], proposal_validity_days: 7,
    retry_after_days: 3, max_retries: 2, min_debt_value: 0,
  }),
}))

const INTEGRAL = { original_value: 250, discount_pct: 0, discount_value: 0, entry_value: 0, installments: 1, installment_value: 250, total_value: 250, billing_type: "PIX", first_due_date: "2026-09-29" }
const MATRIX_CASH = { ...INTEGRAL, discount_pct: 5, discount_value: 12.5, installment_value: 237.5, total_value: 237.5 }

/** N ofertas integrais aceitas, cada uma com um acordo CANCELADO (histórico real do QA). */
function seed(historic = 120) {
  counts = {}
  db = { negotiation_offers: [], negotiation_acceptances: [], agreements: [] }
  const base = Date.now() - historic * 60_000
  for (let i = 0; i < historic; i++) {
    const created = new Date(base + i * 60_000).toISOString()
    db.negotiation_offers.push({ id: `off-${i}`, company_id: CO, session_id: SID, source: "system", status: "accepted", terms: INTEGRAL, valid_until: null, created_at: created })
    db.negotiation_acceptances.push({ company_id: CO, session_id: SID, offer_id: `off-${i}`, agreement_id: `ag-${i}` })
    db.agreements.push({ id: `ag-${i}`, company_id: CO, customer_id: CUST, asaas_payment_id: `pay_${i}`, payment_status: "deleted", asaas_status: "DELETED", status: "cancelled", origin: "chat_journey", offer_id: `off-${i}`, negotiation_session_id: SID, created_at: created })
  }
  // conjunto da matriz (não integral) também no histórico
  for (let i = 0; i < 30; i++) {
    db.negotiation_offers.push({ id: `mx-${i}`, company_id: CO, session_id: SID, source: "system", status: "accepted", terms: MATRIX_CASH, valid_until: null, created_at: new Date(base).toISOString() })
  }
}

describe("QA rodada 6 — ensureIntegralOffer sem laço serial (Q2r2-01)", () => {
  beforeEach(() => seed())

  it("120 integrais aceitas com acordos cancelados → oferta NOVA em < 500 ms, 1 leitura de aceites e ≤ 1 de acordos", async () => {
    const { ensureIntegralOffer } = await import("@/lib/journey/pay")
    const t0 = Date.now()
    const r = await ensureIntegralOffer(ctx, [DEBT])
    const ms = Date.now() - t0
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.valor).toBe(250)
    expect(r.offerId.startsWith("off-")).toBe(false) // nenhum acordo vivo → oferta nova
    const created = db.negotiation_offers.find((o) => o.id === r.offerId)!
    expect(created.status).toBe("presented")
    expect(created.terms.purpose).toBe("pay_integral")
    expect(ms).toBeLessThan(500)
    expect(counts.negotiation_acceptances).toBe(1)
    expect(counts.agreements ?? 0).toBeLessThanOrEqual(1)
    expect(counts.negotiation_offers).toBe(2) // 1 leitura + 1 insert
  })

  it("uma das 120 tem acordo VIVO → reusa essa oferta (idempotência preservada), ainda em < 500 ms", async () => {
    Object.assign(db.agreements[77], { payment_status: "pending", asaas_status: "PENDING", status: "active" })
    const { ensureIntegralOffer } = await import("@/lib/journey/pay")
    const t0 = Date.now()
    const r = await ensureIntegralOffer(ctx, [DEBT])
    expect(Date.now() - t0).toBeLessThan(500)
    expect(r).toMatchObject({ ok: true, offerId: "off-77", valor: 250 })
    expect(counts.negotiation_offers).toBe(1) // só a leitura: nenhuma oferta nova
  })

  it("acordo pending_charge (espelho antes do ASAAS, sem asaas_payment_id) também é reusado", async () => {
    Object.assign(db.agreements[5], { asaas_payment_id: null, payment_status: "pending", asaas_status: null, status: "active" })
    const { ensureIntegralOffer } = await import("@/lib/journey/pay")
    const r = await ensureIntegralOffer(ctx, [DEBT])
    expect(r).toMatchObject({ ok: true, offerId: "off-5" })
  })

  it("integral 'presented' válida → reuso direto, sem consultar acordos", async () => {
    db.negotiation_offers.push({ id: "pres-1", company_id: CO, session_id: SID, source: "system", status: "presented", terms: { ...INTEGRAL, purpose: "pay_integral" }, valid_until: new Date(Date.now() + 86400_000).toISOString(), created_at: new Date().toISOString() })
    const { ensureIntegralOffer } = await import("@/lib/journey/pay")
    const r = await ensureIntegralOffer(ctx, [DEBT])
    expect(r).toMatchObject({ ok: true, offerId: "pres-1" })
    expect(counts.agreements ?? 0).toBe(0)
  })

  it("integral 'presented' VENCIDA não é reusada (gera outra)", async () => {
    db.negotiation_offers.push({ id: "pres-old", company_id: CO, session_id: SID, source: "system", status: "presented", terms: INTEGRAL, valid_until: new Date(Date.now() - 1000).toISOString(), created_at: new Date().toISOString() })
    const { ensureIntegralOffer } = await import("@/lib/journey/pay")
    const r = await ensureIntegralOffer(ctx, [DEBT])
    expect(r.ok && r.offerId).not.toBe("pres-old")
  })

  it("pickReusableIntegralOffer (pura): a presented mais recente; accepted em ordem decrescente; ignora não-integrais", async () => {
    const { pickReusableIntegralOffer } = await import("@/lib/journey/pay")
    const now = Date.now()
    const r = pickReusableIntegralOffer([
      { id: "a1", terms: INTEGRAL as any, status: "accepted", created_at: "2026-09-26T10:00:00Z" },
      { id: "a2", terms: INTEGRAL as any, status: "accepted", created_at: "2026-09-26T11:00:00Z" },
      { id: "m1", terms: MATRIX_CASH as any, status: "presented", created_at: "2026-09-26T12:00:00Z" },
      { id: "p1", terms: INTEGRAL as any, status: "presented", created_at: "2026-09-26T09:00:00Z" },
      { id: "p2", terms: INTEGRAL as any, status: "presented", created_at: "2026-09-26T09:30:00Z" },
    ], 250, now)
    expect(r.presentedId).toBe("p2")
    expect(r.acceptedIds).toEqual(["a2", "a1"])
  })
})
