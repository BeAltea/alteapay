// QA round 2 — QAA2-02 (MÉDIO): Negociar < 3 s. Em produção o Promise.race de
// 2,5 s do kickoff era consumido inteiro (n8n respondendo 5–9 s depois) e as
// parcelas só apareciam em 3,1–5,5 s. Agora, com as parcelas prontas, a resposta
// NÃO espera o kickoff (settle(0)): devolve `delivered` se o disparo já resolveu,
// senão `pending`; o disparo segue em curso. Sem parcelas (espera D2) o deadline
// continua valendo. Teste de timing com o n8n PENDURADO (fake): a resposta chega
// muito antes do deadline de 2,5 s — no reuso e na 1ª apresentação.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

process.env.CHAT_JOURNEY_ENABLED = "true"
process.env.NEGOTIATION_JWT_SECRET = "test-secret-qa2-neglat"

const CO = "eeeeeeee-0000-0000-0000-000000qa2nl1"
const SID = "sess-qa2-neglat"
const CUST = "cust-qa2-neglat"
const DEBT = "debt-qa2-neglat"

let db: FakeDb
let emitMode: "deliver" | "hang" = "hang"
let emitCalls = 0
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
  emitNegotiationStart: async () => {
    emitCalls += 1
    if (emitMode === "hang") return new Promise(() => {}) // n8n pendurado: nunca resolve
    return { ok: true, delivered: true, event_id: "evt-qa2" }
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
function seed(opts: { matrix?: boolean } = {}) {
  emitMode = "hang"
  emitCalls = 0
  delete process.env.N8N_KICKOFF_DEADLINE_MS
  db = {
    tenant_chat_config: [{
      company_id: CO, payment_origin: "platform", allow_payment_without_acknowledgement: true,
      acknowledgement_enabled: true, show_handoff_button: false, on_debt_not_recognized: "continue",
      official_channel_label: null, official_channel_url: null, branding: { brand_name: "VMAX" }, creditor_notification_emails: [],
    }],
    companies: [{ id: CO, name: "VMAX LTDA" }],
    customers: [{ id: CUST, company_id: CO, name: "Fabio Mendes", document: "11144477735" }],
    debts: [{ id: DEBT, company_id: CO, customer_id: CUST, status: "pending", amount: 250, due_date: "2020-01-01" }],
    vmax_invoices: [{ id_company: CO, doc: "11144477735", fatura: "F1", vencimento: "2020-01-10", saldo: 250 }],
    negotiation_sessions: [{ id: SID, company_id: CO, customer_id: CUST, debt_id: DEBT, agreement_id: null, debt_acknowledged_at: null, engine_owner: "platform", thread_epoch: 0 }],
    negotiation_offers: [], negotiation_condition_matrix: opts.matrix === false ? [] : [MATRIX], negotiation_acceptances: [], negotiation_cases: [],
    contact_suppressions: [], chat_prompts: [], chat_messages: [], debt_acknowledgements: [], debt_acknowledgement_latest: [], agreements: [],
  }
}
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
const active = () => db.chat_prompts.find((p) => p.status === "active")
/** Deadline do kickoff em vigor (default 2 500 ms) — a resposta tem de ficar BEM abaixo. */
const DEADLINE_MS = 2500
const BUDGET_FIRST_MS = 1500 // 1ª apresentação (gera ofertas): meta de produção < 3 s
const BUDGET_REUSE_MS = 1000 // reuso: meta de produção < 2 s

describe("QAA2-02 — Negociar responde sem esperar o kickoff quando as parcelas estão prontas", () => {
  beforeEach(() => seed())

  it("1ª apresentação com o n8n PENDURADO: parcelas no corpo, kickoff:'pending', resposta em << 2,5 s (não consome o deadline)", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    const { kickoffDeadlineMs } = await import("@/lib/journey/acknowledgement")
    expect(kickoffDeadlineMs()).toBe(DEADLINE_MS)
    const p1 = await bootstrap()
    const t0 = Date.now()
    const res = await POST(req(await signed(), { prompt_id: p1.id, button_id: 1 }))
    const ms = Date.now() - t0
    const b = await res.json()
    expect(res.status).toBe(200)
    expect(b).toMatchObject({ ok: true, action: "negotiate", offers_presented: true, kickoff: "pending", engine_owner: "platform" })
    expect(b.prompt.kind).toBe("offer_choice")
    expect(b.prompt.buttons.map((x: { id: number }) => x.id)).toEqual([2, 3, 4, 98])
    expect(ms).toBeLessThan(BUDGET_FIRST_MS)
    // o disparo foi iniciado (segue em curso; não é `void` solto sem começar)
    expect(emitCalls).toBe(1)
  })

  it("reuso (Voltar → Negociar de novo) com o n8n pendurado: mesmas ofertas, resposta em << 2,5 s", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    const p1 = await bootstrap()
    const first = await (await POST(req(await signed(), { prompt_id: p1.id, button_id: 1 }))).json()
    const firstIds = first.prompt.buttons.filter((x: { id: number }) => x.id !== 98).map((x: { value: string }) => x.value)
    await POST(req(await signed(), { prompt_id: first.prompt.id, button_id: 98 }))
    const menu = active()!
    expect(menu.kind).toBe("debt_three_options")
    const t0 = Date.now()
    const b = await (await POST(req(await signed(), { prompt_id: menu.id, button_id: 1 }))).json()
    const ms = Date.now() - t0
    expect(b.offers_presented).toBe(true)
    expect(b.kickoff).toBe("pending")
    const ids = b.prompt.buttons.filter((x: { id: number }) => x.id !== 98).map((x: { value: string }) => x.value)
    expect(ids).toEqual(firstIds)
    expect(ms).toBeLessThan(BUDGET_REUSE_MS)
  })

  it("kickoff que resolve ANTES das parcelas continua reportado (delivered/n8n) — settle(0) devolve o desfecho já conhecido", async () => {
    emitMode = "deliver"
    const { POST } = await import("@/app/api/chat/button/route")
    const p1 = await bootstrap()
    const b = await (await POST(req(await signed(), { prompt_id: p1.id, button_id: 1 }))).json()
    expect(b.offers_presented).toBe(true)
    expect(["delivered", "pending"]).toContain(b.kickoff)
    if (b.kickoff === "delivered") expect(b.engine_owner).toBe("n8n")
  })

  it("SEM parcelas (sem faixa de matriz) a espera D2 continua aguardando o deadline do kickoff (bounded, como antes)", async () => {
    seed({ matrix: false })
    process.env.N8N_KICKOFF_DEADLINE_MS = "300"
    const { POST } = await import("@/app/api/chat/button/route")
    const p1 = await bootstrap()
    const t0 = Date.now()
    const b = await (await POST(req(await signed(), { prompt_id: p1.id, button_id: 1 }))).json()
    const ms = Date.now() - t0
    expect(b.wait_state).toBe("aguardando_motor")
    expect(b.kickoff).toBe("pending")
    expect(ms).toBeGreaterThanOrEqual(250)
    expect(ms).toBeLessThan(2000)
  })

  it("caminho legado (handleDebtNegotiate): com parcelas, não espera o kickoff pendurado mesmo com deadline de 2,5 s", async () => {
    const { handleDebtNegotiate, bootstrapAcknowledgementPrompt } = await import("@/lib/journey/acknowledgement")
    const { answerPrompt } = await import("@/lib/journey/prompts")
    const r = await bootstrapAcknowledgementPrompt({ companyId: CO, sessionId: SID, customerId: CUST, debtIds: [DEBT], primaryDebtId: DEBT })
    if (!r.ok || !r.created) throw new Error("bootstrap legado falhou")
    const pid = r.prompt.id
    expect((await answerPrompt({ sessionId: SID, companyId: CO, promptId: pid, buttonId: 3 })).ok).toBe(true)
    const t0 = Date.now()
    const out = await handleDebtNegotiate({ companyId: CO, sessionId: SID, customerId: CUST, debtId: DEBT, debtIds: [DEBT], promptId: pid, buttonId: 3, dispatchDeadlineMs: DEADLINE_MS })
    const ms = Date.now() - t0
    expect(out.offersPresented).toBe(true)
    expect(out.prompt?.kind).toBe("offer_choice")
    expect(out.kickoff).toBe("pending")
    expect(ms).toBeLessThan(BUDGET_FIRST_MS)
  })
})
