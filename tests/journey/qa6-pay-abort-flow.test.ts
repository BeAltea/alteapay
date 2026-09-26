// QA rodada 6 — Pagar abortado (`charge_deferred`) e o que vem depois, pelas
// rotas REAIS (/api/chat/button, /api/chat/reopen) com banco em memória:
//  - Q2r2-02: o `erro_cobranca` é aposentado pelo servidor quando um prompt novo
//    é publicado (relogin/menu reaberto/Negociar) — nunca coexiste com o menu;
//  - Q2r2-03: depois do Pagar abortado, o Negociar apresenta o conjunto COMPLETO
//    da matriz (à vista com desconto + 2x + 3x); a integral órfã do Pagar sai de
//    cena (superseded);
//  - Q5r2-02: "Falar com atendimento" a partir do erro devolve o OUTCOME do
//    handoff no corpo, limpa o erro e um 2º pedido em < 15 min também tem bolha.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

process.env.CHAT_JOURNEY_ENABLED = "true"
process.env.NEGOTIATION_JWT_SECRET = "test-secret-qa6-pay-abort"

const CO = "eeeeeeee-0000-0000-0000-0000000qa6a1"
const SID = "sess-qa6-abort"
const CUST = "cust-qa6-abort"
const DEBT = "debt-qa6-abort"

let db: FakeDb
let confirmCalls = 0
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
// O orçamento da função estourou antes de a cobrança começar: nada é criado.
vi.mock("@/lib/journey/closing", () => ({
  buildAcceptSummary: async () => ({ ok: true, summary: { termsHash: "h", terms: {}, validUntil: null } }),
  confirmAccept: async () => {
    confirmCalls += 1
    return { ok: false, error: "CHARGE_DEFERRED" }
  },
}))
vi.mock("@/lib/negotiation/engine", () => ({
  engineName: () => "disabled",
  emitNegotiationStart: async () => ({ ok: true, delivered: false, reason: "engine_unavailable" }),
}))

// Matriz da VMAX na rodada (0-89 dias): à vista 5 %, parcelado 2,5 %, até 3x.
const MATRIX = {
  id: "mx-qa6", company_id: CO, name: "VMAX 0-89", priority: 1, active: true,
  valid_from: null, valid_to: null, aging_min_days: 0, aging_max_days: 89,
  aging_basis: "oldest_due", max_discount_pct: 5, installment_discount_pct: 2.5,
  min_entry_pct: 0, max_installments: 3, min_installment_value: 30,
  allowed_billing_types: ["PIX", "BOLETO", "CREDIT_CARD"], proposal_validity_days: 7,
  retry_after_days: 3, max_retries: 2, min_debt_value: 0,
}

const DUE = new Date(Date.now() - 42 * 86400_000).toISOString().slice(0, 10)

function seed() {
  confirmCalls = 0
  events.length = 0
  db = {
    tenant_chat_config: [{
      company_id: CO, payment_origin: "platform", allow_payment_without_acknowledgement: true,
      acknowledgement_enabled: true, show_handoff_button: false, on_debt_not_recognized: "continue",
      official_channel_label: null, official_channel_url: null, branding: { brand_name: "VMAX" },
      creditor_notification_emails: [],
    }],
    companies: [{ id: CO, name: "VMAX LTDA" }],
    customers: [{ id: CUST, company_id: CO, name: "Fabio Mendes", document: "11144477735" }],
    debts: [{ id: DEBT, company_id: CO, customer_id: CUST, status: "pending", amount: 250, due_date: DUE }],
    vmax_invoices: [{ id_company: CO, doc: "11144477735", fatura: "F1", vencimento: DUE, saldo: 250 }],
    negotiation_sessions: [{ id: SID, company_id: CO, customer_id: CUST, debt_id: DEBT, agreement_id: null, debt_acknowledged_at: null, wait_state: null }],
    negotiation_offers: [], negotiation_condition_matrix: [MATRIX], negotiation_acceptances: [], negotiation_cases: [],
    contact_suppressions: [], chat_prompts: [], chat_messages: [], debt_acknowledgements: [], debt_acknowledgement_latest: [], agreements: [],
  }
}

function ageClicks(ms = 3000) {
  for (const m of (db.chat_messages ?? []) as Array<{ role?: string; created_at?: string }>) {
    if (m.role === "customer" && m.created_at) m.created_at = new Date(Date.parse(m.created_at) - ms).toISOString()
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
const session = () => db.negotiation_sessions[0]
const nbsp = (s: string) => s.replace(/ /g, " ")

/** Pagar → charge_deferred: devolve o estado de erro persistido. */
async function payAborted() {
  const { POST } = await import("@/app/api/chat/button/route")
  const menu = await bootstrap()
  const res = await POST(req(await signed(), { prompt_id: menu.id, button_id: 4 }))
  const body = await res.json()
  expect(body).toMatchObject({ ok: false, action: "pay", error: "charge_deferred", wait_state: "erro_cobranca" })
  expect(session().wait_state).toBe("erro_cobranca")
  expect(db.agreements.length).toBe(0) // nenhuma cobrança/acordo
  expect(confirmCalls).toBe(1)
  // a integral do Pagar ficou 'presented' (órfã) e marcada como do Pagar
  const integral = db.negotiation_offers.find((o) => o.terms?.purpose === "pay_integral")
  expect(integral?.status).toBe("presented")
  ageClicks()
  return integral!
}

describe("QA rodada 6 — Pagar abortado: erro aposentado, Negociar completo, handoff com resposta", () => {
  beforeEach(seed)

  it("Q2r2-02: relogin/menu novo depois do erro → servidor limpa o erro_cobranca (nunca erro + menu)", async () => {
    await payAborted()
    // relogin: o bootstrap publica o menu de 3 opções
    const menu = await bootstrap()
    expect(menu.kind).toBe("debt_three_options")
    expect(session().wait_state).toBeNull()
  })

  it("Q2r2-02: prompt novo NÃO apaga 'gerando_cobranca' (Pagar em voo em outra request)", async () => {
    session().wait_state = "gerando_cobranca"
    await bootstrap()
    expect(session().wait_state).toBe("gerando_cobranca")
  })

  it("Q2r2-02 + Q2r2-03: Negociar depois do Pagar abortado → conjunto COMPLETO da matriz; integral órfã superseded; erro limpo", async () => {
    const integral = await payAborted()
    const { POST } = await import("@/app/api/chat/button/route")
    const menu = await bootstrap() // relogin (ou Voltar às opções)
    ageClicks()
    const res = await POST(req(await signed(), { prompt_id: menu.id, button_id: 1 }))
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, action: "negotiate", offers_presented: true })
    const labels: string[] = body.prompt.buttons.map((b: { label: string }) => nbsp(b.label))
    // à vista COM desconto (5 % de 250 = 237,50) + 2x + 3x; nunca a integral sozinha
    expect(labels.some((l) => /237,50/.test(l))).toBe(true)
    expect(labels.some((l) => /^2x/.test(l))).toBe(true)
    expect(labels.some((l) => /^3x/.test(l))).toBe(true)
    expect(labels.some((l) => /250,00/.test(l))).toBe(false)
    const offerIds: string[] = body.prompt.buttons.map((b: { value?: string }) => b.value).filter(Boolean)
    expect(offerIds).not.toContain(integral.id)
    expect(db.negotiation_offers.find((o) => o.id === integral.id)!.status).toBe("superseded")
    expect(session().wait_state).toBeNull()
  })

  it("Q2r2-03: integral LEGADA (sem marcador) órfã também é superseded pelo Negociar", async () => {
    const { listOffers } = await import("@/lib/journey/actions")
    const legacyId = "legacy-integral"
    db.negotiation_offers.push({
      id: legacyId, company_id: CO, session_id: SID, customer_id: CUST, debt_id: DEBT, source: "system", status: "presented",
      valid_until: new Date(Date.now() + 5 * 86400_000).toISOString(), created_at: new Date().toISOString(),
      terms: { original_value: 250, discount_pct: 0, discount_value: 0, entry_value: 0, installments: 1, installment_value: 250, total_value: 250, billing_type: "PIX", first_due_date: "2026-09-29" },
    })
    const offers = await listOffers({ sessionId: SID, companyId: CO, customerId: CUST, debtId: DEBT }, { summary: { agingDays: 42, originalValue: 250 } as any })
    expect(offers.length).toBe(3)
    expect(offers.map((o) => o.id)).not.toContain(legacyId)
    expect(offers.some((o) => o.terms.installments === 1 && o.terms.discount_value > 0)).toBe(true)
    expect(db.negotiation_offers.find((o) => o.id === legacyId)!.status).toBe("superseded")
  })

  it("Q5r2-02 (a): 'Falar com atendimento' no erro de cobrança → outcome no corpo, erro limpo; (b) 2º pedido < 15 min também tem bolha", async () => {
    await payAborted()
    const { POST } = await import("@/app/api/chat/reopen/route")
    const res = await POST(req(await signed(), { action: "handoff" }))
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, action: "handoff", transferred: true })
    expect(body.outcome).toBeTruthy()
    expect(body.outcome.stage).toBe("handoff")
    expect(body.outcome.text).toMatch(/Registramos o seu pedido de atendimento\./)
    const persisted = db.chat_messages.find((m) => m.id === body.outcome.id)
    expect(persisted?.offers_snapshot?.stage).toBe("handoff")
    expect(session().wait_state).toBeNull()

    ageClicks()
    const res2 = await POST(req(await signed(), { action: "handoff" }))
    const body2 = await res2.json()
    expect(body2.transferred).toBe(true)
    expect(body2.outcome?.id).toBeTruthy()
    expect(body2.outcome.id).not.toBe(body.outcome.id) // o dedup de conteúdo não engole a resposta
    const handoffBubbles = db.chat_messages.filter((m) => m.role === "assistant" && m.offers_snapshot?.stage === "handoff")
    expect(handoffBubbles.length).toBe(2)
  })

  it("Q5r2-02: handoff pelo botão [99] também devolve o outcome no corpo", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    db.tenant_chat_config[0].show_handoff_button = true
    const menu = await bootstrap()
    const res = await POST(req(await signed(), { prompt_id: menu.id, button_id: 99 }))
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, transferred: true })
    expect(body.outcome?.stage).toBe("handoff")
    expect(body.outcome?.text).toMatch(/Registramos o seu pedido de atendimento\./)
  })
})
