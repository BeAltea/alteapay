// QA round 2 — QAB1-H5 (BAIXO): atalhos do painel de pagamento (Voltar às
// opções / Pagar agora / Tentar de novo / Falar com atendimento) com guarda de
// clique duplo (in-flight): dois toques rápidos → 1 POST /api/chat/reopen.
// Regra pura (click-feedback.ts) + leitura do fonte de chat.tsx.
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("QAB1-H5 regra pura — createInFlightGuard", () => {
  it("dois toques concorrentes → a ação roda UMA vez; o 2º é ignorado (undefined)", async () => {
    const { createInFlightGuard } = await import("@/lib/journey/click-feedback")
    const g = createInFlightGuard()
    let runs = 0
    const fn = async () => { runs += 1; await sleep(20); return "ok" }
    const [a, b] = await Promise.all([g.run(fn), g.run(fn)])
    expect(runs).toBe(1)
    expect(a).toBe("ok")
    expect(b).toBeUndefined()
    expect(g.busy).toBe(false)
  })

  it("toques sequenciais (após liberar) rodam; uma exceção libera a guarda", async () => {
    const { createInFlightGuard } = await import("@/lib/journey/click-feedback")
    const g = createInFlightGuard()
    let runs = 0
    await g.run(async () => { runs += 1 })
    await g.run(async () => { runs += 1 })
    expect(runs).toBe(2)
    await expect(g.run(async () => { throw new Error("x") })).rejects.toThrow("x")
    expect(g.busy).toBe(false)
    await g.run(async () => { runs += 1 })
    expect(runs).toBe(3)
  })
})

describe("QAB1-H5 client (chat.tsx) — atalhos guardados (leitura do fonte)", () => {
  const src = readFileSync(join(__dirname, "..", "..", "components", "journey", "chat.tsx"), "utf8")
  const fnBody = (name: string) => {
    const start = src.indexOf(`async function ${name}(`)
    expect(start).toBeGreaterThan(0)
    const rest = src.slice(start)
    return rest.slice(0, rest.indexOf("\n  }\n") + 4)
  }

  it("onWaitPayNow / onWaitRetryOptions / onWaitHandoff / onPayRetry / onPayBackToOptions passam por shortcutGuardRef.current.run", () => {
    for (const name of ["onWaitPayNow", "onWaitRetryOptions", "onWaitHandoff", "onPayRetry", "onPayBackToOptions"]) {
      expect(fnBody(name)).toContain("shortcutGuardRef.current.run(")
    }
    expect(src).toContain("const shortcutGuardRef = useRef(createInFlightGuard())")
  })

  it("o núcleo do Pagar agora (payNowCore) fica sem guarda para ser composto: onPayRetry chama payNowCore, não onWaitPayNow (senão o aninhamento seria ignorado)", () => {
    expect(fnBody("payNowCore")).not.toContain("shortcutGuardRef")
    expect(fnBody("onPayRetry")).toContain("await payNowCore()")
    expect(fnBody("onPayRetry")).not.toContain("onWaitPayNow()")
  })
})
