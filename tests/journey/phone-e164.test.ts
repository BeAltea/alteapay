import { describe, expect, it } from "vitest"
import { toE164Mobile } from "@/lib/journey/campaigns"

describe("toE164Mobile", () => {
  it("aceita 11 dígitos já com o 9 (celular)", () => {
    expect(toE164Mobile("11987654321")).toBe("+5511987654321")
  })

  it("aceita entrada formatada e ignora pontuação", () => {
    expect(toE164Mobile("(11) 98765-4321")).toBe("+5511987654321")
  })

  it("insere o 9 em número de 10 dígitos com celular antigo (3º dígito 6-9)", () => {
    expect(toE164Mobile("1188765432")).toBe("+5511988765432")
  })

  it("remove o prefixo +55 / 55 antes de normalizar", () => {
    expect(toE164Mobile("+5511987654321")).toBe("+5511987654321")
    expect(toE164Mobile("551188765432")).toBe("+5511988765432")
  })

  it("rejeita fixo de 10 dígitos (3º dígito não é 6-9)", () => {
    expect(toE164Mobile("1132654321")).toBeNull()
  })

  it("rejeita 11 dígitos sem o 9 na terceira posição", () => {
    expect(toE164Mobile("11887654321")).toBeNull()
  })

  it("rejeita DDD inválido (< 11)", () => {
    expect(toE164Mobile("10987654321")).toBeNull()
  })

  it("rejeita lixo, vazio e nulo", () => {
    expect(toE164Mobile("abc")).toBeNull()
    expect(toE164Mobile("")).toBeNull()
    expect(toE164Mobile(null)).toBeNull()
    expect(toE164Mobile(undefined)).toBeNull()
    expect(toE164Mobile("12345")).toBeNull()
  })
})
