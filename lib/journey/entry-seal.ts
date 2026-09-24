// R4 — Selo de legitimidade na PORTA (antes do CPF). Copy PURA e testável.
//
// Decisão G5 (R4): mostrar, ANTES de pedir CPF+LGPD, um selo minimalista que diz
// de QUEM o devedor recebeu o link e que a AlteaPay apenas OPERA o canal — sem
// revelar NADA do débito (valor/vencimento/quem-deve seguem pós-login, D6/D17).
// Reduz o abandono do desconfiado (3 de 8 personas, risco de abandono nº2) sem
// tocar o gate de auth/captcha.
//
// Fonte do nome do credor: `companies.name` da VMAX (via branding.brandName do
// tenant do link). Se ausente, cai num texto GENÉRICO seguro — nunca "null",
// nunca string vazia, nunca outro cedente (anti-GNLink). O selo NÃO é PII: é o
// nome do credor, o mesmo que o cabeçalho já mostra pós-login.

/** Nome genérico seguro quando o credor não pôde ser resolvido (companies.name
 *  nulo). Nunca renderizar "null"/vazio/terceiro. */
const GENERIC_CREDITOR = "a empresa credora"

/** Nomes que NÃO identificam o credor (fallbacks internos) → tratados como
 *  ausência de nome real, para o selo usar a variação genérica. */
const PLACEHOLDER_NAMES = new Set(["credor", "empresa credora", "a empresa credora", ""])

/** true quando `raw` é um nome de credor REAL (não um placeholder/fallback). */
export function hasRealCreditorName(raw: string | null | undefined): boolean {
  const name = (raw ?? "").trim()
  if (!name) return false
  return !PLACEHOLDER_NAMES.has(name.toLowerCase())
}

/**
 * Texto do selo da porta. Com nome real: "Você recebeu este link da {credor},
 * operado pela AlteaPay." Sem nome real: variação genérica ("da empresa
 * credora"). NUNCA vaza dado do débito; NUNCA "null"/vazio.
 */
export function entrySealText(creditorName: string | null | undefined): string {
  const who = hasRealCreditorName(creditorName)
    ? (creditorName as string).trim()
    : GENERIC_CREDITOR
  return `Você recebeu este link de cobrança da ${who}, operado pela AlteaPay.`
}

/** Rótulo da afordância "quem somos / por que recebi este link". */
export const ENTRY_SEAL_WHO_LABEL = "Quem somos e por que recebi este link"

/** Explicação curta exibida ao expandir "quem somos" — sem revelar o débito. */
export function entrySealWhoText(creditorName: string | null | undefined): string {
  const who = hasRealCreditorName(creditorName) ? (creditorName as string).trim() : GENERIC_CREDITOR
  return (
    `A AlteaPay é a plataforma que opera o canal de negociação em nome da ${who}. ` +
    `Por segurança, nenhuma informação da cobrança é exibida antes de você confirmar o seu CPF ou CNPJ. ` +
    `Se tiver dúvidas sobre a origem da cobrança, procure a ${who} pelo canal oficial informado na sua fatura ou no site oficial.`
  )
}
