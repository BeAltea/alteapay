// QA round 2 — QAB1-H1 (ALTO): reload durante o Pagar não pode deixar a tela sem
// caminho. Servidor: o ramo PAGAR (e o aceite de parcela) grava
// wait_state='gerando_cobranca' ANTES do payService e limpa ao final (link
// entregue → prompt pós-link já existe) ou grava 'erro_cobranca' (erro/exceção).
// Client: ao reidratar 'gerando_cobranca' sem prompt ativo → modo espera com copy
// progressiva, poll de /api/chat/payment e saída humana no teto (regra pura
// decidePayResume + leitura do fonte de chat.tsx). Rotas reais + fake supabase.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

process.env.CHAT_JOURNEY_ENABLED = "true"
process.env.NEGOTIATION_JWT_SECRET = "test-secret-qa2-paywait"

const CO = "eeeeeeee-0000-0000-0000-000000qa2pw1"
const SID = "sess-qa2-paywait"
const CUST = "cust-qa2-paywait"
const DEBT = "debt-qa2-paywait"

let db: FakeDb
let confirmCalls = 0
let confirmMode: "ok" | "throw" = "ok"
/** wait_state observado DURANTE o serviço de cobrança (dentro do confirmAccept). */
let waitDuringCharge: string | null | undefined
const events: Array<{ type: string; payload?: Record<string, unknown> }> = []

vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/asaas", () => ({ getAsaasPaymentsForCustomer: async () => [], getAsaasPayment: async () => null }))
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
  confirmAccept: async ({ offerId }: { offerId: string }) => {
    confirmCalls += 1
    waitDuringCharge = db.negotiation_sessions[0].wait_state
    if (confirmMode === "throw") throw new Error("asaas exploded")
    const agId = `agNew-${confirmCalls}`
    ;(db.agreements ??= []).push({
      id: agId, company_id: CO, customer_id: CUST, asaas_payment_id: `pay_new_${confirmCalls}`,
      asaas_billing_type: "PIX", agreed_amount: 250, installments: 1, due_date: "2026-09-28",
      asaas_pix_qrcode_url: null, asaas_boleto_url: null,
      asaas_invoice_url: `https://asaas/i/pay_new_${confirmCalls}`,
      payment_status: "pending", asaas_status: "PENDING", status: "active",
    })
    ;(db.negotiation_acceptances ??= []).push({ company_id: CO, session_id: SID, offer_id: offerId, agreement_id: agId })
    const offer = (db.negotiation_offers ?? []).find((o) => o.id === offerId)
    if (offer) offer.status = "accepted"
    db.negotiation_sessions[0].agreement_id = agId
    return { ok: true, agreementId: agId }
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

function seed(opts: { matrix?: boolean } = {}) {
  confirmCalls = 0
  confirmMode = "ok"
  waitDuringCharge = undefined
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
    debts: [{ id: DEBT, company_id: CO, customer_id: CUST, status: "pending", amount: 250, due_date: "2026-08-15" }],
    vmax_invoices: [{ id_company: CO, doc: "11144477735", fatura: "F1", vencimento: "2026-08-15", saldo: 250 }],
    negotiation_sessions: [{ id: SID, company_id: CO, customer_id: CUST, debt_id: DEBT, agreement_id: null, debt_acknowledged_at: null, wait_state: null, wait_started_at: null, thread_epoch: 0 }],
    negotiation_offers: [], negotiation_condition_matrix: opts.matrix === false ? [] : [MATRIX], negotiation_acceptances: [], negotiation_cases: [],
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
const session = () => db.negotiation_sessions[0]
const active = () => db.chat_prompts.find((p) => p.status === "active")
async function getMessages() {
  const { GET } = await import("@/app/api/chat/messages/route")
  const cookie = await signed()
  const res = await GET({
    cookies: { get: (n: string) => (n === "alteapay_chat_session" ? { value: cookie } : undefined) },
    nextUrl: { searchParams: new URLSearchParams("") },
  } as any)
  return res.json()
}

describe("QAB1-H1 servidor — Pagar persiste 'gerando_cobranca' antes da cobrança e limpa ao final", () => {
  beforeEach(() => seed())

  it("Pagar [4]: wait_state='gerando_cobranca' DURANTE o payService; ao final null (prompt pós-link ativo); corpo traz wait_state:null", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    const p1 = await bootstrap()
    expect(session().wait_state).toBeNull()
    const b = await (await POST(req(await signed(), { prompt_id: p1.id, button_id: 4 }))).json()
    expect(b).toMatchObject({ ok: true, action: "pay", processing: false, wait_state: null })
    expect(b.link).toBe("https://asaas/i/pay_new_1")
    expect(b.prompt?.kind).toBe("post_payment_link")
    // durante a cobrança a sessão estava em 'gerando_cobranca' (um F5 reidrata a espera)
    expect(waitDuringCharge).toBe("gerando_cobranca")
    expect(typeof session().wait_started_at === "string" || session().wait_started_at === null).toBe(true)
    // ao final: limpo (o prompt pós-link é o caminho) — wait_started_at também
    expect(session().wait_state).toBeNull()
    expect(session().wait_started_at).toBeNull()
    expect(active()?.kind).toBe("post_payment_link")
    expect(confirmCalls).toBe(1)
  })

  it("Pagar com erro de negócio (sem faixa de matriz): wait_state='erro_cobranca' persistido; corpo ok:false + wait_state; reopen limpa e repõe o menu", async () => {
    seed({ matrix: false })
    const { POST } = await import("@/app/api/chat/button/route")
    const p1 = await bootstrap()
    const b = await (await POST(req(await signed(), { prompt_id: p1.id, button_id: 4 }))).json()
    expect(b).toMatchObject({ ok: false, action: "pay", error: "no_matrix_row", wait_state: "erro_cobranca" })
    expect(session().wait_state).toBe("erro_cobranca")
    expect(confirmCalls).toBe(0)
    // a saída do painel de erro ("Voltar às opções") reabre o menu e limpa a espera
    const { POST: REOPEN } = await import("@/app/api/chat/reopen/route")
    const r = await (await REOPEN(req(await signed(), { action: "reopen_options" }))).json()
    expect(r).toMatchObject({ ok: true, action: "reopen_options" })
    expect(session().wait_state).toBeNull()
    expect(active()?.kind).toBe("debt_three_options")
  })

  it("Pagar com EXCEÇÃO no serviço: 'erro_cobranca' fica gravado e a rota ainda devolve JSON (nunca 'gerando' eterno)", async () => {
    confirmMode = "throw"
    const { POST } = await import("@/app/api/chat/button/route")
    const p1 = await bootstrap()
    const res = await POST(req(await signed(), { prompt_id: p1.id, button_id: 4 }))
    const b = await res.json()
    expect(b.ok).toBe(false)
    expect(waitDuringCharge).toBe("gerando_cobranca")
    expect(session().wait_state).toBe("erro_cobranca")
  })

  it("aceite de PARCELA (offer_choice): 'gerando_cobranca' durante o aceite; null ao final; link + prompt pós-link no corpo", async () => {
    db.negotiation_offers = [{
      id: "off-2x", company_id: CO, session_id: SID, customer_id: CUST, debt_id: DEBT, status: "presented", valid_until: null, source: "system",
      terms: { original_value: 250, discount_pct: 2.5, discount_value: 6.25, entry_value: 0, installments: 2, installment_value: 121.88, total_value: 243.76, billing_type: "BOLETO", first_due_date: "2026-10-02" },
    }]
    db.chat_prompts = [{
      id: "oc-1", company_id: CO, session_id: SID, kind: "offer_choice", question: "Certo. Estas são as condições disponíveis para você:",
      buttons: [{ id: 2, label: "2x de R$ 121,88 (total R$ 243,76)", value: "off-2x", order: 0 }, { id: 98, label: "Voltar às opções", order: 1 }],
      context: { offer_ids: ["off-2x"], debt_ids: [DEBT], primary_debt_id: DEBT }, status: "active", created_by: "platform",
      n8n_execution_id: null, expires_at: null, created_at: "2026-09-25T10:00:00Z",
    }]
    const { POST } = await import("@/app/api/chat/button/route")
    const b = await (await POST(req(await signed(), { prompt_id: "oc-1", button_id: 2 }))).json()
    expect(b).toMatchObject({ ok: true, action: "pay", processing: false, wait_state: null })
    expect(b.link).toBe("https://asaas/i/pay_new_1")
    expect(b.prompt?.kind).toBe("post_payment_link")
    expect(waitDuringCharge).toBe("gerando_cobranca")
    expect(session().wait_state).toBeNull()
  })

  it("GET /api/chat/messages durante a cobrança devolve wait_state='gerando_cobranca' + wait_started_at (o reload reidrata)", async () => {
    const { setSessionWaitState } = await import("@/lib/journey/session-wait")
    expect(await setSessionWaitState(SID, "gerando_cobranca")).toBe(true)
    const body = await getMessages()
    expect(body.wait_state).toBe("gerando_cobranca")
    expect(typeof body.wait_started_at).toBe("string")
    expect(body.active_prompt).toBeNull()
    expect(await setSessionWaitState(SID, null)).toBe(true)
    expect((await getMessages()).wait_state).toBeNull()
  })
})

describe("QAB1-H1 regra pura (pay-poll.ts) — decidePayResume", () => {
  it("isPayWaitState: gerando_cobranca/erro_cobranca/link_entregue são do PAGAR; aguardando_motor/null não", async () => {
    const { isPayWaitState } = await import("@/lib/journey/pay-poll")
    expect(isPayWaitState("gerando_cobranca")).toBe(true)
    expect(isPayWaitState("erro_cobranca")).toBe(true)
    expect(isPayWaitState("link_entregue")).toBe(true)
    expect(isPayWaitState("aguardando_motor")).toBe(false)
    expect(isPayWaitState(null)).toBe(false)
    expect(isPayWaitState(undefined)).toBe(false)
  })

  it("sem prompt ativo + servidor 'gerando_cobranca' + client idle (reload) → resume_generating (modo espera com saída)", async () => {
    const { decidePayResume } = await import("@/lib/journey/pay-poll")
    const base = { serverWaitState: "gerando_cobranca", localWaitState: "idle", payInFlight: false, resumed: false, hasActivePrompt: false, linkDelivered: false }
    expect(decidePayResume(base)).toBe("resume_generating")
    // também a partir de uma espera de negociação (outra aba pagou)
    expect(decidePayResume({ ...base, localWaitState: "aguardando_motor" })).toBe("resume_generating")
    expect(decidePayResume({ ...base, localWaitState: "negociando" })).toBe("resume_generating")
    // já em espera de pagamento → nada a repor (mantém o poll)
    expect(decidePayResume({ ...base, localWaitState: "gerando_cobranca", resumed: true })).toBe("none")
  })

  it("o POST do Pagar em voo NESTA aba nunca é sobreposto; link entregue é absorvente", async () => {
    const { decidePayResume } = await import("@/lib/journey/pay-poll")
    expect(decidePayResume({ serverWaitState: null, localWaitState: "gerando_cobranca", payInFlight: true, resumed: false, hasActivePrompt: true, linkDelivered: false })).toBe("none")
    expect(decidePayResume({ serverWaitState: "erro_cobranca", localWaitState: "gerando_cobranca", payInFlight: true, resumed: false, hasActivePrompt: false, linkDelivered: false })).toBe("none")
    expect(decidePayResume({ serverWaitState: "gerando_cobranca", localWaitState: "link_entregue", payInFlight: false, resumed: true, hasActivePrompt: true, linkDelivered: false })).toBe("none")
    expect(decidePayResume({ serverWaitState: "gerando_cobranca", localWaitState: "idle", payInFlight: false, resumed: false, hasActivePrompt: true, linkDelivered: true })).toBe("none")
  })

  it("servidor 'erro_cobranca' → show_error (reload após erro), salvo quando o erro/espera local é de um clique próprio", async () => {
    const { decidePayResume } = await import("@/lib/journey/pay-poll")
    expect(decidePayResume({ serverWaitState: "erro_cobranca", localWaitState: "idle", payInFlight: false, resumed: false, hasActivePrompt: false, linkDelivered: false })).toBe("show_error")
    expect(decidePayResume({ serverWaitState: "erro_cobranca", localWaitState: "gerando_cobranca", payInFlight: false, resumed: true, hasActivePrompt: false, linkDelivered: false })).toBe("show_error")
    expect(decidePayResume({ serverWaitState: "erro_cobranca", localWaitState: "erro_cobranca", payInFlight: false, resumed: false, hasActivePrompt: false, linkDelivered: false })).toBe("none")
    expect(decidePayResume({ serverWaitState: "erro_cobranca", localWaitState: "gerando_cobranca", payInFlight: false, resumed: false, hasActivePrompt: false, linkDelivered: false })).toBe("none")
  })

  it("servidor concluiu (null) com a espera RETOMADA e um prompt na tela → settle_idle (o menu conduz); sem prompt → segue esperando (teto dá a saída)", async () => {
    const { decidePayResume } = await import("@/lib/journey/pay-poll")
    expect(decidePayResume({ serverWaitState: null, localWaitState: "gerando_cobranca", payInFlight: false, resumed: true, hasActivePrompt: true, linkDelivered: false })).toBe("settle_idle")
    expect(decidePayResume({ serverWaitState: null, localWaitState: "erro_cobranca", payInFlight: false, resumed: true, hasActivePrompt: true, linkDelivered: false })).toBe("settle_idle")
    expect(decidePayResume({ serverWaitState: null, localWaitState: "gerando_cobranca", payInFlight: false, resumed: true, hasActivePrompt: false, linkDelivered: false })).toBe("none")
    // clique próprio (não retomado) com servidor null → o clique governa
    expect(decidePayResume({ serverWaitState: null, localWaitState: "erro_cobranca", payInFlight: false, resumed: false, hasActivePrompt: true, linkDelivered: false })).toBe("none")
  })

  it("teto do poll (~60 s): shouldOfferProcessingExit após PAY_POLL_MAX_ATTEMPTS (24 × 2,5 s)", async () => {
    const { shouldOfferProcessingExit, PAY_POLL_MAX_ATTEMPTS } = await import("@/lib/journey/pay-poll")
    expect(PAY_POLL_MAX_ATTEMPTS * 2500).toBe(60_000)
    expect(shouldOfferProcessingExit(PAY_POLL_MAX_ATTEMPTS - 1)).toBe(false)
    expect(shouldOfferProcessingExit(PAY_POLL_MAX_ATTEMPTS)).toBe(true)
  })
})

describe("QAB1-H1 client (chat.tsx) — wire-up (leitura do fonte)", () => {
  const src = readFileSync(join(__dirname, "..", "..", "components", "journey", "chat.tsx"), "utf8")

  it("o poll reconcilia o estado de PAGAR do servidor DEPOIS das mensagens/prompt (reconcilePayWait → decidePayResume)", () => {
    const poll = src.slice(src.indexOf("async function pollMessages("), src.indexOf("function reconcilePayWait("))
    const apIdx = poll.indexOf("setActivePrompt(ap)")
    const recIdx = poll.indexOf("reconcilePayWait(data?.wait_state ?? null, liveLinkSeen)")
    expect(apIdx).toBeGreaterThan(0)
    expect(recIdx).toBeGreaterThan(apIdx)
    expect(src).toContain("decidePayResume({")
    // resume → processing RETOMADO (copy progressiva) + gerando_cobranca
    const rec = src.slice(src.indexOf("function reconcilePayWait("), src.indexOf("// QA round 1 (QAA1-01) — ARMING"))
    expect(rec).toContain('decision === "resume_generating"')
    expect(rec).toContain("resumed: true })")
    expect(rec).toContain('setWaitState("gerando_cobranca")')
    expect(rec).toContain('decision === "show_error"')
    expect(rec).toContain('setWaitState("erro_cobranca")')
    expect(rec).toContain('decision === "settle_idle"')
  })

  it("a reidratação da espera de NEGOCIAÇÃO ignora os estados de PAGAR do servidor (isPayWaitState)", () => {
    const fn = src.slice(src.indexOf("const rehydrateWait = useCallback("), src.indexOf("useEffect(() => {\n    scrollRef.current?.scrollTo"))
    expect(fn).toContain("if (isPayWaitState(serverWaitState)) return")
  })

  it("espera retomada: copy 'Ainda estou gerando o seu link de pagamento.' e, no teto, [Voltar às opções] [Falar com atendimento]", async () => {
    const { PAY_RESUME_GENERATING_TEXT } = await import("@/lib/journey/pay-poll")
    expect(PAY_RESUME_GENERATING_TEXT).toBe("Ainda estou gerando o seu link de pagamento.")
    expect(src).toContain("{payResult.resumed ? PAY_RESUME_GENERATING_TEXT : PAY_PROCESSING_TEXT}")
    const slow = src.slice(src.indexOf("{shouldOfferProcessingExit(payPollAttempts) ? ("), src.indexOf('payResult.status === "processing" ? (') + 4000)
    const slowBlock = slow.slice(0, slow.indexOf(") : null}") + 9)
    expect(slowBlock).toContain("Voltar às opções")
    expect(slowBlock).toContain("onClick={onPayBackToOptions}")
    expect(slowBlock).toContain("Falar com atendimento")
    expect(slowBlock).toContain("onClick={onWaitHandoff}")
  })

  it("o clique em Pagar marca o POST em voo e libera no finally; a recuperação de transporte entrega a autoridade ao servidor (resumed)", () => {
    const click = src.slice(src.indexOf("async function clickButton("), src.indexOf("function startPayLongWait()"))
    expect(click).toContain("payInFlightRef.current = true")
    expect(click).toContain("if (isPay) payInFlightRef.current = false")
    const recover = src.slice(src.indexOf("async function recoverPayAfterTransportFailure("), src.indexOf("function armNegotiationWait("))
    expect(recover).toContain("payResumedRef.current = true")
    expect(recover).toContain("resumed: true })")
  })
})
