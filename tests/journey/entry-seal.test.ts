// R4 — selo de legitimidade na porta (entry-seal.ts). Copy PURA: diz de QUEM veio
// o link + AlteaPay opera o canal, SEM revelar o débito, com fallback genérico
// seguro (nunca "null"/vazio/terceiro) quando o credor não pôde ser resolvido.
import { describe, expect, it } from "vitest"
import {
  entrySealText,
  entrySealWhoText,
  hasRealCreditorName,
  ENTRY_SEAL_WHO_LABEL,
} from "@/lib/journey/entry-seal"

describe("entry-seal — selo da porta (R4)", () => {
  it("com nome real: nomeia o credor e a AlteaPay como operadora", () => {
    const t = entrySealText("VMAX")
    expect(t).toContain("VMAX")
    expect(t).toContain("AlteaPay")
    expect(t.toLowerCase()).toContain("você recebeu este link")
  })

  it("hasRealCreditorName: só true para nome de credor REAL", () => {
    expect(hasRealCreditorName("VMAX")).toBe(true)
    expect(hasRealCreditorName("  VMAX  ")).toBe(true)
    // placeholders internos NÃO contam como nome real
    expect(hasRealCreditorName("Credor")).toBe(false)
    expect(hasRealCreditorName("credor")).toBe(false)
    expect(hasRealCreditorName("empresa credora")).toBe(false)
    expect(hasRealCreditorName("")).toBe(false)
    expect(hasRealCreditorName("   ")).toBe(false)
    expect(hasRealCreditorName(null)).toBe(false)
    expect(hasRealCreditorName(undefined)).toBe(false)
  })

  it("sem nome real: usa o genérico seguro — NUNCA 'null'/vazio/'Credor'", () => {
    for (const raw of [null, undefined, "", "   ", "Credor", "empresa credora"]) {
      const t = entrySealText(raw as string | null | undefined)
      expect(t).not.toMatch(/null|undefined/i)
      expect(t).not.toMatch(/\bCredor\b/) // não vaza o placeholder cru
      expect(t).toContain("a empresa credora")
      expect(t).toContain("AlteaPay")
      expect(t.trim().length).toBeGreaterThan(0)
    }
  })

  it("NUNCA revela dado do débito (valor/vencimento/nº faturas)", () => {
    const seal = entrySealText("VMAX")
    const who = entrySealWhoText("VMAX")
    for (const s of [seal, who]) {
      expect(s).not.toMatch(/R\$\s?\d/) // sem valor
      expect(s).not.toMatch(/\d{2}\/\d{2}\/\d{4}/) // sem data de vencimento
      expect(s).not.toMatch(/\d+\s+faturas?/i) // sem contagem de faturas
      expect(s).not.toMatch(/\bd[ií]vida\b/i) // não afirma "dívida" na porta
    }
  })

  it("copy 'quem somos' explica o papel da AlteaPay e o canal do credor (D36, sem ameaça)", () => {
    const who = entrySealWhoText("VMAX")
    expect(who).toContain("AlteaPay")
    expect(who).toContain("VMAX")
    expect(who).toContain("canal oficial")
    // sem ameaça / termos de cobrança agressiva (D36)
    expect(who).not.toMatch(/negativa|protesto|serasa|spc|judicial|cart[óo]rio/i)
    expect(ENTRY_SEAL_WHO_LABEL.toLowerCase()).toContain("quem somos")
  })

  it("fallback genérico também na copy 'quem somos'", () => {
    const who = entrySealWhoText(null)
    expect(who).not.toMatch(/null|undefined/i)
    expect(who).toContain("a empresa credora")
  })
})
