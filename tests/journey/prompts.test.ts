// R4: prompts com botões — createPrompt supersede o ativo; answerPrompt valida
// integridade (404/409), grava a mensagem do cliente e é anti-concorrente.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

const CO = "eeeeeeee-0000-0000-0000-000000000010"
const SID = "sess-1"

let db: FakeDb
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/journey/events", () => ({ recordEvent: async () => ({ ok: true, duplicate: false }) }))

function reset() {
  db = { chat_prompts: [], chat_messages: [] }
}

describe("createPrompt", () => {
  beforeEach(reset)

  it("cria prompt ativo com botões ordenados por id", async () => {
    const { createPrompt } = await import("@/lib/journey/prompts")
    const r = await createPrompt({
      companyId: CO,
      sessionId: SID,
      kind: "generic_yes_no",
      question: "Confirma?",
      buttons: [{ id: 1, label: "Sim" }, { id: 0, label: "Não" }],
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.prompt.status).toBe("active")
      expect(r.prompt.buttons.map((b) => b.id)).toEqual([0, 1])
    }
  })

  it("rejeita botões inválidos (ids duplicados)", async () => {
    const { createPrompt } = await import("@/lib/journey/prompts")
    const r = await createPrompt({
      companyId: CO, sessionId: SID, kind: "generic_yes_no", question: "x",
      buttons: [{ id: 2, label: "A" }, { id: 2, label: "B" }],
    })
    expect(r).toEqual({ ok: false, error: "button_id_duplicate" })
  })

  it("supersede o prompt ativo anterior da sessão", async () => {
    const { createPrompt, getActivePrompt } = await import("@/lib/journey/prompts")
    const a = await createPrompt({ companyId: CO, sessionId: SID, kind: "generic_yes_no", question: "1", buttons: [{ id: 1, label: "Sim" }, { id: 0, label: "Não" }] })
    const b = await createPrompt({ companyId: CO, sessionId: SID, kind: "generic_yes_no", question: "2", buttons: [{ id: 1, label: "Sim" }, { id: 0, label: "Não" }] })
    expect(a.ok && b.ok).toBe(true)
    const active = await getActivePrompt(SID)
    expect(active?.question).toBe("2")
    const old = db.chat_prompts.find((p) => p.question === "1")
    expect(old?.status).toBe("superseded")
  })
})

describe("answerPrompt", () => {
  beforeEach(reset)

  async function seedActive(buttons = [{ id: 1, label: "Sim" }, { id: 0, label: "Não" }]) {
    const { createPrompt } = await import("@/lib/journey/prompts")
    const r = await createPrompt({ companyId: CO, sessionId: SID, kind: "generic_yes_no", question: "q", buttons })
    if (!r.ok) throw new Error("seed failed")
    return r.prompt.id
  }

  it("prompt inexistente → 404 prompt_not_found", async () => {
    const { answerPrompt } = await import("@/lib/journey/prompts")
    const r = await answerPrompt({ sessionId: SID, companyId: CO, promptId: "nope", buttonId: 1 })
    expect(r).toEqual({ ok: false, status: 404, code: "prompt_not_found" })
  })

  it("button_id fora do catálogo → 409 button_invalid", async () => {
    const id = await seedActive()
    const { answerPrompt } = await import("@/lib/journey/prompts")
    const r = await answerPrompt({ sessionId: SID, companyId: CO, promptId: id, buttonId: 7 })
    expect(r).toEqual({ ok: false, status: 409, code: "button_invalid" })
  })

  it("clique válido → answered + grava chat_messages(customer, label, button_id)", async () => {
    const id = await seedActive()
    const { answerPrompt } = await import("@/lib/journey/prompts")
    const r = await answerPrompt({ sessionId: SID, companyId: CO, promptId: id, buttonId: 0 })
    expect(r.ok).toBe(true)
    const prompt = db.chat_prompts.find((p) => p.id === id)
    expect(prompt?.status).toBe("answered")
    expect(prompt?.answered_button_id).toBe(0)
    const msg = db.chat_messages.find((m) => m.prompt_id === id)
    expect(msg?.role).toBe("customer")
    expect(msg?.text).toBe("Não")
    expect(msg?.button_id).toBe(0)
  })

  it("2º clique concorrente → 409 prompt_not_active", async () => {
    const id = await seedActive()
    const { answerPrompt } = await import("@/lib/journey/prompts")
    const first = await answerPrompt({ sessionId: SID, companyId: CO, promptId: id, buttonId: 1 })
    const second = await answerPrompt({ sessionId: SID, companyId: CO, promptId: id, buttonId: 0 })
    expect(first.ok).toBe(true)
    expect(second).toEqual({ ok: false, status: 409, code: "prompt_not_active" })
  })
})
