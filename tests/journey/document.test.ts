// N7: normalização, classificação, aceitação e mascaramento de documento.
import { describe, expect, it } from "vitest"
import {
  classify,
  isAcceptableDocument,
  maskDocument,
  normalizeDocument,
} from "@/lib/journey/document"

describe("normalizeDocument", () => {
  it("remove pontuação e não-dígitos", () => {
    expect(normalizeDocument("111.444.777-35")).toBe("11144477735")
    expect(normalizeDocument("11.222.333/0001-81")).toBe("11222333000181")
    expect(normalizeDocument(" 529 982 247 25 ")).toBe("52998224725")
    expect(normalizeDocument(null)).toBe("")
    expect(normalizeDocument(undefined)).toBe("")
  })
})

describe("classify", () => {
  it("11 dígitos = cpf, 14 = cnpj, resto = invalid", () => {
    expect(classify("11144477735")).toBe("cpf")
    expect(classify("11222333000181")).toBe("cnpj")
    expect(classify("123")).toBe("invalid")
    expect(classify("111.444.777-35")).toBe("cpf")
    expect(classify("11.222.333/0001-81")).toBe("cnpj")
  })
})

describe("isAcceptableDocument", () => {
  it("aceita CPF e CNPJ com DV válido (com ou sem pontuação)", () => {
    expect(isAcceptableDocument("111.444.777-35")).toBe(true)
    expect(isAcceptableDocument("52998224725")).toBe(true)
    expect(isAcceptableDocument("11.222.333/0001-81")).toBe(true)
    expect(isAcceptableDocument("11444777000161")).toBe(true)
  })
  it("rejeita DV errado, sequências e comprimento inválido", () => {
    expect(isAcceptableDocument("11144477736")).toBe(false)
    expect(isAcceptableDocument("11111111111")).toBe(false)
    expect(isAcceptableDocument("00000000000000")).toBe(false)
    expect(isAcceptableDocument("123")).toBe(false)
    expect(isAcceptableDocument("")).toBe(false)
  })
})

describe("maskDocument", () => {
  it("mascara sem revelar DV nem primeiros dígitos", () => {
    const cpf = maskDocument("11144477735")
    expect(cpf).toBe("***.444.777-**")
    expect(cpf).not.toContain("111")
    expect(cpf).not.toContain("35")
    const cnpj = maskDocument("11222333000181")
    expect(cnpj).toBe("**.222.333/****-**")
    expect(cnpj).not.toContain("81")
    expect(maskDocument("123")).toBe("***")
    expect(maskDocument(null)).toBe("***")
  })
})
