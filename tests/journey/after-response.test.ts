// Latência (ops/negociacao-final/10-latencia.md) — trabalho opcional fora do
// caminho da resposta: waitUntil da plataforma quando existe; senão INLINE (nunca
// perde a escrita); `AFTER_RESPONSE_MODE=background` só em servidor de longa
// duração. Projeção em série por chave.
import { afterEach, describe, expect, it } from "vitest"
import { afterResponseMode, runAfterResponse, serializeByKey } from "@/lib/journey/after-response"

const SYM = Symbol.for("@next/request-context")
const g = globalThis as Record<symbol, unknown>

afterEach(() => {
  delete g[SYM]
  delete process.env.AFTER_RESPONSE_MODE
})

const tick = () => new Promise((r) => setTimeout(r, 0))

describe("runAfterResponse", () => {
  it("sem waitUntil e sem flag → INLINE: só resolve depois do trabalho", async () => {
    let done = false
    await runAfterResponse("t", async () => {
      await tick()
      done = true
    })
    expect(done).toBe(true)
    expect(afterResponseMode()).toBe("inline")
  })

  it("com waitUntil da plataforma → entrega a promise ao waitUntil e resolve na hora", async () => {
    const handed: Promise<unknown>[] = []
    g[SYM] = { get: () => ({ waitUntil: (p: Promise<unknown>) => handed.push(p) }) }
    let done = false
    await runAfterResponse("t", async () => {
      await tick()
      await tick()
      done = true
    })
    expect(afterResponseMode()).toBe("wait_until")
    expect(done).toBe(false)
    expect(handed).toHaveLength(1)
    await handed[0]
    expect(done).toBe(true)
  })

  it("contexto sem waitUntil (função ausente) → INLINE", async () => {
    g[SYM] = { get: () => ({}) }
    let done = false
    await runAfterResponse("t", async () => {
      done = true
    })
    expect(done).toBe(true)
    expect(afterResponseMode()).toBe("inline")
  })

  it("AFTER_RESPONSE_MODE=background → dispara e segue", async () => {
    process.env.AFTER_RESPONSE_MODE = "background"
    let done = false
    await runAfterResponse("t", async () => {
      await tick()
      done = true
    })
    expect(done).toBe(false)
    await tick()
    await tick()
    expect(done).toBe(true)
  })

  it("falha do trabalho nunca rejeita (vira aviso)", async () => {
    await expect(runAfterResponse("t", async () => { throw new Error("x") })).resolves.toBeUndefined()
  })
})

describe("serializeByKey", () => {
  it("mesma chave roda em série, na ordem de agendamento; chaves diferentes não esperam", async () => {
    const log: string[] = []
    const slow = (tag: string, ms: number) => async () => {
      log.push(`start:${tag}`)
      await new Promise((r) => setTimeout(r, ms))
      log.push(`end:${tag}`)
    }
    const a = serializeByKey("k", slow("a1", 20))
    const b = serializeByKey("k", slow("a2", 1))
    const c = serializeByKey("other", slow("b1", 1))
    await Promise.all([a, b, c])
    expect(log.indexOf("end:a1")).toBeLessThan(log.indexOf("start:a2"))
    expect(log.indexOf("start:b1")).toBeLessThan(log.indexOf("end:a1"))
  })

  it("uma falha não trava a fila da chave", async () => {
    const failed = serializeByKey("k2", async () => { throw new Error("boom") })
    await expect(failed).rejects.toThrow("boom")
    let ran = false
    await serializeByKey("k2", async () => { ran = true })
    expect(ran).toBe(true)
  })
})

// Integração N8N-10 × latência: UM mecanismo pós-resposta. A entrega do
// engine_outbox (deferDelivery) registra no MESMO waitUntil e nunca é aguardada.
describe("deferAfterResponse / deferDelivery do outbox", () => {
  it("com waitUntil → a entrega vai ao waitUntil; o chamador não espera", async () => {
    const { deferAfterResponse } = await import("@/lib/journey/after-response")
    const handed: Promise<unknown>[] = []
    g[SYM] = { get: () => ({ waitUntil: (p: Promise<unknown>) => handed.push(p) }) }
    let done = false
    deferAfterResponse("t", async () => { await tick(); done = true })
    expect(done).toBe(false)
    expect(handed).toHaveLength(1)
    await handed[0]
    expect(done).toBe(true)
  })

  it("sem waitUntil → NÃO roda inline (nunca aguardado), mas roda", async () => {
    const { deferAfterResponse } = await import("@/lib/journey/after-response")
    let done = false
    deferAfterResponse("t", async () => { await tick(); done = true })
    expect(done).toBe(false)
    await tick(); await tick()
    expect(done).toBe(true)
  })

  it("deferDelivery do outbox usa o mesmo waitUntil (um só ponto de registro)", async () => {
    const { deferDelivery } = await import("@/lib/negotiation/outbox")
    const handed: Promise<unknown>[] = []
    g[SYM] = { get: () => ({ waitUntil: (p: Promise<unknown>) => handed.push(p) }) }
    deferDelivery("session.start", async () => { throw new Error("n8n fora") })
    expect(handed).toHaveLength(1)
    await expect(handed[0]).resolves.toBeUndefined() // nunca rejeita
  })
})
