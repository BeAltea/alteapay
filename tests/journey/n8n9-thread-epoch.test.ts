// N8N-9 — linhas do n8n e o reset de 24h (thread_epoch).
//
// O reset (resetStaleChatIfInactive) arquiva a thread e faz thread_epoch + 1; o
// GET /api/chat/messages e o recap só mostram a época corrente. Antes da correção
// o chat.send do n8n gravava sem thread_epoch: depois do reset a resposta nova do
// motor ficava invisível para o devedor.
//
// Cobre: chat.send antes e depois do reset (cada um na sua thread); resposta
// atrasada a um evento da thread velha (409 thread_epoch_stale, nada gravado);
// prompt.ask atrasado; histórico mostrando as duas threads; turno livre/placeholder
// na época corrente; prompt da thread velha não responde pelo menu novo.
//
// Rotas e libs reais + fake supabase; só rede/cobrança/eventos são mockados.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

process.env.CHAT_JOURNEY_ENABLED = "true"
process.env.NEGOTIATION_JWT_SECRET = "test-secret-n8n9-epoch"

const CO = "eeeeeeee-0000-0000-0000-0000000n8n09"
const SID = "sess-n8n9"
const CUST = "cust-n8n9"
const DEBT = "debt-n8n9"
const ctx = { sessionId: SID, companyId: CO, customerId: CUST, debtId: DEBT }

let db: FakeDb
const events: Array<{ type: string; actor?: string; payload?: Record<string, unknown> }> = []

vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/asaas", () => ({ getAsaasPaymentsForCustomer: async () => [] }))
vi.mock("@/lib/notifications/email", () => ({ sendEmail: async () => ({ ok: true }) }))
vi.mock("@/lib/journey/events", () => ({
  recordEvent: async (i: { type: string; actor?: string; payload?: Record<string, unknown> }) => {
    events.push({ type: i.type, actor: i.actor, payload: i.payload })
    return { ok: true, duplicate: false }
  },
  getTimeline: async () => [],
}))
vi.mock("@/lib/negotiation/turn", () => ({
  runChatbotTurn: async () => ({ reply: "Resposta síncrona do motor", action: null, engine: "n8n", n8n_execution_id: "exec_T", latency_ms: 5 }),
}))
vi.mock("@/lib/negotiation/outbox", () => ({ flushOutbox: async () => ({ ok: true }) }))
vi.mock("@/lib/negotiation/engine", () => ({
  engineName: () => "disabled",
  fallbackMode: () => "off",
  emitNegotiationStart: async () => ({ ok: true, delivered: false, reason: "engine_unavailable" }),
}))

function seed() {
  events.length = 0
  db = {
    tenant_chat_config: [{
      company_id: CO, payment_origin: "platform",
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
    negotiation_sessions: [{
      id: SID, company_id: CO, customer_id: CUST, debt_id: DEBT, primary_debt_id: DEBT, debt_ids: [DEBT],
      agreement_id: null, debt_acknowledged_at: null, thread_epoch: 0, wait_state: null, wait_started_at: null,
    }],
    negotiation_offers: [],
    negotiation_condition_matrix: [],
    negotiation_acceptances: [],
    negotiation_cases: [],
    contact_suppressions: [],
    chat_prompts: [],
    chat_messages: [],
    debt_acknowledgements: [],
    debt_acknowledgement_latest: [],
    agreements: [],
  }
}

/** Envelhece a conversa (25 h) e roda o reset de 24h real → época + 1. */
async function crossReset() {
  const old = (iso?: string) => new Date(Date.parse(iso ?? new Date().toISOString()) - 25 * 3600_000).toISOString()
  for (const m of db.chat_messages) m.created_at = old(m.created_at)
  for (const p of db.chat_prompts) p.created_at = old(p.created_at)
  const { resetStaleChatIfInactive } = await import("@/lib/journey/acknowledgement")
  expect(await resetStaleChatIfInactive(SID, CO)).toBe(true)
}

async function cookie() {
  const { signChatJwt } = await import("@/lib/negotiation/crypto")
  return signChatJwt({ sid: SID, cid: CO }, 3600)
}
function getReq(c: string, path = "/api/chat/messages") {
  return {
    cookies: { get: (n: string) => (n === "alteapay_chat_session" ? { value: c } : undefined) },
    nextUrl: new URL(`https://x.test${path}`),
    headers: { get: () => null },
  } as any
}
async function visibleTexts(): Promise<string[]> {
  const { GET } = await import("@/app/api/chat/messages/route")
  const body = await (await GET(getReq(await cookie()))).json()
  return (body.messages ?? []).map((m: { text: string }) => m.text)
}
async function historyTexts(): Promise<Array<{ text: string; thread_epoch: number | null | undefined }>> {
  const { GET } = await import("@/app/api/chat/history/route")
  const body = await (await GET(getReq(await cookie(), "/api/chat/history"))).json()
  return (body.messages ?? []).map((m: { text: string; thread_epoch?: number | null }) => ({ text: m.text, thread_epoch: m.thread_epoch }))
}

describe("N8N-9 chat.send do n8n × reset de 24h", () => {
  beforeEach(seed)

  it("chat.send antes do reset fica na thread velha; depois do reset entra na thread nova (visível)", async () => {
    const { chatSend } = await import("@/lib/journey/chat-send")
    const a = await chatSend(ctx, { text: "Resposta do motor antes", n8n_execution_id: "exec_A" }, "evt-A")
    expect(a.ok).toBe(true)
    expect(await visibleTexts()).toContain("Resposta do motor antes")

    await crossReset()
    expect(db.negotiation_sessions[0].thread_epoch).toBe(1)

    const b = await chatSend(ctx, { text: "Resposta do motor depois", n8n_execution_id: "exec_B" }, "evt-B")
    expect(b.ok).toBe(true)
    const rowB = db.chat_messages.find((m) => m.text === "Resposta do motor depois")!
    expect(rowB.thread_epoch).toBe(1) // carimbada pelo servidor
    expect(rowB.engine).toBe("n8n")

    const shown = await visibleTexts()
    expect(shown).toContain("Resposta do motor depois") // antes da correção: sumia
    expect(shown).not.toContain("Resposta do motor antes") // thread velha fora da tela nova
  })

  it("a época vem da sessão, nunca do payload do n8n", async () => {
    const { chatSend } = await import("@/lib/journey/chat-send")
    db.negotiation_sessions[0].thread_epoch = 2
    await chatSend(ctx, { text: "oi", thread_epoch: 0, n8n_execution_id: "exec_X" } as any, "evt-X")
    expect(db.chat_messages[0].thread_epoch).toBe(2)
  })

  it("chat.send com prompt depois do reset: mensagem e prompt na época nova; o prompt vira o ativo do GET", async () => {
    const { chatSend } = await import("@/lib/journey/chat-send")
    await chatSend(ctx, { text: "antes" }, "evt-0")
    await crossReset()
    const r = await chatSend(ctx, {
      text: "Qual forma de pagamento?",
      prompt: { kind: "payment_method_choice", question: "Escolha:", buttons: [{ id: 2, label: "PIX", value: "PIX" }] },
      n8n_execution_id: "exec_P",
    }, "evt-P")
    expect(r.ok).toBe(true)
    const prompt = db.chat_prompts.find((p) => p.created_by === "n8n")!
    expect(prompt.thread_epoch).toBe(1)
    expect(db.chat_messages.find((m) => m.prompt_id === prompt.id)!.thread_epoch).toBe(1)
    const { GET } = await import("@/app/api/chat/messages/route")
    const body = await (await GET(getReq(await cookie()))).json()
    expect(body.active_prompt?.id).toBe(prompt.id)
    expect(body.messages.map((m: { text: string }) => m.text)).toContain("Qual forma de pagamento?")
  })

  it("resposta ATRASADA (execução da thread velha) depois do reset → 409 thread_epoch_stale, nada gravado, auditado", async () => {
    const { chatSend } = await import("@/lib/journey/chat-send")
    // a execução exec_OLD começou na thread velha (1ª bolha dela gravada antes do reset)
    await chatSend(ctx, { text: "Vou verificar as condições…", n8n_execution_id: "exec_OLD" }, "evt-old-1")
    await crossReset()
    const before = db.chat_messages.length
    const promptsBefore = db.chat_prompts.length

    const late = await chatSend(ctx, {
      text: "Encontrei 3 condições para você",
      prompt: { kind: "payment_method_choice", question: "Escolha:", buttons: [{ id: 2, label: "PIX", value: "PIX" }] },
      n8n_execution_id: "exec_OLD",
    }, "evt-old-2")
    expect(late).toMatchObject({ ok: false, status: 409, code: "thread_epoch_stale" })
    expect(db.chat_messages.length).toBe(before) // nada gravado
    expect(db.chat_prompts.length).toBe(promptsBefore) // nenhum prompt novo
    expect(await visibleTexts()).not.toContain("Encontrei 3 condições para você")
    expect((await historyTexts()).map((h) => h.text)).not.toContain("Encontrei 3 condições para você")
    const audit = events.find((e) => e.type === "chat.engine_invalid_action" && e.payload?.code === "thread_epoch_stale")
    expect(audit?.payload).toMatchObject({ action: "chat.send", reason: "execution_from_previous_thread", current_epoch: 1 })
    expect(JSON.stringify(audit?.payload)).not.toContain("Encontrei") // sem texto cru
  })

  it("resposta atrasada ao turno assíncrono (202 gravado antes do reset com o execution id) → 409", async () => {
    const { chatSend } = await import("@/lib/journey/chat-send")
    // chat-turn grava o 202 do n8n com n8n_execution_id (modo async)
    db.chat_messages.push({
      id: "m-async", session_id: SID, company_id: CO, role: "assistant", text: "Só um instante…",
      engine: "n8n", n8n_execution_id: "exec_ASYNC", created_at: new Date().toISOString(),
    })
    await crossReset()
    const r = await chatSend(ctx, { text: "Aqui está a resposta", n8n_execution_id: "exec_ASYNC" }, "evt-async")
    expect(r).toMatchObject({ ok: false, status: 409, code: "thread_epoch_stale" })
  })

  it("execução que JÁ escreveu na thread corrente continua aceita (não é atrasada)", async () => {
    const { chatSend } = await import("@/lib/journey/chat-send")
    await chatSend(ctx, { text: "antes", n8n_execution_id: "exec_OLD" }, "evt-1")
    await crossReset()
    await chatSend(ctx, { text: "primeira da thread nova", n8n_execution_id: "exec_NEW" }, "evt-2")
    const r = await chatSend(ctx, { text: "segunda da thread nova", n8n_execution_id: "exec_NEW" }, "evt-3")
    expect(r.ok).toBe(true)
    expect(await visibleTexts()).toEqual(expect.arrayContaining(["primeira da thread nova", "segunda da thread nova"]))
  })

  it("prompt.ask de uma execução da thread velha → 409 thread_epoch_stale, o menu corrente fica", async () => {
    const { chatSend, promptAsk } = await import("@/lib/journey/chat-send")
    await chatSend(ctx, { text: "antes", n8n_execution_id: "exec_OLD" }, "evt-1")
    await crossReset()
    const r = await promptAsk(ctx, {
      kind: "payment_method_choice", question: "Escolha:", buttons: [{ id: 2, label: "PIX", value: "PIX" }],
      n8n_execution_id: "exec_OLD",
    })
    expect(r).toMatchObject({ ok: false, status: 409, code: "thread_epoch_stale" })
    expect(db.chat_prompts.filter((p) => p.status === "active").length).toBe(0)
  })

  it("histórico do cliente mostra as DUAS threads (R-08: a velha preservada), cada mensagem com a sua época", async () => {
    const { chatSend } = await import("@/lib/journey/chat-send")
    await chatSend(ctx, { text: "motor thread 0", n8n_execution_id: "exec_A" }, "evt-A")
    await crossReset()
    await chatSend(ctx, { text: "motor thread 1", n8n_execution_id: "exec_B" }, "evt-B")
    const h = await historyTexts()
    expect(h).toEqual([
      { text: "motor thread 0", thread_epoch: undefined }, // NULL = época 0 (arquivada, preservada)
      { text: "motor thread 1", thread_epoch: 1 },
    ])
  })
})

describe("N8N-9 turno livre (chat-turn) na época corrente", () => {
  beforeEach(seed)

  it("turno livre depois do reset: cliente e resposta síncrona do motor na época nova (visíveis)", async () => {
    const { chatSend } = await import("@/lib/journey/chat-send")
    await chatSend(ctx, { text: "antes" }, "evt-0")
    await crossReset()
    const { runJourneyTurn } = await import("@/lib/journey/chat-turn")
    const out = await runJourneyTurn(ctx, "quero parcelar")
    expect(out.reply).toBe("Resposta síncrona do motor")
    const mine = db.chat_messages.filter((m) => m.text === "quero parcelar" || m.text === "Resposta síncrona do motor")
    expect(mine.map((m) => m.thread_epoch)).toEqual([1, 1])
    expect(await visibleTexts()).toEqual(expect.arrayContaining(["quero parcelar", "Resposta síncrona do motor"]))
  })

  it("placeholder 'trabalhando' depois do reset é carimbado com a época nova", async () => {
    db.negotiation_sessions[0].thread_epoch = 3
    const { recordWorkingPlaceholder, WORKING_PLACEHOLDER_TEXT } = await import("@/lib/journey/chat-turn")
    await recordWorkingPlaceholder({ companyId: CO, sessionId: SID })
    const row = db.chat_messages.find((m) => m.text === WORKING_PLACEHOLDER_TEXT)!
    expect(row.thread_epoch).toBe(3)
  })
})

describe("N8N-9 resolveN8nReplyEpoch (helper)", () => {
  beforeEach(seed)

  it("época 0: sempre aceita (não há thread anterior)", async () => {
    const { resolveN8nReplyEpoch } = await import("@/lib/journey/thread-epoch")
    db.chat_messages.push({ session_id: SID, n8n_execution_id: "e", archived_at: "2026-01-01T00:00:00Z" })
    expect(await resolveN8nReplyEpoch(SID, { n8nExecutionId: "e" })).toEqual({ ok: true, epoch: 0 })
  })

  it("originSentAt anterior ao início da thread corrente → stale; posterior → aceita", async () => {
    const { resolveN8nReplyEpoch } = await import("@/lib/journey/thread-epoch")
    db.negotiation_sessions[0].thread_epoch = 1
    db.chat_messages.push({ session_id: SID, company_id: CO, text: "x", archived_at: "2026-09-27T21:43:01.883Z", created_at: "2026-09-26T10:00:00Z" })
    expect(await resolveN8nReplyEpoch(SID, { originSentAt: "2026-09-26T10:00:05Z" })).toMatchObject({
      ok: false, status: 409, code: "thread_epoch_stale", reason: "origin_before_thread_start",
    })
    expect(await resolveN8nReplyEpoch(SID, { originSentAt: "2026-09-27T21:50:00Z" })).toEqual({ ok: true, epoch: 1 })
  })

  it("sem sinal nenhum: entra na época corrente", async () => {
    const { resolveN8nReplyEpoch } = await import("@/lib/journey/thread-epoch")
    db.negotiation_sessions[0].thread_epoch = 4
    expect(await resolveN8nReplyEpoch(SID, {})).toEqual({ ok: true, epoch: 4 })
  })

  it("samePromptThread: arquivado ou de outra época → false", async () => {
    const { samePromptThread } = await import("@/lib/journey/thread-epoch")
    expect(samePromptThread({ thread_epoch: 1 }, { thread_epoch: 1 })).toBe(true)
    expect(samePromptThread({ thread_epoch: null }, { thread_epoch: 0 })).toBe(true)
    expect(samePromptThread({ thread_epoch: null, archived_at: "x" }, { thread_epoch: 1 })).toBe(false)
    expect(samePromptThread({ thread_epoch: 0 }, { thread_epoch: 1 })).toBe(false)
  })
})

describe("N8N-9 prompt da thread velha não responde pelo menu novo", () => {
  beforeEach(seed)

  function buttonReq(c: string, body: Record<string, unknown>) {
    return {
      cookies: { get: (n: string) => (n === "alteapay_chat_session" ? { value: c } : undefined) },
      headers: { get: () => null },
      json: async () => body,
    } as any
  }

  it("clique no menu de 3 opções da época 0 depois do reset → 409 prompt_stale (sem re-alvejar no menu da época 1)", async () => {
    const { bootstrapThreeOptionsPrompt } = await import("@/lib/journey/acknowledgement")
    await bootstrapThreeOptionsPrompt({ companyId: CO, sessionId: SID, customerId: CUST, debtIds: [DEBT], primaryDebtId: DEBT })
    const p0 = db.chat_prompts.find((p) => p.status === "active")!
    await crossReset()
    expect(p0.status).toBe("superseded")
    expect(p0.archived_at).toBeTruthy()
    await bootstrapThreeOptionsPrompt({ companyId: CO, sessionId: SID, customerId: CUST, debtIds: [DEBT], primaryDebtId: DEBT })
    const p1 = db.chat_prompts.find((p) => p.status === "active")!
    expect(p1.id).not.toBe(p0.id)
    expect(p1.thread_epoch).toBe(1)
    // mesmo kind e mesmo botão "Detalhes" nos dois menus (o re-alvejamento de A1 valeria)
    expect(p1.kind).toBe(p0.kind)

    const { POST } = await import("@/app/api/chat/button/route")
    const r = await POST(buttonReq(await cookie(), { prompt_id: p0.id, button_id: 2 }))
    const b = await r.json()
    expect(r.status).toBe(409)
    expect(b.code).toBe("prompt_stale")
    expect(b.active_prompt?.id).toBe(p1.id)
    expect(db.chat_prompts.find((p) => p.id === p1.id)!.status).toBe("active") // intacto
    expect(db.chat_messages.filter((m) => m.role === "customer").length).toBe(0) // nenhum eco
  })
})
