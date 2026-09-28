// N87-07 / N87-09 / N87-10 — achados abertos do relatório N8N-7 (estados de
// espera do motor com NEGOTIATION_ENGINE=n8n). Mesmo harness do
// n8n7-engine-wait-states.test.ts: rotas reais (/api/chat/button, /reopen,
// /messages, /api/webhooks/n8n), fluxo n8n simulado por HTTP local com HMAC,
// correlação N8N-16 LIGADA (N8N_REQUIRE_EVENT_CORRELATION=on, como em produção)
// e fake supabase. Só a fronteira da cobrança é espiada (payService).
//
//  N87-07: depois de "Tentar as opções de novo" (ou "Já paguei"/Pagar da
//          espera), um prompt tardio do n8n que responde a um evento enviado
//          ANTES disso não troca o menu reaberto → 422 prompt_outside_window
//          (reason engine_wait_superseded), nada gravado. Evento enviado depois
//          (novo Negociar) segue valendo.
//  N87-09: "Pagar agora"/"Pagar à vista" na espera cobram num toque só, pelo
//          MESMO clique do Pagar do menu; toque duplo = 1 cobrança.
//  N87-10: Negociar sem parcelas grava "Vou buscar as condições…" (sem prometer
//          a lista); com parcelas, a frase com dois-pontos antes da lista.
import { createServer, type Server } from "node:http"
import { createHmac } from "node:crypto"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

process.env.CHAT_JOURNEY_ENABLED = "true"
process.env.NEGOTIATION_JWT_SECRET = "test-secret-n87"
const SECRET = "test-n87-hmac-secret"

const CO = "c0c0c0c0-0000-4000-8000-000000000087"
const SID = "5e55e55e-0000-4000-8000-000000000087"
const CUST = "cust-n87f"
const DEBT = "debt-n87f"

let db: FakeDb
const payCalls: Array<{ debtIds?: string[] }> = []

vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/asaas", () => ({ getAsaasPaymentsForCustomer: async () => [] }))
vi.mock("@/lib/notifications/email", () => ({ sendEmail: async () => ({ ok: true }) }))
vi.mock("@/lib/journey/events", () => ({
  recordEvent: async () => ({ ok: true, duplicate: false }),
  getTimeline: async () => [],
}))
// Sem Redis no teste: o rate limit do webhook deixa passar (tem testes próprios).
vi.mock("@/lib/negotiation/rate-limit", () => ({
  LIMITS: { resolvePerIp: { limit: 10, windowSeconds: 60 }, messagePerSession: { limit: 20, windowSeconds: 60 }, messagePerIp: { limit: 40, windowSeconds: 60 } },
  rateLimit: async () => ({ allowed: true, remaining: 10 }),
}))
// Fronteira da cobrança: conta QUANTAS cobranças os cliques pediriam e com
// QUAIS dívidas (o valor é o do menu, do servidor). O guard/ASAAS têm testes próprios.
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

// --- fluxo n8n simulado ------------------------------------------------------
type Mode = "async" | "hang" | "slow_prompt"
let mode: Mode = "async"
let server: Server
let port = 0

const YES_NO = { kind: "generic_yes_no", question: "Quer ver as condições de parcelamento?", buttons: [{ id: 1, label: "Sim" }, { id: 0, label: "Não" }] }

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      const json = (body: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body))
      switch (mode) {
        case "hang": return
        case "slow_prompt": return void setTimeout(() => json({ text: "Posso te ajudar com isso.", prompt: YES_NO }), 450)
        default: return json({ message: "Workflow was started" })
      }
    })
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const a = server.address()
  port = typeof a === "object" && a ? a.port : 0
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

const DEADLINE_MS = 250
const KICK_TIMEOUT_MS = 200

function seed(opts: { matrix?: boolean } = {}) {
  payCalls.length = 0
  mode = "async"
  process.env.NEGOTIATION_ENGINE = "n8n"
  process.env.N8N_WEBHOOK_SECRET = SECRET
  delete process.env.N8N_WEBHOOK_SECRET_PREVIOUS
  process.env.N8N_REQUIRE_EVENT_CORRELATION = "on"
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
    journey_events: [],
    conversation_messages: [],
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
  const r = await POST(req(await cookie(), { prompt_id: promptId, button_id: buttonId }))
  return { status: r.status, body: await r.json() }
}
async function reopen(action: "reopen_options" | "handoff" | "payment_claim" | "pay_now") {
  const { POST } = await import("@/app/api/chat/reopen/route")
  const r = await POST(req(await cookie(), { action }))
  return { status: r.status, body: await r.json() }
}
function ageClicks(ms = 5_000) {
  for (const m of db.chat_messages) if (m.role === "customer") m.created_at = new Date(Date.now() - ms).toISOString()
}
/** Envelhece as linhas de journey_events (o devedor real leva segundos entre um
 *  evento e o próximo toque; no teste tudo cai no mesmo milissegundo). */
function ageJourneyEvents(ms: number) {
  for (const e of db.journey_events) e.occurred_at = new Date(Date.parse(e.occurred_at ?? new Date().toISOString()) - ms).toISOString()
}
/** event_ids de negotiation.start registrados no ledger de saída (N8N-16), em ordem. */
const outboundOrigins = () =>
  db.journey_events.filter((e) => e.event_type === "n8n.outbound").map((e) => String(e.event_id).replace(/^n8n_out:/, ""))

/** Callback do n8n pelo webhook REAL, assinado, ecoando o evento de origem. */
async function n8nCallback(action: "chat.send" | "prompt.ask", origin: string, args: Record<string, unknown>, eventId: string) {
  const { POST } = await import("@/app/api/webhooks/n8n/route")
  const raw = JSON.stringify({ action, session_id: SID, event_id: eventId, origin_event_id: origin, args })
  const ts = String(Math.floor(Date.now() / 1000))
  const sig = "sha256=" + createHmac("sha256", SECRET).update(`${ts}.${raw}`).digest("hex")
  const r = await POST(new Request("http://localhost/api/webhooks/n8n", {
    method: "POST",
    headers: { "content-type": "application/json", "x-alteapay-signature": sig, "x-alteapay-timestamp": ts },
    body: raw,
  }))
  return { status: r.status, body: await r.json() }
}
async function enterWait() {
  mode = "hang"
  const p = await bootstrap()
  const r = await click(p.id, 1)
  expect(r.body.wait_state).toBe("aguardando_motor")
  return p
}

// =============================================================================
describe("N87-07 — prompt tardio da negociação abandonada não troca o menu reaberto", () => {
  beforeEach(() => seed())

  it("Negociar → espera → 'Tentar as opções de novo' → yes/no tardio do 1º Negociar: 422 prompt_outside_window, menu reaberto fica", async () => {
    await enterWait()
    const [origin] = outboundOrigins()
    expect(origin).toBeTruthy()
    ageJourneyEvents(5_000) // o evento saiu segundos antes da reabertura
    const re = await reopen("reopen_options")
    expect(re.body.prompt?.kind).toBe("debt_three_options")
    const menuId = re.body.prompt.id

    const late = await n8nCallback("chat.send", origin, { text: "Posso te ajudar com isso.", prompt: YES_NO }, "evt-late-yesno")
    expect(late.status).toBe(422)
    expect(late.body).toMatchObject({ code: "prompt_outside_window", reason: "engine_wait_superseded" })
    // antes: o yes/no substituía o menu reaberto (1 menu, mas obsoleto)
    expect(activePrompts().map((p) => p.id)).toEqual([menuId])
    expect(db.chat_messages.some((m) => m.engine === "n8n")).toBe(false) // nada gravado
    const ask = await n8nCallback("prompt.ask", origin, YES_NO, "evt-late-ask")
    expect(ask.status).toBe(422)
    expect(ask.body).toMatchObject({ code: "prompt_outside_window", reason: "engine_wait_superseded" })
    expect(activePrompts().map((p) => p.id)).toEqual([menuId])
  })

  it("resposta ao NOVO Negociar (evento enviado depois da reabertura) segue valendo", async () => {
    await enterWait()
    ageJourneyEvents(10_000)
    const re = await reopen("reopen_options")
    ageJourneyEvents(5_000) // reabertura segundos antes do novo Negociar
    ageClicks()
    const again = await click(re.body.prompt.id, 1)
    expect(again.body.wait_state).toBe("aguardando_motor")
    const origins = outboundOrigins()
    expect(origins.length).toBe(2)
    const fresh = await n8nCallback("chat.send", origins[1], { text: "Posso te ajudar com isso.", prompt: YES_NO }, "evt-fresh")
    expect(fresh.status).toBe(200)
    expect(activePrompts().map((p) => p.kind)).toEqual(["generic_yes_no"])
    expect(sess().wait_state).toBeNull() // o prompt do motor resolveu a espera
  })

  it("sem reabertura (degradação só visual) a tardia é a resposta esperada — comportamento N8N-7 preservado", async () => {
    await enterWait()
    const [origin] = outboundOrigins()
    const late = await n8nCallback("chat.send", origin, { text: "Posso te ajudar com isso.", prompt: YES_NO }, "evt-late-ok")
    expect(late.status).toBe(200)
    expect(activePrompts().map((p) => p.kind)).toEqual(["generic_yes_no"])
  })

  it("texto sem botões da negociação abandonada segue como nota (não troca o menu, como antes)", async () => {
    await enterWait()
    const [origin] = outboundOrigins()
    ageJourneyEvents(5_000)
    const re = await reopen("reopen_options")
    const note = await n8nCallback("chat.send", origin, { text: "Estou verificando as condições para você." }, "evt-late-text")
    expect(note.status).toBe(200)
    expect(activePrompts().map((p) => p.id)).toEqual([re.body.prompt.id])
  })

  it("'Já paguei' na espera também encerra a conversa com o motor: yes/no tardio recusado", async () => {
    await enterWait()
    const [origin] = outboundOrigins()
    ageJourneyEvents(5_000)
    ageClicks()
    const c = await reopen("payment_claim")
    expect(c.body.prompt?.kind).toBe("debt_three_options")
    const late = await n8nCallback("chat.send", origin, { text: "Posso te ajudar com isso.", prompt: YES_NO }, "evt-late-claim")
    expect(late.status).toBe(422)
    expect(late.body.code).toBe("prompt_outside_window")
    expect(activePrompts().map((p) => p.kind)).toEqual(["debt_three_options"])
  })

  it("resposta SÍNCRONA tardia do kickoff depois da reabertura também não troca o menu", async () => {
    mode = "slow_prompt" // o n8n responde o negotiation.start em 450 ms, com botões
    process.env.N8N_KICKOFF_TIMEOUT_MS = "1500" // o POST ainda está aberto quando o clique responde
    const p = await bootstrap()
    const r = await click(p.id, 1)
    expect(r.body.wait_state).toBe("aguardando_motor")
    // o devedor reabre o menu antes de o corpo síncrono chegar
    ageJourneyEvents(5_000)
    const re = await reopen("reopen_options")
    await sleep(700)
    expect(activePrompts().map((x) => x.id)).toEqual([re.body.prompt.id])
    expect(db.chat_messages.some((m) => m.engine === "n8n")).toBe(false)
  })

  it("chatSend/promptAsk direto: sem o instante do evento de origem (correlação sem registro) não recusa", async () => {
    await enterWait()
    ageJourneyEvents(5_000)
    await reopen("reopen_options")
    const { chatSend } = await import("@/lib/journey/chat-send")
    const ctx = { sessionId: SID, companyId: CO, customerId: CUST, debtId: DEBT }
    // origem conhecida e anterior à reabertura → recusa
    const stale = await chatSend(ctx, { text: "Posso te ajudar com isso.", prompt: YES_NO }, "evt-direct-1", {
      originSentAt: new Date(Date.now() - 60_000).toISOString(),
    })
    expect(stale).toMatchObject({ ok: false, status: 422, code: "prompt_outside_window", reason: "engine_wait_superseded" })
    // origem desconhecida → regras anteriores (guard do menu protegido: yes/no acionável entra)
    const unknown = await chatSend(ctx, { text: "Posso te ajudar com isso.", prompt: YES_NO }, "evt-direct-2")
    expect(unknown.ok).toBe(true)
  })

  it("a marca respeita a empresa: marca de outra empresa na mesma sessão não recusa", async () => {
    await enterWait()
    const { markEngineSuperseded, engineSupersededSince } = await import("@/lib/journey/engine-supersede")
    const before = new Date(Date.now() - 60_000).toISOString()
    await markEngineSuperseded({ companyId: "outra-empresa", sessionId: SID, reason: "reopen_options" })
    expect(await engineSupersededSince(SID, CO, before)).toBeNull()
    await markEngineSuperseded({ companyId: CO, sessionId: SID, reason: "reopen_options" })
    expect(await engineSupersededSince(SID, CO, before)).toBeTruthy()
    expect(await engineSupersededSince(SID, CO, null)).toBeNull()
  })
})

// =============================================================================
describe("N87-09 — 'Pagar agora' / 'Pagar à vista' na espera cobram num toque", () => {
  beforeEach(() => seed())

  for (const degraded of [false, true]) {
    it(`${degraded ? "menu_degradado ('Pagar à vista')" : "aguardando_motor ('Pagar agora')"}: um POST → link, pelo Pagar do menu (mesmas dívidas), espera encerrada`, async () => {
      await enterWait()
      if (degraded) sess().wait_state = "menu_degradado"
      ageClicks()
      const r = await reopen("pay_now")
      expect(r.status).toBe(200)
      // antes: { action:'reopen_options' } — só reabria o menu (2 toques para pagar)
      expect(r.body).toMatchObject({ ok: true, action: "pay", button_id: 4, link: "https://www.asaas.com/i/fake" })
      expect(payCalls.length).toBe(1)
      expect(payCalls[0].debtIds).toEqual([DEBT]) // valor do menu (servidor), não do n8n
      expect(sess().wait_state).toBeNull()
      // o clique ficou no histórico como o do menu (eco "Pagar …" do devedor)
      const menu = db.chat_prompts.find((p) => p.kind === "debt_three_options" && p.answered_button_id === 4)
      expect(menu).toBeTruthy()
      expect(db.chat_messages.some((m) => m.role === "customer" && m.button_id === 4)).toBe(true)
    })
  }

  it("toque duplo (dois POST concorrentes) → exatamente 1 cobrança", async () => {
    await enterWait()
    ageClicks()
    const [a, b] = await Promise.all([reopen("pay_now"), reopen("pay_now")])
    expect(payCalls.length).toBe(1)
    expect([a.body, b.body].filter((x) => x.action === "pay" && x.link).length).toBe(1)
    // o outro é duplicado/ignorado/obsoleto — nunca uma 2ª cobrança
    const other = [a, b].find((x) => !(x.body.action === "pay" && x.body.link))!
    expect(other.status === 409 || other.body.duplicate === true || other.body.ignored === "double_tap" || other.body.action === "reopen_options").toBe(true)
  })

  it("2º toque depois do 1º concluir → não cobra de novo (a espera acabou: vira só reabrir)", async () => {
    await enterWait()
    ageClicks()
    await reopen("pay_now")
    ageClicks()
    const second = await reopen("pay_now")
    expect(second.body.action).not.toBe("pay")
    expect(payCalls.length).toBe(1)
  })

  it("fora da espera do motor, pay_now é o reopen_options de antes (nenhuma cobrança)", async () => {
    await bootstrap()
    const r = await reopen("pay_now")
    expect(r.body).toMatchObject({ ok: true, action: "reopen_options" })
    expect(payCalls.length).toBe(0)
  })

  it("dívida quitada: pay_now devolve o estado de quitado, nunca cobra", async () => {
    await enterWait()
    const settled = await import("@/lib/journey/settled-state")
    const spy = vi.spyOn(settled, "settledReopenBody").mockResolvedValueOnce({ ok: true, action: "pay_now", settled: true, prompt: null })
    const r = await reopen("pay_now")
    expect(r.body.settled).toBe(true)
    expect(payCalls.length).toBe(0)
    spy.mockRestore()
  })
})

// =============================================================================
describe("N87-10 — confirmação do Negociar não promete lista quando não há parcelas", () => {
  it("sem parcelas: grava 'Vou buscar as condições…' (sem dois-pontos), nunca a frase da lista", async () => {
    seed()
    const { NEGOTIATION_PENDING_TEXT, NEGOTIATION_SEARCHING_TEXT } = await import("@/lib/journey/wait-machine")
    const r = await enterWait().then(() => db.chat_messages)
    const assistant = r.filter((m) => m.role === "assistant").map((m) => m.text)
    expect(assistant).toContain(NEGOTIATION_SEARCHING_TEXT)
    expect(assistant).not.toContain(NEGOTIATION_PENDING_TEXT)
  })

  it("sem parcelas: o corpo do clique traz a frase de busca (o client troca a bolha otimista)", async () => {
    seed()
    mode = "hang"
    const { NEGOTIATION_SEARCHING_TEXT } = await import("@/lib/journey/wait-machine")
    const p = await bootstrap()
    const r = await click(p.id, 1)
    expect(r.body.reply).toBe(NEGOTIATION_SEARCHING_TEXT)
    expect(r.body.reply.endsWith(":")).toBe(false)
  })

  it("com parcelas: a confirmação com dois-pontos vem uma vez, ANTES da pergunta das parcelas", async () => {
    seed({ matrix: true })
    mode = "hang"
    const { NEGOTIATION_PENDING_TEXT, NEGOTIATION_SEARCHING_TEXT } = await import("@/lib/journey/wait-machine")
    const p = await bootstrap()
    const r = await click(p.id, 1)
    expect(r.body.offers_presented).toBe(true)
    expect(r.body.reply).toBe(NEGOTIATION_PENDING_TEXT)
    const rows = db.chat_messages.filter((m) => m.role === "assistant")
    const confirm = rows.filter((m) => m.text === NEGOTIATION_PENDING_TEXT && !m.prompt_id)
    const question = rows.find((m) => m.prompt_id === r.body.prompt.id)
    expect(confirm.length).toBe(1)
    expect(question).toBeTruthy()
    expect(rows.indexOf(confirm[0])).toBeLessThan(rows.indexOf(question!))
    expect(rows.some((m) => m.text === NEGOTIATION_SEARCHING_TEXT)).toBe(false)
  })
})
