// A2 (G2-c) — caminho LEGADO "Negociar Dívida" [3] do prompt debt_consult passa a
// apresentar a MATRIZ (nenhum "negociar" sem parcelas na tela): o POST devolve o
// offer_choice completo, o reconhecimento explícito (button 3) é gravado, e sem
// faixa de matriz o clique arma a espera D2 (nunca "preparando…" para sempre).
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

process.env.CHAT_JOURNEY_ENABLED = "true"
process.env.NEGOTIATION_JWT_SECRET = "test-secret-a2-legacy"

const CO = "eeeeeeee-0000-0000-0000-0000000a2leg"
const SID = "sess-a2-legacy"
const CUST = "cust-a2-legacy"
const DEBT = "debt-a2-legacy"

let db: FakeDb
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/asaas", () => ({ getAsaasPaymentsForCustomer: async () => [] }))
vi.mock("@/lib/notifications/email", () => ({ sendEmail: async () => ({ ok: true }) }))
vi.mock("@/lib/journey/events", () => ({
  recordEvent: async () => ({ ok: true, duplicate: false }),
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
  id: "mx-1", company_id: CO, name: "default", priority: 1, active: true,
  valid_from: null, valid_to: null, aging_min_days: 0, aging_max_days: null,
  aging_basis: "oldest_due", max_discount_pct: 30, installment_discount_pct: 10,
  min_entry_pct: 20, max_installments: 3, min_installment_value: 10,
  allowed_billing_types: ["PIX", "BOLETO"], proposal_validity_days: 7,
  retry_after_days: 3, max_retries: 2, min_debt_value: 0,
}

function seed(opts: { matrix?: boolean } = {}) {
  db = {
    tenant_chat_config: [{
      company_id: CO, payment_origin: "platform", allow_payment_without_acknowledgement: false,
      acknowledgement_enabled: true, show_handoff_button: false, on_debt_not_recognized: "continue",
      official_channel_label: null, official_channel_url: null, branding: { brand_name: "VMAX" },
    }],
    companies: [{ id: CO, name: "VMAX LTDA" }],
    customers: [{ id: CUST, company_id: CO, name: "Fabio Mendes", document: "11144477735" }],
    debts: [{ id: DEBT, company_id: CO, customer_id: CUST, status: "pending", amount: 250, due_date: "2020-01-01" }],
    vmax_invoices: [{ id_company: CO, doc: "11144477735", fatura: "F1", vencimento: "2020-01-10", saldo: 250 }],
    negotiation_sessions: [{ id: SID, company_id: CO, customer_id: CUST, debt_id: DEBT, agreement_id: null, debt_acknowledged_at: null, engine_owner: "platform" }],
    negotiation_offers: [],
    negotiation_condition_matrix: opts.matrix === false ? [] : [MATRIX],
    negotiation_acceptances: [],
    chat_prompts: [],
    chat_messages: [],
    debt_acknowledgements: [],
    debt_acknowledgement_latest: [],
    agreements: [],
  }
}

function buttonReq(cookieValue: string | null, body: Record<string, unknown>) {
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
async function bootstrapLegacy() {
  const { bootstrapAcknowledgementPrompt } = await import("@/lib/journey/acknowledgement")
  const r = await bootstrapAcknowledgementPrompt({ companyId: CO, sessionId: SID, customerId: CUST, debtIds: [DEBT], primaryDebtId: DEBT })
  if (!r.ok || !r.created) throw new Error("bootstrap legado falhou")
  expect(r.prompt.kind).toBe("debt_consult")
  return r.prompt.id
}
const active = () => db.chat_prompts.find((p) => p.status === "active")

describe("A2 — legado debt_consult / 'Negociar Dívida' [3] apresenta a matriz", () => {
  beforeEach(() => seed())

  it("POST [3] → offers_presented + prompt offer_choice no corpo; reconhecimento explícito gravado; reply T2", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    const { NEGOTIATE_ACK_TEXT } = await import("@/lib/journey/acknowledgement")
    const pid = await bootstrapLegacy()
    const r = await POST(buttonReq(await signed(), { prompt_id: pid, button_id: 3 }))
    const b = await r.json()
    expect(r.status).toBe(200)
    expect(b.action).toBe("negotiate")
    expect(b.acknowledged).toBe(true)
    expect(b.offers_presented).toBe(true)
    expect(b.prompt.kind).toBe("offer_choice")
    expect(b.prompt.buttons.map((x: { id: number }) => x.id)).toEqual([2, 3, 4, 98])
    expect(b.reply).toBe(NEGOTIATE_ACK_TEXT)
    expect(b.wait_state).toBeUndefined()
    // parcelas ATIVAS no banco (nunca mais "preparando… só um instante" sem saída)
    expect(active()!.kind).toBe("offer_choice")
    const ack = db.debt_acknowledgements.find((a) => a.button_id === 3)
    expect(ack).toMatchObject({ acknowledged: true, source: "chat_button_negotiate" })
    // histórico: dados da dívida (legado) e T2 antes da pergunta das parcelas
    const assistant = db.chat_messages.filter((m) => m.role === "assistant").map((m) => m.text)
    expect(assistant.some((t) => t.includes("dados da sua pendência"))).toBe(true)
    const iAck = assistant.indexOf(NEGOTIATE_ACK_TEXT)
    const iQ = assistant.findIndex((t) => /condições disponíveis/i.test(t))
    expect(iAck).toBeGreaterThanOrEqual(0)
    expect(iQ).toBeGreaterThan(iAck)
    // o reply legado "Perfeito!… preparando…" NÃO é gravado quando há parcelas
    expect(assistant.some((t) => t.includes("preparando sua negociação"))).toBe(false)
  })

  it("sem faixa de matriz → wait_state aguardando_motor + reply legado (espera D2, nunca beco)", async () => {
    seed({ matrix: false })
    const { POST } = await import("@/app/api/chat/button/route")
    const pid = await bootstrapLegacy()
    const b = await (await POST(buttonReq(await signed(), { prompt_id: pid, button_id: 3 }))).json()
    expect(b.ok).toBe(true)
    expect(b.wait_state).toBe("aguardando_motor")
    expect(b.offers_presented).toBeUndefined()
    expect(b.reply).toContain("preparando sua negociação")
    expect(db.chat_prompts.some((p) => p.kind === "offer_choice")).toBe(false)
  })

  it("handleDebtNegotiate devolve prompt/offersPresented/kickoff e não lança com o n8n indisponível", async () => {
    const { handleDebtNegotiate } = await import("@/lib/journey/acknowledgement")
    const { answerPrompt } = await import("@/lib/journey/prompts")
    const pid = await bootstrapLegacy()
    const answered = await answerPrompt({ sessionId: SID, companyId: CO, promptId: pid, buttonId: 3 })
    expect(answered.ok).toBe(true)
    const out = await handleDebtNegotiate({ companyId: CO, sessionId: SID, customerId: CUST, debtId: DEBT, debtIds: [DEBT], promptId: pid, buttonId: 3, dispatchDeadlineMs: 200 })
    expect(out.ok).toBe(true)
    expect(out.offersPresented).toBe(true)
    expect(out.prompt?.kind).toBe("offer_choice")
    expect(out.engineOwner).toBe("platform")
    expect(["unavailable", "pending"]).toContain(out.kickoff)
  })
})
