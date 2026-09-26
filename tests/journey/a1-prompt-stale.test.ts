// A1 — 409 NUNCA é mudo (N-D3-3 / N-D1-4 / N-D3-2).
//
// POST /api/chat/button com um prompt_id obsoleto (respondido/substituído):
//  - se o prompt ATIVO tem o MESMO kind e contém o MESMO button_id → o clique é
//    RE-ALVEJADO para o ativo (200, `retargeted_from`; journey_events
//    chat.turn.customer com payload.retargeted_from);
//  - senão → 409 { code:'prompt_stale', active_prompt } com o prompt ativo no
//    MESMO shape do GET /api/chat/messages (id, kind, question, buttons, status,
//    created_at) — o client re-hidrata e avisa; nunca reabilita em silêncio.
// E todo clique válido deixa rastro `chat.turn.customer` (N-D3-2).
//
// Rotas reais + fake supabase; só a fronteira de cobrança/rede é mockada (mesmo
// recorte de d1-becos-lifecycle.test.ts).
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

process.env.CHAT_JOURNEY_ENABLED = "true"
process.env.NEGOTIATION_JWT_SECRET = "test-secret-a1-stale"

const CO = "eeeeeeee-0000-0000-0000-0000000a1st1"
const SID = "sess-a1-stale"
const CUST = "cust-a1-stale"
const DEBT = "debt-a1-stale"

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
      asaas_pix_qrcode_url: "pixcopy", asaas_boleto_url: null,
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

function seed() {
  confirmCalls = 0
  events.length = 0
  db = {
    tenant_chat_config: [{
      company_id: CO, payment_origin: "platform",
      // o guard de reconhecimento (view) é exercitado em three-options.test.ts; aqui o
      // fake não recalcula a view dentro da mesma request → liberado por flag.
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
    negotiation_sessions: [{ id: SID, company_id: CO, customer_id: CUST, debt_id: DEBT, agreement_id: null, debt_acknowledged_at: null }],
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
  delete process.env.PAYMENT_ORIGIN
  delete process.env.PAY_LINK_DUE_DAYS
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

describe("re-alvejamento: prompt obsoleto + ativo do MESMO kind com o MESMO botão", () => {
  beforeEach(seed)

  it("Detalhes num menu já respondido → 200 re-alvejado ao menu ativo, com auditoria retargeted_from", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    const p1 = await bootstrap()
    const r1 = await POST(buttonReq(await signed(), { prompt_id: p1.id, button_id: 2 }))
    expect((await r1.json()).action).toBe("consult")
    const p2 = active()!
    expect(p2.id).not.toBe(p1.id)

    // QA round 1 (QAA1-06): o MESMO botão no MESMO prompt logo em seguida é o
    // mesmo clique chegando de novo → 200 duplicate, sem efeito novo (o menu
    // ativo p2 continua ativo; nenhum eco/outcome novo; nada re-alvejado).
    const rDup = await POST(buttonReq(await signed(), { prompt_id: p1.id, button_id: 2 }))
    const bDup = await rDup.json()
    expect(rDup.status).toBe(200)
    expect(bDup).toMatchObject({ ok: true, duplicate: true })
    expect(bDup.prompt?.id).toBe(p2.id)
    expect(active()!.id).toBe(p2.id)
    expect(db.chat_messages.filter((m) => m.role === "customer" && m.button_id === 2).length).toBe(1)

    // client atrasado / 2ª aba, GENUINAMENTE tardio (fora da janela de duplicidade):
    // clica de novo em p1 (answered) com o mesmo botão → re-alvejado (A1).
    db.chat_prompts.find((p) => p.id === p1.id)!.answered_at = new Date(Date.now() - 60_000).toISOString()
    const r2 = await POST(buttonReq(await signed(), { prompt_id: p1.id, button_id: 2 }))
    const b2 = await r2.json()
    expect(r2.status).toBe(200)
    expect(b2.ok).toBe(true)
    expect(b2.action).toBe("consult")
    expect(b2.retargeted_from).toBe(p1.id)
    // o clique valeu para p2 (respondido) e há um novo menu ativo p3
    expect(db.chat_prompts.find((p) => p.id === p2.id)!.status).toBe("answered")
    const p3 = active()!
    expect(p3.id).not.toBe(p2.id)
    // eco do clique gravado no prompt re-alvejado (p2), não no obsoleto
    const echoes = db.chat_messages.filter((m) => m.role === "customer" && m.button_id === 2)
    expect(echoes.map((m) => m.prompt_id)).toEqual([p1.id, p2.id])
    // auditoria (N-D3-2): chat.turn.customer para os 2 cliques; o 2º com retargeted_from
    const turns = events.filter((e) => e.type === "chat.turn.customer")
    expect(turns.length).toBe(2)
    expect(turns[1].payload?.retargeted_from).toBe(p1.id)
    expect(turns[1].payload?.prompt_id).toBe(p2.id)
  })

  it("Pagar num menu obsoleto enquanto o menu ativo é payável → re-alvejado (1 cobrança)", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    const p1 = await bootstrap()
    // Voltar/Detalhes reabriu o menu (p2); a aba antiga ainda mostra p1
    await POST(buttonReq(await signed(), { prompt_id: p1.id, button_id: 2 }))
    const p2 = active()!
    const r = await POST(buttonReq(await signed(), { prompt_id: p1.id, button_id: 4 }))
    const b = await r.json()
    expect(r.status).toBe(200)
    expect(b.action).toBe("pay")
    expect(b.ok).toBe(true)
    expect(confirmCalls).toBe(1)
    expect(db.chat_prompts.find((p) => p.id === p2.id)!.status).toBe("answered")
  })
})

describe("409 prompt_stale: ativo de OUTRO kind ou sem o botão → aviso + active_prompt no corpo", () => {
  beforeEach(seed)

  it("Detalhes num menu obsoleto quando o ativo é o prompt pós-link → 409 prompt_stale com active_prompt (shape do GET)", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    const p1 = await bootstrap()
    // Pagar → prompt pós-link (post_payment_link) fica ativo
    const pay = await POST(buttonReq(await signed(), { prompt_id: p1.id, button_id: 4 }))
    expect((await pay.json()).ok).toBe(true)
    const post = active()!
    expect(post.kind).toBe("post_payment_link")

    const r = await POST(buttonReq(await signed(), { prompt_id: p1.id, button_id: 2 }))
    const b = await r.json()
    expect(r.status).toBe(409)
    expect(b.ok).toBe(false)
    expect(b.code).toBe("prompt_stale")
    // active_prompt no MESMO shape do GET /api/chat/messages
    expect(b.active_prompt).toBeTruthy()
    expect(Object.keys(b.active_prompt).sort()).toEqual(["buttons", "created_at", "id", "kind", "question", "status"])
    expect(b.active_prompt.id).toBe(post.id)
    expect(b.active_prompt.kind).toBe("post_payment_link")
    expect(b.active_prompt.status).toBe("active")
    expect(b.active_prompt.buttons.map((x: any) => x.id)).toEqual([98, 99])
    // nenhum efeito colateral: sem eco novo, sem 2ª cobrança, ativo intacto
    expect(db.chat_messages.filter((m) => m.role === "customer").length).toBe(1)
    expect(confirmCalls).toBe(1)
    expect(active()!.id).toBe(post.id)
  })

  it("mesmo kind mas SEM o botão (menu-volta do 'não reconheço' só tem [98]) → 409 prompt_stale", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    const p1 = await bootstrap()
    await POST(buttonReq(await signed(), { prompt_id: p1.id, button_id: 0 }))
    const back = active()!
    expect(back.buttons.map((x: any) => x.id)).toEqual([98])
    const r = await POST(buttonReq(await signed(), { prompt_id: p1.id, button_id: 4 }))
    const b = await r.json()
    expect(r.status).toBe(409)
    expect(b.code).toBe("prompt_stale")
    expect(b.active_prompt.id).toBe(back.id)
    expect(confirmCalls).toBe(0)
  })

  it("sem NENHUM prompt ativo → 409 prompt_stale com active_prompt null (o client re-hidrata pelo poll)", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    const p1 = await bootstrap()
    // supersede tudo (ex.: reset de thread) sem criar outro
    for (const p of db.chat_prompts) p.status = "superseded"
    const r = await POST(buttonReq(await signed(), { prompt_id: p1.id, button_id: 2 }))
    const b = await r.json()
    expect(r.status).toBe(409)
    expect(b.code).toBe("prompt_stale")
    expect(b.active_prompt).toBeNull()
  })

  it("corrida: 2 cliques concorrentes no MESMO Pagar → 1 'pay' + 1 duplicate (nunca prompt_not_active mudo, nunca 2 cobranças)", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    const p1 = await bootstrap()
    const jwt = await signed()
    const [r1, r2] = await Promise.all([
      POST(buttonReq(jwt, { prompt_id: p1.id, button_id: 4 })),
      POST(buttonReq(jwt, { prompt_id: p1.id, button_id: 4 })),
    ])
    const bodies = [await r1.json(), await r2.json()]
    // QA round 1 (QAA1-06): o perdedor é o MESMO clique (mesmo prompt + mesmo
    // botão, instantes depois) → 200 duplicate, nunca 409 mudo, nunca 2ª cobrança.
    const codes = bodies.map((b) => b.code ?? (b.duplicate ? "duplicate" : b.action))
    expect(codes).toContain("pay")
    expect(codes).toContain("duplicate")
    expect(codes).not.toContain("prompt_not_active")
    expect(confirmCalls).toBe(1)
  })
})

describe("auditoria de clique (N-D3-2)", () => {
  beforeEach(seed)

  it("todo clique válido grava chat.turn.customer com button_id/prompt_id/kind", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    const p1 = await bootstrap()
    await POST(buttonReq(await signed(), { prompt_id: p1.id, button_id: 2 }))
    const turn = events.find((e) => e.type === "chat.turn.customer")
    expect(turn).toBeTruthy()
    expect(turn!.payload).toMatchObject({ button_id: 2, prompt_id: p1.id, kind: "debt_three_options" })
    expect(turn!.payload?.retargeted_from).toBeUndefined()
  })
})

describe("re-alvejamento exige o MESMO botão: id + rótulo + value iguais (A1-R2 / D3)", () => {
  beforeEach(seed)

  it("mesmo kind e mesmo id, rótulo DIFERENTE (saldo mudou entre os menus) → 409 prompt_stale, 0 cobrança, ativo intacto", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    const p1 = await bootstrap()
    // Detalhes reabre o menu (p2, mesmo kind); a aba antiga ainda mostra p1
    await POST(buttonReq(await signed(), { prompt_id: p1.id, button_id: 2 }))
    const p2 = active()!
    expect(p2.kind).toBe(p1.kind)
    const staleLabel = p1.buttons.find((b: any) => b.id === 4)!.label
    // VMAX atualizou o saldo: o menu ATIVO cobra outro valor
    p2.buttons = p2.buttons.map((b: any) => (b.id === 4 ? { ...b, label: "Pagar R$ 260,00" } : b))
    expect(staleLabel).not.toBe("Pagar R$ 260,00")

    const r = await POST(buttonReq(await signed(), { prompt_id: p1.id, button_id: 4 }))
    const b = await r.json()
    expect(r.status).toBe(409)
    expect(b.ok).toBe(false)
    expect(b.code).toBe("prompt_stale")
    expect(b.active_prompt.id).toBe(p2.id)
    expect(b.active_prompt.buttons.find((x: any) => x.id === 4).label).toBe("Pagar R$ 260,00")
    // D3: o valor do menu ativo NUNCA é cobrado por um clique no menu antigo
    expect(confirmCalls).toBe(0)
    expect(active()!.id).toBe(p2.id)
    expect(db.chat_prompts.find((p) => p.id === p2.id)!.status).toBe("active")
    // nenhum eco novo (só o Detalhes)
    expect(db.chat_messages.filter((m) => m.role === "customer").length).toBe(1)
    expect(events.filter((e) => e.type === "chat.turn.customer").length).toBe(1)
  })

  it("offer_choice: mesmo id posicional com value (offer_id) DIFERENTE → 409 prompt_stale; a oferta do outro prompt nunca é aceita", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    const base = {
      company_id: CO, session_id: SID, kind: "offer_choice", question: "Qual opção prefere?",
      created_by: "platform", n8n_execution_id: null, expires_at: null, thread_epoch: 0, archived_at: null,
    }
    db.chat_prompts = [
      {
        ...base, id: "oc-old", status: "answered", created_at: "2026-09-25T10:00:00Z",
        buttons: [{ id: 2, label: "3x de R$ 81,25", value: "off-a" }, { id: 98, label: "Voltar às opções" }],
        context: { offer_ids: ["off-a"] },
      },
      {
        ...base, id: "oc-new", status: "active", created_at: "2026-09-25T10:05:00Z",
        buttons: [{ id: 2, label: "3x de R$ 81,25", value: "off-b" }, { id: 98, label: "Voltar às opções" }],
        context: { offer_ids: ["off-b"] },
      },
    ]
    const r = await POST(buttonReq(await signed(), { prompt_id: "oc-old", button_id: 2 }))
    const b = await r.json()
    expect(r.status).toBe(409)
    expect(b.code).toBe("prompt_stale")
    expect(b.active_prompt.id).toBe("oc-new")
    expect(confirmCalls).toBe(0)
    expect(db.chat_prompts.find((p) => p.id === "oc-new")!.status).toBe("active")
    expect(db.chat_messages.filter((m) => m.role === "customer").length).toBe(0)
  })

  it("offer_choice: botão sem value e rótulo igual ([98] Voltar) → continua re-alvejado (mesma intenção)", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    const base = {
      company_id: CO, session_id: SID, kind: "offer_choice", question: "Qual opção prefere?",
      created_by: "platform", n8n_execution_id: null, expires_at: null, thread_epoch: 0, archived_at: null,
    }
    db.chat_prompts = [
      {
        ...base, id: "oc-old", status: "answered", created_at: "2026-09-25T10:00:00Z",
        buttons: [{ id: 2, label: "3x de R$ 81,25", value: "off-a" }, { id: 98, label: "Voltar às opções" }],
        context: { offer_ids: ["off-a"], debt_ids: [DEBT], primary_debt_id: DEBT },
      },
      {
        ...base, id: "oc-new", status: "active", created_at: "2026-09-25T10:05:00Z",
        buttons: [{ id: 2, label: "3x de R$ 81,25", value: "off-b" }, { id: 98, label: "Voltar às opções" }],
        context: { offer_ids: ["off-b"], debt_ids: [DEBT], primary_debt_id: DEBT },
      },
    ]
    const r = await POST(buttonReq(await signed(), { prompt_id: "oc-old", button_id: 98 }))
    const b = await r.json()
    expect(r.status).toBe(200)
    expect(b.ok).toBe(true)
    expect(b.action).toBe("back_to_options")
    expect(db.chat_prompts.find((p) => p.id === "oc-new")!.status).toBe("answered")
    expect(confirmCalls).toBe(0)
  })
})
