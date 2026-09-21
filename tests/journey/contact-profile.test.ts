import { describe, expect, it } from "vitest"
import {
  deriveContactProfile,
  isEmailValid,
  type ContactProfile,
} from "@/lib/journey/contact-profile"

// A normalização de telefone é a de campaigns.ts::toE164Mobile (coberta por
// phone-e164.test.ts). Aqui validamos como ela alimenta o perfil de contato.

describe("isEmailValid", () => {
  it("aceita e-mails bem formados", () => {
    expect(isEmailValid("fabio@gmail.com")).toBe(true)
    expect(isEmailValid("a.b+tag@sub.dominio.com.br")).toBe(true)
    expect(isEmailValid("  Fabio@Example.Org  ".replace("Example", "gmail"))).toBe(true)
  })

  it("normaliza case e espaços", () => {
    expect(isEmailValid("    ")).toBe(false)
    expect(isEmailValid("FABIO@GMAIL.COM")).toBe(true)
  })

  it("rejeita vazio, nulo e undefined", () => {
    expect(isEmailValid("")).toBe(false)
    expect(isEmailValid(null)).toBe(false)
    expect(isEmailValid(undefined)).toBe(false)
  })

  it("rejeita placeholders do cedente (naotem*, sememail, sem@, nao@)", () => {
    expect(isEmailValid("naotem@vmax.com")).toBe(false)
    expect(isEmailValid("naotem")).toBe(false)
    expect(isEmailValid("sememail@x.com")).toBe(false)
    expect(isEmailValid("sem@dominio.com")).toBe(false)
    expect(isEmailValid("nao@tem.com")).toBe(false)
  })

  it("rejeita domínio interno do cedente / placeholder", () => {
    expect(isEmailValid("cliente@vmax.com")).toBe(false)
    expect(isEmailValid("x@alteapay.com")).toBe(false)
    expect(isEmailValid("y@example.com")).toBe(false)
    expect(isEmailValid("z@localhost")).toBe(false)
    expect(isEmailValid("w@invalid.tld")).toBe(false)
  })

  it("rejeita sintaxe inválida", () => {
    expect(isEmailValid("semarroba.com")).toBe(false)
    expect(isEmailValid("dois@@arrobas.com")).toBe(false)
    expect(isEmailValid("sem@tld")).toBe(false)
    expect(isEmailValid("@dominio.com")).toBe(false)
  })
})

describe("deriveContactProfile", () => {
  const cases: Array<[string, Parameters<typeof deriveContactProfile>[0], ContactProfile]> = [
    ["celular + e-mail → both", { phone: "11987654321", email: "a@gmail.com" }, "both"],
    ["só celular → mobile", { phone: "11987654321", email: null }, "mobile"],
    ["só e-mail → email_only", { phone: null, email: "a@gmail.com" }, "email_only"],
    ["nada → none", { phone: null, email: null }, "none"],
    ["fixo + e-mail → email_only", { phone: "1132654321", email: "a@gmail.com" }, "email_only"],
    ["celular + e-mail placeholder → mobile", { phone: "11987654321", email: "naotem@vmax.com" }, "mobile"],
  ]

  for (const [name, input, expected] of cases) {
    it(name, () => {
      expect(deriveContactProfile(input)).toBe(expected)
    })
  }

  it("usa o fallback VMAX Telefone 1 quando customers.phone não é celular", () => {
    expect(
      deriveContactProfile({ phone: "1132654321", vmaxPhone1: "11987654321", email: null }),
    ).toBe("mobile")
  })

  it("cai para VMAX Telefone 2 quando Telefone 1 também não serve", () => {
    expect(
      deriveContactProfile({
        phone: null,
        vmaxPhone1: "1132654321",
        vmaxPhone2: "11988887777",
        email: null,
      }),
    ).toBe("mobile")
  })

  it("phone válido tem prioridade sobre o fallback VMAX", () => {
    expect(
      deriveContactProfile({ phone: "11987654321", vmaxPhone1: "lixo", email: null }),
    ).toBe("mobile")
  })

  it("celular do fallback + e-mail válido → both", () => {
    expect(
      deriveContactProfile({ phone: null, vmaxPhone1: "11987654321", email: "a@gmail.com" }),
    ).toBe("both")
  })
})
