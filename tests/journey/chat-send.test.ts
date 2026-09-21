// R4: chat.send (papel B) — dedupe por event_id, cria prompt opcional (validando
// botões), rejeita botões inválidos. prompt.ask / prompt.close.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

const CO = "eeeeeeee-0000-0000-0000-000000000012"
const ctx = { sessionId: "sess-cs", companyId: CO, customerId: "cust", debtId: "debt" }

let db: FakeDb
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/journey/events", () => ({ recordEvent: async () => ({ ok: true, duplicate: false }) }))

function reset() {
  db = { chat_messages: [], chat_prompts: [] }
}

describe("chatSend", () => {
  beforeEach(reset)

  it("grava mensagem do assistente com n8n_execution_id", async () => {
    const { chatSend } = await import("@/lib/journey/chat-send")
    const r = await chatSend(ctx, { text: "Olá!", n8n_execution_id: "exec_1" }, "evt-1")
    expect(r.ok).toBe(true)
    const msg = db.chat_messages[0]
    expect(msg.role).toBe("assistant")
    expect(msg.text).toBe("Olá!")
    expect(msg.n8n_execution_id).toBe("exec_1")
    expect(msg.engine).toBe("n8n")
  })

  it("dedupe por event_id: 2ª chamada devolve o mesmo message_id (duplicate)", async () => {
    const { chatSend } = await import("@/lib/journey/chat-send")
    const a = await chatSend(ctx, { text: "oi" }, "evt-dup")
    const b = await chatSend(ctx, { text: "oi" }, "evt-dup")
    expect(a.ok && b.ok).toBe(true)
    if (a.ok && b.ok) {
      expect(b.message_id).toBe(a.message_id)
      expect(b.duplicate).toBe(true)
    }
    expect(db.chat_messages.length).toBe(1) // sem duplicar
  })

  it("cria prompt embutido (botões válidos) e vincula à mensagem", async () => {
    const { chatSend } = await import("@/lib/journey/chat-send")
    const r = await chatSend(ctx, {
      text: "Qual forma de pagamento?",
      prompt: {
        kind: "payment_method_choice",
        question: "Escolha:",
        buttons: [{ id: 2, label: "PIX", value: "PIX" }, { id: 3, label: "Boleto", value: "BOLETO" }],
      },
    }, "evt-p")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.prompt_id).toBeTruthy()
    expect(db.chat_prompts.length).toBe(1)
    expect(db.chat_messages[0].prompt_id).toBe(db.chat_prompts[0].id)
  })

  it("rejeita botões inválidos (ids duplicados) sem gravar nada", async () => {
    const { chatSend } = await import("@/lib/journey/chat-send")
    const r = await chatSend(ctx, {
      text: "x",
      prompt: { kind: "generic_yes_no", question: "q", buttons: [{ id: 1, label: "A" }, { id: 1, label: "B" }] },
    }, "evt-bad")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(422)
    expect(db.chat_messages.length).toBe(0)
    expect(db.chat_prompts.length).toBe(0)
  })

  it("rejeita chamada sem text e sem prompt", async () => {
    const { chatSend } = await import("@/lib/journey/chat-send")
    const r = await chatSend(ctx, { text: "" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("empty_message")
  })
})

describe("promptAsk / promptClose", () => {
  beforeEach(reset)

  it("promptAsk cria só o prompt (sem mensagem)", async () => {
    const { promptAsk } = await import("@/lib/journey/chat-send")
    const r = await promptAsk(ctx, { kind: "generic_yes_no", question: "Confirma?", buttons: [{ id: 1, label: "Sim" }, { id: 0, label: "Não" }] })
    expect(r.ok).toBe(true)
    expect(db.chat_prompts.length).toBe(1)
    expect(db.chat_messages.length).toBe(0)
  })

  it("promptClose supersede o prompt ativo", async () => {
    const { promptAsk, promptClose } = await import("@/lib/journey/chat-send")
    await promptAsk(ctx, { kind: "generic_yes_no", question: "q", buttons: [{ id: 1, label: "Sim" }, { id: 0, label: "Não" }] })
    const r = await promptClose(ctx)
    expect(r.closed).toBe(true)
    expect(db.chat_prompts[0].status).toBe("superseded")
  })
})
