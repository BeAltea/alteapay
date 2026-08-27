import { describe, expect, it } from "vitest"

import { cashDiscountPctForAging } from "@/lib/negotiation/charge-rules"

describe("characterization: espelho da tabela de descontos do agente", () => {
  // Contrato: estes valores DEVEM ser idênticos a
  // alteapay-agents/agents/negotiation/config/charge_rules.yaml
  // (0-89d: 5% · 90-180d: 15% · 181-365d: 25% · 366d+: 35%).
  it("buckets de aging batem com charge_rules.yaml", () => {
    expect(cashDiscountPctForAging(0)).toBe(5)
    expect(cashDiscountPctForAging(89)).toBe(5)
    expect(cashDiscountPctForAging(90)).toBe(15)
    expect(cashDiscountPctForAging(180)).toBe(15)
    expect(cashDiscountPctForAging(181)).toBe(25)
    expect(cashDiscountPctForAging(365)).toBe(25)
    expect(cashDiscountPctForAging(366)).toBe(35)
    expect(cashDiscountPctForAging(516)).toBe(35)
  })
})
