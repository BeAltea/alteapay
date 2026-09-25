// A1 / G1 (com dado fresco) — N-D1-1 / N-D1-3 / N-D1-5 / N-D1-8.
//
//  - PAGAR persiste a bolha do link como OUTCOME (stage 'payment_link' + ação
//    open_payment_link) e, LOGO APÓS, o prompt pós-link (kind 'post_payment_link',
//    pergunta curta, [98 Voltar às opções] [99 Falar com atendimento]) — o
//    próximo passo NÃO vive só no client (sobrevive ao reload);
//  - POST /api/chat/button trata post_payment_link: 98 → menu curto; 99 → handoff;
//  - clique repetido em PAGAR reusa a oferta integral já aceita do acordo VIVO
//    (0 oferta nova, 0 reject, 0 confirmAccept) e responde already_charged com o
//    MESMO link; acordo cancelado → oferta nova → cobrança nova;
//  - reconhecimento implícito não é regravado quando a sessão já reconheceu.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

process.env.CHAT_JOURNEY_ENABLED = "true"
process.env.NEGOTIATION_JWT_SECRET = "test-secret-a1-postlink"

const CO = "eeeeeeee-0000-0000-0000-0000000a1pl1"
const SID = "sess-a1-postlink"
const CUST = "cust-a1-postlink"
const DEBT = "debt-a1-postlink"
const ctx = { sessionId: SID, companyId: CO, customerId: CUST, debtId: DEBT }

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
// closing: o caminho canônico (closeAgreement → charge-inline). Marca a oferta
// como accepted (como o real faz) e registra acordo + acceptance.
vi.mock("@/lib/journey/closing", () => ({
  buildAcceptSummary: async () => ({ ok: true, summary: { termsHash: "h", terms: {}, validUntil: null } }),
  confirmAccept: async ({ offerId }: { offerId: string }) => {
    confirmCalls += 1
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

function seed() {
  confirmCalls = 0
  events.length = 0
  db = {
    tenant_chat_config: [{
      company_id: CO, payment_origin: "platform", // o guard de reconhecimento (view) é exercitado em three-options.test.ts; aqui o
      // fake não recalcula a view dentro da mesma request → liberado por flag.
      allow_payment_without_acknowledgement: true,
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
  delete process.env.PAY_LINK_DUE_DAYS
}
/** Recalcula a "view" debt_acknowledgement_latest a partir do append-log. */
function refreshView() {
  const latest = new Map<string, any>()
  for (const r of db.debt_acknowledgements ?? []) {
    const key = `${r.session_id}|${r.debt_id}`
    const cur = latest.get(key)
    if (!cur || r.created_at >= cur.created_at) latest.set(key, r)
  }
  db.debt_acknowledgement_latest = [...latest.values()]
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
const active = () => db.chat_prompts.find((p) => p.status === "active")!
const linkBubbles = () => db.chat_messages.filter((m) => m.role === "assistant" && m.offers_snapshot?.stage === "payment_link")

describe("PAGAR → bolha do link (outcome) + prompt pós-link persistidos pelo servidor", () => {
  beforeEach(seed)

  it("resposta traz link + post_prompt_id; bolha com stage payment_link e ação open_payment_link; prompt post_payment_link ativo", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    const p1 = await bootstrap()
    const res = await POST(req(await signed(), { prompt_id: p1.id, button_id: 4 }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toMatchObject({ ok: true, action: "pay", already_charged: false, processing: false })
    expect(body.link).toBe("https://asaas/i/pay_new_1")
    expect(body.valor).toBe(250)
    expect(typeof body.post_prompt_id).toBe("string")

    // bolha do link = OUTCOME (fonte única do painel do client)
    const bubbles = linkBubbles()
    expect(bubbles.length).toBe(1)
    const b = bubbles[0]
    expect(b.offers_snapshot.message_action).toEqual({ type: "open_payment_link", label: "Abrir link de pagamento", href: body.link })
    expect(b.offers_snapshot.agreement_id).toBe(body.agreement_id)
    expect(b.text).toMatch(/R\$\s?250,00/)
    expect(b.text).toContain(body.link)
    expect(b.text.toLowerCase()).not.toMatch(/pagamento (confirmado|recebido)|quitad/)

    // prompt pós-link ativo, criado DEPOIS da bolha
    const post = active()
    expect(post.id).toBe(body.post_prompt_id)
    expect(post.kind).toBe("post_payment_link")
    expect(post.question).toBe("Como prefere seguir?")
    expect(post.buttons.map((x: any) => [x.id, x.label])).toEqual([[98, "Voltar às opções"], [99, "Falar com atendimento"]])
    expect(post.context.link).toBe(body.link)
    expect(post.context.agreement_id).toBe(body.agreement_id)
    expect(new Date(b.created_at).getTime()).toBeLessThanOrEqual(new Date(post.created_at).getTime())
    // o menu de 3 opções clicado ficou answered; exatamente 1 ativo
    expect(db.chat_prompts.find((p) => p.id === p1.id)!.status).toBe("answered")
    expect(db.chat_prompts.filter((p) => p.status === "active").length).toBe(1)
    expect(confirmCalls).toBe(1)
  })

  it("post_payment_link [98] → menu curto de 3 opções (back_to_options), sem saudação nova", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    const p1 = await bootstrap()
    await POST(req(await signed(), { prompt_id: p1.id, button_id: 4 }))
    const post = active()
    const res = await POST(req(await signed(), { prompt_id: post.id, button_id: 98 }))
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.action).toBe("back_to_options")
    expect(body.reply).toBe("Como prefere seguir?")
    const menu = active()
    expect(menu.kind).toBe("debt_three_options")
    expect(menu.question).toBe("Como prefere seguir?")
    expect(menu.buttons.map((x: any) => x.id)).toEqual([4, 1, 2, 0])
    expect(db.chat_messages.filter((m) => m.role === "assistant" && m.offers_snapshot?.stage === "greeting").length).toBe(1)
    // a bolha do link continua no histórico (outcome preservado)
    expect(linkBubbles().length).toBe(1)
  })

  it("post_payment_link [99] → handoff (transferred:true)", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    const p1 = await bootstrap()
    await POST(req(await signed(), { prompt_id: p1.id, button_id: 4 }))
    const post = active()
    const res = await POST(req(await signed(), { prompt_id: post.id, button_id: 99 }))
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.transferred).toBe(true)
    expect(db.negotiation_cases.some((c) => c.type === "human_handoff")).toBe(true)
  })

  it("já paguei (reopen payment_claim) sob o prompt pós-link → claim + menu curto; link preservado", async () => {
    const { POST: BUTTON } = await import("@/app/api/chat/button/route")
    const { POST: REOPEN } = await import("@/app/api/chat/reopen/route")
    const p1 = await bootstrap()
    await BUTTON(req(await signed(), { prompt_id: p1.id, button_id: 4 }))
    const res = await REOPEN(req(await signed(), { action: "payment_claim" }))
    const body = await res.json()
    expect(body.claim_registered).toBe(true)
    expect(active().kind).toBe("debt_three_options")
    expect(linkBubbles().length).toBe(1)
    expect(db.agreements.length).toBe(1)
  })
})

describe("clique repetido em PAGAR (N-D1-5): reusa a oferta aceita do acordo VIVO", () => {
  beforeEach(seed)

  it("Pagar → Voltar → Pagar: already_charged com o MESMO link, 0 oferta nova, 0 reject, 1 confirmAccept, 1 reconhecimento", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    const p1 = await bootstrap()
    const r1 = await (await POST(req(await signed(), { prompt_id: p1.id, button_id: 4 }))).json()
    refreshView()
    const post = active()
    await POST(req(await signed(), { prompt_id: post.id, button_id: 98 }))
    const menu = active()
    const r2 = await (await POST(req(await signed(), { prompt_id: menu.id, button_id: 4 }))).json()
    expect(r2.ok).toBe(true)
    expect(r2.already_charged).toBe(true)
    expect(r2.link).toBe(r1.link)
    expect(r2.agreement_id).toBe(r1.agreement_id)
    // 1 oferta integral (accepted), nenhuma criada+rejeitada por clique
    expect(db.negotiation_offers.length).toBe(1)
    expect(db.negotiation_offers[0].status).toBe("accepted")
    expect(events.filter((e) => e.type === "offer.rejected").length).toBe(0)
    expect(confirmCalls).toBe(1)
    // reconhecimento implícito gravado 1x (não regrava quando a sessão já reconheceu)
    expect(db.debt_acknowledgements.length).toBe(1)
    // 2 bolhas de link (novo + "já tem"), ambas outcome com ação; 1 prompt pós-link ativo
    const bubbles = linkBubbles()
    expect(bubbles.length).toBe(2)
    expect(bubbles[1].text).toMatch(/já tem uma cobrança ativa/i)
    expect(bubbles[1].offers_snapshot.message_action.href).toBe(r1.link)
    expect(active().kind).toBe("post_payment_link")
    expect(db.chat_prompts.filter((p) => p.status === "active").length).toBe(1)
  })

  it("payService: oferta integral aceita cujo acordo está CANCELADO não é reusada → oferta nova + cobrança nova", async () => {
    const { payService } = await import("@/lib/journey/pay")
    db.tenant_chat_config[0].allow_payment_without_acknowledgement = true
    // estado real do usuário de teste (N-D1-2): oferta integral aceita → acordo
    // cancelado (payment_status deleted) com asaas_status ainda 'PENDING'
    db.negotiation_offers = [{
      id: "off-accepted", company_id: CO, session_id: SID, customer_id: CUST, debt_id: DEBT, status: "accepted",
      terms: { original_value: 250, discount_pct: 0, discount_value: 0, entry_value: 0, installments: 1, installment_value: 250, total_value: 250, billing_type: "PIX", first_due_date: "2026-09-28" },
    }]
    db.negotiation_acceptances = [{ company_id: CO, session_id: SID, offer_id: "off-accepted", agreement_id: "ag-dead" }]
    db.agreements = [{
      id: "ag-dead", company_id: CO, customer_id: CUST, asaas_payment_id: "pay_dead", status: "cancelled",
      payment_status: "deleted", asaas_status: "PENDING", asaas_invoice_url: "https://asaas/i/dead", agreed_amount: 250, installments: 1, due_date: "2026-09-28",
    }]
    db.negotiation_sessions[0].agreement_id = "ag-dead"
    const r = await payService(ctx)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.already_charged).toBe(false)
      expect(r.link).toBe("https://asaas/i/pay_new_1")
      expect(r.link).not.toBe("https://asaas/i/dead")
    }
    expect(confirmCalls).toBe(1)
    // oferta NOVA (a aceita do acordo morto não foi reusada nem rejeitada)
    expect(db.negotiation_offers.length).toBe(2)
    expect(db.negotiation_offers.find((o) => o.id === "off-accepted")!.status).toBe("accepted")
  })

  it("payService: oferta integral aceita cujo acordo está VIVO é reusada (idempotente → already_charged, 0 confirmAccept)", async () => {
    const { payService } = await import("@/lib/journey/pay")
    db.tenant_chat_config[0].allow_payment_without_acknowledgement = true
    db.negotiation_offers = [{
      id: "off-live", company_id: CO, session_id: SID, customer_id: CUST, debt_id: DEBT, status: "accepted",
      terms: { original_value: 250, discount_pct: 0, discount_value: 0, entry_value: 0, installments: 1, installment_value: 250, total_value: 250, billing_type: "PIX", first_due_date: "2026-09-28" },
    }]
    db.negotiation_acceptances = [{ company_id: CO, session_id: SID, offer_id: "off-live", agreement_id: "ag-live" }]
    db.agreements = [{
      id: "ag-live", company_id: CO, customer_id: CUST, asaas_payment_id: "pay_live", status: "active",
      payment_status: "pending", asaas_status: "PENDING", asaas_invoice_url: "https://asaas/i/live", agreed_amount: 250, installments: 1, due_date: "2026-09-28",
    }]
    const r = await payService(ctx)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.already_charged).toBe(true)
      expect(r.link).toBe("https://asaas/i/live")
      expect(r.agreement_id).toBe("ag-live")
    }
    expect(confirmCalls).toBe(0)
    expect(db.negotiation_offers.length).toBe(1)
    expect(active().kind).toBe("post_payment_link")
  })
})
