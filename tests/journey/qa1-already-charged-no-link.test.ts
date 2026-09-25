// QA round 1 — QAA1-02 (ALTO em produção) / A1-R3: Pagar com uma cobrança viva
// de OFERTA ACEITA (acordo 3x) devolvia `already_charged:true, link:null` sem
// bolha nem prompt → menu consumido, tela sem botões (também após F5).
// Agora o servidor:
//  (1) resolve o link vivo pelo acordo e, sem URL local, pelo ASAAS
//      (asaas_payment_id do acordo; ou a cobrança viva do cliente — guard
//      nível-ASAAS sem acordo local, R3) e persiste bolha + prompt pós-link;
//  (2) sem link resolvível, persiste um OUTCOME humano ('charge_active') + o
//      menu curto; a resposta traz o `prompt` ativo.
// Nunca ok:true sem outcome e sem prompt. Mesmo recorte de mocks da A1
// (payService/rotas reais; só o núcleo do ASAAS/closing mockado).
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

process.env.CHAT_JOURNEY_ENABLED = "true"
process.env.NEGOTIATION_JWT_SECRET = "test-secret-qa1-acnl"

const CO = "eeeeeeee-0000-0000-0000-000000qa1ac1"
const SID = "sess-qa1-acnl"
const CUST = "cust-qa1-acnl"
const DEBT = "debt-qa1-acnl"
const ctx = { sessionId: SID, companyId: CO, customerId: CUST, debtId: DEBT }

let db: FakeDb
let confirmCalls = 0
let asaasById: Record<string, Record<string, unknown> | null> = {}
let asaasForCustomer: Array<Record<string, unknown>> = []
const events: Array<{ type: string; payload?: Record<string, unknown> }> = []

vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/asaas", () => ({
  getAsaasPaymentsForCustomer: async () => asaasForCustomer,
  getAsaasPayment: async (id: string) => {
    const p = asaasById[id]
    if (!p) throw new Error("asaas 404")
    return p
  },
}))
vi.mock("@/lib/notifications/email", () => ({ sendEmail: async () => ({ ok: true }) }))
vi.mock("@/lib/journey/events", () => ({
  recordEvent: async (i: { type: string; payload?: Record<string, unknown> }) => {
    events.push({ type: i.type, payload: i.payload })
    return { ok: true, duplicate: false }
  },
  getTimeline: async () => [],
}))
// closing: a cobrança já existe (guard duplo) → ALREADY_CHARGED sempre.
vi.mock("@/lib/journey/closing", () => ({
  buildAcceptSummary: async () => ({ ok: true, summary: { termsHash: "h", terms: {}, validUntil: null } }),
  confirmAccept: async () => {
    confirmCalls += 1
    return { ok: false, error: "ALREADY_CHARGED" }
  },
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

/** Acordo 3x VIVO (oferta aceita) SEM URL local — o estado da QAA1-02. */
const LIVE_3X_NO_URL = {
  id: "ag-3x", company_id: CO, customer_id: CUST, asaas_payment_id: "pay_inst_1", asaas_customer_id: "cus_x",
  status: "active", payment_status: "pending", asaas_status: "PENDING", asaas_billing_type: "BOLETO",
  asaas_invoice_url: null, asaas_payment_url: null, asaas_boleto_url: null, asaas_pix_qrcode_url: null,
  agreed_amount: 243.75, installments: 3, installment_amount: 81.25, due_date: "2026-10-02",
}
/** Acordo cancelado (só para conhecer o asaas_customer_id — caso R3). */
const DEAD = {
  id: "ag-dead", company_id: CO, customer_id: CUST, asaas_payment_id: "pay_dead", asaas_customer_id: "cus_x",
  status: "cancelled", payment_status: "deleted", asaas_status: "DELETED",
  asaas_invoice_url: "https://asaas/i/dead", agreed_amount: 250, installments: 1, due_date: "2026-09-28",
}

function seed() {
  confirmCalls = 0
  events.length = 0
  asaasById = {}
  asaasForCustomer = []
  db = {
    tenant_chat_config: [{
      company_id: CO, payment_origin: "platform", allow_payment_without_acknowledgement: true,
      acknowledgement_enabled: true, show_handoff_button: false, on_debt_not_recognized: "continue",
      official_channel_label: null, official_channel_url: null, branding: { brand_name: "VMAX" },
      creditor_notification_emails: [],
    }],
    companies: [{ id: CO, name: "VMAX LTDA" }],
    customers: [{ id: CUST, company_id: CO, name: "Fabio Mendes", document: "11144477735" }],
    debts: [{ id: DEBT, company_id: CO, customer_id: CUST, status: "pending", amount: 250, due_date: "2026-08-15" }],
    vmax_invoices: [{ id_company: CO, doc: "11144477735", fatura: "F1", vencimento: "2026-08-15", saldo: 250 }],
    negotiation_sessions: [{ id: SID, company_id: CO, customer_id: CUST, debt_id: DEBT, agreement_id: null, debt_acknowledged_at: null }],
    negotiation_offers: [], negotiation_condition_matrix: [MATRIX], negotiation_acceptances: [], negotiation_cases: [],
    contact_suppressions: [], chat_prompts: [], chat_messages: [], debt_acknowledgements: [], debt_acknowledgement_latest: [], agreements: [],
  }
  delete process.env.PAYMENT_ORIGIN
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
const linkBubbles = () => db.chat_messages.filter((m) => m.role === "assistant" && m.offers_snapshot?.stage === "payment_link")
const chargeActiveBubbles = () => db.chat_messages.filter((m) => m.role === "assistant" && m.offers_snapshot?.stage === "charge_active")

describe("QAA1-02 — already_charged com o link resolvido pelo ASAAS (acordo parcelado sem URL local)", () => {
  beforeEach(seed)

  it("payService: acordo 3x vivo sem URL → link via getAsaasPayment(asaas_payment_id); bolha do link + prompt pós-link; URLs gravadas de volta", async () => {
    db.agreements = [{ ...LIVE_3X_NO_URL }]
    db.negotiation_sessions[0].agreement_id = LIVE_3X_NO_URL.id
    asaasById.pay_inst_1 = { id: "pay_inst_1", status: "PENDING", deleted: false, invoiceUrl: "https://asaas/i/inst_1", bankSlipUrl: "https://asaas/b/inst_1", dueDate: "2026-10-02", value: 81.25 }
    const { payService } = await import("@/lib/journey/pay")
    const r = await payService(ctx)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.already_charged).toBe(true)
    expect(r.link).toBe("https://asaas/i/inst_1")
    expect(r.agreement_id).toBe("ag-3x")
    expect(r.prompt?.kind).toBe("post_payment_link")
    expect(r.post_prompt_id).toBe(r.prompt?.id)
    // bolha do link (outcome) com ação viva + copy "já tem cobrança ativa"
    const bubbles = linkBubbles()
    expect(bubbles.length).toBe(1)
    expect(bubbles[0].offers_snapshot.message_action).toMatchObject({ type: "open_payment_link", href: "https://asaas/i/inst_1" })
    expect(bubbles[0].text).toMatch(/já tem uma cobrança ativa/i)
    expect(bubbles[0].text).not.toMatch(/R\$\s?250,00/) // valor da COBRANÇA, não do rótulo
    // prompt pós-link ativo; URLs gravadas de volta no acordo (próximos polls)
    expect(active()?.kind).toBe("post_payment_link")
    const ag = db.agreements.find((a) => a.id === "ag-3x")!
    expect(ag.asaas_invoice_url).toBe("https://asaas/i/inst_1")
    expect(ag.asaas_boleto_url).toBe("https://asaas/b/inst_1")
    expect(confirmCalls).toBe(1)
  })

  it("R3 — guard nível-ASAAS sem acordo vivo local: link da cobrança viva do cliente no ASAAS; bolha + prompt pós-link", async () => {
    db.agreements = [{ ...DEAD }]
    asaasForCustomer = [
      { id: "pay_dead", status: "PENDING", deleted: true, invoiceUrl: "https://asaas/i/dead" },
      { id: "pay_other", status: "PENDING", deleted: false, invoiceUrl: "https://asaas/i/other", dueDate: "2026-10-05", value: 250 },
    ]
    const { payService } = await import("@/lib/journey/pay")
    const r = await payService(ctx)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.already_charged).toBe(true)
    expect(r.link).toBe("https://asaas/i/other") // nunca o link morto
    expect(r.prompt?.kind).toBe("post_payment_link")
    expect(linkBubbles().length).toBe(1)
    expect(linkBubbles()[0].offers_snapshot.message_action.href).toBe("https://asaas/i/other")
  })
})

describe("QAA1-02 — já-cobrado SEM link resolvível: outcome humano + menu curto (nunca beco)", () => {
  beforeEach(seed)

  it("payService: sem URL local, ASAAS sem link → ok:true, already_charged, link:null, outcome 'charge_active' persistido e prompt ATIVO (menu curto)", async () => {
    db.agreements = [{ ...LIVE_3X_NO_URL }]
    db.negotiation_sessions[0].agreement_id = LIVE_3X_NO_URL.id
    asaasById.pay_inst_1 = { id: "pay_inst_1", status: "PENDING", deleted: false } // sem URLs
    const { payService, ALREADY_CHARGED_NO_LINK_TEXT } = await import("@/lib/journey/pay")
    const r = await payService(ctx)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.already_charged).toBe(true)
    expect(r.link).toBeNull()
    expect(r.prompt).toBeTruthy()
    expect(r.prompt?.kind).toBe("debt_three_options")
    expect(r.prompt?.status).toBe("active")
    expect(r.prompt?.buttons.map((b: any) => b.id)).toEqual([4, 1, 2, 0])
    // outcome humano ligado ao resultado (nunca ok:true mudo)
    const out = chargeActiveBubbles()
    expect(out.length).toBe(1)
    expect(out[0].text).toBe(ALREADY_CHARGED_NO_LINK_TEXT)
    expect(out[0].text).toBe("Você já tem uma cobrança ativa. Se o link não aparecer, fale com o atendimento.")
    expect(linkBubbles().length).toBe(0)
    expect(active()?.id).toBe(r.prompt?.id)
  })

  it("rota POST /api/chat/button (Pagar): corpo traz already_charged + prompt (menu curto); o menu clicado ficou answered e há 1 ativo", async () => {
    db.agreements = [{ ...LIVE_3X_NO_URL }]
    db.negotiation_sessions[0].agreement_id = LIVE_3X_NO_URL.id
    asaasById.pay_inst_1 = { id: "pay_inst_1", status: "PENDING" }
    const { POST } = await import("@/app/api/chat/button/route")
    const p1 = await bootstrap()
    const b = await (await POST(req(await signed(), { prompt_id: p1.id, button_id: 4 }))).json()
    expect(b).toMatchObject({ ok: true, action: "pay", already_charged: true, link: null, processing: false })
    expect(b.prompt?.kind).toBe("debt_three_options")
    expect(b.prompt?.question).toBe("Como prefere seguir?")
    expect(db.chat_prompts.find((p) => p.id === p1.id)!.status).toBe("answered")
    expect(db.chat_prompts.filter((p) => p.status === "active").length).toBe(1)
    expect(chargeActiveBubbles().length).toBe(1)
    // 2 POSTs concorrentes no mesmo estado: 1 pay + 1 duplicate; ainda 1 ativo, 1 outcome novo no máximo
    const menu = active()!
    const jwt = await signed()
    const [r1, r2] = await Promise.all([
      POST(req(jwt, { prompt_id: menu.id, button_id: 4 })),
      POST(req(jwt, { prompt_id: menu.id, button_id: 4 })),
    ])
    const bodies = [await r1.json(), await r2.json()]
    expect(bodies.filter((x) => x.action === "pay").length).toBe(1)
    expect(bodies.filter((x) => x.duplicate === true).length).toBe(1)
    expect(db.chat_prompts.filter((p) => p.status === "active").length).toBe(1)
    expect(active()?.kind).toBe("debt_three_options")
  })

  it("GET /api/chat/messages depois do Pagar: o outcome vem com stage 'charge_active' (classe outcome — sobrevive ao F5 e à retomada) e o menu está ativo", async () => {
    db.agreements = [{ ...LIVE_3X_NO_URL }]
    db.negotiation_sessions[0].agreement_id = LIVE_3X_NO_URL.id
    asaasById.pay_inst_1 = { id: "pay_inst_1", status: "PENDING" }
    const { POST } = await import("@/app/api/chat/button/route")
    const { classifyMessage } = await import("@/lib/journey/display-class")
    const p1 = await bootstrap()
    await POST(req(await signed(), { prompt_id: p1.id, button_id: 4 }))
    const body = await getMessages()
    const out = body.messages.find((m: any) => m.stage === "charge_active")
    expect(out).toBeTruthy()
    expect(classifyMessage({ role: "assistant", stage: out.stage, promptId: null, text: out.text }, { activePromptId: body.active_prompt?.id })).toBe("outcome")
    expect(body.active_prompt?.kind).toBe("debt_three_options")
  })
})

describe("QAA1-02 — caminho offer_choice (parcela clicada) já-cobrado sem link: mesmo outcome + prompt", () => {
  beforeEach(seed)

  it("acceptMatrixCondition via rota: already_charged sem link → prompt (menu curto) no corpo, outcome charge_active persistido", async () => {
    db.agreements = [{ ...LIVE_3X_NO_URL }]
    db.negotiation_sessions[0].agreement_id = LIVE_3X_NO_URL.id
    asaasById.pay_inst_1 = { id: "pay_inst_1", status: "PENDING" }
    db.negotiation_offers = [{
      id: "off-3x", company_id: CO, session_id: SID, customer_id: CUST, debt_id: DEBT, status: "presented", valid_until: null, source: "system",
      terms: { original_value: 250, discount_pct: 2.5, discount_value: 6.25, entry_value: 0, installments: 3, installment_value: 81.25, total_value: 243.75, billing_type: "BOLETO", first_due_date: "2026-10-02" },
    }]
    db.chat_prompts = [{
      id: "oc-1", company_id: CO, session_id: SID, kind: "offer_choice", question: "Certo. Estas são as condições disponíveis para você:",
      buttons: [{ id: 2, label: "3x de R$ 81,25 (total R$ 243,75)", value: "off-3x", order: 0 }, { id: 98, label: "Voltar às opções", order: 1 }],
      context: { offer_ids: ["off-3x"], debt_ids: [DEBT], primary_debt_id: DEBT }, status: "active", created_by: "platform",
      n8n_execution_id: null, expires_at: null, created_at: "2026-09-25T10:00:00Z",
    }]
    const { POST } = await import("@/app/api/chat/button/route")
    const b = await (await POST(req(await signed(), { prompt_id: "oc-1", button_id: 2 }))).json()
    expect(b).toMatchObject({ ok: true, action: "pay", already_charged: true, link: null })
    expect(b.prompt?.kind).toBe("debt_three_options")
    expect(chargeActiveBubbles().length).toBe(1)
    expect(active()?.kind).toBe("debt_three_options")
  })
})

/** GET /api/chat/messages (1º poll, sem `since`) com o cookie da sessão de teste. */
async function getMessages() {
  const { GET } = await import("@/app/api/chat/messages/route")
  const cookie = await signed()
  const res = await GET({
    cookies: { get: (n: string) => (n === "alteapay_chat_session" ? { value: cookie } : undefined) },
    nextUrl: { searchParams: new URLSearchParams("") },
  } as any)
  return res.json()
}
