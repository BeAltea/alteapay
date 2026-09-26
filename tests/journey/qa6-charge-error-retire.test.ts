// QA rodada 6 (Q2r2-02, ALTO) — o bloco de erro do Pagar (`erro_cobranca`)
// sobrevivia a F5/relogin/Negociar/troca de prompt e a tela ficava com duas
// fileiras de ação. Regras do client (puras) + limpeza no servidor ao publicar um
// prompt (createPrompt). O fluxo pelas rotas reais está em qa6-pay-abort-flow.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

let db: FakeDb
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/journey/events", () => ({ recordEvent: async () => ({ ok: true, duplicate: false }), getTimeline: async () => [] }))

const base = { payInFlight: false, linkDelivered: false }

describe("QA rodada 6 — erro de cobrança nunca coexiste com o menu (Q2r2-02)", () => {
  beforeEach(() => {
    db = { chat_prompts: [], negotiation_sessions: [{ id: "s1", company_id: "co", wait_state: "erro_cobranca", wait_started_at: "2026-09-26T13:00:00Z" }] }
  })

  it("decidePayResume: servidor ainda com erro_cobranca mas há prompt na tela (relogin) → nunca 'show_error'", async () => {
    const { decidePayResume } = await import("@/lib/journey/pay-poll")
    // F5/relogin: a aba nasce idle, o poll traz erro + menu → não mostra o erro
    expect(decidePayResume({ ...base, serverWaitState: "erro_cobranca", localWaitState: "idle", resumed: false, hasActivePrompt: true })).toBe("none")
    // erro já na tela e chega um menu → aposenta o erro
    expect(decidePayResume({ ...base, serverWaitState: "erro_cobranca", localWaitState: "erro_cobranca", resumed: true, hasActivePrompt: true })).toBe("settle_idle")
    // sem prompt na tela, o erro continua sendo a saída (tentar/voltar/atendimento)
    expect(decidePayResume({ ...base, serverWaitState: "erro_cobranca", localWaitState: "idle", resumed: false, hasActivePrompt: false })).toBe("show_error")
  })

  it("decidePayResume: erro local (clique desta aba) + prompt novo (Negociar/menu) → settle_idle", async () => {
    const { decidePayResume } = await import("@/lib/journey/pay-poll")
    expect(decidePayResume({ ...base, serverWaitState: null, localWaitState: "erro_cobranca", resumed: false, hasActivePrompt: true })).toBe("settle_idle")
    // Pagar em voo governa (nunca mexe)
    expect(decidePayResume({ ...base, payInFlight: true, serverWaitState: null, localWaitState: "erro_cobranca", resumed: false, hasActivePrompt: true })).toBe("none")
  })

  it("shouldRetireChargeError: prompt novo aplicado (poll ou corpo do POST) aposenta o erro; Pagar em voo não", async () => {
    const { shouldRetireChargeError } = await import("@/lib/journey/pay-poll")
    expect(shouldRetireChargeError({ localWaitState: "erro_cobranca", payInFlight: false, localPayStatus: "error", incomingPromptId: "p2" })).toBe(true)
    expect(shouldRetireChargeError({ localWaitState: "idle", payInFlight: false, localPayStatus: "error", incomingPromptId: "p2" })).toBe(true)
    expect(shouldRetireChargeError({ localWaitState: "erro_cobranca", payInFlight: true, localPayStatus: "error", incomingPromptId: "p2" })).toBe(false)
    expect(shouldRetireChargeError({ localWaitState: "erro_cobranca", payInFlight: false, localPayStatus: "error", incomingPromptId: null })).toBe(false)
    expect(shouldRetireChargeError({ localWaitState: "link_entregue", payInFlight: false, localPayStatus: "link", incomingPromptId: "p2" })).toBe(false)
  })

  it("servidor: createPrompt (qualquer prompt novo) limpa erro_cobranca", async () => {
    const { createPrompt } = await import("@/lib/journey/prompts")
    const r = await createPrompt({ companyId: "co", sessionId: "s1", kind: "offer_choice", question: "q", buttons: [{ id: 98, label: "Voltar às opções", order: 0 }] })
    expect(r.ok).toBe(true)
    expect(db.negotiation_sessions[0].wait_state).toBeNull()
    expect(db.negotiation_sessions[0].wait_started_at).toBeNull()
  })

  it("servidor: createPrompt NÃO limpa outros estados (gerando_cobranca / aguardando_motor)", async () => {
    const { createPrompt } = await import("@/lib/journey/prompts")
    for (const st of ["gerando_cobranca", "aguardando_motor"]) {
      db.negotiation_sessions[0].wait_state = st
      await createPrompt({ companyId: "co", sessionId: "s1", kind: "offer_choice", question: "q", buttons: [{ id: 98, label: "Voltar às opções", order: 0 }] })
      expect(db.negotiation_sessions[0].wait_state).toBe(st)
    }
  })
})
