// QA round 1 — QAA1-01 (BLOQUEANTE em produção): toque duplo em "Negociar"
// transferia ao atendimento. Duas pontas:
//  - SERVIDOR: um handoff (POST /api/chat/reopen {handoff} ou botão [99]) recebido
//    < 2 s depois de um clique válido no mesmo prompt/sessão é toque duplo →
//    200 { ok:true, ignored:'double_tap' }: 0 handoff, 0 supressão, 0 caso, a
//    conversa segue; decisão auditada (chat.click_ignored). Passada a janela, o
//    handoff é legítimo e transfere (e um [99] num prompt novo — pós-link — nunca
//    é toque duplo).
//  - CLIENT (regras puras em wait-machine.ts + wire-up em chat.tsx): o clique em
//    Negociar NÃO arma a espera (só a resposta sem parcelas arma); as saídas do
//    bloco nascem inertes por WAIT_EXITS_ARM_MS; "Falar com atendimento" a partir
//    da espera só existe do degrau d3 (10 s).
// Rotas reais + fake supabase; só cobrança/rede/engine mockados.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

process.env.CHAT_JOURNEY_ENABLED = "true"
process.env.NEGOTIATION_JWT_SECRET = "test-secret-qa1-dbltap"

const CO = "eeeeeeee-0000-0000-0000-000000qa1dt1"
const SID = "sess-qa1-dbltap"
const CUST = "cust-qa1-dbltap"
const DEBT = "debt-qa1-dbltap"

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
vi.mock("@/lib/journey/closing", () => ({
  buildAcceptSummary: async () => ({ ok: true, summary: { termsHash: "h", terms: {}, validUntil: null } }),
  confirmAccept: async ({ offerId }: { offerId: string }) => {
    confirmCalls += 1
    const agId = `agNew-${confirmCalls}`
    ;(db.agreements ??= []).push({
      id: agId, company_id: CO, customer_id: CUST, asaas_payment_id: "pay_new",
      asaas_billing_type: "PIX", agreed_amount: 250, installments: 1, due_date: "2026-09-27",
      asaas_pix_qrcode_url: null, asaas_boleto_url: null,
      asaas_invoice_url: "https://asaas/checkout/pay_new",
      payment_status: "pending", asaas_status: "PENDING", status: "active",
    })
    ;(db.negotiation_acceptances ??= []).push({ company_id: CO, session_id: SID, offer_id: offerId, agreement_id: agId })
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

function seed(opts: { showHandoff?: boolean } = {}) {
  confirmCalls = 0
  events.length = 0
  db = {
    tenant_chat_config: [{
      company_id: CO, payment_origin: "platform", allow_payment_without_acknowledgement: true,
      acknowledgement_enabled: true, show_handoff_button: opts.showHandoff === true,
      on_debt_not_recognized: "continue", official_channel_label: null, official_channel_url: null,
      branding: { brand_name: "VMAX" }, creditor_notification_emails: [],
    }],
    companies: [{ id: CO, name: "VMAX LTDA" }],
    customers: [{ id: CUST, company_id: CO, name: "Fabio Mendes", document: "11144477735" }],
    debts: [{ id: DEBT, company_id: CO, customer_id: CUST, status: "pending", amount: 250, due_date: "2020-01-01" }],
    vmax_invoices: [{ id_company: CO, doc: "11144477735", fatura: "F1", vencimento: "2020-01-10", saldo: 250 }],
    negotiation_sessions: [{ id: SID, company_id: CO, customer_id: CUST, debt_id: DEBT, agreement_id: null, debt_acknowledged_at: null, engine_owner: "platform" }],
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
const active = () => db.chat_prompts.find((p) => p.status === "active")
const handoffCases = () => db.negotiation_cases.filter((c) => c.type === "human_handoff")
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** envelhece todos os ecos de clique da sessão (simula "passou a janela"). */
function ageClicks(ms: number) {
  const at = new Date(Date.now() - ms).toISOString()
  for (const m of db.chat_messages) if (m.role === "customer") m.created_at = at
}

describe("QAA1-01 servidor — handoff < 2 s após um clique válido é toque duplo (ignorado)", () => {
  beforeEach(() => seed())

  it("Negociar + 'Falar com atendimento' (reopen handoff) 150 ms depois → ignored:double_tap; 0 handoff, 0 supressão, parcelas continuam", async () => {
    const { POST: BUTTON } = await import("@/app/api/chat/button/route")
    const { POST: REOPEN } = await import("@/app/api/chat/reopen/route")
    const p1 = await bootstrap()
    const jwt = await signed()
    const neg = await (await BUTTON(req(jwt, { prompt_id: p1.id, button_id: 1 }))).json()
    expect(neg.offers_presented).toBe(true)
    await sleep(150)
    // o 2º toque cai no bloco de espera → o client (antigo) mandava o handoff
    const r = await REOPEN(req(jwt, { action: "handoff" }))
    const b = await r.json()
    expect(r.status).toBe(200)
    expect(b).toMatchObject({ ok: true, ignored: "double_tap", transferred: false })
    // NENHUM efeito destrutivo
    expect(handoffCases().length).toBe(0)
    expect(db.contact_suppressions.length).toBe(0)
    expect(events.filter((e) => e.type === "human.transfer").length).toBe(0)
    // as parcelas (offer_choice) continuam ativas — 1 efeito para o clique
    expect(active()?.kind).toBe("offer_choice")
    expect(db.chat_messages.filter((m) => m.role === "customer").length).toBe(1)
    // decisão auditada, sem PII
    const ignored = events.find((e) => e.type === "chat.click_ignored")
    expect(ignored?.payload).toMatchObject({ reason: "double_tap", source: "reopen", button_id: 99 })
  })

  it("toque TRIPLO (Negociar + 2 handoffs em 300 ms) → 1 efeito, 0 handoff", async () => {
    const { POST: BUTTON } = await import("@/app/api/chat/button/route")
    const { POST: REOPEN } = await import("@/app/api/chat/reopen/route")
    const p1 = await bootstrap()
    const jwt = await signed()
    await BUTTON(req(jwt, { prompt_id: p1.id, button_id: 1 }))
    await sleep(100)
    const [a, b] = await Promise.all([REOPEN(req(jwt, { action: "handoff" })), REOPEN(req(jwt, { action: "handoff" }))])
    expect((await a.json()).ignored).toBe("double_tap")
    expect((await b.json()).ignored).toBe("double_tap")
    expect(handoffCases().length).toBe(0)
    expect(db.contact_suppressions.length).toBe(0)
    expect(active()?.kind).toBe("offer_choice")
  })

  it("botão [99] num prompt que acabou de receber um clique → ignored:double_tap; o menu ativo fica intacto", async () => {
    seed({ showHandoff: true })
    const { POST } = await import("@/app/api/chat/button/route")
    const p1 = await bootstrap()
    expect(p1.buttons.some((x: any) => x.id === 99)).toBe(true)
    const jwt = await signed()
    // 1º toque: Detalhes (p1 respondido; menu p2 do mesmo kind, também com [99])
    await POST(req(jwt, { prompt_id: p1.id, button_id: 2 }))
    const p2 = active()!
    await sleep(120)
    // 2º toque: [99] ainda no p1 (obsoleto) — antes era re-alvejado ao p2 → handoff
    const r = await POST(req(jwt, { prompt_id: p1.id, button_id: 99 }))
    const b = await r.json()
    expect(r.status).toBe(200)
    expect(b).toMatchObject({ ok: true, ignored: "double_tap" })
    expect(b.prompt?.id).toBe(p2.id)
    expect(active()?.id).toBe(p2.id)
    expect(handoffCases().length).toBe(0)
    expect(db.contact_suppressions.length).toBe(0)
    expect(events.find((e) => e.type === "chat.click_ignored")?.payload).toMatchObject({ source: "button", prompt_id: p1.id })
  })

  it("handoff DEPOIS da janela (2 s) é legítimo: transfere, abre o caso, suprime", async () => {
    const { POST: BUTTON } = await import("@/app/api/chat/button/route")
    const { POST: REOPEN } = await import("@/app/api/chat/reopen/route")
    const p1 = await bootstrap()
    const jwt = await signed()
    await BUTTON(req(jwt, { prompt_id: p1.id, button_id: 1 }))
    ageClicks(5_000)
    const b = await (await REOPEN(req(jwt, { action: "handoff" }))).json()
    expect(b).toMatchObject({ ok: true, transferred: true })
    expect(handoffCases().length).toBe(1)
    expect(events.some((e) => e.type === "human.transfer")).toBe(true)
    expect(events.some((e) => e.type === "chat.click_ignored")).toBe(false)
  })

  it("[99] no prompt pós-link logo após o Pagar NÃO é toque duplo (prompt novo, sem clique anterior nele) → transfere", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    const p1 = await bootstrap()
    const jwt = await signed()
    const pay = await (await POST(req(jwt, { prompt_id: p1.id, button_id: 4 }))).json()
    expect(pay.action).toBe("pay")
    const post = active()!
    expect(post.kind).toBe("post_payment_link")
    const b = await (await POST(req(jwt, { prompt_id: post.id, button_id: 99 }))).json()
    expect(b.transferred).toBe(true)
    expect(handoffCases().length).toBe(1)
  })

  it("handoff sem NENHUM clique anterior na sessão (ex.: menu degradado após reload) → transfere", async () => {
    const { POST: REOPEN } = await import("@/app/api/chat/reopen/route")
    await bootstrap()
    const b = await (await REOPEN(req(await signed(), { action: "handoff" }))).json()
    expect(b.transferred).toBe(true)
  })
})

describe("QAA1-01 regras puras (double-tap.ts / wait-machine.ts)", () => {
  it("isWithinWindow: < janela → true; ≥ janela → false; inválido/ausente → false; futuro (clock skew) → true", async () => {
    const { isWithinWindow, DOUBLE_TAP_WINDOW_MS } = await import("@/lib/journey/double-tap")
    const now = Date.parse("2026-09-25T20:00:00.000Z")
    const iso = (ms: number) => new Date(now - ms).toISOString()
    expect(isWithinWindow(iso(150), now, DOUBLE_TAP_WINDOW_MS)).toBe(true)
    expect(isWithinWindow(iso(1999), now, DOUBLE_TAP_WINDOW_MS)).toBe(true)
    expect(isWithinWindow(iso(2000), now, DOUBLE_TAP_WINDOW_MS)).toBe(false)
    expect(isWithinWindow(iso(-500), now, DOUBLE_TAP_WINDOW_MS)).toBe(true)
    expect(isWithinWindow(null, now, DOUBLE_TAP_WINDOW_MS)).toBe(false)
    expect(isWithinWindow("nope", now, DOUBLE_TAP_WINDOW_MS)).toBe(false)
  })

  it("areWaitExitsArmed: inerte por WAIT_EXITS_ARM_MS (≥ 1,5 s) desde que o bloco apareceu; sem instante → inerte", async () => {
    const { areWaitExitsArmed, WAIT_EXITS_ARM_MS } = await import("@/lib/journey/wait-machine")
    expect(WAIT_EXITS_ARM_MS).toBeGreaterThanOrEqual(1500)
    const t0 = 1_000_000
    expect(areWaitExitsArmed(t0, t0 + 100)).toBe(false)
    expect(areWaitExitsArmed(t0, t0 + 300)).toBe(false)
    expect(areWaitExitsArmed(t0, t0 + WAIT_EXITS_ARM_MS - 1)).toBe(false)
    expect(areWaitExitsArmed(t0, t0 + WAIT_EXITS_ARM_MS)).toBe(true)
    expect(areWaitExitsArmed(null, t0)).toBe(false)
  })

  it("shouldShowWaitHandoffExit: 'Falar com atendimento' na espera só de d3 (10 s) em diante", async () => {
    const { shouldShowWaitHandoffExit, deriveWaitStep } = await import("@/lib/journey/wait-machine")
    expect(shouldShowWaitHandoffExit(deriveWaitStep(0))).toBe(false)
    expect(shouldShowWaitHandoffExit(deriveWaitStep(200))).toBe(false)
    expect(shouldShowWaitHandoffExit(deriveWaitStep(3_000))).toBe(false)
    expect(shouldShowWaitHandoffExit(deriveWaitStep(9_999))).toBe(false)
    expect(shouldShowWaitHandoffExit(deriveWaitStep(10_000))).toBe(true)
    expect(shouldShowWaitHandoffExit(deriveWaitStep(15_000))).toBe(true)
  })

  it("negotiateWaitOnResponse: só arma a espera quando o servidor respondeu SEM parcelas (wait_state)", async () => {
    const { negotiateWaitOnResponse } = await import("@/lib/journey/wait-machine")
    expect(negotiateWaitOnResponse({ ok: true, action: "negotiate", offers_presented: true })).toBe(false)
    expect(negotiateWaitOnResponse({ ok: true, action: "negotiate", wait_state: "aguardando_motor" })).toBe(true)
    expect(negotiateWaitOnResponse({ ok: true, action: "negotiate", offers_presented: true, wait_state: "aguardando_motor" })).toBe(false)
    expect(negotiateWaitOnResponse({ ok: true, action: "consult" })).toBe(false)
    expect(negotiateWaitOnResponse({ ok: false, action: "negotiate", wait_state: "aguardando_motor" })).toBe(false)
    expect(negotiateWaitOnResponse(null)).toBe(false)
  })
})

describe("QAA1-01 client (chat.tsx) — wire-up das regras (leitura do fonte)", () => {
  const src = readFileSync(join(__dirname, "..", "..", "components", "journey", "chat.tsx"), "utf8")

  it("o clique em Negociar NÃO arma a espera (nenhum setWaitState('aguardando_motor') no bloco do clique)", () => {
    const start = src.indexOf("if (isNegotiate) {\n      negotiateClickedAtRef.current")
    expect(start).toBeGreaterThan(0)
    const block = src.slice(start, src.indexOf("const controller = new AbortController()", start))
    expect(block).not.toContain('setWaitState("aguardando_motor")')
    expect(block).not.toContain("startTick()")
    // a espera só arma na resposta sem parcelas
    expect(src).toContain("else if (negotiateWaitOnResponse(data))")
    expect(src).toContain("armNegotiationWait()")
  })

  it("as saídas da espera/degradação/erro nascem inertes (disabled + pointer-events-none até o arming)", () => {
    expect(src).toContain("setTimeout(() => setWaitExitsArmed(true), WAIT_EXITS_ARM_MS)")
    const disabledCount = (src.match(/disabled=\{!waitExitsArmed\}/g) ?? []).length
    // Pagar agora, Falar (espera), Pagar à vista, Tentar de novo, Falar (degradado),
    // Falar (processing), Tentar de novo, Voltar, Falar (erro) = 9
    expect(disabledCount).toBeGreaterThanOrEqual(9)
    expect(src).toContain('pointer-events-none opacity-60')
  })

  it("'Falar com atendimento' na espera só renderiza com shouldShowWaitHandoffExit(waitStep)", () => {
    const waitBlock = src.slice(src.indexOf('waitState === "aguardando_motor" ?'), src.indexOf('waitState === "menu_degradado" ?'))
    expect(waitBlock).toContain("{shouldShowWaitHandoffExit(waitStep) ? (")
    // o botão de handoff (onClick={onWaitHandoff}) do bloco de espera vem DEPOIS
    // do guard de degrau — nunca renderiza antes de d3.
    const handoffBtnIdx = waitBlock.indexOf("onClick={onWaitHandoff}")
    expect(handoffBtnIdx).toBeGreaterThan(0)
    expect(waitBlock.lastIndexOf("shouldShowWaitHandoffExit(waitStep)", handoffBtnIdx)).toBeGreaterThan(0)
    // e o "Pagar agora" do mesmo bloco NÃO está atrás do guard (caminho de ação desde o início)
    const payNowIdx = waitBlock.indexOf("onClick={onWaitPayNow}")
    expect(payNowIdx).toBeGreaterThan(0)
    expect(payNowIdx).toBeLessThan(waitBlock.indexOf("{shouldShowWaitHandoffExit(waitStep) ? ("))
  })

  it("um handoff ignorado como toque duplo NÃO reabre o menu por cima das parcelas (só poll)", () => {
    const fn = src.slice(src.indexOf("async function requestHandoffNoPrompt()"), src.indexOf("function payActiveButtonId()"))
    const ignoredIdx = fn.indexOf('data?.ignored === "double_tap"')
    const reopenIdx = fn.indexOf("await reopenOptions()")
    expect(ignoredIdx).toBeGreaterThan(0)
    expect(ignoredIdx).toBeLessThan(reopenIdx)
    expect(fn.slice(ignoredIdx, reopenIdx)).toContain("await pollMessages()")
  })
})
