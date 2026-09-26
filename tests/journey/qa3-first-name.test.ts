// QA round 3 — QAB3-03: primeiro nome ÚNICO (lib/journey/first-name.ts) usado
// pela saudação (acknowledgement/recap) e pelo {{primeiro_nome}} das campanhas.
// Razão social, CNPJ, token numérico ou com < 2 letras → null ("Olá." / "Olá de novo.").
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { firstNameOf, isCnpjDocument, looksLikeLegalEntityName } from "@/lib/journey/first-name"
import { firstNameOf as ackFirstNameOf } from "@/lib/journey/acknowledgement"
import { returnGreeting } from "@/lib/journey/recap"

const src = (rel: string) => readFileSync(join(__dirname, "..", "..", rel), "utf8")

describe("QAB3-03 — firstNameOf", () => {
  it("pessoa física → primeiro nome (caixa normalizada)", () => {
    expect(firstNameOf("Fabio Mendes", "111.444.777-35")).toBe("Fabio")
    expect(firstNameOf("JOÃO DA SILVA")).toBe("João")
    expect(firstNameOf("maria souza")).toBe("Maria")
    expect(firstNameOf("Ana Sá")).toBe("Ana")
    expect(firstNameOf("Jo Silva")).toBe("Jo")
  })

  it("CNPJ → null, qualquer nome", () => {
    expect(isCnpjDocument("26.123.456/0001-90")).toBe(true)
    expect(firstNameOf("Fabio Mendes", "26.123.456/0001-90")).toBeNull()
    expect(firstNameOf("Auto Peças Silva", "26123456000190")).toBeNull()
  })

  it("tokens de PJ → null (LTDA, ME, EPP, EIRELI, S.A., S/A, SA, CIA, …)", () => {
    for (const n of [
      "Auto Center LTDA", "Top Modas ME", "Mega Comercio EPP", "Regra Serviços EIRELI", "Visual S.A.",
      "Visual S/A", "Grupo X SA", "Silva & Filhos", "Oliveira e Cia", "Jm Transportes", "L. Souza Ltda.",
    ]) {
      expect(looksLikeLegalEntityName(n), n).toBe(true)
      expect(firstNameOf(n), n).toBeNull()
    }
    // "Sá" (sobrenome) não é "SA"
    expect(looksLikeLegalEntityName("Ana Sá")).toBe(false)
  })

  it("1º token numérico, com dígito ou com < 2 letras → null; vazio → null", () => {
    expect(firstNameOf("26.123.456 Fabio")).toBeNull()
    expect(firstNameOf("L Souza")).toBeNull()
    expect(firstNameOf("M. Souza")).toBeNull()
    expect(firstNameOf("P.S. Souza")).toBeNull()
    expect(firstNameOf("")).toBeNull()
    expect(firstNameOf(null)).toBeNull()
    expect(firstNameOf("   ")).toBeNull()
  })

  it("saudação sem nome quando null", () => {
    expect(returnGreeting(firstNameOf("Top Modas ME"))).toMatch(/^Olá de novo\./)
    expect(returnGreeting(firstNameOf("Fabio Mendes"))).toMatch(/^Olá de novo, Fabio\./)
  })

  it("fonte única: acknowledgement re-exporta; campaign-send e recap importam de first-name (sem cópia local)", () => {
    expect(ackFirstNameOf).toBe(firstNameOf)
    const campaign = src("lib/journey/campaign-send.ts")
    expect(campaign).toMatch(/import \{ firstNameOf \} from "\.\/first-name"/)
    expect(campaign).not.toMatch(/function firstNameOf/)
    expect(campaign).not.toMatch(/split\(\/\\s\+\/\)\[0\]/)
    expect(src("lib/journey/recap.ts")).toMatch(/from "\.\/first-name"/)
    expect(src("lib/journey/acknowledgement.ts")).not.toMatch(/function firstNameOf/)
  })
})
