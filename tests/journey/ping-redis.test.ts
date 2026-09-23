// pingRedis (lib/queue/queues) — ping rápido usado pelo fallback inline do hub.
//
// Prova que:
//   - PING respondendo 'PONG' → true.
//   - PING lançando (Redis fora) → false (NUNCA propaga o erro).
//   - PING que nunca resolve → false por TIMEOUT (dentro do prazo curto).
//
// Mocka ioredis e bullmq para que importar queues.ts NÃO abra conexão real
// (queues.ts constrói várias Queues no import). O foco é só pingRedis.

import { afterEach, describe, expect, it, vi } from "vitest"

// estado do ping controlado por teste.
const pingState: { mode: "pong" | "throw" | "hang" } = { mode: "pong" }

vi.mock("ioredis", () => {
  class FakeRedis {
    on() { return this }
    async ping(): Promise<string> {
      if (pingState.mode === "throw") throw new Error("ECONNREFUSED")
      if (pingState.mode === "hang") return await new Promise<string>(() => {}) // nunca resolve
      return "PONG"
    }
  }
  return { default: FakeRedis }
})

// bullmq Queue: no-op (não conecta). queues.ts instancia várias no import.
vi.mock("bullmq", () => ({
  Queue: class { constructor() {} add() {} },
}))

afterEach(() => {
  pingState.mode = "pong"
})

describe("pingRedis", () => {
  it("PING respondendo PONG → true", async () => {
    pingState.mode = "pong"
    const { pingRedis } = await import("@/lib/queue/queues")
    expect(await pingRedis(500)).toBe(true)
  })

  it("PING lançando (Redis fora) → false (não propaga)", async () => {
    pingState.mode = "throw"
    const { pingRedis } = await import("@/lib/queue/queues")
    expect(await pingRedis(500)).toBe(false)
  })

  it("PING que trava → false por timeout (dentro do prazo)", async () => {
    pingState.mode = "hang"
    const { pingRedis } = await import("@/lib/queue/queues")
    const t0 = Date.now()
    const ok = await pingRedis(120) // prazo curto
    expect(ok).toBe(false)
    // resolveu por timeout, não ficou pendurado.
    expect(Date.now() - t0).toBeLessThan(1000)
  })
})
