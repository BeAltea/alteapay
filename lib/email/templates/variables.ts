// Allowlist de variáveis de template (E9 / §5.4) — DOIS NÍVEIS (onda VMAX cobrança).
//
// REGRA DE OURO (default): um template de e-mail NÃO carrega dados do débito. O
// e-mail é um convite neutro — o dado sensível vive DENTRO do chat, após a
// autenticação por CPF. Essa continua sendo a regra para QUALQUER template.
//
// EXCEÇÃO CONTROLADA (canal e-mail de COBRANÇA VMAX): um template pode OPTAR por
// carregar um conjunto ESTRITO de dados de débito (nome, documento MASCARADO,
// valor, vencimento original, qtd de faturas) SOMENTE quando as TRÊS condições
// valem ao mesmo tempo:
//   1) o template tem `allow_debt_fields=true`;
//   2) o propósito é `negotiation`;
//   3) o canal de render é `email`.
// Fora dessas condições, as variáveis de débito voltam a ser PROIBIDAS. Mesmo com
// a exceção ligada, dados PROIBIDOS SEMPRE (documento COMPLETO, contrato, nº de
// fatura, linha digitável, dados bancários) nunca passam (FORBIDDEN_ALWAYS).

export type TemplatePurpose = "negotiation" | "communication"

/** As 7 variáveis básicas neutras — sempre permitidas em qualquer template. */
export const BASIC_VARIABLES = [
  "primeiro_nome",
  "credor",
  "marca",
  "link_negociacao",
  "link_descadastro",
  "contato_suporte",
  "ano",
] as const

/**
 * As 5 variáveis de DÉBITO — só liberadas com allow_debt_fields + purpose
 * negotiation + canal email (ver `validateVariables`/`resolveGateForDebtFields`).
 * Coordenadas com o D2 (UI/HTML).
 */
export const DEBT_VARIABLES = [
  "nome_cliente",
  "documento_mascarado",
  "valor_divida",
  "vencimento_original",
  "qtd_faturas",
] as const

/** União das duas listas — o universo de variáveis que o render conhece. */
export const ALLOWED_VARIABLES = [...BASIC_VARIABLES, ...DEBT_VARIABLES] as const

export type BasicVariable = (typeof BASIC_VARIABLES)[number]
export type DebtVariable = (typeof DEBT_VARIABLES)[number]
export type AllowedVariable = BasicVariable | DebtVariable

const BASIC_SET = new Set<string>(BASIC_VARIABLES)
const DEBT_SET = new Set<string>(DEBT_VARIABLES)

/** True se `name` é uma das 5 variáveis de débito. */
export function isDebtVariable(name: string): name is DebtVariable {
  return DEBT_SET.has(name)
}

/** Descrição amigável de cada variável (painel de inserção do editor). */
export const VARIABLE_DESCRIPTIONS: Record<AllowedVariable, string> = {
  primeiro_nome: "Primeiro nome do destinatário",
  credor: "Nome do credor/cedente (aparece só após o login no chat)",
  marca: "Marca da plataforma (AlteaPay)",
  link_negociacao: "Link único de negociação (opaco, sem revelar o credor)",
  link_descadastro: "Link de descadastro / opt-out (List-Unsubscribe)",
  contato_suporte: "Contato de suporte / atendimento",
  ano: "Ano corrente (rodapé/copyright)",
  nome_cliente: "Nome completo do cliente (só em e-mail de cobrança)",
  documento_mascarado: "CPF/CNPJ mascarado, ex.: ***.456.789-** (só em e-mail de cobrança)",
  valor_divida: "Valor atualizado da dívida em R$ (só em e-mail de cobrança)",
  vencimento_original: "Vencimento original (DD/MM/AAAA) (só em e-mail de cobrança)",
  qtd_faturas: "Quantidade de faturas em aberto (só em e-mail de cobrança)",
}

// Gate para liberar as variáveis de débito. As 3 condições precisam valer.
export interface DebtFieldsGate {
  /** coluna allow_debt_fields do template. */
  allowDebtFields: boolean
  /** propósito do template. */
  purpose: TemplatePurpose
  /** canal em que o conteúdo será renderizado. */
  channel: "email" | "whatsapp"
}

/** As DEBT_VARIABLES só passam com allow_debt_fields + negotiation + email. */
export function resolveGateForDebtFields(gate: DebtFieldsGate | undefined): boolean {
  if (!gate) return false
  return gate.allowDebtFields === true && gate.purpose === "negotiation" && gate.channel === "email"
}

// Dados PROIBIDOS SEMPRE — nem a exceção de débito os libera. O documento
// COMPLETO (não mascarado), o nº de contrato, o nº de fatura/boleto individual,
// a linha digitável e dados bancários NUNCA aparecem no e-mail. Estas regras têm
// precedência sobre a allowlist DEBT (uma variável de débito precisa estar na
// DEBT_VARIABLES E não casar aqui). O `documento_mascarado` é permitido; o
// `documento`/`cpf`/`cnpj` cru NÃO.
const FORBIDDEN_ALWAYS: { pattern: RegExp; label: string }[] = [
  // documento COMPLETO (documento_mascarado é tratado à parte, na DEBT allowlist).
  { pattern: /^(cpf|cnpj|documento|document)(?!_mascarado)/i, label: "documento completo (CPF/CNPJ)" },
  { pattern: /contrato|contract/i, label: "número de contrato" },
  { pattern: /linha_?digit|codigo_?barras|barcode|nosso_?numero/i, label: "linha digitável / código de barras" },
  { pattern: /banco|agencia|ag[êe]ncia|conta_?corrente|pix_?key|chave_?pix/i, label: "dados bancários" },
  { pattern: /numero_?fatura|fatura_?numero|invoice_?number|boleto/i, label: "número de fatura/boleto" },
]

// Variáveis de dado do débito EXPLICITAMENTE proibidas quando o gate NÃO está
// aberto — a mensagem de erro cita o motivo específico (dado do débito) em vez do
// genérico "variável desconhecida". A chave é comparada de forma tolerante.
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

/** Dado PROIBIDO SEMPRE (documento completo, contrato, linha digitável, banco…). */
function matchForbiddenAlways(name: string): string | null {
  for (const { pattern, label } of FORBIDDEN_ALWAYS) {
    if (pattern.test(name)) return label
  }
  return null
}

/**
 * Valida as variáveis usadas em `subject`, `preheader`, `html`, `textFallback`.
 *
 * Allowlist de DOIS NÍVEIS:
 *   - BÁSICAS (7): sempre permitidas.
 *   - DÉBITO (5): só quando o `gate` abre (allow_debt_fields + negotiation + email).
 *
 * PRECEDÊNCIA: a allowlist DEBT vence a regex FORBIDDEN_VARIABLE_HINTS — sem isso,
 * `documento_mascarado`/`valor_divida`/`vencimento_original`/`qtd_faturas`
 * casariam com os hints de proibição e seriam barrados. Mas FORBIDDEN_ALWAYS
 * (documento COMPLETO, contrato, nº de fatura, linha digitável, banco) vence
 * TUDO — nem uma variável de débito o supera.
 *
 * Quando o gate abre, as DEBT vars são PROIBIDAS no assunto/pré-header (só no
 * corpo/texto). Sem gate, qualquer DEBT var (em qualquer campo) é bloqueada.
 */
export function validateVariables(
  parts: {
    subject?: string
    preheader?: string
    html?: string
    textFallback?: string
  },
  gate?: DebtFieldsGate,
): VariableValidationResult {
  const debtAllowed = resolveGateForDebtFields(gate)
  const errors: string[] = []
  const validUsed: string[] = []

  // Assunto + pré-header: DEBT vars NUNCA são aceitas aqui (nem com o gate aberto).
  const headerVars = extractVariables(parts.subject ?? "", parts.preheader ?? "")
  const headerSet = new Set(headerVars)
  // Corpo (html + texto): pode ter DEBT vars quando o gate abre.
  const bodyVars = extractVariables(parts.html ?? "", parts.textFallback ?? "")

  // universo (dedup, ordem estável: header primeiro, depois corpo)
  const seen = new Set<string>()
  const used: string[] = []
  for (const name of [...headerVars, ...bodyVars]) {
    if (!seen.has(name)) {
      seen.add(name)
      used.push(name)
    }
  }

  for (const name of used) {
    // 1) básica → sempre ok.
    if (BASIC_SET.has(name)) {
      validUsed.push(name)
      continue
    }

    // 2) débito → a allowlist DEBT tem PRECEDÊNCIA sobre FORBIDDEN_VARIABLE_HINTS
    //    e FORBIDDEN_ALWAYS (as 5 são nomes conhecidos e seguros: valor,
    //    vencimento, doc MASCARADO, qtd, nome). Só passam com o gate aberto E
    //    fora do assunto/pré-header.
    if (DEBT_SET.has(name)) {
      if (!debtAllowed) {
        errors.push(
          `A variável {{${name}}} é de dado do débito e só pode aparecer em um template de e-mail de cobrança (com "permitir dados do débito" ligado, propósito de negociação). Fora disso, esses dados só existem dentro do chat.`,
        )
        continue
      }
      if (headerSet.has(name)) {
        errors.push(
          `A variável {{${name}}} não pode aparecer no assunto nem no pré-header — dados do débito só no corpo do e-mail.`,
        )
        continue
      }
      validUsed.push(name)
      continue
    }

    // 3) PROIBIDO SEMPRE — só chega aqui quem NÃO está em nenhuma allowlist
    //    (documento COMPLETO, contrato, linha digitável, banco, nº de fatura).
    const forbiddenAlways = matchForbiddenAlways(name)
    if (forbiddenAlways) {
      errors.push(
        `A variável {{${name}}} nunca é permitida em um e-mail: ${forbiddenAlways}. Esse dado não pode sair no e-mail em nenhuma hipótese.`,
      )
      continue
    }

    // 4) resto: proibida (dado do débito) ou desconhecida.
    const forbidden = matchForbidden(name)
    if (forbidden) {
      errors.push(
        `A variável {{${name}}} não é permitida: dados do débito (${forbidden}) nunca podem aparecer em um template de e-mail. Esses dados só existem dentro do chat, após a autenticação.`,
      )
    } else {
      errors.push(
        `A variável {{${name}}} é desconhecida. Use apenas as variáveis permitidas: ${BASIC_VARIABLES.map((v) => `{{${v}}}`).join(", ")}.`,
      )
    }
  }

  return { ok: errors.length === 0, used: validUsed, errors }
}

/** Variáveis que todo template de negociação DEVE conter (E9). */
export const REQUIRED_NEGOTIATION_VARIABLES: AllowedVariable[] = ["link_negociacao", "link_descadastro"]

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

/**
 * Regras EXTRAS de um template com `allow_debt_fields=true` (e-mail de cobrança):
 *   - exige `{{link_negociacao}}` + `{{link_descadastro}}` (CTA + opt-out);
 *   - o propósito PRECISA ser `negotiation` (o gate de débito só abre aí);
 *   - nenhuma DEBT var no assunto/pré-header (checagem redundante com
 *     validateVariables — defesa em profundidade).
 * Sem `allow_debt_fields`, não impõe nada.
 */
export function validateDebtFieldsRequirements(
  allowDebtFields: boolean,
  purpose: TemplatePurpose,
  parts: { subject?: string; preheader?: string; html?: string; textFallback?: string },
): { ok: boolean; errors: string[] } {
  if (!allowDebtFields) return { ok: true, errors: [] }
  const errors: string[] = []

  if (purpose !== "negotiation") {
    errors.push('Um template com "dados do débito" precisa ter propósito de negociação.')
  }

  const used = new Set(
    extractVariables(parts.subject ?? "", parts.preheader ?? "", parts.html ?? "", parts.textFallback ?? ""),
  )
  for (const required of REQUIRED_NEGOTIATION_VARIABLES) {
    if (!used.has(required)) {
      errors.push(`Um template com "dados do débito" exige a variável {{${required}}}.`)
    }
  }

  const headerVars = new Set(extractVariables(parts.subject ?? "", parts.preheader ?? ""))
  for (const name of headerVars) {
    if (DEBT_SET.has(name)) {
      errors.push(`A variável de débito {{${name}}} não pode aparecer no assunto nem no pré-header.`)
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
  // DEBT vars: dados FICTÍCIOS para o preview do e-mail de cobrança (nunca PII).
  nome_cliente: "Maria Da Silva",
  documento_mascarado: "***.456.789-**",
  valor_divida: "R$ 1.234,56",
  vencimento_original: "10/04/2026",
  qtd_faturas: "1",
}

/**
 * Renderiza as variáveis (`{{nome}}`) com um mapa de valores. Variáveis sem valor
 * no mapa viram string vazia (não vazam o token). NÃO sanitiza — o chamador deve
 * sanitizar ANTES ou DEPOIS conforme o contexto (o preview sanitiza depois).
 */
export function renderVariables(content: string, values: Partial<Record<string, string>>): string {
  return content.replace(VARIABLE_TOKEN_RE, (_full, name: string) => values[name] ?? "")
}
