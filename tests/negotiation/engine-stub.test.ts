// N7: engine stub — roteiro determinístico que exercita todas as ações, e
// engineName() com stub/n8n-sem-URL/disabled em produção.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/journey/actions", () => ({
  loadSessionCtx: async () => ({ sessionId: "s1", companyId: "c1", customerId: "cust1", debtId: "d1" }),
  listOffers: async () => [
    { id: "o1", terms: { installments: 1, total_value: 100, discount_pct: 10, billing_type: "PIX" }, valid_until: null },
  ],
}))

const input = (message: string) =>
  ({ session: { id: "s1", company_id: "c1", thread_id: "web_s1" }, message, channel: "webchat", debtor: null, tenant: null }) as any

describe("stubChat — cobre todas as ações", () => {
  it.each([
    ["quero ver minhas faturas", "debt.summary"],
    ["quais as opções de pagamento", "offer.list"],
    ["consigo pagar em 2x", "offer.propose"],
    ["já paguei essa dívida", "payment_claim.register"],
    ["quero contestar essa cobrança", "dispute.register"],
    ["quero falar com um atendente", "human.transfer"],
    ["obrigado, pode encerrar", "session.close"],
    ["oi", "debt.summary"], // saudação → menu (summary)
  ])("'%s' → tool_call %s", async (msg, expectedTool) => {
    const { stubChat } = await import("@/lib/negotiation/engines/stub")
    const r = await stubChat(input(msg))
    expect(r.reply).toBeTruthy()
    expect(r.tool_calls.map((t) => t.name)).toContain(expectedTool)
  })

  it("handoff quando não há oferta", async () => {
    vi.resetModules()
    vi.doMock("@/lib/journey/actions", () => ({
      loadSessionCtx: async () => ({ sessionId: "s1", companyId: "c1", customerId: "cust1", debtId: "d1" }),
      listOffers: async () => [],
    }))
    const { stubChat } = await import("@/lib/negotiation/engines/stub")
    const r = await stubChat(input("quais as opções de pagamento"))
    expect(r.action).toBe("handoff")
    vi.doUnmock("@/lib/journey/actions")
  })
})

describe("engineName", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllEnvs()
  })
  afterEach(() => vi.unstubAllEnvs())

  it("stub fora de produção", async () => {
    vi.stubEnv("NODE_ENV", "test")
    vi.stubEnv("NEGOTIATION_ENGINE", "stub")
    const { engineName } = await import("@/lib/negotiation/engine")
    expect(engineName()).toBe("stub")
  })

  it("stub degrada para disabled em produção", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("MOCK_ALL_INTEGRATIONS", "")
    vi.stubEnv("NEGOTIATION_ENGINE", "stub")
    const { engineName } = await import("@/lib/negotiation/engine")
    expect(engineName()).toBe("disabled")
  })

  it("n8n sem URL cai para stub SÓ no laboratório (MOCK_ALL_INTEGRATIONS=1)", async () => {
    vi.stubEnv("NODE_ENV", "test")
    vi.stubEnv("NEGOTIATION_ENGINE", "n8n")
    vi.stubEnv("N8N_CHAT_FLOW_URL", "")
    // sem o flag de lab: mantém o default seguro disabled
    vi.stubEnv("MOCK_ALL_INTEGRATIONS", "")
    const mod1 = await import("@/lib/negotiation/engine")
    expect(mod1.engineName()).toBe("disabled")
    // com o flag de lab: cai para stub (E2E sem servidor n8n)
    vi.stubEnv("MOCK_ALL_INTEGRATIONS", "1")
    const mod2 = await import("@/lib/negotiation/engine")
    expect(mod2.engineName()).toBe("stub")
  })

  it("default disabled", async () => {
    vi.stubEnv("NODE_ENV", "test")
    vi.stubEnv("NEGOTIATION_ENGINE", "")
    const { engineName } = await import("@/lib/negotiation/engine")
    expect(engineName()).toBe("disabled")
  })
})
