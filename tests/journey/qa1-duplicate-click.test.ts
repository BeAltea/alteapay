// QA round 1 — QAA1-06 (re-alvejamento em cascata) + F-QAA3-1 (ecos sem resposta).
//  - SERVIDOR: N POSTs concorrentes/sequenciais do MESMO botão no MESMO prompt →
//    só o 1º produz efeito; os demais 200 { ok:true, duplicate:true, prompt } sem
//    novo eco/outcome/menu e sem re-alvejar em cascata. Um 2º clique
//    GENUINAMENTE tardio (2ª aba, fora da janela) segue re-alvejado (A1).
//  - RENDER (chat-display): o dedup por conteúdo preserva a resposta ligada a
//    cada eco (outcome), e o colapso de decisions vira colapso de TURNOS: o par
//    "Detalhes › mesma resposta" repetido colapsa no último par; um resultado
//    diferente separa; ecos com outros cliques entre eles ficam, cada um com a
//    sua resposta.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"
import { collapseConsecutiveDecisions, dedupAssistantByContent, type ChatMsg } from "@/components/journey/chat-display"

process.env.CHAT_JOURNEY_ENABLED = "true"
process.env.NEGOTIATION_JWT_SECRET = "test-secret-qa1-dup"

const CO = "eeeeeeee-0000-0000-0000-000000qa1dp1"
const SID = "sess-qa1-dup"
const CUST = "cust-qa1-dup"
const DEBT = "debt-qa1-dup"

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
    debts: [{ id: DEBT, company_id: CO, customer_id: CUST, status: "pending", amount: 250, due_date: "2020-01-01" }],
    vmax_invoices: [{ id_company: CO, doc: "11144477735", fatura: "F1", vencimento: "2020-01-10", saldo: 250 }],
    negotiation_sessions: [{ id: SID, company_id: CO, customer_id: CUST, debt_id: DEBT, agreement_id: null, debt_acknowledged_at: null }],
    negotiation_offers: [], negotiation_condition_matrix: [MATRIX], negotiation_acceptances: [], negotiation_cases: [],
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
const activePrompts = () => db.chat_prompts.filter((p) => p.status === "active")
const echoes = (btn: number) => db.chat_messages.filter((m) => m.role === "customer" && m.button_id === btn)
const detailOutcomes = () => db.chat_messages.filter((m) => m.role === "assistant" && m.offers_snapshot?.stage === "detail")

describe("QAA1-06 servidor — clique duplicado (mesmo prompt + mesmo botão) sem cascata", () => {
  beforeEach(seed)

  it("3 POSTs CONCORRENTES de Detalhes no mesmo prompt → 1 consult + 2 duplicate; 1 eco, 1 outcome, 1 menu ativo, 0 re-alvejamento", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    const p1 = await bootstrap()
    const jwt = await signed()
    const rs = await Promise.all([1, 2, 3].map(() => POST(req(jwt, { prompt_id: p1.id, button_id: 2 }))))
    const bodies = await Promise.all(rs.map((r) => r.json()))
    expect(rs.every((r) => r.status === 200)).toBe(true)
    expect(bodies.filter((b) => b.action === "consult").length).toBe(1)
    expect(bodies.filter((b) => b.duplicate === true && b.ok === true).length).toBe(2)
    // os duplicados trazem o prompt ATIVO (o menu reaberto pelo 1º) para o client
    // re-hidratar — ou null quando respondem ANTES de o 1º reabrir o menu
    // (corrida real): aí o client re-hidrata pelo poll. Nunca um prompt inventado.
    const menu = activePrompts()[0]
    for (const b of bodies.filter((x) => x.duplicate)) expect(b.prompt === null || b.prompt?.id === menu.id).toBe(true)
    expect(activePrompts().length).toBe(1)
    expect(echoes(2).length).toBe(1)
    expect(detailOutcomes().length).toBe(1)
    expect(events.filter((e) => e.type === "chat.turn.customer").length).toBe(1)
    expect(events.some((e) => e.payload?.retargeted_from)).toBe(false)
  })

  it("3 POSTs SEQUENCIAIS rápidos (mesmo prompt, mesmo botão) → idem: 1 efeito, sem cascata pelos menus reabertos", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    const p1 = await bootstrap()
    const jwt = await signed()
    const b1 = await (await POST(req(jwt, { prompt_id: p1.id, button_id: 2 }))).json()
    const b2 = await (await POST(req(jwt, { prompt_id: p1.id, button_id: 2 }))).json()
    const b3 = await (await POST(req(jwt, { prompt_id: p1.id, button_id: 2 }))).json()
    expect(b1.action).toBe("consult")
    expect(b2).toMatchObject({ ok: true, duplicate: true })
    expect(b3).toMatchObject({ ok: true, duplicate: true })
    // sequencial: o menu reaberto pelo 1º já existe → vem no corpo dos duplicados
    expect(b2.prompt?.id).toBe(activePrompts()[0].id)
    expect(b3.prompt?.id).toBe(activePrompts()[0].id)
    expect(echoes(2).length).toBe(1)
    expect(detailOutcomes().length).toBe(1)
    expect(db.chat_prompts.length).toBe(2) // p1 + o menu reaberto (nada em cascata)
  })

  it("botão DIFERENTE no prompt obsoleto (Pagar após Detalhes, 2ª aba) NÃO é duplicado: re-alvejado ao menu ativo (intenção nova)", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    const p1 = await bootstrap()
    const jwt = await signed()
    await POST(req(jwt, { prompt_id: p1.id, button_id: 2 }))
    const b = await (await POST(req(jwt, { prompt_id: p1.id, button_id: 1 }))).json()
    expect(b.duplicate).toBeUndefined()
    expect(b.action).toBe("negotiate")
    expect(b.retargeted_from).toBe(p1.id)
  })

  it("o MESMO botão fora da janela (2ª aba minutos depois) → re-alvejado (A1 preservada)", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    const p1 = await bootstrap()
    const jwt = await signed()
    await POST(req(jwt, { prompt_id: p1.id, button_id: 2 }))
    db.chat_prompts.find((p) => p.id === p1.id)!.answered_at = new Date(Date.now() - 120_000).toISOString()
    const b = await (await POST(req(jwt, { prompt_id: p1.id, button_id: 2 }))).json()
    expect(b.action).toBe("consult")
    expect(b.retargeted_from).toBe(p1.id)
    expect(echoes(2).length).toBe(2)
  })

  it("isDuplicateClick (puro): answered + mesmo botão + dentro da janela; nunca para active / outro botão / fora da janela", async () => {
    const { isDuplicateClick, DUPLICATE_CLICK_WINDOW_MS } = await import("@/lib/journey/double-tap")
    const now = Date.parse("2026-09-25T20:00:00Z")
    const at = (ms: number) => new Date(now - ms).toISOString()
    expect(isDuplicateClick({ status: "answered", answered_button_id: 2, answered_at: at(100) }, 2, now)).toBe(true)
    expect(isDuplicateClick({ status: "answered", answered_button_id: 2, answered_at: at(DUPLICATE_CLICK_WINDOW_MS - 1) }, 2, now)).toBe(true)
    expect(isDuplicateClick({ status: "answered", answered_button_id: 2, answered_at: at(DUPLICATE_CLICK_WINDOW_MS) }, 2, now)).toBe(false)
    expect(isDuplicateClick({ status: "answered", answered_button_id: 4, answered_at: at(100) }, 2, now)).toBe(false)
    expect(isDuplicateClick({ status: "active", answered_button_id: null, answered_at: null }, 2, now)).toBe(false)
    expect(isDuplicateClick({ status: "superseded", answered_button_id: 2, answered_at: at(100) }, 2, now)).toBe(false)
    expect(isDuplicateClick(null, 2, now)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// RENDER — F-QAA3-1 + QAA1-06 (ecos consecutivos não colapsados / sem resposta)
// ---------------------------------------------------------------------------
const DETAIL = "Vencimento original 15/08/2026 · 1 fatura · serviço da VMAX."
function cust(id: string, text: string, buttonId: number): ChatMsg {
  return { id, from: "customer", text, action: null, promptId: null, buttonId, engine: null }
}
function asst(id: string, text: string, extra: Partial<ChatMsg> = {}): ChatMsg {
  return { id, from: "assistant", text, action: null, promptId: null, engine: null, buttonId: null, ...extra }
}
const ids = (l: ChatMsg[]) => l.map((m) => m.id)
const pipeline = (l: ChatMsg[]) => dedupAssistantByContent(collapseConsecutiveDecisions(l, null, "idle"))

describe("render — dedup preserva a resposta de cada eco; colapso por turno", () => {
  it("dedup por conteúdo NÃO apaga outcomes ligados ao clique (stage detail) — só guidance idêntica", () => {
    const list = [
      cust("c1", "Detalhes da dívida", 2), asst("d1", DETAIL, { stage: "detail" }),
      asst("q1", "Como prefere seguir?"),
      cust("c2", "Negociar", 1), asst("t2", "Certo. Estas são as condições disponíveis para você:"),
      cust("c3", "Detalhes da dívida", 2), asst("d2", DETAIL, { stage: "detail" }),
      asst("q2", "Como prefere seguir?"),
    ]
    const out = dedupAssistantByContent(list)
    expect(ids(out)).toContain("d1")
    expect(ids(out)).toContain("d2")
    expect(ids(out)).not.toContain("q1") // guidance idêntica: só a última
    expect(ids(out)).toContain("q2")
  })

  it("3 ecos concorrentes de Detalhes com a MESMA resposta (histórico da QAA1-06) → 1 eco + 1 resposta", () => {
    const list = [
      cust("c1", "Detalhes da dívida", 2), asst("d1", DETAIL, { stage: "detail" }),
      cust("c2", "Detalhes da dívida", 2), asst("d2", DETAIL, { stage: "detail" }),
      cust("c3", "Detalhes da dívida", 2), asst("d3", DETAIL, { stage: "detail" }),
      asst("q", "Como prefere seguir?"),
    ]
    expect(ids(pipeline(list))).toEqual(["c3", "d3", "q"])
  })

  it("F-QAA3-1: Detalhes › resposta › Negociar › T2 › Detalhes › resposta — cada eco fica COM a sua resposta (nada órfão)", () => {
    const list = [
      cust("c1", "Detalhes da dívida", 2), asst("d1", DETAIL, { stage: "detail" }),
      cust("c2", "Negociar", 1), asst("t2", "Certo. Estas são as condições disponíveis para você:"),
      cust("c3", "Detalhes da dívida", 2), asst("d2", DETAIL, { stage: "detail" }),
    ]
    const out = pipeline(list)
    expect(ids(out)).toEqual(["c1", "d1", "c2", "t2", "c3", "d2"])
    // invariante: todo eco de Detalhes é seguido da sua resposta
    for (let i = 0; i < out.length; i++) {
      if (out[i].from === "customer" && out[i].buttonId === 2) expect(out[i + 1]?.stage).toBe("detail")
    }
  })

  it("resultado DIFERENTE separa: Pagar › link › Pagar › 'já tem' ficam os dois pares", () => {
    const l1 = asst("o1", "Aqui está seu link\nhttps://pay.example.test/c/1", { action: { type: "open_payment_link", label: "Abrir link de pagamento", href: "https://pay.example.test/c/1" }, stage: "payment_link" })
    const l2 = asst("o2", "Você já tem uma cobrança ativa.\nhttps://pay.example.test/c/1", { action: { type: "open_payment_link", label: "Abrir link de pagamento", href: "https://pay.example.test/c/1" }, stage: "payment_link" })
    const list = [cust("c1", "Pagar R$ 250,00", 4), l1, cust("c2", "Pagar R$ 250,00", 4), l2]
    expect(ids(pipeline(list))).toEqual(["c1", "o1", "c2", "o2"])
  })

  it("eco repetido SEM resposta antes de um eco com resposta → colapsa no que respondeu (ruído some, resposta fica)", () => {
    const list = [cust("c1", "Detalhes da dívida", 2), cust("c2", "Detalhes da dívida", 2), asst("d", DETAIL, { stage: "detail" })]
    expect(ids(pipeline(list))).toEqual(["c2", "d"])
  })
})
