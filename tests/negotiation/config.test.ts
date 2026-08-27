import { describe, expect, it } from "vitest"

import { agingDays, todaySaoPaulo } from "@/lib/negotiation/config"

describe("cálculo de aging em America/Sao_Paulo (regra 4)", () => {
  it("todaySaoPaulo devolve YYYY-MM-DD", () => {
    expect(todaySaoPaulo()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it("dívida vencida ontem tem 1 dia de atraso; futura tem 0", () => {
    const today = todaySaoPaulo()
    const d = new Date(`${today}T12:00:00Z`)
    const yesterday = new Date(d.getTime() - 86_400_000).toISOString().slice(0, 10)
    const tomorrow = new Date(d.getTime() + 86_400_000).toISOString().slice(0, 10)
    expect(agingDays(yesterday)).toBe(1)
    expect(agingDays(today)).toBe(0)
    expect(agingDays(tomorrow)).toBe(0)
  })

  it("aging bate com os buckets do rules engine", () => {
    const today = todaySaoPaulo()
    const d = new Date(`${today}T12:00:00Z`)
    const days92 = new Date(d.getTime() - 92 * 86_400_000).toISOString().slice(0, 10)
    expect(agingDays(days92)).toBe(92)
  })
})
