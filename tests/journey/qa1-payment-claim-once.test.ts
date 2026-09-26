// QA round 1 — QAA1-05 / M1: "Já paguei" repetido em < 15 min ficava sem
// resposta visível (dedup de conteúdo) e abria um `negotiation_cases` novo a
// cada clique. Agora: a orientação é a resposta ÀQUELE clique (fora do dedup —
// sempre visível) e há no máximo 1 caso `payment_claim` ABERTO por sessão (o
// aberto é reusado; um caso resolvido deixa de contar).
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

process.env.CHAT_JOURNEY_ENABLED = "true"
process.env.NEGOTIATION_JWT_SECRET = "test-secret-qa1-claim"

const CO = "eeeeeeee-0000-0000-0000-000000qa1cl1"
const SID = "sess-qa1-claim"
const CUST = "cust-qa1-claim"
const DEBT = "debt-qa1-claim"
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

describe("QAA1-05 — 'Já paguei' repetido: resposta sempre visível, 1 caso aberto por sessão", () => {
  beforeEach(seed)

  it("handlePaymentClaim 2x em < 15 min → 2 bolhas 'Obrigado por avisar…' (uma por clique), 1 caso payment_claim, 2 eventos (o 2º reusando o caso)", async () => {
    const { handlePaymentClaim } = await import("@/lib/journey/actions")
    const r1 = await handlePaymentClaim(ctx, "customer")
    const r2 = await handlePaymentClaim(ctx, "customer")
    expect(r1.reply).toMatch(/Obrigado por avisar/)
    expect(r2.reply).toBe(r1.reply)
    expect(r2.caseId).toBe(r1.caseId)
    expect(claimCases().length).toBe(1)
    expect(claimBubbles().length).toBe(2)
    for (const b of claimBubbles()) expect(b.offers_snapshot.case_id).toBe(r1.caseId)
    const regs = events.filter((e) => e.type === "payment_claim.registered")
    expect(regs.length).toBe(2)
    expect(regs[0].payload?.reused_open_case).toBeUndefined()
    expect(regs[1].payload?.reused_open_case).toBe(true)
    // nunca declara pago
    for (const b of claimBubbles()) expect(b.text.toLowerCase()).not.toMatch(/pagamento (confirmado|recebido)|quitad/)
  })

  it("POST /api/chat/reopen {payment_claim} 2x → mesmo case_id, claim_registered nas duas, menu de 3 opções ativo, bolha por clique", async () => {
    const { POST } = await import("@/app/api/chat/reopen/route")
    const jwt = await signed()
    const b1 = await (await POST(req(jwt, { action: "payment_claim" }))).json()
    // QA round 4 (R-21): o 2º "Já paguei" é um clique NOVO (≥ 2 s depois) — dentro
    // da janela de toque múltiplo ele é o MESMO pedido (qa4-effect-double-tap).
    for (const m of db.chat_messages ?? []) {
      if (m.role === "customer") m.created_at = new Date(Date.parse(m.created_at) - 3000).toISOString()
    }
    const b2 = await (await POST(req(jwt, { action: "payment_claim" }))).json()
    expect(b1.claim_registered).toBe(true)
    expect(b2.claim_registered).toBe(true)
    expect(b2.case_id).toBe(b1.case_id)
    expect(claimCases().length).toBe(1)
    expect(claimBubbles().length).toBe(2)
    expect(db.chat_prompts.filter((p) => p.status === "active").length).toBe(1)
    expect(db.chat_prompts.find((p) => p.status === "active")!.kind).toBe("debt_three_options")
  })

  it("caso anterior RESOLVIDO → um novo 'Já paguei' abre um caso novo (só o aberto é reusado)", async () => {
    const { handlePaymentClaim } = await import("@/lib/journey/actions")
    const r1 = await handlePaymentClaim(ctx, "customer")
    db.negotiation_cases.find((c) => c.id === r1.caseId)!.status = "resolved"
    const r2 = await handlePaymentClaim(ctx, "customer")
    expect(r2.caseId).not.toBe(r1.caseId)
    expect(claimCases().length).toBe(2)
  })

  it("isolamento: caso aberto de OUTRA sessão/empresa não é reusado", async () => {
    db.negotiation_cases.push({ id: "case-other", company_id: CO, session_id: "outra-sessao", customer_id: CUST, debt_id: DEBT, type: "payment_claim", status: "open", details: {} })
    db.negotiation_cases.push({ id: "case-other-co", company_id: "outra-empresa", session_id: SID, customer_id: CUST, debt_id: DEBT, type: "payment_claim", status: "open", details: {} })
    const { handlePaymentClaim } = await import("@/lib/journey/actions")
    const r = await handlePaymentClaim(ctx, "customer")
    expect(r.caseId).not.toBe("case-other")
    expect(r.caseId).not.toBe("case-other-co")
    expect(claimCases().filter((c) => c.session_id === SID && c.company_id === CO).length).toBe(1)
  })
})
