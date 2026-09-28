// N8N-7 — estados `aguardando_motor` e `menu_degradado` com o motor n8n LIGADO
// (NEGOTIATION_ENGINE=n8n) e um fluxo n8n SIMULADO por um servidor HTTP local
// (o mesmo caminho real: kickoff negotiation.start → callN8nFlow → corpo SYNC →
// chatSend). Rotas reais (/api/chat/button, /reopen, /messages) + fake supabase.
// Só a fronteira da cobrança é espiada (payService / acceptMatrixCondition).
//
// Premissa provada aqui: a espera do motor só existe quando a MATRIZ não gera
// parcelas (sem faixa vigente) — com parcelas, o Negociar nunca espera o n8n,
// por mais lento que ele esteja. Cenários:
//  (a) n8n lento (responde depois do deadline)      (b) n8n estoura o timeout
//  (c) n8n 5xx                                        (d) n8n devolve fallback
//  (e) n8n sem ofertas / botões vazios               (f) resposta tardia após a degradação
//  (g) cada botão em aguardando_motor e em menu_degradado
// Asserções: transições; no máximo UM menu ativo (prompt ativo XOR espera no
// servidor); nenhum clique sem próximo passo; valores só da matriz; nenhuma
// cobrança duplicada; espera limitada pelo deadline.
import { createServer, type Server } from "node:http"
import { createHmac } from "node:crypto"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

process.env.CHAT_JOURNEY_ENABLED = "true"
process.env.NEGOTIATION_JWT_SECRET = "test-secret-n8n7"
const SECRET = "test-n8n7-hmac-secret"

const CO = "eeeeeeee-0000-0000-0000-000000000n87"
const SID = "5e551011-0000-0000-0000-000000000n87"
const CUST = "cust-n87"
const DEBT = "debt-n87"

let db: FakeDb
const payCalls: Array<{ debtIds?: string[] }> = []
const acceptCalls: string[] = []

vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/asaas", () => ({ getAsaasPaymentsForCustomer: async () => [] }))
vi.mock("@/lib/notifications/email", () => ({ sendEmail: async () => ({ ok: true }) }))
vi.mock("@/lib/journey/events", () => ({
  recordEvent: async () => ({ ok: true, duplicate: false }),
  getTimeline: async () => [],
}))
// Fronteira da cobrança: o guard/ASAAS têm testes próprios. Aqui só contamos
// QUANTAS cobranças o clique pediria e com QUAL oferta.
vi.mock("@/lib/journey/pay", async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  return {
    ...real,
    payService: async (_ctx: unknown, opts?: { debtIds?: string[] }) => {
      payCalls.push({ debtIds: opts?.debtIds })
      return {
        ok: true, link: "https://www.asaas.com/i/fake", valor: "R$ 250,00", vencimento_link: "01/10/2026",
        already_charged: payCalls.length > 1, processing: false, agreement_id: "ag-1", post_prompt_id: null,
        link_message_id: null, prompt: null,
      }
    },
  }
})
vi.mock("@/lib/journey/assisted", async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  return {
    ...real,
    acceptMatrixCondition: async (_ctx: unknown, offerId: string) => {
      acceptCalls.push(offerId)
      const ok = (db.negotiation_offers ?? []).some((o) => o.id === offerId && o.status === "presented")
      return ok ? { ok: false, code: "unexpected_in_test" } : { ok: false, code: "offer_not_available", status: 422 }
    },
  }
})

// --- fluxo n8n simulado ------------------------------------------------------
type Mode = "async" | "slow" | "hang" | "5xx" | "fallback" | "empty" | "empty_buttons" | "prompt_fast" | "text_slow"
let mode: Mode = "async"
let hits = 0
let badSignatures = 0
let server: Server
let port = 0

const YES_NO = { kind: "generic_yes_no", question: "Quer ver as condições de parcelamento?", buttons: [{ id: 1, label: "Sim" }, { id: 0, label: "Não" }] }

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      hits++
      const ts = String(req.headers["x-alteapay-timestamp"] ?? "")
      const sig = String(req.headers["x-alteapay-signature"] ?? "")
      const expected = createHmac("sha256", SECRET).update(`${ts}.${raw}`).digest("hex")
      if (!sig.includes(expected)) badSignatures++
      const json = (body: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body))
      switch (mode) {
        case "hang": return // nunca responde (o timeout do kickoff corta)
        case "5xx": return void res.writeHead(502).end("bad gateway")
        case "slow": return void setTimeout(() => json({ text: "Posso te ajudar com isso.", prompt: YES_NO }), 450)
        case "text_slow": return void setTimeout(() => json({ text: "Vou verificar as condições para você." }), 450)
        case "fallback": return json({ text: "Desculpe, não entendi. Por favor, selecione uma das opções válidas." })
        case "empty": return json({})
        case "empty_buttons": return json({ text: "", buttons: [] })
        case "prompt_fast": return json({ text: "Posso te ajudar com isso.", prompt: YES_NO })
        default: return json({ message: "Workflow was started" })
      }
    })
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const a = server.address()
  port = typeof a === "object" && a ? a.port : 0
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

// Deadline curto para o teste (produção: 2500 ms / 2500 ms).
const DEADLINE_MS = 250
const KICK_TIMEOUT_MS = 200

function seed(opts: { matrix?: boolean } = {}) {
  payCalls.length = 0
  acceptCalls.length = 0
  hits = 0
  badSignatures = 0
  mode = "async"
  process.env.NEGOTIATION_ENGINE = "n8n"
  process.env.N8N_WEBHOOK_SECRET = SECRET
  process.env.N8N_CHAT_FLOW_URL = `http://127.0.0.1:${port}/webhook/chat`
  process.env.N8N_KICKOFF_DEADLINE_MS = String(DEADLINE_MS)
  process.env.N8N_KICKOFF_TIMEOUT_MS = String(KICK_TIMEOUT_MS)
  process.env.NEXT_PUBLIC_APP_URL = "https://alteapay.com"
  delete process.env.N8N_EVENT_FLOW_URL
  delete process.env.MOCK_ALL_INTEGRATIONS
  db = {
    tenant_chat_config: [{
      company_id: CO, payment_origin: "platform", allow_payment_without_acknowledgement: true,
      acknowledgement_enabled: true, show_handoff_button: false, on_debt_not_recognized: "continue",
      official_channel_label: null, official_channel_url: null, branding: { brand_name: "VMAX" },
      creditor_notification_emails: [], send_document_to_engine: false,
    }],
    companies: [{ id: CO, name: "VMAX LTDA" }],
    customers: [{ id: CUST, company_id: CO, name: "Fabio Mendes", document: "11144477735" }],
    debts: [{ id: DEBT, company_id: CO, customer_id: CUST, status: "pending", amount: 250, due_date: "2020-01-01" }],
    vmax_invoices: [{ id_company: CO, doc: "11144477735", fatura: "F1", vencimento: "2020-01-10", saldo: 250 }],
    negotiation_sessions: [{
      id: SID, company_id: CO, customer_id: CUST, debt_id: DEBT, primary_debt_id: DEBT, debt_ids: [DEBT],
      agreement_id: null, debt_acknowledged_at: null, engine_owner: "platform", engine: "n8n",
      channel: "web_generic", identity_verified_at: "2026-09-27T10:00:00Z", fulfillment_mode: "A",
      wait_state: null, wait_started_at: null, thread_epoch: 0,
    }],
    negotiation_offers: [],
    // SEM faixa de matriz: é a ÚNICA forma de o Negociar cair na espera do motor.
    negotiation_condition_matrix: opts.matrix
      ? [{
          id: "mx-1", company_id: CO, name: "default", priority: 1, active: true, valid_from: null, valid_to: null,
          aging_min_days: 0, aging_max_days: null, aging_basis: "oldest_due", max_discount_pct: 30,
          installment_discount_pct: 10, min_entry_pct: 20, max_installments: 3, min_installment_value: 10,
          allowed_billing_types: ["PIX", "BOLETO"], proposal_validity_days: 7, retry_after_days: 3, max_retries: 2,
          min_debt_value: 0,
        }]
      : [],
    negotiation_acceptances: [],
    negotiation_cases: [],
    contact_suppressions: [],
    chat_prompts: [],
    chat_messages: [],
    debt_acknowledgements: [],
    debt_acknowledgement_latest: [],
    agreements: [],
    engine_outbox: [],
  }
}

// --- helpers -----------------------------------------------------------------
function req(cookie: string, body: Record<string, unknown> = {}, search = "") {
  return {
    cookies: { get: (n: string) => (n === "alteapay_chat_session" ? { value: cookie } : undefined) },
    headers: { get: () => null },
    nextUrl: { searchParams: new URLSearchParams(search) },
    json: async () => body,
  } as any
}
async function cookie() {
  const { signChatJwt } = await import("@/lib/negotiation/crypto")
  return signChatJwt({ sid: SID, cid: CO }, 3600)
}
async function bootstrap() {
  const { bootstrapThreeOptionsPrompt } = await import("@/lib/journey/acknowledgement")
  await bootstrapThreeOptionsPrompt({ companyId: CO, sessionId: SID, customerId: CUST, debtIds: [DEBT], primaryDebtId: DEBT })
  return activePrompts()[0]
}
const activePrompts = () => (db.chat_prompts ?? []).filter((p) => p.status === "active")
const sess = () => db.negotiation_sessions.find((s) => s.id === SID)!
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function click(promptId: string, buttonId: number) {
  const { POST } = await import("@/app/api/chat/button/route")
  const t0 = Date.now()
  const r = await POST(req(await cookie(), { prompt_id: promptId, button_id: buttonId }))
  return { status: r.status, body: await r.json(), ms: Date.now() - t0 }
}
/** Envelhece os cliques já gravados (o devedor real só toca uma saída depois
 *  de ela armar, WAIT_EXITS_ARM_MS = 2,5 s > janela do toque duplo de 2 s). */
function ageClicks(ms = 5_000) {
  for (const m of db.chat_messages) if (m.role === "customer") m.created_at = new Date(Date.now() - ms).toISOString()
}
async function reopen(action: "reopen_options" | "handoff" | "payment_claim") {
  const { POST } = await import("@/app/api/chat/reopen/route")
  const r = await POST(req(await cookie(), { action }))
  return { status: r.status, body: await r.json() }
}
async function poll() {
  const { GET } = await import("@/app/api/chat/messages/route")
  const r = await GET(req(await cookie()))
  return (await r.json()) as { wait_state: string | null; wait_started_at: string | null; active_prompt: { id: string; kind: string; buttons: Array<{ id: number; label: string; value?: string }> } | null; messages: Array<{ role: string; text: string; engine?: string | null; prompt_id?: string | null }> }
}

/**
 * O que a TELA mostra num poll (F5 ou poll corrente), pela regra do client:
 * hydrateWaitState/resolveWaitView (wait-machine.ts) + o prompt ativo. O bloco
 * de espera/degradação é renderizado por waitState e o menu por active_prompt,
 * de forma independente (chat.tsx) — por isso "um menu só" é: nunca os dois.
 */
async function screenAt(nowOffsetMs = 0) {
  const { hydrateWaitState, resolveWaitView } = await import("@/lib/journey/wait-machine")
  const p = await poll()
  const view = resolveWaitView(hydrateWaitState(p), p.wait_started_at, Date.now() + nowOffsetMs)
  const waitBlock = view.state === "aguardando_motor" || view.state === "menu_degradado" ? view.state : null
  return { waitBlock, menu: p.active_prompt, poll: p, menus: (waitBlock ? 1 : 0) + (p.active_prompt ? 1 : 0) }
}

// =============================================================================
describe("N8N-7 — premissa: com parcelas da matriz o Negociar nunca espera o n8n", () => {
  beforeEach(() => seed({ matrix: true }))

  it("n8n pendurado + matriz com faixa → parcelas na hora, sem wait_state", async () => {
    mode = "hang"
    const p = await bootstrap()
    const r = await click(p.id, 1)
    expect(r.body.offers_presented).toBe(true)
    expect(r.body.wait_state).toBeUndefined()
    expect(sess().wait_state).toBeNull()
    expect(r.ms).toBeLessThan(DEADLINE_MS) // não espera o kickoff
    const s = await screenAt(20_000)
    expect(s.waitBlock).toBeNull()
    expect(s.menu?.kind).toBe("offer_choice")
  })
})

describe("N8N-7 (a) n8n LENTO — responde depois do deadline", () => {
  beforeEach(() => seed())

  // O POST do kickoff precisa durar MAIS que o deadline do clique para a resposta
  // síncrona tardia ainda chegar (em produção os dois são 2500 ms: um n8n mais
  // lento que isso é, para a plataforma, um timeout — ver (b) e o relatório).
  beforeEach(() => { process.env.N8N_KICKOFF_TIMEOUT_MS = "1000" })

  it("clique responde no deadline com aguardando_motor; a resposta tardia com botões encerra a espera (um menu só)", async () => {
    mode = "slow"
    const p = await bootstrap()
    const r = await click(p.id, 1)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, action: "negotiate", wait_state: "aguardando_motor", kickoff: "pending" })
    expect(r.ms).toBeLessThan(DEADLINE_MS + 400)
    const { negotiateWaitOnResponse } = await import("@/lib/journey/wait-machine")
    expect(negotiateWaitOnResponse(r.body)).toBe(true)
    // durante a espera: só o bloco de espera (menu de 3 opções consumido)
    let s = await screenAt()
    expect(s.waitBlock).toBe("aguardando_motor")
    expect(s.menu).toBeNull()
    expect(s.menus).toBe(1)
    // n8n responde (450 ms) → prompt do n8n ativo, espera aposentada no servidor
    await sleep(700)
    s = await screenAt(20_000) // F5 muito depois: nunca o menu de degradação junto
    expect(s.menu?.kind).toBe("generic_yes_no")
    expect(s.waitBlock).toBeNull()
    expect(s.menus).toBe(1)
    expect(activePrompts().length).toBe(1)
    expect(badSignatures).toBe(0)
  })

  it("resposta tardia só com TEXTO não tira o devedor da espera (antes: sem espera e sem menu)", async () => {
    mode = "text_slow"
    const p = await bootstrap()
    await click(p.id, 1)
    await sleep(700)
    const s = await screenAt()
    // a bolha entra, mas a espera continua e degrada aos 15 s — nunca beco
    expect(s.poll.messages.some((m) => m.engine === "n8n" && /verificar/.test(m.text))).toBe(true)
    expect(sess().wait_state).toBe("aguardando_motor")
    expect(s.waitBlock).toBe("aguardando_motor")
    expect((await screenAt(16_000)).waitBlock).toBe("menu_degradado")
  })
})

describe("N8N-7 (b) timeout e (c) 5xx — o motor não responde", () => {
  beforeEach(() => seed())

  for (const m of ["hang", "5xx"] as const) {
    it(`${m}: clique limitado pelo deadline, espera armada; aos 15 s o F5 mostra só o menu de degradação`, async () => {
      mode = m
      const p = await bootstrap()
      const r = await click(p.id, 1)
      expect(r.body.wait_state).toBe("aguardando_motor")
      expect(["pending", "unavailable"]).toContain(r.body.kickoff)
      expect(r.ms).toBeLessThan(DEADLINE_MS + 400)
      await sleep(KICK_TIMEOUT_MS + 100)
      // outbox durável para a reentrega; nada gravado para o devedor
      expect(db.engine_outbox?.some((o) => o.status === "pending")).toBe(true)
      expect(db.chat_messages.some((x) => x.engine === "n8n")).toBe(false)
      const at14 = await screenAt(14_000)
      expect(at14.waitBlock).toBe("aguardando_motor")
      const at15 = await screenAt(15_001)
      expect(at15.waitBlock).toBe("menu_degradado")
      expect(at15.menu).toBeNull()
      expect(at15.menus).toBe(1)
    })
  }
})

describe("N8N-7 (d) n8n devolve texto de FALLBACK (guard N8N-6)", () => {
  beforeEach(() => seed())

  it("fallback dentro do deadline → sessão em menu_degradado na hora; nada do texto chega ao devedor; um menu só", async () => {
    mode = "fallback"
    const p = await bootstrap()
    const r = await click(p.id, 1)
    expect(r.body.wait_state).toBe("menu_degradado")
    const { negotiateWaitOnResponse } = await import("@/lib/journey/wait-machine")
    expect(negotiateWaitOnResponse(r.body)).toBe(true) // o client arma e o poll degrada
    const s = await screenAt()
    expect(s.waitBlock).toBe("menu_degradado")
    expect(s.menu).toBeNull() // antes: menu de 3 opções reaberto JUNTO da espera
    expect(s.menus).toBe(1)
    expect(s.poll.messages.some((m) => /op[cç][õo]es v[áa]lidas/i.test(m.text))).toBe(false)
    expect(sess().engine).toBe("disabled") // degradada para o assistido
  })

  it("fallback tardio (webhook chat.send) na espera → menu_degradado, sem menu duplicado", async () => {
    mode = "async"
    const p = await bootstrap()
    await click(p.id, 1)
    expect(sess().wait_state).toBe("aguardando_motor")
    const { chatSend } = await import("@/lib/journey/chat-send")
    const out = await chatSend({ sessionId: SID, companyId: CO, customerId: CUST, debtId: DEBT }, { text: "Selecione uma das opções válidas." }, "evt-fb-late")
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.code).toBe("text_rejected")
    const s = await screenAt()
    expect(s.waitBlock).toBe("menu_degradado")
    expect(s.menu).toBeNull()
  })

  it("fallback FORA da espera (sem prompt ativo) → reabre o menu de 3 opções (comportamento N8N-6 preservado)", async () => {
    const { chatSend } = await import("@/lib/journey/chat-send")
    await chatSend({ sessionId: SID, companyId: CO, customerId: CUST, debtId: DEBT }, { text: "Selecione uma das opções válidas." }, "evt-fb-idle")
    const s = await screenAt()
    expect(s.menu?.kind).toBe("debt_three_options")
    expect(s.waitBlock).toBeNull()
  })
})

describe("N8N-7 (e) n8n sem ofertas / botões vazios", () => {
  beforeEach(() => seed())

  for (const m of ["empty", "empty_buttons"] as const) {
    it(`${m}: nada persiste, a espera segue e degrada aos 15 s; nenhum botão vazio na tela`, async () => {
      mode = m
      const p = await bootstrap()
      const r = await click(p.id, 1)
      expect(r.body.wait_state).toBe("aguardando_motor")
      await sleep(100)
      expect(db.chat_messages.some((x) => x.engine === "n8n")).toBe(false)
      expect(activePrompts().length).toBe(0)
      expect((await screenAt(15_001)).waitBlock).toBe("menu_degradado")
    })
  }

  it("webhook chat.send com offer_choice de botões vazios → 422, nada gravado, espera intacta", async () => {
    const p = await bootstrap()
    await click(p.id, 1)
    const { chatSend } = await import("@/lib/journey/chat-send")
    const out = await chatSend({ sessionId: SID, companyId: CO, customerId: CUST, debtId: DEBT }, { text: "Escolha:", prompt: { kind: "offer_choice", question: "Escolha:", buttons: [] } }, "evt-empty-btn")
    expect(out.ok).toBe(false)
    expect(sess().wait_state).toBe("aguardando_motor")
    expect(activePrompts().length).toBe(0)
  })

  it("n8n inventa parcela com valor que a matriz não gerou → recusada pelo guard; nada cobrável aparece", async () => {
    const p = await bootstrap()
    await click(p.id, 1)
    const { chatSend } = await import("@/lib/journey/chat-send")
    const out = await chatSend(
      { sessionId: SID, companyId: CO, customerId: CUST, debtId: DEBT },
      { text: "Condições:", prompt: { kind: "offer_choice", question: "Condições:", buttons: [{ id: 2, label: "3x de R$ 50,00", value: "parc_3" }] } },
      "evt-invented",
    )
    expect(out.ok).toBe(false)
    expect(activePrompts().length).toBe(0)
    expect(sess().wait_state).toBe("aguardando_motor")
  })

  it("parcela do n8n sem valor e sem offer_id da matriz: o clique nunca cobra (aceite recusa a oferta)", async () => {
    const p = await bootstrap()
    await click(p.id, 1)
    const { chatSend } = await import("@/lib/journey/chat-send")
    const out = await chatSend(
      { sessionId: SID, companyId: CO, customerId: CUST, debtId: DEBT },
      { text: "Condições:", prompt: { kind: "offer_choice", question: "Condições:", buttons: [{ id: 2, label: "Parcelar", value: "parc_3" }] } },
      "evt-noval",
    )
    expect(out.ok).toBe(true) // sem menu protegido ativo → entra (contrato canônico: ver N8N-2)
    const s = await screenAt()
    expect(s.menus).toBe(1) // o prompt do n8n aposentou a espera
    const r = await click(s.menu!.id, 2)
    expect(acceptCalls).toEqual(["parc_3"])
    expect(r.body).toMatchObject({ ok: false, action: "pay", error: "offer_not_available" })
    expect(payCalls.length).toBe(0)
  })
})

describe("N8N-7 (f) resposta TARDIA depois da degradação", () => {
  beforeEach(() => seed())

  it("degradado (só visual, sem clique): a tardia com botões é a resposta — encerra a espera, um menu só", async () => {
    const p = await bootstrap()
    await click(p.id, 1)
    expect((await screenAt(16_000)).waitBlock).toBe("menu_degradado")
    const { chatSend } = await import("@/lib/journey/chat-send")
    const out = await chatSend({ sessionId: SID, companyId: CO, customerId: CUST, debtId: DEBT }, { text: "Posso te ajudar com isso.", prompt: YES_NO }, "evt-late-1")
    expect(out.ok).toBe(true)
    const s = await screenAt(16_000)
    expect(s.waitBlock).toBeNull() // antes: o F5 desenhava a degradação JUNTO do prompt
    expect(s.menu?.kind).toBe("generic_yes_no")
    expect(s.menus).toBe(1)
  })

  it("degradado + 'Tentar as opções de novo': a tardia não acionável é recusada; o menu reaberto fica (1 ativo)", async () => {
    const p = await bootstrap()
    await click(p.id, 1)
    const re = await reopen("reopen_options")
    expect(re.body.prompt?.kind).toBe("debt_three_options")
    expect(sess().wait_state).toBeNull()
    const { chatSend } = await import("@/lib/journey/chat-send")
    const out = await chatSend(
      { sessionId: SID, companyId: CO, customerId: CUST, debtId: DEBT },
      { text: "Condições:", prompt: { kind: "offer_choice", question: "Condições:", buttons: [{ id: 2, label: "Parcelar", value: "parc_3" }] } },
      "evt-late-2",
    )
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.code).toBe("prompt_not_actionable")
    expect(activePrompts().map((x) => x.kind)).toEqual(["debt_three_options"])
    expect((await screenAt(20_000)).menus).toBe(1)
  })

  it("degradado + Pagar (link entregue): a tardia NUNCA troca o pós-link, nem com prompt acionável (N8N-8 prompt_outside_window)", async () => {
    const p = await bootstrap()
    await click(p.id, 1)
    await reopen("reopen_options")
    // o pós-link persistido pela plataforma depois do Pagar
    const { createPrompt } = await import("@/lib/journey/prompts")
    await createPrompt({ companyId: CO, sessionId: SID, kind: "post_payment_link", question: "", buttons: [{ id: 98, label: "Voltar às opções" }], createdBy: "platform" })
    const { chatSend, promptAsk } = await import("@/lib/journey/chat-send")
    const a = await chatSend({ sessionId: SID, companyId: CO, customerId: CUST, debtId: DEBT }, { text: "Posso te ajudar com isso.", prompt: YES_NO }, "evt-late-3")
    const b = await promptAsk({ sessionId: SID, companyId: CO, customerId: CUST, debtId: DEBT }, YES_NO)
    for (const out of [a, b]) {
      expect(out.ok).toBe(false)
      if (!out.ok) expect(out.code).toBe("prompt_outside_window")
    }
    expect(activePrompts().map((x) => x.kind)).toEqual(["post_payment_link"])
  })

  it("corrida: o n8n responde com botões DENTRO do deadline → o clique devolve o prompt, sem espera pendurada", async () => {
    mode = "prompt_fast"
    process.env.N8N_KICKOFF_TIMEOUT_MS = "1500"
    process.env.N8N_KICKOFF_DEADLINE_MS = "1500"
    const p = await bootstrap()
    const r = await click(p.id, 1)
    expect(r.body.wait_state).toBeUndefined()
    expect(r.body.prompt?.kind).toBe("generic_yes_no")
    expect(sess().wait_state).toBeNull() // antes: 'aguardando_motor' gravado DEPOIS do prompt
    const s = await screenAt(20_000)
    expect(s.waitBlock).toBeNull()
    expect(s.menus).toBe(1)
  })
})

describe("N8N-7 — Negociar sem parcelas depois de um handoff nunca vira 'conversa encerrada'", () => {
  beforeEach(() => seed())

  it("a confirmação do clique é gravada de novo (sem dedup de 15 min) e passa a ser a última bolha do assistente", async () => {
    mode = "hang"
    const { NEGOTIATION_PENDING_TEXT } = await import("@/lib/journey/wait-machine")
    const { isHandoffTerminal } = await import("@/lib/journey/display-class")
    const old = new Date(Date.now() - 5 * 60_000).toISOString()
    // histórico: Negociar anterior (confirmação < 15 min) → espera → atendimento pedido
    db.chat_messages.push(
      { id: "m-conf-old", company_id: CO, session_id: SID, role: "assistant", text: NEGOTIATION_PENDING_TEXT, created_at: old },
      { id: "m-handoff", company_id: CO, session_id: SID, role: "assistant", text: "Certo. Registramos o seu pedido de atendimento.", stage: "handoff", created_at: new Date(Date.now() - 60_000).toISOString() },
    )
    const p = await bootstrap() // o devedor volta: menu de 3 opções
    const r = await click(p.id, 1)
    expect(r.body.wait_state).toBe("aguardando_motor")
    const assistants = db.chat_messages.filter((m) => m.role === "assistant").sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    const last = assistants.at(-1)!
    expect(last.text).toBe(NEGOTIATION_PENDING_TEXT)
    expect(last.id).not.toBe("m-conf-old")
    // regra do client: sem prompt ativo + última bolha = handoff → encerra. Não mais.
    expect(isHandoffTerminal(last.stage ?? null, activePrompts().length > 0)).toBe(false)
  })
})

describe("N8N-7 (g) cada botão em aguardando_motor e em menu_degradado", () => {
  // Na tela: aguardando_motor = [Pagar agora] (+ [Falar com atendimento] a
  // partir de 10 s); menu_degradado = [Pagar à vista] [Tentar as opções de novo]
  // [Falar com atendimento]. Sem prompt ativo: os atalhos usam /api/chat/reopen.
  // Negociar/Detalhes/Não reconheço/Voltar/parcela só existem via API (prompt
  // consumido) → 409 prompt_stale com active_prompt, nunca mudo.
  beforeEach(() => seed())

  async function enterWait() {
    mode = "hang"
    const p = await bootstrap()
    const r = await click(p.id, 1)
    expect(r.body.wait_state).toBe("aguardando_motor")
    return p
  }

  it("Pagar agora / Pagar à vista → reabre o menu pagável (1 menu, espera limpa) → Pagar cobra 1x; toque duplo não cobra 2x", async () => {
    await enterWait()
    const re = await reopen("reopen_options")
    expect(re.status).toBe(200)
    expect(re.body.prompt.kind).toBe("debt_three_options")
    expect(re.body.prompt.buttons.some((b: { id: number }) => b.id === 4)).toBe(true)
    expect(sess().wait_state).toBeNull()
    expect((await screenAt(20_000)).menus).toBe(1)
    const menuId = re.body.prompt.id
    ageClicks()
    const [c1, c2] = await Promise.all([click(menuId, 4), click(menuId, 4)])
    expect(payCalls.length).toBe(1)
    expect([c1.body, c2.body].some((b) => b.action === "pay" && b.link)).toBe(true)
    // o valor cobrado é o do menu (debtIds do contexto do prompt), não do n8n
    expect(payCalls[0].debtIds).toEqual([DEBT])
  })

  it("Tentar as opções de novo (degradado) → menu de 3 opções, espera encerrada; Negociar de novo volta à espera (sem 2º menu)", async () => {
    await enterWait()
    const re = await reopen("reopen_options")
    expect(sess().wait_state).toBeNull()
    const r = await click(re.body.prompt.id, 1)
    expect(r.body.wait_state).toBe("aguardando_motor")
    expect(activePrompts().length).toBe(0)
    expect((await screenAt()).menus).toBe(1)
  })

  it("Falar com atendimento → handoff com resposta persistida; a espera some", async () => {
    await enterWait()
    // fora da janela do toque duplo do servidor (o bloco nasce inerte por 2,5 s)
    ageClicks()
    const h = await reopen("handoff")
    expect(h.body.transferred).toBe(true)
    expect(h.body.outcome?.text).toBeTruthy()
    expect(sess().wait_state).toBeNull()
    expect((await screenAt(20_000)).waitBlock).toBeNull()
  })

  it("Já paguei (API) na espera → payment_claim + menu reaberto, espera limpa, nunca declara pago", async () => {
    await enterWait()
    ageClicks()
    const c = await reopen("payment_claim")
    expect(c.body.claim_registered).toBe(true)
    expect(c.body.prompt?.kind).toBe("debt_three_options")
    expect(sess().wait_state).toBeNull()
    expect(/pago|quitad/i.test(String(c.body.reply ?? "")) && !/n[ãa]o/i.test(String(c.body.reply))).toBe(false)
    expect((await screenAt(20_000)).menus).toBe(1)
  })

  it("Negociar / Detalhes / Não reconheço / Voltar / Pagar no prompt consumido → 409 prompt_stale, duplicado ou toque ignorado; nunca efeito", async () => {
    const p = await enterWait()
    const within2s = []
    for (const b of [1, 2, 0, 98, 4]) within2s.push(await click(p.id, b))
    ageClicks()
    const later = []
    for (const b of [2, 0, 98, 4]) later.push(await click(p.id, b))
    for (const r of [...within2s, ...later]) {
      if (r.status === 200) expect(r.body.duplicate === true || r.body.ignored === "double_tap").toBe(true)
      else {
        expect(r.status).toBe(409)
        expect(r.body.code).toBe("prompt_stale")
        expect("active_prompt" in r.body).toBe(true)
      }
    }
    // fora da janela do toque duplo, todo clique no menu consumido é 409 humano
    for (const r of later) expect(r.status).toBe(409)
    expect(payCalls.length).toBe(0)
    expect(sess().wait_state).toBe("aguardando_motor")
    expect(db.debt_acknowledgements.filter((a) => a.acknowledged === false).length).toBe(0)
  })

  it("o client nunca fica sem próximo passo: aguardando_motor sempre tem 'Pagar agora'; degradado tem as 3 saídas", async () => {
    const wm = await import("@/lib/journey/wait-machine")
    for (const t of [0, 1_300, 5_000, 11_000]) {
      const v = wm.resolveWaitView("aguardando_motor", new Date(Date.now() - t).toISOString(), Date.now())
      expect(v.state).toBe("aguardando_motor") // "Pagar agora" é renderizado em todo degrau
      expect(wm.shouldShowWaitHandoffExit(v.step)).toBe(t >= 10_000)
    }
    const v = wm.resolveWaitView("aguardando_motor", new Date(Date.now() - 15_000).toISOString(), Date.now())
    expect(v.state).toBe("menu_degradado")
    expect(wm.DEGRADED_MENU_COPY).toMatch(/à vista.*de novo.*atendimento/)
    // espera limitada: nenhum degrau passa de 15 s
    expect(wm.WAIT_STEP_MS.DEGRADED).toBe(15_000)
  })
})
