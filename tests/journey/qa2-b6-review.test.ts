// QA round 2 — achados da revisão B6 da rodada 1 (03-review-B6.md):
//  M-1  WAIT_EXITS_ARM_MS (1,5 s) < janela do toque duplo do servidor (2,0 s): um
//       clique legítimo em "Falar com atendimento" entre 1,5–2,0 s era ignorado sem
//       feedback. Agora arming ≥ janela + folga (2,5 s) E o guard do
//       `reopen {handoff}` só vale quando o último clique foi o próprio Negociar.
//  M-2  passo 2 do resolveLiveChargeLink exibia link/valor de QUALQUER cobrança viva
//       do cliente ASAAS (outro cedente/legada): agora só cobranças MAPEÁVEIS a um
//       acordo desta company_id (ou externalReference desta sessão); sem
//       mapeamento → outcome charge_active sem link.
//  B-1  leitura de agreements sempre com company_id.
//  B-2  passo 1 usa isBlockingPayment (nunca link de cobrança RECEIVED/REFUNDED).
//  B-3  copy do já-cobrado usa o TOTAL do acordo (243,75), nunca a parcela (81,25).
import { beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

process.env.CHAT_JOURNEY_ENABLED = "true"
process.env.NEGOTIATION_JWT_SECRET = "test-secret-qa2-b6"

const CO = "eeeeeeee-0000-0000-0000-000000qa2b61"
const OTHER_CO = "eeeeeeee-0000-0000-0000-000000qa2b62"
const SID = "sess-qa2-b6"
const CUST = "cust-qa2-b6"
const DEBT = "debt-qa2-b6"
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
/** Acordo 3x VIVO sem URL local (o estado da QAA1-02). */
const LIVE_3X_NO_URL = {
  id: "ag-3x", company_id: CO, customer_id: CUST, asaas_payment_id: "pay_inst_1", asaas_customer_id: "cus_x",
  status: "active", payment_status: "pending", asaas_status: "PENDING", asaas_billing_type: "BOLETO",
  asaas_invoice_url: null, asaas_payment_url: null, asaas_boleto_url: null, asaas_pix_qrcode_url: null,
  agreed_amount: 243.75, installments: 3, installment_amount: 81.25, due_date: "2026-10-02",
}
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
      official_channel_label: null, official_channel_url: null, branding: { brand_name: "VMAX" }, creditor_notification_emails: [],
    }],
    companies: [{ id: CO, name: "VMAX LTDA" }],
    customers: [{ id: CUST, company_id: CO, name: "Fabio Mendes", document: "11144477735" }],
    debts: [{ id: DEBT, company_id: CO, customer_id: CUST, status: "pending", amount: 250, due_date: "2026-08-15" }],
    vmax_invoices: [{ id_company: CO, doc: "11144477735", fatura: "F1", vencimento: "2026-08-15", saldo: 250 }],
    negotiation_sessions: [{ id: SID, company_id: CO, customer_id: CUST, debt_id: DEBT, agreement_id: null, debt_acknowledged_at: null, engine_owner: "platform", thread_epoch: 0 }],
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
const linkBubbles = () => db.chat_messages.filter((m) => m.role === "assistant" && m.offers_snapshot?.stage === "payment_link")
const chargeActiveBubbles = () => db.chat_messages.filter((m) => m.role === "assistant" && m.offers_snapshot?.stage === "charge_active")
const handoffCases = () => db.negotiation_cases.filter((c) => c.type === "human_handoff")
/** eco de clique recém-gravado (o servidor mede a janela pelo último eco). */
function echoNow(buttonId: number, promptId: string | null = null) {
  db.chat_messages.push({ id: `echo-${buttonId}-${db.chat_messages.length}`, session_id: SID, company_id: CO, role: "customer", text: "clique", button_id: buttonId, prompt_id: promptId, created_at: new Date().toISOString() })
}

describe("B6 M-1 — arming do client ≥ janela do servidor; guard do reopen só após Negociar", () => {
  beforeEach(seed)

  it("WAIT_EXITS_ARM_MS ≥ DOUBLE_TAP_WINDOW_MS + folga de relógio (500 ms)", async () => {
    const { WAIT_EXITS_ARM_MS } = await import("@/lib/journey/wait-machine")
    const { DOUBLE_TAP_WINDOW_MS } = await import("@/lib/journey/double-tap")
    expect(WAIT_EXITS_ARM_MS).toBeGreaterThanOrEqual(DOUBLE_TAP_WINDOW_MS + 500)
  })

  it("reopenHandoffGuardApplies: só Negociar (1 = menu de 3 opções, 3 = legado); Pagar/Detalhes/Não reconheço/Voltar/[99]/nenhum → não", async () => {
    const { reopenHandoffGuardApplies } = await import("@/lib/journey/double-tap")
    expect(reopenHandoffGuardApplies(1)).toBe(true)
    expect(reopenHandoffGuardApplies(3)).toBe(true)
    for (const id of [4, 2, 0, 98, 99]) expect(reopenHandoffGuardApplies(id)).toBe(false)
    expect(reopenHandoffGuardApplies(null)).toBe(false)
    expect(reopenHandoffGuardApplies(undefined)).toBe(false)
  })

  it("Pagar → erro rápido → 'Falar com atendimento' 150 ms depois (reopen handoff) TRANSFERE (clique legítimo, não é toque duplo)", async () => {
    const { POST: REOPEN } = await import("@/app/api/chat/reopen/route")
    echoNow(4)
    const b = await (await REOPEN(req(await signed(), { action: "handoff" }))).json()
    expect(b).toMatchObject({ ok: true, action: "handoff", transferred: true })
    expect(handoffCases().length).toBe(1)
    expect(events.find((e) => e.type === "chat.click_ignored")).toBeUndefined()
  })

  it("Negociar → reopen handoff 150 ms depois continua IGNORADO (QAA1-01 preservado)", async () => {
    const { POST: REOPEN } = await import("@/app/api/chat/reopen/route")
    echoNow(1)
    const b = await (await REOPEN(req(await signed(), { action: "handoff" }))).json()
    expect(b).toMatchObject({ ok: true, transferred: false, ignored: "double_tap" })
    expect(handoffCases().length).toBe(0)
    expect(events.find((e) => e.type === "chat.click_ignored")?.payload).toMatchObject({ source: "reopen", reason: "double_tap" })
  })

  it("[99] no MESMO prompt logo após um clique nele continua guardado (source 'button' não depende do botão anterior)", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    const p1 = await bootstrap()
    // o prompt acabou de ser respondido por Pagar (eco no prompt)
    p1.status = "answered"; p1.answered_button_id = 4; p1.answered_at = new Date().toISOString()
    echoNow(4, p1.id)
    const b = await (await POST(req(await signed(), { prompt_id: p1.id, button_id: 99 }))).json()
    expect(b).toMatchObject({ ok: true, ignored: "double_tap" })
    expect(handoffCases().length).toBe(0)
  })

  it("client: a saída de handoff que nasce em d3 ganha o próprio arming (dep waitHandoffExitVisible)", () => {
    const src = readFileSync(join(__dirname, "..", "..", "components", "journey", "chat.tsx"), "utf8")
    expect(src).toContain('const waitHandoffExitVisible = waitState === "aguardando_motor" && shouldShowWaitHandoffExit(waitStep)')
    expect(src).toContain("}, [waitState, payResult?.status, waitHandoffExitVisible])")
  })
})

describe("B6 M-2 regra pura — matchLiveChargeToAgreement", () => {
  it("cobrança viva cujo id é o asaas_payment_id de um acordo desta empresa → link + TOTAL do acordo (B-3)", async () => {
    const { matchLiveChargeToAgreement } = await import("@/lib/journey/pay")
    const out = matchLiveChargeToAgreement(
      [{ id: "pay_inst_1", status: "PENDING", deleted: false, value: 81.25, invoiceUrl: "https://asaas/i/inst_1", installment: "inst-1" }],
      [{ id: "ag-3x", asaas_payment_id: "pay_inst_1", agreed_amount: 243.75 }],
      SID,
    )
    expect(out).toMatchObject({ link: "https://asaas/i/inst_1", total: 243.75, agreementId: "ag-3x" })
  })

  it("cobrança viva de OUTRO cedente/legada (sem acordo desta empresa) → null (nunca 'a sua cobrança ativa')", async () => {
    const { matchLiveChargeToAgreement } = await import("@/lib/journey/pay")
    const out = matchLiveChargeToAgreement(
      [{ id: "pay_other", status: "PENDING", deleted: false, value: 999, invoiceUrl: "https://asaas/i/other", externalReference: "journey_sess-outra_off" }],
      [{ id: "ag-dead", asaas_payment_id: "pay_dead", agreed_amount: 250 }],
      SID,
    )
    expect(out).toBeNull()
  })

  it("externalReference desta sessão sem acordo gravado → link; total = value só em cobrança única (parcela → sem valor)", async () => {
    const { matchLiveChargeToAgreement } = await import("@/lib/journey/pay")
    const single = matchLiveChargeToAgreement([{ id: "p1", status: "PENDING", value: 250, invoiceUrl: "https://asaas/i/p1", externalReference: `journey_${SID}_off1` }], [], SID)
    expect(single).toMatchObject({ link: "https://asaas/i/p1", total: 250, agreementId: null })
    const inst = matchLiveChargeToAgreement([{ id: "p2", status: "PENDING", value: 81.25, invoiceUrl: "https://asaas/i/p2", externalReference: `journey_${SID}_off2`, installment: "i-2" }], [], SID)
    expect(inst).toMatchObject({ link: "https://asaas/i/p2", total: null })
  })

  it("B-2: cobranças deletadas/REFUNDED/RECEIVED/CONFIRMED nunca são escolhidas, mesmo mapeadas (isPayableCharge)", async () => {
    const { matchLiveChargeToAgreement } = await import("@/lib/journey/pay")
    const ags = [{ id: "ag-1", asaas_payment_id: "pay_1", agreed_amount: 250 }]
    expect(matchLiveChargeToAgreement([{ id: "pay_1", status: "PENDING", deleted: true, invoiceUrl: "https://asaas/i/1" }], ags, SID)).toBeNull()
    expect(matchLiveChargeToAgreement([{ id: "pay_1", status: "REFUNDED", invoiceUrl: "https://asaas/i/1" }], ags, SID)).toBeNull()
    expect(matchLiveChargeToAgreement([{ id: "pay_1", status: "DELETED", invoiceUrl: "https://asaas/i/1" }], ags, SID)).toBeNull()
    expect(matchLiveChargeToAgreement([{ id: "pay_1", status: "RECEIVED", invoiceUrl: "https://asaas/i/1" }], ags, SID)).toBeNull()
    expect(matchLiveChargeToAgreement([{ id: "pay_1", status: "CONFIRMED", invoiceUrl: "https://asaas/i/1" }], ags, SID)).toBeNull()
    // PENDING/OVERDUE continuam pagáveis
    expect(matchLiveChargeToAgreement([{ id: "pay_1", status: "OVERDUE", invoiceUrl: "https://asaas/i/1" }], ags, SID)).toMatchObject({ link: "https://asaas/i/1" })
    // sem URL nenhuma → não há o que entregar
    expect(matchLiveChargeToAgreement([{ id: "pay_1", status: "PENDING" }], ags, SID)).toBeNull()
  })
})

describe("B6 M-2 / B-1 / B-2 / B-3 — resolveLiveChargeLink e payService (rota real)", () => {
  beforeEach(seed)

  it("M-2 (era o R3 da rodada 1): acordo cancelado + cobrança viva NÃO mapeável no ASAAS → sem link, outcome charge_active + menu curto", async () => {
    db.agreements = [{ ...DEAD }]
    asaasForCustomer = [
      { id: "pay_dead", status: "PENDING", deleted: true, invoiceUrl: "https://asaas/i/dead" },
      { id: "pay_other", status: "PENDING", deleted: false, invoiceUrl: "https://asaas/i/other", dueDate: "2026-10-05", value: 250 },
    ]
    const { payService, ALREADY_CHARGED_NO_LINK_TEXT } = await import("@/lib/journey/pay")
    const r = await payService(ctx)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.already_charged).toBe(true)
    expect(r.link).toBeNull()
    expect(r.prompt?.kind).toBe("debt_three_options")
    expect(linkBubbles().length).toBe(0)
    expect(chargeActiveBubbles().length).toBe(1)
    expect(chargeActiveBubbles()[0].text).toBe(ALREADY_CHARGED_NO_LINK_TEXT)
  })

  it("M-2 positivo: cobrança viva no ASAAS mapeada pelo asaas_payment_id de um acordo desta empresa (local defasado) → link + total do acordo", async () => {
    db.agreements = [{ ...DEAD, asaas_payment_id: "pay_dead", agreed_amount: 250 }]
    asaasForCustomer = [
      { id: "pay_dead", status: "PENDING", deleted: false, invoiceUrl: "https://asaas/i/dead-but-live", dueDate: "2026-10-05", value: 250 },
    ]
    const { payService } = await import("@/lib/journey/pay")
    const r = await payService(ctx)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.link).toBe("https://asaas/i/dead-but-live")
    expect(r.prompt?.kind).toBe("post_payment_link")
    expect(linkBubbles()[0].text).toMatch(/R\$\s?250,00/)
  })

  it("B-1: acordo de OUTRA empresa com o mesmo customer_id e a mesma cobrança viva → não mapeia (nunca cruza tenant)", async () => {
    db.agreements = [{ ...DEAD }, { ...DEAD, id: "ag-other-co", company_id: OTHER_CO, asaas_payment_id: "pay_other", status: "active", payment_status: "pending" }]
    asaasForCustomer = [{ id: "pay_other", status: "PENDING", deleted: false, invoiceUrl: "https://asaas/i/other", value: 250 }]
    const { payService } = await import("@/lib/journey/pay")
    const r = await payService(ctx)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.link).toBeNull()
    expect(chargeActiveBubbles().length).toBe(1)
  })

  it("isPayableCharge: PENDING/OVERDUE sim; DELETED/REFUNDED/RECEIVED/CONFIRMED/RECEIVED_IN_CASH/deleted não", async () => {
    const { isPayableCharge } = await import("@/lib/journey/pay")
    expect(isPayableCharge({ status: "PENDING" })).toBe(true)
    expect(isPayableCharge({ status: "OVERDUE" })).toBe(true)
    for (const status of ["DELETED", "REFUNDED", "RECEIVED", "CONFIRMED", "RECEIVED_IN_CASH"]) expect(isPayableCharge({ status })).toBe(false)
    expect(isPayableCharge({ status: "PENDING", deleted: true })).toBe(false)
    expect(isPayableCharge(null)).toBe(false)
  })

  it("B-2: passo 1 com a cobrança do acordo já RECEIVED no ASAAS (local defasado) → sem link 'cobrança ativa' (outcome humano)", async () => {
    db.agreements = [{ ...LIVE_3X_NO_URL }]
    db.negotiation_sessions[0].agreement_id = LIVE_3X_NO_URL.id
    asaasById.pay_inst_1 = { id: "pay_inst_1", status: "RECEIVED", deleted: false, invoiceUrl: "https://asaas/i/inst_1", value: 81.25 }
    asaasForCustomer = [{ id: "pay_inst_1", status: "RECEIVED", deleted: false, invoiceUrl: "https://asaas/i/inst_1", value: 81.25 }]
    const { payService } = await import("@/lib/journey/pay")
    const r = await payService(ctx)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.link).toBeNull()
    expect(linkBubbles().length).toBe(0)
    expect(chargeActiveBubbles().length).toBe(1)
    // nunca declara pago
    expect(chargeActiveBubbles()[0].text).not.toMatch(/pago|recebid|quitad/i)
  })

  it("B-3: acordo 3x vivo sem URL local → copy com o TOTAL (R$ 243,75), nunca a parcela (R$ 81,25); rota Pagar idem", async () => {
    db.agreements = [{ ...LIVE_3X_NO_URL }]
    db.negotiation_sessions[0].agreement_id = LIVE_3X_NO_URL.id
    asaasById.pay_inst_1 = { id: "pay_inst_1", status: "PENDING", deleted: false, invoiceUrl: "https://asaas/i/inst_1", bankSlipUrl: "https://asaas/b/inst_1", dueDate: "2026-10-02", value: 81.25, installment: "inst-1" }
    const { POST } = await import("@/app/api/chat/button/route")
    const p1 = await bootstrap()
    const b = await (await POST(req(await signed(), { prompt_id: p1.id, button_id: 4 }))).json()
    expect(b).toMatchObject({ ok: true, action: "pay", already_charged: true, link: "https://asaas/i/inst_1" })
    expect(b.valor).toBe(243.75)
    expect(linkBubbles().length).toBe(1)
    expect(linkBubbles()[0].text).toMatch(/R\$\s?243,75/)
    expect(linkBubbles()[0].text).not.toMatch(/R\$\s?81,25/)
    expect(linkBubbles()[0].text).not.toMatch(/R\$\s?250,00/)
    // write-back das URLs continua (próximos polls)
    expect(db.agreements.find((a) => a.id === "ag-3x")!.asaas_invoice_url).toBe("https://asaas/i/inst_1")
  })
})
