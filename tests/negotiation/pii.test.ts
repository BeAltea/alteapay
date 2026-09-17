import { describe, expect, it } from "vitest"

import { maskCpf, maskName, onlyDigits, redactPii } from "@/lib/negotiation/pii"

describe("mascaramento de PII (regra 7)", () => {
  it("maskCpf preserva só os 2 últimos dígitos", () => {
    expect(maskCpf("111.444.777-35")).toBe("***.***.***-35")
    expect(maskCpf("11144477735")).toBe("***.***.***-35")
    expect(maskCpf("")).toBe("***")
  })

  it("maskName mantém primeiro nome + inicial", () => {
    expect(maskName("Maria da Silva Sousa")).toBe("Maria S.")
    expect(maskName("João")).toBe("João")
  })

  it("onlyDigits normaliza CPF/CNPJ para comparação (regra 3)", () => {
    expect(onlyDigits("111.444.777-35")).toBe("11144477735")
    expect(onlyDigits("12.345.678/0001-90")).toBe("12345678000190")
  })

  it("redactPii remove CPF, e-mail, telefone e datas de nascimento", () => {
    const text = "Meu CPF é 111.444.777-35, nasci em 1985-03-12, email x@y.com, fone (11) 98888-7777"
    const redacted = redactPii(text)
    expect(redacted).not.toContain("111.444.777-35")
    expect(redacted).not.toContain("x@y.com")
    expect(redacted).not.toContain("98888-7777")
    expect(redacted).not.toContain("1985-03-12")
    expect(redacted).toContain("***.***.***-35")
  })
})
