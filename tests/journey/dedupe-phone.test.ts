import { describe, expect, it } from "vitest"
import { dedupeByPhone } from "@/lib/journey/campaigns"
import type { EligibilityResult } from "@/lib/journey/campaigns"

const el = (customerId: string, phone: string | undefined): EligibilityResult => ({
  customerId,
  eligible: true,
  phoneE164: phone,
  debtIds: ["d1"],
  totalValue: 100,
})

describe("dedupeByPhone (V10)", () => {
  it("mantém o primeiro de cada telefone; duplicatas viram telefone_duplicado", () => {
    const out = dedupeByPhone([
      el("c1", "+5511999990001"),
      el("c2", "+5511999990001"), // mesmo telefone que c1
      el("c3", "+5511999990002"),
    ])
    expect(out[0]).toMatchObject({ customerId: "c1", eligible: true })
    expect(out[1]).toMatchObject({ customerId: "c2", eligible: false, reason: "telefone_duplicado" })
    expect(out[1].phoneE164).toBeUndefined()
    expect(out[2]).toMatchObject({ customerId: "c3", eligible: true })
  })

  it("não mexe em resultados já inelegíveis", () => {
    const inelig: EligibilityResult = { customerId: "c9", eligible: false, reason: "suprimido" }
    const out = dedupeByPhone([inelig, el("c1", "+5511999990001")])
    expect(out[0]).toBe(inelig)
    expect(out[1].eligible).toBe(true)
  })

  it("três no mesmo número: só o primeiro sobrevive", () => {
    const out = dedupeByPhone([
      el("c1", "+5511988887777"),
      el("c2", "+5511988887777"),
      el("c3", "+5511988887777"),
    ])
    expect(out.filter((r) => r.eligible)).toHaveLength(1)
    expect(out.filter((r) => r.reason === "telefone_duplicado")).toHaveLength(2)
  })
})
