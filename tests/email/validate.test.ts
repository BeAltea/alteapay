// Testes do orquestrador de validação de template (grava só se passar em tudo).
import { describe, it, expect } from "vitest"
import { validateTemplateInput } from "@/lib/email/templates/validate"
import { buildPreviewHtml } from "@/lib/email/templates/preview"
import type { TemplateInput } from "@/lib/email/templates/types"

function base(overrides: Partial<TemplateInput> = {}): TemplateInput {
  return {
    name: "Convite",
    scope: "global",
    companyId: null,
    purpose: "communication",
    allowDebtFields: false,
    subject: "Olá {{primeiro_nome}}",
    preheader: "Prévia",
    html: "<p>Olá {{primeiro_nome}}, tudo bem?</p>",
    textFallback: "",
    ...overrides,
  }
}

describe("validateTemplateInput", () => {
  it("aceita um template válido e devolve conteúdo sanitizado", () => {
    const r = validateTemplateInput(base())
    expect(r.ok).toBe(true)
    expect(r.sanitized).toBeDefined()
    expect(r.sanitized!.variablesUsed).toContain("primeiro_nome")
    // gera texto alternativo automaticamente
    expect(r.sanitized!.textFallback.length).toBeGreaterThan(0)
  })

  it("sanitiza o HTML na gravação (remove <script>)", () => {
    const r = validateTemplateInput(base({ html: "<p>oi {{primeiro_nome}}</p><script>bad()</script>" }))
    expect(r.ok).toBe(true)
    expect(r.sanitized!.html.toLowerCase()).not.toContain("script")
  })

  it("bloqueia variável proibida (valor)", () => {
    const r = validateTemplateInput(base({ html: "<p>{{valor_divida}}</p>" }))
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.field === "variables")).toBe(true)
  })

  it("bloqueia negotiation sem os links obrigatórios", () => {
    const r = validateTemplateInput(base({ purpose: "negotiation" }))
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.field === "purpose")).toBe(true)
  })

  it("aceita negotiation com os links obrigatórios", () => {
    const r = validateTemplateInput(
      base({
        purpose: "negotiation",
        html: "<p>Olá {{primeiro_nome}} <a href='{{link_negociacao}}'>negociar</a> <a href='{{link_descadastro}}'>sair</a></p>",
      }),
    )
    expect(r.ok).toBe(true)
  })

  it("exige nome, assunto e html", () => {
    expect(validateTemplateInput(base({ name: "" })).ok).toBe(false)
    expect(validateTemplateInput(base({ subject: "" })).ok).toBe(false)
    expect(validateTemplateInput(base({ html: "" })).ok).toBe(false)
  })

  it("escopo company exige companyId", () => {
    const r = validateTemplateInput(base({ scope: "company", companyId: null }))
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.field === "scope")).toBe(true)
  })
})

describe("buildPreviewHtml — dados fictícios + sanitizado", () => {
  it("substitui variáveis por dados fictícios e nunca vaza script", () => {
    const html = buildPreviewHtml({
      subject: "s",
      preheader: "pre {{primeiro_nome}}",
      html: "<p>Olá {{primeiro_nome}} da {{credor}}</p><script>x()</script>",
    })
    expect(html).toContain("Maria") // PREVIEW_SAMPLE.primeiro_nome
    expect(html).toContain("Loja Exemplo LTDA") // PREVIEW_SAMPLE.credor
    expect(html.toLowerCase()).not.toContain("<script")
  })
})
