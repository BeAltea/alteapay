// QA round 1 — QAA1-04 / M2: "Negociar" reaproveitava um conjunto de ofertas
// PARCIALMENTE consumido (a à vista rejeitada pelo guard already_charged do n8n
// → só 2x/3x, sem a opção recomendada). Agora listOffers regenera o conjunto
// COMPLETO quando qualquer irmã do conjunto vigente (mesmo valid_until) não está
// 'presented'; as restantes viram 'superseded'. presentMatrixOffers só reusa o
// 'offer_choice' ativo quando os offer_ids batem com o conjunto vigente.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"
import { isOfferSetIntact } from "@/lib/journey/actions"

process.env.CHAT_JOURNEY_ENABLED = "true"
process.env.NEGOTIATION_JWT_SECRET = "test-secret-qa1-offers"

const CO = "eeeeeeee-0000-0000-0000-000000qa1of1"
const SID = "sess-qa1-offers"
const CUST = "cust-qa1-offers"
const DEBT = "debt-qa1-offers"
const ctx = { sessionId: SID, companyId: CO, customerId: CUST, debtId: DEBT }

let db: FakeDb
const events: Array<{ type: string; eventId?: string; payload?: Record<string, unknown> }> = []

vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/asaas", () => ({ getAsaasPaymentsForCustomer: async () => [] }))
vi.mock("@/lib/notifications/email", () => ({ sendEmail: async () => ({ ok: true }) }))
vi.mock("@/lib/journey/events", () => ({
  recordEvent: async (i: { type: string; eventId?: string; payload?: Record<string, unknown> }) => {
    events.push({ type: i.type, eventId: i.eventId, payload: i.payload })
    return { ok: true, duplicate: false }
  },
  getTimeline: async () => [],
}))
vi.mock("@/lib/journey/closing", () => ({
  buildAcceptSummary: async () => ({ ok: true, summary: { termsHash: "h", terms: {}, validUntil: null } }),
  confirmAccept: async () => ({ ok: false, error: "never_called" }),
}))
vi.mock("@/lib/negotiation/engine", () => ({
  engineName: () => "disabled",
  emitNegotiationStart: async () => ({ ok: true, delivered: false, reason: "engine_unavailable" }),
}))

const MATRIX = {
  id: "mx-1", company_id: CO, name: "VMAX 0-89 dias", priority: 1, active: true,
  valid_from: null, valid_to: null, aging_min_days: 0, aging_max_days: null,
  aging_basis: "oldest_due", max_discount_pct: 5, installment_discount_pct: 2.5,
  min_entry_pct: 0, max_installments: 3, min_installment_value: 30,
  allowed_billing_types: ["PIX", "BOLETO"], proposal_validity_days: 7,
  retry_after_days: 3, max_retries: 2, min_debt_value: 0,
}
const VALID_UNTIL = "2026-10-02T12:00:00.000Z"
const terms = (n: number, total: number) => ({
  original_value: 250, discount_pct: n === 1 ? 5 : 2.5, discount_value: 250 - total, entry_value: 0,
  installments: n, installment_value: Math.round((total / n) * 100) / 100, total_value: total, billing_type: "PIX", first_due_date: "2026-10-02",
})
function offer(id: string, n: number, total: number, status = "presented", validUntil = VALID_UNTIL) {
  return { id, company_id: CO, session_id: SID, customer_id: CUST, debt_id: DEBT, matrix_id: "mx-1", source: "system", status, valid_until: validUntil, terms: terms(n, total), created_at: `2026-09-25T10:00:0${n}Z` }
}

function seed() {
  events.length = 0
  db = {
    tenant_chat_config: [{
      company_id: CO, payment_origin: "platform", allow_payment_without_acknowledgement: true,
      acknowledgement_enabled: true, show_handoff_button: false, on_debt_not_recognized: "continue",
      official_channel_label: null, official_channel_url: null, branding: { brand_name: "VMAX" }, creditor_notification_emails: [],
    }],
    companies: [{ id: CO, name: "VMAX LTDA" }],
    customers: [{ id: CUST, company_id: CO, name: "Fabio Mendes", document: "11144477735" }],
    debts: [{ id: DEBT, company_id: CO, customer_id: CUST, status: "pending", amount: 250, due_date: "2026-08-15" }],
    vmax_invoices: [{ id_company: CO, doc: "11144477735", fatura: "F1", vencimento: "2026-08-15", saldo: 250 }],
    negotiation_sessions: [{ id: SID, company_id: CO, customer_id: CUST, debt_id: DEBT, agreement_id: null, debt_acknowledged_at: null }],
    negotiation_offers: [offer("off-1x", 1, 237.5), offer("off-2x", 2, 243.76), offer("off-3x", 3, 243.75)],
    negotiation_condition_matrix: [MATRIX], negotiation_acceptances: [], negotiation_cases: [],
    contact_suppressions: [], chat_prompts: [], chat_messages: [], debt_acknowledgements: [], debt_acknowledgement_latest: [], agreements: [],
  }
}
const presented = () => db.negotiation_offers.filter((o) => o.status === "presented")

describe("isOfferSetIntact (puro)", () => {
  it("conjunto vigente com todas as irmãs 'presented' → intacto; uma rejeitada/aceita/expirada → não", () => {
    const set = (s1: string, s2: string, s3: string) => [
      { id: "a", status: s1, valid_until: VALID_UNTIL }, { id: "b", status: s2, valid_until: VALID_UNTIL }, { id: "c", status: s3, valid_until: VALID_UNTIL },
    ]
    const cur = new Set(["b", "c"])
    expect(isOfferSetIntact(set("presented", "presented", "presented"), new Set(["a", "b", "c"]))).toBe(true)
    expect(isOfferSetIntact(set("rejected", "presented", "presented"), cur)).toBe(false)
    expect(isOfferSetIntact(set("accepted", "presented", "presented"), cur)).toBe(false)
    expect(isOfferSetIntact(set("expired", "presented", "presented"), cur)).toBe(false)
    expect(isOfferSetIntact(set("superseded", "presented", "presented"), cur)).toBe(false)
  })
  it("ofertas de OUTRO conjunto (valid_until diferente — ex.: integral do Pagar aceita) não contam como irmãs; sem vigentes → intacto", () => {
    const rows = [
      { id: "a", status: "presented", valid_until: VALID_UNTIL }, { id: "b", status: "presented", valid_until: VALID_UNTIL },
      { id: "int", status: "accepted", valid_until: "2026-09-28T00:00:00.000Z" },
      { id: "old", status: "rejected", valid_until: "2026-09-20T00:00:00.000Z" },
    ]
    expect(isOfferSetIntact(rows, new Set(["a", "b"]))).toBe(true)
    expect(isOfferSetIntact(rows, new Set())).toBe(true)
  })
})

describe("listOffers — regenera o conjunto completo quando uma irmã foi consumida (M2)", () => {
  beforeEach(seed)

  it("à vista 'rejected' (guard already_charged do payment.create) → 3 ofertas NOVAS com a à vista; 2x/3x antigas viram superseded", async () => {
    db.negotiation_offers.find((o) => o.id === "off-1x")!.status = "rejected"
    const { listOffers } = await import("@/lib/journey/actions")
    const out = await listOffers(ctx)
    expect(out.length).toBe(3)
    expect(out.map((o) => o.terms.installments)).toEqual([1, 2, 3])
    expect(out.some((o) => ["off-2x", "off-3x"].includes(o.id))).toBe(false)
    for (const id of ["off-2x", "off-3x"]) expect(db.negotiation_offers.find((o) => o.id === id)!.status).toBe("superseded")
    expect(presented().length).toBe(3)
    expect(events.filter((e) => e.type === "offer.presented").length).toBe(3)
  })

  it("conjunto intacto → reusa as MESMAS 3 (0 oferta nova, 0 offer.presented)", async () => {
    const { listOffers } = await import("@/lib/journey/actions")
    const out = await listOffers(ctx)
    expect(out.map((o) => o.id)).toEqual(["off-1x", "off-2x", "off-3x"])
    expect(db.negotiation_offers.length).toBe(3)
    expect(events.filter((e) => e.type === "offer.presented").length).toBe(0)
  })

  it("oferta integral do PAGAR (outro valid_until, accepted) não quebra o conjunto → reusa", async () => {
    db.negotiation_offers.push({ ...offer("off-int", 1, 250, "accepted", "2026-09-28T00:00:00.000Z"), terms: { ...terms(1, 250), discount_pct: 0, discount_value: 0 } })
    const { listOffers } = await import("@/lib/journey/actions")
    const out = await listOffers(ctx)
    expect(out.map((o) => o.id)).toEqual(["off-1x", "off-2x", "off-3x"])
    expect(db.negotiation_offers.length).toBe(4)
  })

  it("uma irmã 'accepted' (parcela clicada) e o resto presented → regenera (as restantes superseded)", async () => {
    db.negotiation_offers.find((o) => o.id === "off-3x")!.status = "accepted"
    const { listOffers } = await import("@/lib/journey/actions")
    const out = await listOffers(ctx)
    expect(out.length).toBe(3)
    expect(out.map((o) => o.terms.installments)).toEqual([1, 2, 3])
    expect(db.negotiation_offers.find((o) => o.id === "off-1x")!.status).toBe("superseded")
    expect(db.negotiation_offers.find((o) => o.id === "off-3x")!.status).toBe("accepted") // intocada
  })

  it("sem faixa de matriz para regenerar → devolve o que resta (nunca some uma opção válida)", async () => {
    db.negotiation_offers.find((o) => o.id === "off-1x")!.status = "rejected"
    db.negotiation_condition_matrix = []
    const { listOffers } = await import("@/lib/journey/actions")
    const out = await listOffers(ctx)
    expect(out.map((o) => o.id)).toEqual(["off-2x", "off-3x"])
  })
})

describe("Negociar (rota) após uma oferta consumida → menu com À vista + parcelas; prompt antigo não é reusado", () => {
  beforeEach(seed)

  function req(cookieValue: string | null, body: Record<string, unknown>) {
    return {
      cookies: { get: (name: string) => (cookieValue && name === "alteapay_chat_session" ? { value: cookieValue } : undefined) },
      headers: { get: () => null },
      json: async () => body,
    } as any
  }
  async function signed() {
    const { signChatJwt } = await import("@/lib/negotiation/crypto")
    return signChatJwt({ sid: SID, cid: CO }, 3600)
  }
  async function bootstrap() {
    const { bootstrapThreeOptionsPrompt } = await import("@/lib/journey/acknowledgement")
    await bootstrapThreeOptionsPrompt({ companyId: CO, sessionId: SID, customerId: CUST, debtIds: [DEBT], primaryDebtId: DEBT })
    return db.chat_prompts.find((p) => p.status === "active")!
  }

  it("POST Negociar com a à vista rejeitada → prompt offer_choice com [À vista (recomendado)] [2x] [3x] [Voltar]", async () => {
    db.negotiation_offers.find((o) => o.id === "off-1x")!.status = "rejected"
    const { POST } = await import("@/app/api/chat/button/route")
    const p1 = await bootstrap()
    const b = await (await POST(req(await signed(), { prompt_id: p1.id, button_id: 1 }))).json()
    expect(b.offers_presented).toBe(true)
    const labels = b.prompt.buttons.map((x: any) => x.label)
    expect(labels.length).toBe(4)
    expect(labels[0]).toMatch(/^À vista .*\(recomendado\)$/)
    expect(labels[1]).toMatch(/^2x de /)
    expect(labels[2]).toMatch(/^3x de /)
    expect(labels[3]).toBe("Voltar às opções")
    // os values são os ids NOVOS (nunca os superseded)
    const values = b.prompt.buttons.filter((x: any) => x.id !== 98).map((x: any) => x.value)
    expect(values).not.toContain("off-2x")
    expect(values).not.toContain("off-3x")
  })

  it("offer_choice ATIVO apontando para o conjunto antigo (consumido) → prompt NOVO substitui; conjunto intacto → reusa o ativo", async () => {
    const { presentMatrixOffers } = await import("@/lib/journey/acknowledgement")
    const first = await presentMatrixOffers({ companyId: CO, sessionId: SID, customerId: CUST, debtId: DEBT })
    if (!first.ok || !first.presented) throw new Error("seed")
    expect(first.reused).toBe(false)
    const again = await presentMatrixOffers({ companyId: CO, sessionId: SID, customerId: CUST, debtId: DEBT })
    if (!again.ok || !again.presented) throw new Error("seed")
    expect(again.reused).toBe(true)
    expect(again.promptId).toBe(first.promptId)
    // uma irmã consumida entre os cliques (n8n rejeitou a à vista)
    db.negotiation_offers.find((o) => o.id === "off-1x")!.status = "rejected"
    const third = await presentMatrixOffers({ companyId: CO, sessionId: SID, customerId: CUST, debtId: DEBT })
    if (!third.ok || !third.presented) throw new Error("seed")
    expect(third.reused).toBe(false)
    expect(third.promptId).not.toBe(first.promptId)
    expect(db.chat_prompts.find((p) => p.id === first.promptId)!.status).toBe("superseded")
    expect(db.chat_prompts.filter((p) => p.kind === "offer_choice" && p.status === "active").length).toBe(1)
    expect(third.prompt.buttons.filter((x) => x.id !== 98).length).toBe(3)
  })
})
