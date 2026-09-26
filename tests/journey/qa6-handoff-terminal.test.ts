// QA rodada 6 (Q5r2-02, ALTO) — "Falar com atendimento" (a partir do erro de
// cobrança ou de qualquer handoff) terminava numa tela sem resposta. O servidor
// persiste a confirmação com stage 'handoff' (fora do dedup de conteúdo), limpa a
// espera/erro, e o client deriva um estado TERMINAL claro — também após F5. O
// caminho pelas rotas reais está em qa6-pay-abort-flow.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

let db: FakeDb
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/notifications/email", () => ({ sendEmail: async () => ({ ok: true }) }))
vi.mock("@/lib/journey/events", () => ({ recordEvent: async () => ({ ok: true, duplicate: false }), getTimeline: async () => [] }))

const CO = "eeeeeeee-0000-0000-0000-0000000qa6h1"
const ctx = { sessionId: "s-h", companyId: CO, customerId: "c-h", debtId: "d-h" }

describe("QA rodada 6 — handoff com resposta e estado terminal (Q5r2-02)", () => {
  beforeEach(() => {
    db = {
      companies: [{ id: CO, name: "VMAX LTDA" }],
      tenant_chat_config: [{ company_id: CO, branding: { brand_name: "VMAX" }, creditor_notification_emails: [] }],
      negotiation_sessions: [{ id: "s-h", company_id: CO, wait_state: "erro_cobranca", wait_started_at: "2026-09-26T15:04:00Z" }],
      negotiation_cases: [], contact_suppressions: [], chat_messages: [],
    }
  })

  it("transferToHumanWithOutcome: bolha 'Registramos o seu pedido de atendimento.' com stage handoff; erro_cobranca limpo", async () => {
    const { transferToHumanWithOutcome } = await import("@/lib/journey/actions")
    const out = await transferToHumanWithOutcome(ctx, "wait_degraded_handoff", "customer")
    expect(out.caseId).toBeTruthy()
    expect(out.messageId).toBeTruthy()
    expect(out.reply).toMatch(/^Certo\. Registramos o seu pedido de atendimento\./)
    const row = db.chat_messages.find((m) => m.id === out.messageId)!
    expect(row.offers_snapshot?.stage).toBe("handoff")
    expect(db.negotiation_sessions[0].wait_state).toBeNull()
  })

  it("2º pedido em < 15 min: nova bolha (o dedup de conteúdo não engole a resposta)", async () => {
    const { transferToHumanWithOutcome } = await import("@/lib/journey/actions")
    const a = await transferToHumanWithOutcome(ctx, "handoff_button", "customer")
    const b = await transferToHumanWithOutcome(ctx, "handoff_button", "customer")
    expect(a.messageId).not.toBe(b.messageId)
    expect(db.chat_messages.filter((m) => m.offers_snapshot?.stage === "handoff").length).toBe(2)
  })

  it("handoff não apaga um Pagar em voo (gerando_cobranca)", async () => {
    db.negotiation_sessions[0].wait_state = "gerando_cobranca"
    const { transferToHumanWithOutcome } = await import("@/lib/journey/actions")
    await transferToHumanWithOutcome(ctx, "handoff_button", "customer")
    expect(db.negotiation_sessions[0].wait_state).toBe("gerando_cobranca")
  })

  it("client (puro): terminal = última bolha do assistente é o handoff e não há prompt ativo; outcome nunca podado", async () => {
    const { isHandoffTerminal, OUTCOME_STAGES, HANDOFF_STAGE, classifyMessage } = await import("@/lib/journey/display-class") as any
    expect(isHandoffTerminal("handoff", false)).toBe(true)
    expect(isHandoffTerminal("handoff", true)).toBe(false) // relogin publicou o menu: conversa segue
    expect(isHandoffTerminal("payment_link", false)).toBe(false)
    expect(isHandoffTerminal(null, false)).toBe(false)
    expect(OUTCOME_STAGES.has(HANDOFF_STAGE)).toBe(true)
    if (typeof classifyMessage === "function") {
      expect(classifyMessage({ role: "assistant", text: "Certo. Registramos o seu pedido de atendimento.", stage: "handoff", generation: 0 }, { currentGeneration: 5 })).toBe("outcome")
    }
  })
})
