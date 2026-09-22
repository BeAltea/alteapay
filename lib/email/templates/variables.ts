// Allowlist de variáveis de template (E9 / §5.4).
//
// REGRA DE OURO DE PRIVACIDADE: um template de e-mail NUNCA pode conter dados do
// débito (valor, nº de faturas, vencimento, CPF/CNPJ, contrato, etc.). O e-mail é
// só um convite neutro para a negociação — o dado sensível vive DENTRO do chat,
// depois da autenticação por CPF. Por isso a lista de variáveis permitidas é
// curta e fixa, e qualquer `{{...}}` fora dela BLOQUEIA a gravação do template.

/** Variáveis que o autor de template PODE usar. Chave = nome entre chaves duplas. */
export const ALLOWED_VARIABLES = [
  "primeiro_nome",
  "credor",
  "marca",
  "link_negociacao",
  "link_descadastro",
  "contato_suporte",
  "ano",
] as const

export type AllowedVariable = (typeof ALLOWED_VARIABLES)[number]

/** Descrição amigável de cada variável (painel de inserção do editor). */
export const VARIABLE_DESCRIPTIONS: Record<AllowedVariable, string> = {
  primeiro_nome: "Primeiro nome do destinatário",
  credor: "Nome do credor/cedente (aparece só após o login no chat)",
  marca: "Marca da plataforma (AlteaPay)",
  link_negociacao: "Link único de negociação (opaco, sem revelar o credor)",
  link_descadastro: "Link de descadastro / opt-out (List-Unsubscribe)",
  contato_suporte: "Contato de suporte / atendimento",
  ano: "Ano corrente (rodapé/copyright)",
}

// Variáveis EXPLICITAMENTE proibidas — quando detectadas, a mensagem de erro cita
// o motivo específico (dado do débito) em vez do genérico "variável desconhecida".
// A chave é comparada de forma tolerante (ver `matchForbidden`).
const FORBIDDEN_VARIABLE_HINTS: { pattern: RegExp; label: string }[] = [
  { pattern: /valor|montante|divida|d[ií]vida|debito|d[ée]bito|saldo/i, label: "valor da dívida" },
  { pattern: /fatura|parcela|installment|boleto/i, label: "número de faturas/parcelas" },
  { pattern: /vencimento|vence|due_date|duedate|data_venc/i, label: "vencimento" },
  { pattern: /cpf|cnpj|documento|document/i, label: "CPF/CNPJ" },
  { pattern: /contrato|contract/i, label: "número de contrato" },
]

const VARIABLE_TOKEN_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g

/** Todas as variáveis (nomes) referenciadas no conteúdo, deduplicadas e em ordem. */
export function extractVariables(...contents: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const content of contents) {
    if (!content) continue
    for (const m of content.matchAll(VARIABLE_TOKEN_RE)) {
      const name = m[1]
      if (!seen.has(name)) {
        seen.add(name)
        out.push(name)
      }
    }
  }
  return out
}

export interface VariableValidationResult {
  ok: boolean
  /** Variáveis usadas que são válidas (subconjunto da allowlist). */
  used: string[]
  /** Erros bloqueantes (variável proibida ou desconhecida). */
  errors: string[]
}

function matchForbidden(name: string): string | null {
  for (const { pattern, label } of FORBIDDEN_VARIABLE_HINTS) {
    if (pattern.test(name)) return label
  }
  return null
}

/**
 * Valida as variáveis usadas em `subject`, `preheader`, `html`, `textFallback`.
 * BLOQUEIA (ok=false) se houver:
 *   - variável de dado do débito (valor, fatura, vencimento, CPF/CNPJ, contrato…);
 *   - qualquer variável fora da allowlist.
 */
export function validateVariables(parts: {
  subject?: string
  preheader?: string
  html?: string
  textFallback?: string
}): VariableValidationResult {
  const allowed = new Set<string>(ALLOWED_VARIABLES)
  const used = extractVariables(parts.subject ?? "", parts.preheader ?? "", parts.html ?? "", parts.textFallback ?? "")
  const errors: string[] = []
  const validUsed: string[] = []

  for (const name of used) {
    if (allowed.has(name)) {
      validUsed.push(name)
      continue
    }
    const forbidden = matchForbidden(name)
    if (forbidden) {
      errors.push(
        `A variável {{${name}}} não é permitida: dados do débito (${forbidden}) nunca podem aparecer em um template de e-mail. Esses dados só existem dentro do chat, após a autenticação.`,
      )
    } else {
      errors.push(
        `A variável {{${name}}} é desconhecida. Use apenas as variáveis permitidas: ${ALLOWED_VARIABLES.map((v) => `{{${v}}}`).join(", ")}.`,
      )
    }
  }

  return { ok: errors.length === 0, used: validUsed, errors }
}

/** Variáveis que todo template de negociação DEVE conter (E9). */
export const REQUIRED_NEGOTIATION_VARIABLES: AllowedVariable[] = ["link_negociacao", "link_descadastro"]

export type TemplatePurpose = "negotiation" | "communication"

/**
 * Regras de PROPÓSITO. Um template `negotiation` exige o link de negociação e o
 * de descadastro — senão o e-mail seria inútil (sem CTA) ou ilegal (sem opt-out).
 */
export function validatePurposeRequirements(
  purpose: TemplatePurpose,
  parts: { subject?: string; preheader?: string; html?: string; textFallback?: string },
): { ok: boolean; errors: string[] } {
  if (purpose !== "negotiation") return { ok: true, errors: [] }

  const used = new Set(extractVariables(parts.subject ?? "", parts.preheader ?? "", parts.html ?? "", parts.textFallback ?? ""))
  const errors: string[] = []
  for (const required of REQUIRED_NEGOTIATION_VARIABLES) {
    if (!used.has(required)) {
      errors.push(`Templates de negociação exigem a variável {{${required}}}.`)
    }
  }
  return { ok: errors.length === 0, errors }
}

/** Dados fictícios para o PREVIEW (nunca dados reais / PII). */
export const PREVIEW_SAMPLE: Record<AllowedVariable, string> = {
  primeiro_nome: "Maria",
  credor: "Loja Exemplo LTDA",
  marca: "AlteaPay",
  link_negociacao: "https://alteapay.com/n/exemplo123",
  link_descadastro: "https://alteapay.com/descadastro/exemplo123",
  contato_suporte: "suporte@alteapay.com",
  ano: String(new Date().getFullYear()),
}

/**
 * Renderiza as variáveis (`{{nome}}`) com um mapa de valores. Variáveis sem valor
 * no mapa viram string vazia (não vazam o token). NÃO sanitiza — o chamador deve
 * sanitizar ANTES ou DEPOIS conforme o contexto (o preview sanitiza depois).
 */
export function renderVariables(content: string, values: Partial<Record<string, string>>): string {
  return content.replace(VARIABLE_TOKEN_RE, (_full, name: string) => values[name] ?? "")
}
