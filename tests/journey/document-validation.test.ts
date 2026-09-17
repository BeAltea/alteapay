import { describe, expect, it } from "vitest"
import { isValidCpfCnpj } from "@/lib/journey/auth"

describe("isValidCpfCnpj", () => {
  it("aceita CPF válido (DVs corretos)", () => {
    expect(isValidCpfCnpj("11144477735")).toBe(true)
    expect(isValidCpfCnpj("52998224725")).toBe(true)
  })

  it("aceita CNPJ válido (DVs corretos)", () => {
    expect(isValidCpfCnpj("11222333000181")).toBe(true)
    expect(isValidCpfCnpj("11444777000161")).toBe(true)
  })

  it("rejeita CPF com dígito verificador errado", () => {
    expect(isValidCpfCnpj("11144477736")).toBe(false)
    expect(isValidCpfCnpj("52998224724")).toBe(false)
  })

  it("rejeita CNPJ com dígito verificador errado", () => {
    expect(isValidCpfCnpj("11222333000182")).toBe(false)
  })

  it("rejeita sequência de dígitos repetidos (CPF e CNPJ)", () => {
    expect(isValidCpfCnpj("11111111111")).toBe(false)
    expect(isValidCpfCnpj("00000000000")).toBe(false)
    expect(isValidCpfCnpj("11111111111111")).toBe(false)
  })

  it("rejeita comprimentos que não são 11 nem 14 dígitos", () => {
    expect(isValidCpfCnpj("123")).toBe(false)
    expect(isValidCpfCnpj("111444777")).toBe(false)
    expect(isValidCpfCnpj("")).toBe(false)
  })
})
