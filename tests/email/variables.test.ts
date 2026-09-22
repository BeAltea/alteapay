// Testes da allowlist de variáveis (E9 / §5.4) e das regras de propósito.
import { describe, it, expect } from "vitest"
import {
  validateVariables,
  validatePurposeRequirements,
  validateDebtFieldsRequirements,
  resolveGateForDebtFields,
  isDebtVariable,
  extractVariables,
  renderVariables,
  BASIC_VARIABLES,
  DEBT_VARIABLES,
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

  it("BLOQUEIA valor da dívida (sem allow_debt_fields)", () => {
    const r = validateVariables({ html: "<p>Você deve {{valor_divida}}</p>" })
    expect(r.ok).toBe(false)
    // dois níveis: variável de débito só passa com allow_debt_fields+negotiation+email;
    // por padrão continua barrada, agora com a mensagem que explica a regra.
    expect(r.errors.join(" ")).toMatch(/dado do débito/i)
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

// ===========================================================================
// Allowlist de DOIS NÍVEIS (onda VMAX cobrança).
// ===========================================================================

const OPEN_GATE = { allowDebtFields: true, purpose: "negotiation" as const, channel: "email" as const }

describe("resolveGateForDebtFields — as 3 condições", () => {
  it("abre só com allow_debt_fields + negotiation + email", () => {
    expect(resolveGateForDebtFields(OPEN_GATE)).toBe(true)
  })
  it("fecha sem allow_debt_fields", () => {
    expect(resolveGateForDebtFields({ ...OPEN_GATE, allowDebtFields: false })).toBe(false)
  })
  it("fecha com propósito != negotiation", () => {
    expect(resolveGateForDebtFields({ ...OPEN_GATE, purpose: "communication" })).toBe(false)
  })
  it("fecha com canal != email", () => {
    expect(resolveGateForDebtFields({ ...OPEN_GATE, channel: "whatsapp" })).toBe(false)
  })
  it("fecha com gate ausente", () => {
    expect(resolveGateForDebtFields(undefined)).toBe(false)
  })
})

describe("isDebtVariable / listas", () => {
  it("as 5 DEBT vars são reconhecidas; as básicas não", () => {
    for (const v of DEBT_VARIABLES) expect(isDebtVariable(v)).toBe(true)
    for (const v of BASIC_VARIABLES) expect(isDebtVariable(v)).toBe(false)
  })
  it("BASIC tem 7, DEBT tem 5", () => {
    expect(BASIC_VARIABLES).toHaveLength(7)
    expect(DEBT_VARIABLES).toHaveLength(5)
    expect(DEBT_VARIABLES).toEqual([
      "nome_cliente",
      "documento_mascarado",
      "valor_divida",
      "vencimento_original",
      "qtd_faturas",
    ])
  })
})

describe("validateVariables — DEBT vars só com o gate aberto", () => {
  const bodyHtml =
    "<p>{{nome_cliente}} {{documento_mascarado}} {{valor_divida}} {{vencimento_original}} {{qtd_faturas}} " +
    '<a href="{{link_negociacao}}">x</a> <a href="{{link_descadastro}}">y</a></p>'

  it("SEM gate: as 5 DEBT vars são bloqueadas", () => {
    const r = validateVariables({ html: bodyHtml })
    expect(r.ok).toBe(false)
    // cada uma acusa (dado do débito / e-mail de cobrança).
    expect(r.errors.length).toBeGreaterThanOrEqual(1)
    expect(r.errors.join(" ")).toMatch(/cobran|débito|debito/i)
  })

  it("COM gate: as 5 DEBT vars passam no CORPO (precedência DEBT > FORBIDDEN hints)", () => {
    const r = validateVariables({ html: bodyHtml }, OPEN_GATE)
    expect(r.ok).toBe(true)
    // documento_mascarado, valor_divida, vencimento_original casariam com os hints
    // de proibição — mas a allowlist DEBT tem PRECEDÊNCIA.
    expect(r.used).toContain("documento_mascarado")
    expect(r.used).toContain("valor_divida")
    expect(r.used).toContain("vencimento_original")
    expect(r.used).toContain("qtd_faturas")
    expect(r.used).toContain("nome_cliente")
  })

  it("COM gate: DEBT var no ASSUNTO é rejeitada", () => {
    const r = validateVariables(
      { subject: "Você deve {{valor_divida}}", html: bodyHtml },
      OPEN_GATE,
    )
    expect(r.ok).toBe(false)
    expect(r.errors.join(" ")).toMatch(/assunto|pré-header|pre-header/i)
  })

  it("COM gate: DEBT var no PRÉ-HEADER é rejeitada", () => {
    const r = validateVariables(
      { preheader: "{{documento_mascarado}}", html: bodyHtml },
      OPEN_GATE,
    )
    expect(r.ok).toBe(false)
    expect(r.errors.join(" ")).toMatch(/assunto|pré-header|pre-header/i)
  })

  it("básicas continuam passando com ou sem gate", () => {
    const html = "<p>{{primeiro_nome}} {{credor}} {{marca}} {{contato_suporte}} {{ano}}</p>"
    expect(validateVariables({ html }).ok).toBe(true)
    expect(validateVariables({ html }, OPEN_GATE).ok).toBe(true)
  })
})

describe("FORBIDDEN_ALWAYS — proibido mesmo com o gate aberto", () => {
  it("documento COMPLETO (cpf/cnpj/documento) é sempre bloqueado", () => {
    expect(validateVariables({ html: "{{cpf}}" }, OPEN_GATE).ok).toBe(false)
    expect(validateVariables({ html: "{{cnpj}}" }, OPEN_GATE).ok).toBe(false)
    expect(validateVariables({ html: "{{documento}}" }, OPEN_GATE).ok).toBe(false)
  })

  it("documento_mascarado (permitido) NÃO casa com o bloqueio do documento completo", () => {
    const r = validateVariables(
      { html: '{{documento_mascarado}} <a href="{{link_negociacao}}">a</a> <a href="{{link_descadastro}}">b</a>' },
      OPEN_GATE,
    )
    expect(r.ok).toBe(true)
    expect(r.used).toContain("documento_mascarado")
  })

  it("contrato / linha digitável / dados bancários / nº de fatura sempre bloqueados", () => {
    expect(validateVariables({ html: "{{numero_contrato}}" }, OPEN_GATE).ok).toBe(false)
    expect(validateVariables({ html: "{{linha_digitavel}}" }, OPEN_GATE).ok).toBe(false)
    expect(validateVariables({ html: "{{codigo_barras}}" }, OPEN_GATE).ok).toBe(false)
    expect(validateVariables({ html: "{{agencia_conta}}" }, OPEN_GATE).ok).toBe(false)
    expect(validateVariables({ html: "{{chave_pix}}" }, OPEN_GATE).ok).toBe(false)
    expect(validateVariables({ html: "{{numero_fatura}}" }, OPEN_GATE).ok).toBe(false)
    expect(validateVariables({ html: "{{boleto}}" }, OPEN_GATE).ok).toBe(false)
  })
})

describe("validateDebtFieldsRequirements", () => {
  const okBody =
    '<p>{{nome_cliente}} {{valor_divida}} <a href="{{link_negociacao}}">x</a> <a href="{{link_descadastro}}">y</a></p>'

  it("sem allow_debt_fields: não impõe nada", () => {
    expect(validateDebtFieldsRequirements(false, "communication", { html: "<p>oi</p>" }).ok).toBe(true)
  })

  it("com allow_debt_fields exige os dois links", () => {
    const r = validateDebtFieldsRequirements(true, "negotiation", {
      html: "<p>{{nome_cliente}} {{valor_divida}}</p>",
    })
    expect(r.ok).toBe(false)
    expect(r.errors.join(" ")).toMatch(/link_negociacao/)
    expect(r.errors.join(" ")).toMatch(/link_descadastro/)
  })

  it("com allow_debt_fields exige propósito negotiation", () => {
    const r = validateDebtFieldsRequirements(true, "communication", { html: okBody })
    expect(r.ok).toBe(false)
    expect(r.errors.join(" ")).toMatch(/negocia/i)
  })

  it("com allow_debt_fields rejeita DEBT var no assunto", () => {
    const r = validateDebtFieldsRequirements(true, "negotiation", {
      subject: "{{valor_divida}}",
      html: okBody,
    })
    expect(r.ok).toBe(false)
    expect(r.errors.join(" ")).toMatch(/assunto/i)
  })

  it("aceita um corpo válido de cobrança", () => {
    expect(validateDebtFieldsRequirements(true, "negotiation", { html: okBody }).ok).toBe(true)
  })
})
