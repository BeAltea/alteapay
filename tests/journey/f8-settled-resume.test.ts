// F8-02 — sessão JÁ ABERTA depois da quitação (webhook quitou a dívida enquanto
// o devedor estava com o chat aberto). Reload/poll, cliques de uma página
// defasada e o poll do link devem mostrar o MESMO estado de quitado do login:
// mensagem de quitação (copy do login), sem card do valor, sem link vivo, sem
// "Já paguei", sem menu de pagar/negociar — e nunca uma cobrança nova.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

const CO = "cccccccc-0000-0000-0000-0000000f8a02"
const OTHER_CO = "dddddddd-0000-0000-0000-0000000f8a02"
const SID = "sess_f8_02"
const CUST = "cust_f8"
const DEBT = "debt_f8"
const AG = "ag_f8"
const PROMPT = "prompt_menu"
const LINK = "https://www.asaas.com/i/parcela1"

let db: FakeDb
let asaasCalls = 0

vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/asaas", () => ({
  getAsaasPaymentsForCustomer: async () => {
    asaasCalls += 1
    return []
  },
}))

process.env.NEGOTIATION_JWT_SECRET = "test-secret-f8-02"
process.env.CHAT_JOURNEY_ENABLED = "true"
process.env.NEXT_PUBLIC_APP_URL = "https://alteapay.com"

const MENU_BUTTONS = [
  { id: 4, label: "Pagar R$ 250,00" },
  { id: 1, label: "Quero negociar" },
  { id: 0, label: "Não reconheço" },
]

/** Estado do F8 depois da última parcela: acordo completed/received, dívida paid. */
function seedSettled() {
  asaasCalls = 0
  db = {
    companies: [{ id: CO, name: "VMAX" }, { id: OTHER_CO, name: "Outra" }],
    tenant_chat_config: [{ company_id: CO, branding: {}, payment_origin: "platform", allow_payment_without_acknowledgement: true }],
    customers: [{ id: CUST, company_id: CO, name: "Fabio Mendes", document: "41700000011" }],
    debts: [
      { id: DEBT, company_id: CO, customer_id: CUST, status: "paid", amount: 250, due_date: "2026-08-01", updated_at: "2026-09-27T22:41:37.000Z" },
      // mesma pessoa em OUTRO tenant, com dívida aberta: não interfere (company_id).
      { id: "debt_other", company_id: OTHER_CO, customer_id: CUST, status: "pending", amount: 999, due_date: "2026-01-01" },
    ],
    vmax_invoices: [],
    negotiation_sessions: [{
      id: SID, company_id: CO, customer_id: CUST, debt_id: DEBT, debt_ids: [DEBT], primary_debt_id: DEBT,
      agreement_id: AG, thread_epoch: 0, wait_state: "gerando_cobranca", wait_started_at: "2026-09-27T22:39:00.000Z",
      outcome: "abandoned", status: "open",
    }],
    agreements: [{
      id: AG, company_id: CO, customer_id: CUST, debt_id: DEBT, negotiation_session_id: SID, origin: "chat_journey",
      status: "completed", payment_status: "received", asaas_status: "RECEIVED", asaas_payment_id: "pay_1",
      asaas_invoice_url: LINK, asaas_payment_url: null, asaas_boleto_url: null, asaas_pix_qrcode_url: null,
      payment_received_at: "2026-09-27T22:41:37.000Z", agreed_amount: 243.75, installments: 3, installment_amount: 81.25,
      due_date: "2026-10-04",
    }],
    chat_messages: [
      { id: "m1", company_id: CO, session_id: SID, role: "assistant", text: "Olá, Fabio.", button_id: null, prompt_id: null, engine: "platform", offers_snapshot: null, thread_epoch: null, archived_at: null, created_at: "2026-09-27T22:30:00.000Z" },
      { id: "m2", company_id: CO, session_id: SID, role: "customer", text: "3x de R$ 81,25", button_id: 2, prompt_id: "p_offer", engine: null, offers_snapshot: null, thread_epoch: null, archived_at: null, created_at: "2026-09-27T22:31:00.000Z" },
      {
        id: "m3", company_id: CO, session_id: SID, role: "assistant", text: `Aqui está seu link para pagar a 1ª parcela.\n${LINK}`,
        button_id: null, prompt_id: null, engine: "platform", thread_epoch: null, archived_at: null, created_at: "2026-09-27T22:31:05.000Z",
        offers_snapshot: { message_action: { type: "open_payment_link", label: "Abrir link de pagamento", href: LINK }, agreement_id: AG, stage: "payment_link" },
      },
    ],
    chat_prompts: [{
      id: PROMPT, company_id: CO, session_id: SID, kind: "post_payment_link", question: "Como prefere seguir?",
      buttons: MENU_BUTTONS, context: { debt_ids: [DEBT], primary_debt_id: DEBT }, status: "active", created_by: "platform",
      thread_epoch: null, archived_at: null, created_at: "2026-09-27T22:31:06.000Z",
    }],
    journey_events: [],
    negotiation_cases: [],
    negotiation_offers: [],
  }
}

async function cookie() {
  const { signChatJwt } = await import("@/lib/negotiation/crypto")
  return signChatJwt({ sid: SID, cid: CO }, 3600)
}

function getReq(value: string, since?: string) {
  const params = new URLSearchParams()
  if (since) params.set("since", since)
  return {
    cookies: { get: (n: string) => (n === "alteapay_chat_session" ? { value } : undefined) },
    nextUrl: { searchParams: params },
    headers: new Headers(),
  } as any
}

function postReq(value: string, body: Record<string, unknown>) {
  return {
    cookies: { get: (n: string) => (n === "alteapay_chat_session" ? { value } : undefined) },
    nextUrl: { searchParams: new URLSearchParams() },
    headers: new Headers(),
    json: async () => body,
  } as any
}

const settledRows = () =>
  (db.chat_messages ?? []).filter(
    (m) => m.role === "assistant" && m.offers_snapshot?.message_action?.type === "external_link",
  )

describe("F8-02 — detecção de quitação (critério do login)", () => {
  beforeEach(seedSettled)

  it("dívida paga e nenhuma aberta no tenant → quitado (outro tenant não conta)", async () => {
    const { detectCustomerSettlement } = await import("@/lib/journey/settled-state")
    const s = await detectCustomerSettlement({ companyId: CO, customerId: CUST, sessionId: SID })
    expect(s).not.toBeNull()
    expect(s?.totalPaid).toBe(250)
    expect(s?.paidAt).toBe("2026-09-27T22:41:37.000Z")
  })

  it("outra dívida aberta no mesmo tenant → não quitado", async () => {
    db.debts!.push({ id: "debt_2", company_id: CO, customer_id: CUST, status: "pending", amount: 10, due_date: "2026-09-01" })
    const { detectCustomerSettlement } = await import("@/lib/journey/settled-state")
    expect(await detectCustomerSettlement({ companyId: CO, customerId: CUST, sessionId: SID })).toBeNull()
  })

  it("dívida ainda in_negotiation mas o acordo DA SESSÃO quitado → quitado", async () => {
    db.debts![0].status = "in_negotiation"
    const { detectCustomerSettlement } = await import("@/lib/journey/settled-state")
    expect(await detectCustomerSettlement({ companyId: CO, customerId: CUST, sessionId: SID })).not.toBeNull()
  })

  it("parcela intermediária paga (acordo active/pending, dívida in_negotiation) → não quitado", async () => {
    db.debts![0].status = "in_negotiation"
    Object.assign(db.agreements![0], { status: "active", payment_status: "pending", asaas_status: "PENDING" })
    const { detectCustomerSettlement } = await import("@/lib/journey/settled-state")
    expect(await detectCustomerSettlement({ companyId: CO, customerId: CUST, sessionId: SID })).toBeNull()
  })

  it("acordo completed mas estornado, dívida aberta → não quitado", async () => {
    db.debts![0].status = "in_negotiation"
    db.agreements![0].payment_status = "refunded"
    const { detectCustomerSettlement } = await import("@/lib/journey/settled-state")
    expect(await detectCustomerSettlement({ companyId: CO, customerId: CUST, sessionId: SID })).toBeNull()
  })
})

describe("F8-02 — GET /api/chat/messages numa sessão quitada (reload/retomada)", () => {
  beforeEach(seedSettled)

  it("mostra o estado de quitado do login e preserva o histórico", async () => {
    const { GET } = await import("@/app/api/chat/messages/route")
    const res = await GET(getReq(await cookie()))
    const body = await res.json()
    expect(body.settled).toBe(true)
    expect(body.active_prompt).toBeNull()
    expect(body.prompt_pending).toBe(false)
    expect(body.pinned_debt).toBeNull()
    expect(body.recap).toBeNull()
    expect(body.wait_state).toBeNull()
    // histórico preservado, na ordem
    expect(body.messages.slice(0, 3).map((m: { id: string }) => m.id)).toEqual(["m1", "m2", "m3"])
    // link antigo vira histórico (sem Abrir/Copiar) e entra nos links mortos
    expect(body.messages[2].action.live).toBe(false)
    expect(body.dead_payment_links).toContain(LINK)
    // mensagem de quitação = a MESMA copy do login
    const last = body.messages[body.messages.length - 1]
    expect(last.text).toMatch(/^Olá, Fabio\. Não há valor em aberto em seu nome com a VMAX: o pagamento de R\$\s?250,00 consta como recebido em 27\/09\/2026\./)
    expect(last.action).toEqual({ type: "external_link", label: "Falar com atendimento", href: "https://alteapay.com/?tipo=recebi_cobranca#contato" })
    // menu aposentado no banco, espera limpa
    expect(db.chat_prompts![0].status).toBe("superseded")
    expect(db.negotiation_sessions![0].wait_state).toBeNull()
    // nenhum dado apagado
    expect(db.chat_messages!.filter((m) => ["m1", "m2", "m3"].includes(m.id))).toHaveLength(3)
  })

  it("polls seguintes não duplicam a mensagem de quitação", async () => {
    const { GET } = await import("@/app/api/chat/messages/route")
    const c = await cookie()
    await GET(getReq(c))
    await GET(getReq(c))
    const third = await (await GET(getReq(c, "2026-09-27T22:00:00.000Z"))).json()
    expect(settledRows()).toHaveLength(1)
    expect(third.settled).toBe(true)
  })

  it("login novo depois da quitação (mensagem do login já existe) → não duplica e esconde o card", async () => {
    const { bootstrapSettledMessage } = await import("@/lib/journey/acknowledgement")
    db.chat_messages = []
    db.chat_prompts = []
    const b = await bootstrapSettledMessage({ companyId: CO, sessionId: SID, customerId: CUST, totalPaid: 250, oldestDueDate: "2026-08-01", paidAt: "2026-09-27T22:41:37.000Z" })
    expect(b.ok && b.created).toBe(true)
    const { GET } = await import("@/app/api/chat/messages/route")
    const body = await (await GET(getReq(await cookie()))).json()
    expect(settledRows()).toHaveLength(1)
    expect(body.messages).toHaveLength(1)
    expect(body.pinned_debt).toBeNull()
  })

  it("sessão NÃO quitada: resposta de sempre (menu, card, sem `settled`)", async () => {
    db.debts![0].status = "in_negotiation"
    Object.assign(db.agreements![0], { status: "active", payment_status: "pending", asaas_status: "PENDING" })
    const { GET } = await import("@/app/api/chat/messages/route")
    const body = await (await GET(getReq(await cookie()))).json()
    expect(body.settled).toBeUndefined()
    expect(body.active_prompt?.id).toBe(PROMPT)
    expect(body.pinned_debt?.updated_value).toBe(250)
    expect(settledRows()).toHaveLength(0)
    expect(db.chat_prompts![0].status).toBe("active")
  })
})

describe("F8-02 — cliques de uma página defasada numa sessão quitada", () => {
  beforeEach(seedSettled)

  it("Pagar → shape de pagar SEM link, nenhum acordo/cobrança nova, menu aposentado", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    const res = await POST(postReq(await cookie(), { prompt_id: PROMPT, button_id: 4 }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toMatchObject({ ok: true, action: "pay", link: null, processing: false, already_charged: true, settled: true, prompt: null })
    expect(db.agreements).toHaveLength(1)
    expect(db.negotiation_offers).toHaveLength(0)
    expect(asaasCalls).toBe(0)
    expect(db.chat_prompts![0].status).toBe("superseded")
    expect(settledRows()).toHaveLength(1)
    expect((db.journey_events ?? []).some((e) => e.event_type === "chat.click_ignored")).toBe(true)
  })

  it("Negociar → estado de quitado (sem parcelas), clique repetido não duplica a resposta", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    const c = await cookie()
    const body = await (await POST(postReq(c, { prompt_id: PROMPT, button_id: 1 }))).json()
    expect(body).toMatchObject({ ok: true, action: "debt_settled", settled: true, prompt: null })
    await POST(postReq(c, { prompt_id: PROMPT, button_id: 1 }))
    expect(settledRows()).toHaveLength(1)
    expect((db.chat_prompts ?? []).filter((p) => p.status === "active")).toHaveLength(0)
  })

  it("\"Já paguei\" (reopen payment_claim) → sem caso novo, sem menu reaberto", async () => {
    const { POST } = await import("@/app/api/chat/reopen/route")
    const body = await (await POST(postReq(await cookie(), { action: "payment_claim" }))).json()
    expect(body).toMatchObject({ ok: true, action: "payment_claim", settled: true, claim_registered: false, prompt: null })
    expect(db.negotiation_cases).toHaveLength(0)
    expect((db.chat_prompts ?? []).filter((p) => p.status === "active")).toHaveLength(0)
    expect(settledRows()).toHaveLength(1)
  })

  it("\"Voltar às opções\" (reopen) → não republica o menu de pagar", async () => {
    const { POST } = await import("@/app/api/chat/reopen/route")
    const body = await (await POST(postReq(await cookie(), { action: "reopen_options" }))).json()
    expect(body).toMatchObject({ ok: true, settled: true, prompt: null })
    expect((db.chat_prompts ?? []).filter((p) => p.status === "active")).toHaveLength(0)
  })

  it("GET /api/chat/payment de um acordo quitado não devolve o link", async () => {
    const { GET } = await import("@/app/api/chat/payment/route")
    const body = await (await GET(getReq(await cookie()))).json()
    expect(body).toEqual({ ok: true, status: "settled" })
    const { interpretPaymentPoll } = await import("@/lib/journey/pay-poll")
    expect(interpretPaymentPoll(body).status).toBe("generating")
  })

  it("/api/chat/session accept/confirm/payment_claim → 409 debt_settled", async () => {
    const { POST } = await import("@/app/api/chat/session/route")
    const c = await cookie()
    for (const action of ["accept", "confirm", "payment_claim"]) {
      const res = await POST(postReq(c, { action, offerId: "off-1", termsHash: "h" }))
      expect(res.status).toBe(409)
      expect((await res.json()).code).toBe("debt_settled")
    }
  })
})
