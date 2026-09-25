// A2 (G2 / N-D2-2 / N-D2-8 / N-D2-10 / N-D2-12) — "Negociar" no menu de 3 opções:
//  - o POST /api/chat/button devolve o prompt 'offer_choice' COMPLETO
//    (question + buttons, mesmo shape do GET active_prompt) → o client renderiza
//    as parcelas NA HORA, sem depender do poll;
//  - a confirmação T2 precede a pergunta das parcelas no histórico;
//  - o kickoff negotiation.start NÃO bloqueia a resposta (Promise.race com
//    deadline curto): n8n pendurado → resposta em < deadline com kickoff:'pending';
//  - engine_owner devolvido = o gravado no banco (entregue → 'n8n');
//  - auditoria: 1 offer.presented POR oferta (event_id com offer_id);
//  - reconhecimento implícito 1x (clique repetido não regrava).
// Rotas reais + fake supabase; só a fronteira de cobrança/rede é mockada.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

process.env.CHAT_JOURNEY_ENABLED = "true"
process.env.NEGOTIATION_JWT_SECRET = "test-secret-a2-neg"

const CO = "eeeeeeee-0000-0000-0000-0000000a2neg"
const SID = "sess-a2-neg"
const CUST = "cust-a2-neg"
const DEBT = "debt-a2-neg"

let db: FakeDb
const events: Array<{ type: string; eventId?: string; payload?: Record<string, unknown> }> = []
// controle do kickoff: por padrão entrega na hora; testes trocam o comportamento.
let emitMode: "deliver" | "hang" | "unavailable" = "deliver"

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
  confirmAccept: async () => ({ ok: false, error: "never_called_in_a2" }),
}))
vi.mock("@/lib/negotiation/engine", () => ({
  engineName: () => "disabled",
  emitNegotiationStart: async () => {
    if (emitMode === "hang") return new Promise(() => {}) // nunca resolve
    if (emitMode === "unavailable") return { ok: true, delivered: false, reason: "engine_unavailable" }
    return { ok: true, delivered: true, event_id: "evt-a2" }
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

function seed() {
  events.length = 0
  emitMode = "deliver"
  delete process.env.N8N_KICKOFF_DEADLINE_MS
  db = {
    tenant_chat_config: [{
      company_id: CO, payment_origin: "platform",
      allow_payment_without_acknowledgement: true,
      acknowledgement_enabled: true, show_handoff_button: false,
      on_debt_not_recognized: "continue",
      official_channel_label: null, official_channel_url: null,
      branding: { brand_name: "VMAX" }, creditor_notification_emails: [],
    }],
    companies: [{ id: CO, name: "VMAX LTDA" }],
    customers: [{ id: CUST, company_id: CO, name: "Fabio Mendes", document: "11144477735" }],
    debts: [{ id: DEBT, company_id: CO, customer_id: CUST, status: "pending", amount: 250, due_date: "2020-01-01" }],
    vmax_invoices: [{ id_company: CO, doc: "11144477735", fatura: "F1", vencimento: "2020-01-10", saldo: 250 }],
    negotiation_sessions: [{ id: SID, company_id: CO, customer_id: CUST, debt_id: DEBT, agreement_id: null, debt_acknowledged_at: null, engine_owner: "platform" }],
    negotiation_offers: [],
    negotiation_condition_matrix: [MATRIX],
    negotiation_acceptances: [],
    negotiation_cases: [],
    contact_suppressions: [],
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
async function bootstrap() {
  const { bootstrapThreeOptionsPrompt } = await import("@/lib/journey/acknowledgement")
  await bootstrapThreeOptionsPrompt({ companyId: CO, sessionId: SID, customerId: CUST, debtIds: [DEBT], primaryDebtId: DEBT })
  return db.chat_prompts.find((p) => p.status === "active")!
}
const active = () => db.chat_prompts.find((p) => p.status === "active")

describe("A2 — Negociar devolve o offer_choice no corpo do POST", () => {
  beforeEach(seed)

  it("200 com prompt completo (kind offer_choice, question, buttons 2..N + 98) no shape do GET", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    const p1 = await bootstrap()
    const r = await POST(buttonReq(await signed(), { prompt_id: p1.id, button_id: 1 }))
    const b = await r.json()
    expect(r.status).toBe(200)
    expect(b.ok).toBe(true)
    expect(b.action).toBe("negotiate")
    expect(b.offers_presented).toBe(true)
    expect(b.acknowledged).toBe(true)
    // prompt COMPLETO no corpo — o client renderiza as parcelas na hora
    expect(b.prompt).toBeTruthy()
    expect(Object.keys(b.prompt).sort()).toEqual(["buttons", "created_at", "id", "kind", "question", "status"])
    expect(b.prompt.kind).toBe("offer_choice")
    expect(b.prompt.status).toBe("active")
    expect(b.prompt.question).toMatch(/condições disponíveis/i)
    const ids = b.prompt.buttons.map((x: { id: number }) => x.id)
    expect(ids).toEqual([2, 3, 4, 98]) // à vista, 2x, 3x + Voltar às opções
    // o value de cada parcela é um offer_id da matriz (servidor dono)
    const offerIds = new Set(db.negotiation_offers.map((o) => o.id))
    for (const btn of b.prompt.buttons.filter((x: { id: number }) => x.id !== 98)) {
      expect(offerIds.has(btn.value)).toBe(true)
    }
    // …e é o prompt ATIVO no banco (idêntico ao que o poll traria)
    expect(active()!.id).toBe(b.prompt.id)
    expect(active()!.created_by).toBe("platform")
  })

  it("histórico: eco → 'Certo…' (T2) → pergunta das parcelas, nesta ordem; T2 = NEGOTIATION_PENDING_TEXT", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    // A4 r2: fonte única em wait-machine.ts (o alias NEGOTIATE_ACK_TEXT saiu)
    const { NEGOTIATION_PENDING_TEXT } = await import("@/lib/journey/wait-machine")
    const p1 = await bootstrap()
    const before = db.chat_messages.length
    const r = await POST(buttonReq(await signed(), { prompt_id: p1.id, button_id: 1 }))
    const b = await r.json()
    expect(b.reply).toBe(NEGOTIATION_PENDING_TEXT)
    const added = db.chat_messages.slice(before)
    const roles = added.map((m) => `${m.role}:${m.prompt_id ? "p" : "-"}`)
    // eco do clique (customer), confirmação (assistant sem prompt), pergunta (assistant ligada ao prompt)
    expect(roles).toEqual(["customer:p", "assistant:-", "assistant:p"])
    expect(added[1].text).toBe(NEGOTIATION_PENDING_TEXT)
    expect(added[2].prompt_id).toBe(b.prompt.id)
    expect(added[2].engine).toBe("platform")
  })

  it("kickoff NÃO bloqueia: n8n pendurado → responde dentro do deadline com kickoff:'pending' e engine_owner alinhado (platform)", async () => {
    process.env.N8N_KICKOFF_DEADLINE_MS = "300"
    emitMode = "hang"
    const { POST } = await import("@/app/api/chat/button/route")
    const p1 = await bootstrap()
    const t0 = Date.now()
    const r = await POST(buttonReq(await signed(), { prompt_id: p1.id, button_id: 1 }))
    const ms = Date.now() - t0
    const b = await r.json()
    expect(r.status).toBe(200)
    expect(b.offers_presented).toBe(true)
    expect(b.prompt.kind).toBe("offer_choice")
    expect(b.kickoff).toBe("pending")
    expect(b.engine_owner).toBe("platform")
    expect(ms).toBeLessThan(2000)
    // o banco não foi promovido a n8n (nada foi entregue)
    expect(db.negotiation_sessions[0].engine_owner).toBe("platform")
  })

  it("kickoff entregue dentro do deadline → engine_owner:'n8n' na resposta E no banco (N-D2-12 alinhado)", async () => {
    emitMode = "deliver"
    const { POST } = await import("@/app/api/chat/button/route")
    const p1 = await bootstrap()
    const r = await POST(buttonReq(await signed(), { prompt_id: p1.id, button_id: 1 }))
    const b = await r.json()
    expect(b.kickoff).toBe("delivered")
    expect(b.engine_owner).toBe("n8n")
    expect(db.negotiation_sessions[0].engine_owner).toBe("n8n")
    const ev = events.find((e) => e.payload?.event === "negotiation.start")
    expect(ev).toBeTruthy()
    // as parcelas foram apresentadas INDEPENDENTEMENTE do n8n (assistido sempre)
    expect(active()!.kind).toBe("offer_choice")
  })

  it("kickoff indisponível → engine_owner:'platform', kickoff:'unavailable'; parcelas mesmo assim", async () => {
    emitMode = "unavailable"
    const { POST } = await import("@/app/api/chat/button/route")
    const p1 = await bootstrap()
    const b = await (await POST(buttonReq(await signed(), { prompt_id: p1.id, button_id: 1 }))).json()
    expect(b.kickoff).toBe("unavailable")
    expect(b.engine_owner).toBe("platform")
    expect(b.offers_presented).toBe(true)
    expect(events.find((e) => e.payload?.event === "engine_unavailable")).toBeTruthy()
  })

  it("auditoria (N-D2-8): UM offer.presented por oferta, event_id explícito por offer_id; reconhecimento implícito 1x", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    const p1 = await bootstrap()
    await POST(buttonReq(await signed(), { prompt_id: p1.id, button_id: 1 }))
    const presented = events.filter((e) => e.type === "offer.presented")
    expect(presented.length).toBe(3)
    const ids = new Set(presented.map((e) => e.eventId))
    expect(ids.size).toBe(3)
    for (const e of presented) expect(e.eventId).toBe(`offer.presented|${e.payload?.offer_id}`)
    // reconhecimento implícito gravado 1x (source do Negociar do menu de 3 opções)
    const acks = db.debt_acknowledgements.filter((a) => a.session_id === SID)
    expect(acks.length).toBe(1)
    expect(acks[0]).toMatchObject({ acknowledged: true, mode: "implicit", button_id: 1, source: "chat_three_options_negotiate" })
    // clique no Negociar deixa rastro chat.turn.customer (A1) + debt.acknowledged
    expect(events.some((e) => e.type === "chat.turn.customer")).toBe(true)
    expect(events.some((e) => e.type === "debt.acknowledged")).toBe(true)
  })

  it("Voltar às opções [98] no offer_choice → menu curto reaberto; novo Negociar reusa as MESMAS ofertas (idempotente)", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    const p1 = await bootstrap()
    const b1 = await (await POST(buttonReq(await signed(), { prompt_id: p1.id, button_id: 1 }))).json()
    const firstOfferIds = b1.prompt.buttons.filter((x: { id: number }) => x.id !== 98).map((x: { value: string }) => x.value)
    const back = await (await POST(buttonReq(await signed(), { prompt_id: b1.prompt.id, button_id: 98 }))).json()
    expect(back.action).toBe("back_to_options")
    const menu = active()!
    expect(menu.kind).toBe("debt_three_options")
    // reconhecimento NÃO regrava (já positivo) — A1/N-D1-5 aplicado ao Negociar
    const b2 = await (await POST(buttonReq(await signed(), { prompt_id: menu.id, button_id: 1 }))).json()
    expect(b2.offers_presented).toBe(true)
    const secondOfferIds = b2.prompt.buttons.filter((x: { id: number }) => x.id !== 98).map((x: { value: string }) => x.value)
    expect(secondOfferIds).toEqual(firstOfferIds)
    expect(db.negotiation_offers.filter((o) => o.status === "presented").length).toBe(3)
    expect(db.debt_acknowledgements.length).toBe(1)
    // nunca 2 offer_choice ativos
    expect(db.chat_prompts.filter((p) => p.kind === "offer_choice" && p.status === "active").length).toBe(1)
  })

  it("sem faixa de matriz → arma a espera (wait_state) e NÃO devolve prompt (o client cai na espera D2)", async () => {
    db.negotiation_condition_matrix = []
    const { POST } = await import("@/app/api/chat/button/route")
    const p1 = await bootstrap()
    const b = await (await POST(buttonReq(await signed(), { prompt_id: p1.id, button_id: 1 }))).json()
    expect(b.ok).toBe(true)
    expect(b.wait_state).toBe("aguardando_motor")
    expect(b.offers_presented).toBeUndefined()
    expect(b.prompt).toBeUndefined()
    expect(active()).toBeUndefined()
  })
})
