// Testes do template OFICIAL de cobrança da VMAX COM dados do débito (§5.2).
//
// Cobrem: (a) estrutura fixa §5.2 na ordem certa; (b) renderização com dados
// fictícios (nunca PII real); (c) sobrevivência ao sanitizador (a TABELA e os
// estilos inline de layout são preservados); (d) paridade do texto alternativo;
// (e) a lista de PROIBIÇÕES do corpo; (f) a frase de contagem de faturas.
import { describe, it, expect } from "vitest"
import { sanitizeEmailHtml } from "@/lib/email/templates/sanitize"
import { renderVariables } from "@/lib/email/templates/variables"
import {
  VMAX_TEMPLATE_NAME,
  VMAX_TEMPLATE_SUBJECT,
  VMAX_TEMPLATE_PREHEADER,
  VMAX_TEMPLATE_HTML,
  VMAX_TEMPLATE_TEXT,
  VMAX_TEMPLATE_VARIABLES,
  invoiceCountPhrase,
} from "@/lib/email/templates/vmax-negotiation-template"

// Dados FICTÍCIOS (nunca reais). Simulam o que o resolvedor (D1) injeta por devedor.
const VARS = {
  primeiro_nome: "Maria",
  nome_cliente: "Maria Souza",
  credor: "VMAX",
  marca: "AlteaPay",
  documento_mascarado: "***.456.789-**",
  valor_divida: "R$ 199,80",
  vencimento_original: "15/04/2026",
  qtd_faturas: "", // 1 fatura → frase vazia
  link_negociacao: "https://alteapay.com/n/k7Qm3Xb9Rt",
  link_descadastro: "https://alteapay.com/descadastro/k7Qm3Xb9Rt",
  contato_suporte: "relacionamento@alteapay.com",
  ano: "2026",
}

function renderHtml(vars: Record<string, string>): string {
  return renderVariables(VMAX_TEMPLATE_HTML, vars)
}
function renderText(vars: Record<string, string>): string {
  return renderVariables(VMAX_TEMPLATE_TEXT, vars)
}

describe("VMAX template — metadados e variáveis", () => {
  it("expõe nome, assunto e preheader canônicos", () => {
    expect(VMAX_TEMPLATE_NAME).toBe("VMAX — Cobrança oficial com dados do débito")
    // Assunto sem valor e sem a palavra "dívida" (Apêndice A).
    expect(VMAX_TEMPLATE_SUBJECT).not.toMatch(/d[ií]vida/i)
    expect(VMAX_TEMPLATE_SUBJECT).not.toMatch(/R\$/)
    // Preheader curto, sem valor e sem "dívida".
    expect(VMAX_TEMPLATE_PREHEADER).not.toMatch(/d[ií]vida/i)
    expect(VMAX_TEMPLATE_PREHEADER).not.toMatch(/R\$/)
    expect(VMAX_TEMPLATE_PREHEADER.length).toBeLessThan(160)
  })

  it("lista de variables_used bate com os tokens realmente usados", () => {
    const all = `${VMAX_TEMPLATE_SUBJECT}\n${VMAX_TEMPLATE_PREHEADER}\n${VMAX_TEMPLATE_HTML}\n${VMAX_TEMPLATE_TEXT}`
    for (const v of VMAX_TEMPLATE_VARIABLES) {
      expect(all, `variável ${v} deve aparecer no template`).toContain(`{{${v}}}`)
    }
    // e não há token fora da lista declarada.
    const tokens = new Set([...all.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]))
    for (const t of tokens) {
      expect(VMAX_TEMPLATE_VARIABLES as readonly string[], `token {{${t}}} não declarado`).toContain(t)
    }
  })
})

describe("VMAX template — estrutura fixa §5.2", () => {
  const html = renderHtml(VARS)

  it("1. pré-header oculto, curto, SEM valor e SEM a palavra 'dívida'", () => {
    const pre = html.match(/display:none[\s\S]*?<\/div>/i)?.[0] ?? ""
    expect(pre).not.toBe("")
    expect(pre).not.toMatch(/R\$/)
    expect(pre).not.toMatch(/d[ií]vida/i)
  })

  it("2. cabeçalho traz credor + assinatura AlteaPay", () => {
    // Credor no topo e a marca como operadora.
    expect(html).toMatch(/VMAX/)
    expect(html).toMatch(/operada pela AlteaPay/i)
  })

  it("3+4. saudação com nome_cliente + frase de comunicação oficial operacionalizada", () => {
    expect(html).toMatch(/Olá,\s*<strong>Maria Souza<\/strong>/)
    expect(html).toMatch(/comunicação oficial de cobrança em nome da <strong>VMAX<\/strong>, operacionalizada pela AlteaPay/i)
  })

  it("5. bloco de dados: nome, documento mascarado, valor (rótulo 'Valor atualizado'), vencimento (rótulo 'Vencimento original')", () => {
    expect(html).toContain("***.456.789-**")
    expect(html).toContain("R$ 199,80")
    expect(html).toContain("15/04/2026")
    expect(html).toMatch(/Valor atualizado/)
    expect(html).toMatch(/Vencimento original/)
  })

  it("6. CTA único 'Negociar agora' → link_negociacao + link visível em texto + confirmação de CPF/CNPJ", () => {
    const ctas = html.match(/Negociar agora/g) ?? []
    expect(ctas.length).toBe(1) // um único botão
    expect(html).toMatch(/href="https:\/\/alteapay\.com\/n\/k7Qm3Xb9Rt"/)
    // link em texto visível abaixo do botão
    expect(html).toMatch(/Ou acesse:[\s\S]*https:\/\/alteapay\.com\/n\/k7Qm3Xb9Rt/)
    expect(html).toMatch(/confirma o seu CPF\/CNPJ e vê as condições/i)
  })

  it("7. 'Se você já pagou, desconsidere esta mensagem' + contato de suporte", () => {
    expect(html).toMatch(/Se você já pagou, desconsidere esta mensagem/i)
    expect(html).toContain("relacionamento@alteapay.com")
  })

  it("8. rodapé legal: credor + CNPJ, AlteaPay operadora, descadastro e ano", () => {
    expect(html).toContain("07.685.452/0001-01")
    expect(html).toMatch(/operacionalizada pela AlteaPay/i)
    expect(html).toMatch(/href="https:\/\/alteapay\.com\/descadastro\/k7Qm3Xb9Rt"/)
    expect(html).toMatch(/AlteaPay — 2026/)
  })
})

describe("VMAX template — proibições no corpo (§5.2)", () => {
  const html = renderHtml(VARS).toLowerCase()
  const text = renderText(VARS).toLowerCase()

  it("não menciona negativação / protesto / ação judicial / SPC / Serasa", () => {
    for (const banned of ["negativa", "protesto", "ação judicial", "acao judicial", "spc", "serasa"]) {
      expect(html, `HTML não deve conter "${banned}"`).not.toContain(banned)
      expect(text, `texto não deve conter "${banned}"`).not.toContain(banned)
    }
  })

  it("não traz linha digitável / código de barras / dados bancários / nº contrato/fatura / multa/juros", () => {
    for (const banned of [
      "linha digitável",
      "linha digitavel",
      "código de barras",
      "codigo de barras",
      "agência",
      "agencia",
      "conta corrente",
      "nº do contrato",
      "numero do contrato",
      "número da fatura",
      "multa",
      "juros",
    ]) {
      expect(html, `HTML não deve conter "${banned}"`).not.toContain(banned)
      expect(text, `texto não deve conter "${banned}"`).not.toContain(banned)
    }
  })

  it("não usa contagem regressiva / prazo agressivo / % de desconto", () => {
    for (const banned of ["contagem regressiva", "restam", "últimas horas", "ultimas horas", "% de desconto", "expira em"]) {
      expect(html).not.toContain(banned)
      expect(text).not.toContain(banned)
    }
  })
})

describe("VMAX template — sanitização preserva a tabela e estilos de layout", () => {
  it("o HTML renderizado sobrevive ao sanitizador mantendo table/tr/td e o CTA", () => {
    const rendered = renderHtml(VARS)
    const clean = sanitizeEmailHtml(rendered)
    // A estrutura table-based (layout) permanece.
    expect(clean).toContain("<table")
    expect(clean).toContain("<tr")
    expect(clean).toContain("<td")
    // Estilo inline de layout (padding/background) preservado.
    expect(clean).toMatch(/style="[^"]*padding/i)
    expect(clean).toMatch(/style="[^"]*background-color/i)
    // O CTA e os links continuam apontando para o link de negociação.
    expect(clean).toContain('href="https://alteapay.com/n/k7Qm3Xb9Rt"')
    expect(clean).toContain("Negociar agora")
    // Links externos ganham rel de segurança.
    expect(clean).toContain('rel="noopener noreferrer"')
    // Nenhum <style> nem <script> (CSS é 100% inline).
    expect(clean.toLowerCase()).not.toContain("<style")
    expect(clean.toLowerCase()).not.toContain("<script")
    // Os dados do débito continuam presentes após sanitizar.
    expect(clean).toContain("R$ 199,80")
    expect(clean).toContain("***.456.789-**")
    expect(clean).toContain("15/04/2026")
  })

  it("é estável: sanitizar o já-sanitizado não muda nada (idempotente)", () => {
    const once = sanitizeEmailHtml(renderHtml(VARS))
    const twice = sanitizeEmailHtml(once)
    expect(twice).toBe(once)
  })
})

describe("VMAX template — paridade do texto alternativo", () => {
  it("o texto tem os mesmos dados e o link em texto puro", () => {
    const text = renderText(VARS)
    expect(text).toContain("Maria Souza")
    expect(text).toContain("***.456.789-**")
    expect(text).toContain("R$ 199,80")
    expect(text).toContain("15/04/2026")
    expect(text).toContain("Negociar agora: https://alteapay.com/n/k7Qm3Xb9Rt")
    expect(text).toContain("relacionamento@alteapay.com")
    expect(text).toContain("07.685.452/0001-01")
    expect(text).toContain("descadastre-se: https://alteapay.com/descadastro/k7Qm3Xb9Rt")
    expect(text).toContain("AlteaPay — 2026")
    // não sobra nenhum token não substituído.
    expect(text).not.toMatch(/\{\{[^}]+\}\}/)
  })
})

describe("VMAX template — frase de contagem de faturas (qtd_faturas > 1)", () => {
  it("HTML: injeta a frase quando há mais de uma fatura; vazia quando <= 1", () => {
    expect(invoiceCountPhrase(1, "html")).toBe("")
    expect(invoiceCountPhrase(0, "html")).toBe("")
    const many = invoiceCountPhrase(2, "html")
    expect(many).toMatch(/reúne <strong>2<\/strong> faturas/i)
    // e essa frase, injetada no template, sobrevive ao sanitizador.
    const html = renderHtml({ ...VARS, qtd_faturas: many })
    const clean = sanitizeEmailHtml(html)
    expect(clean).toMatch(/reúne <strong>2<\/strong> faturas/i)
  })

  it("texto: injeta uma linha só quando > 1", () => {
    expect(invoiceCountPhrase(1, "text")).toBe("")
    expect(invoiceCountPhrase(3, "text")).toMatch(/reúne 3 faturas em aberto/i)
  })
})
