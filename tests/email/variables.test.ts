// Testes da allowlist de variáveis (E9 / §5.4) e das regras de propósito.
import { describe, it, expect } from "vitest"
import {
  validateVariables,
  validatePurposeRequirements,
  extractVariables,
  renderVariables,
} from "@/lib/email/templates/variables"

describe("validateVariables — allowlist", () => {
  it("aceita variáveis permitidas", () => {
    const r = validateVariables({
      subject: "Olá {{primeiro_nome}}",
      html: "<p>{{credor}} {{link_negociacao}} {{link_descadastro}} {{marca}} {{ano}} {{contato_suporte}}</p>",
    })
    expect(r.ok).toBe(true)
    expect(r.errors).toHaveLength(0)
    expect(r.used).toContain("primeiro_nome")
    expect(r.used).toContain("link_negociacao")
  })

  it("BLOQUEIA valor da dívida", () => {
    const r = validateVariables({ html: "<p>Você deve {{valor_divida}}</p>" })
    expect(r.ok).toBe(false)
    expect(r.errors.join(" ")).toMatch(/valor da dívida/i)
  })

  it("BLOQUEIA vencimento, CPF/CNPJ, faturas e contrato", () => {
    expect(validateVariables({ html: "{{vencimento}}" }).ok).toBe(false)
    expect(validateVariables({ html: "{{cpf}}" }).ok).toBe(false)
    expect(validateVariables({ html: "{{cnpj}}" }).ok).toBe(false)
    expect(validateVariables({ html: "{{numero_faturas}}" }).ok).toBe(false)
    expect(validateVariables({ html: "{{numero_contrato}}" }).ok).toBe(false)
  })

  it("BLOQUEIA variável desconhecida (fora da allowlist)", () => {
    const r = validateVariables({ html: "<p>{{qualquer_coisa}}</p>" })
    expect(r.ok).toBe(false)
    expect(r.errors.join(" ")).toMatch(/desconhecida/i)
  })

  it("mensagem de erro cita o motivo (dado do débito)", () => {
    const r = validateVariables({ html: "{{saldo_devedor}}" })
    expect(r.errors[0]).toMatch(/débito|dívida/i)
  })
})

describe("validatePurposeRequirements — negotiation", () => {
  it("exige link_negociacao e link_descadastro", () => {
    const r = validatePurposeRequirements("negotiation", { html: "<p>{{primeiro_nome}}</p>" })
    expect(r.ok).toBe(false)
    expect(r.errors.join(" ")).toMatch(/link_negociacao/)
    expect(r.errors.join(" ")).toMatch(/link_descadastro/)
  })

  it("passa quando ambos os links estão presentes", () => {
    const r = validatePurposeRequirements("negotiation", {
      html: "<p>{{link_negociacao}} {{link_descadastro}}</p>",
    })
    expect(r.ok).toBe(true)
  })

  it("communication não exige os links", () => {
    const r = validatePurposeRequirements("communication", { html: "<p>oi</p>" })
    expect(r.ok).toBe(true)
  })
})

describe("extractVariables / renderVariables", () => {
  it("extrai deduplicado e em ordem", () => {
    expect(extractVariables("{{a}} {{b}} {{a}}")).toEqual(["a", "b"])
  })
  it("renderiza valores e some com token sem valor", () => {
    expect(renderVariables("Oi {{primeiro_nome}} {{x}}", { primeiro_nome: "Ana" })).toBe("Oi Ana ")
  })
})
