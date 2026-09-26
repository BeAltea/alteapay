// QA round 3 — QAB2-02 (MÉDIO): "Já paguei" CONCORRENTE (1 clique na UI + 3
// POST /api/chat/reopen {payment_claim} em paralelo) abria 4 negotiation_cases.
// Agora: single-flight por sessão na instância + reconciliação pós-insert entre
// instâncias (canônico = o aberto mais antigo; duplicata removida) → no máximo 1
// caso payment_claim ABERTO por sessão, e todas as chamadas devolvem o mesmo id.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

process.env.CHAT_JOURNEY_ENABLED = "true"
process.env.NEGOTIATION_JWT_SECRET = "test-secret-qa3-race"

const CO = "eeeeeeee-0000-0000-0000-000000qa3rc1"
const SID = "sess-qa3-race"
const CUST = "cust-qa3-race"
const DEBT = "debt-qa3-race"
const ctx = { sessionId: SID, companyId: CO, customerId: CUST, debtId: DEBT }

let db: FakeDb
const events: Array<{ type: string; payload?: Record<string, unknown> }> = []

vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/asaas", () => ({ getAsaasPaymentsForCustomer: async () => [] }))
vi.mock("@/lib/notifications/email", () => ({ sendEmail: async () => ({ ok: true }) }))
vi.mock("@/lib/journey/events", () => ({
  recordEvent: async (i: { type: string; payload?: Record<string, unknown> }) => {
    events.push({ type: i.type, payload: i.payload })
    return { ok: true, duplicate: false }
  },
  getTimeline: async () => [],
}))
vi.mock("@/lib/negotiation/engine", () => ({
  engineName: () => "disabled",
  emitNegotiationStart: async () => ({ ok: true, delivered: false, reason: "engine_unavailable" }),
}))

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
    negotiation_sessions: [{ id: SID, company_id: CO, customer_id: CUST, debt_id: DEBT, debt_ids: [DEBT], primary_debt_id: DEBT, agreement_id: null }],
    negotiation_offers: [], negotiation_condition_matrix: [], negotiation_acceptances: [], negotiation_cases: [],
    contact_suppressions: [], chat_prompts: [], chat_messages: [], debt_acknowledgements: [], debt_acknowledgement_latest: [], agreements: [],
  }
}
const claimCases = () => db.negotiation_cases.filter((c) => c.type === "payment_claim")
const claimBubbles = () => db.chat_messages.filter((m) => m.role === "assistant" && m.offers_snapshot?.stage === "payment_claim")
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

describe("QAB2-02 — 'Já paguei' concorrente: no máximo 1 caso aberto por sessão", () => {
  beforeEach(seed)

  const openClaims = () => claimCases().filter((c) => c.status == null || c.status === "open")

  it("1 clique + 3 POST /api/chat/reopen {payment_claim} concorrentes → 1 caso aberto; todos devolvem o mesmo case_id", async () => {
    const { POST } = await import("@/app/api/chat/reopen/route")
    const { handlePaymentClaim } = await import("@/lib/journey/actions")
    const jwt = await signed()
    const [ui, ...posts] = await Promise.all([
      handlePaymentClaim(ctx, "customer"),
      POST(req(jwt, { action: "payment_claim" })).then((r: Response) => r.json()),
      POST(req(jwt, { action: "payment_claim" })).then((r: Response) => r.json()),
      POST(req(jwt, { action: "payment_claim" })).then((r: Response) => r.json()),
    ])
    expect(openClaims().length).toBe(1)
    expect(claimCases().length).toBe(1)
    for (const p of posts) {
      expect(p.claim_registered).toBe(true)
      expect(p.case_id).toBe(ui.caseId)
    }
    // cada clique ainda tem a sua resposta visível
    expect(claimBubbles().length).toBe(4)
  })

  it("corrida ENTRE INSTÂNCIAS (módulos isolados, sem single-flight compartilhado) → converge para 1 caso aberto", async () => {
    vi.resetModules()
    const a = await import("@/lib/journey/actions")
    vi.resetModules()
    const b = await import("@/lib/journey/actions")
    expect(a.registerPaymentClaim).not.toBe(b.registerPaymentClaim)
    const ids = await Promise.all([
      a.registerPaymentClaim(ctx, { channel: "chat" }, "customer"),
      b.registerPaymentClaim(ctx, { channel: "chat" }, "customer"),
      a.registerPaymentClaim(ctx, { channel: "chat" }, "customer"),
      b.registerPaymentClaim(ctx, { channel: "chat" }, "customer"),
    ])
    expect(openClaims().length).toBe(1)
    expect(new Set(ids).size).toBe(1)
    expect(ids[0]).toBe(openClaims()[0].id)
  })

  it("reconcilePaymentClaimCase: 2 abertos → o mais antigo é canônico; o nosso (mais novo) sai; desempate por id", async () => {
    const { reconcilePaymentClaimCase } = await import("@/lib/journey/actions")
    db.negotiation_cases.push(
      { id: "case-b", company_id: CO, session_id: SID, customer_id: CUST, debt_id: DEBT, type: "payment_claim", status: "open", details: {}, created_at: "2026-09-25T10:00:00.000Z" },
      { id: "case-a", company_id: CO, session_id: SID, customer_id: CUST, debt_id: DEBT, type: "payment_claim", status: "open", details: {}, created_at: "2026-09-25T10:00:00.000Z" },
      { id: "case-c", company_id: CO, session_id: SID, customer_id: CUST, debt_id: DEBT, type: "payment_claim", status: "open", details: {}, created_at: "2026-09-25T10:00:01.000Z" },
    )
    expect(await reconcilePaymentClaimCase(ctx, "case-c")).toBe("case-a")
    expect(await reconcilePaymentClaimCase(ctx, "case-b")).toBe("case-a")
    expect(await reconcilePaymentClaimCase(ctx, "case-a")).toBe("case-a")
    expect(openClaims().map((c) => c.id)).toEqual(["case-a"])
  })

  it("reconcile não toca caso de outra sessão/empresa nem casos resolvidos", async () => {
    const { reconcilePaymentClaimCase } = await import("@/lib/journey/actions")
    db.negotiation_cases.push(
      { id: "old-resolved", company_id: CO, session_id: SID, customer_id: CUST, debt_id: DEBT, type: "payment_claim", status: "resolved", details: {}, created_at: "2026-09-01T00:00:00.000Z" },
      { id: "other-sess", company_id: CO, session_id: "outra", customer_id: CUST, debt_id: DEBT, type: "payment_claim", status: "open", details: {}, created_at: "2026-09-01T00:00:00.000Z" },
      { id: "mine", company_id: CO, session_id: SID, customer_id: CUST, debt_id: DEBT, type: "payment_claim", status: "open", details: {}, created_at: "2026-09-25T00:00:00.000Z" },
    )
    expect(await reconcilePaymentClaimCase(ctx, "mine")).toBe("mine")
    expect(db.negotiation_cases.map((c) => c.id).sort()).toEqual(["mine", "old-resolved", "other-sess"])
  })
})
