// QA round 3 (QAB3-03) — PRIMEIRO NOME para a saudação do chat ("Olá, {nome}.",
// "Olá de novo, {nome}.", quitação) e para a variável {{primeiro_nome}} das
// campanhas (WhatsApp/e-mail). FONTE ÚNICA: acknowledgement.ts re-exporta e
// campaign-send.ts importa daqui (antes cada um tinha a sua cópia de
// `name.trim().split(/\s+/)[0]`, que tratava razão social como nome: "Olá, Auto."
// / "Olá, Top." / "Olá, L." / "Olá, 26.xxx.xxx.").
//
// Regra: devolve o primeiro nome de PESSOA FÍSICA ou `null` (a copy cai em
// "Olá." / "Olá de novo." — o Apêndice B prevê a saudação sem nome). É `null`
// quando:
//   - o nome está vazio;
//   - o documento é CNPJ (14 dígitos): pessoa jurídica, não se chama pelo 1º token;
//   - o nome contém tokens de PJ (LTDA, ME, EPP, EIRELI, MEI, S.A./S/A/SA, CIA,
//     COMERCIO, INDUSTRIA, SERVICOS, "&", …);
//   - o 1º token é numérico/começa por dígito, é abreviação com ponto ("P.S.")
//     ou tem menos de 2 letras ("M.", "L").
// Caixa alta ("JOÃO DA SILVA") vira "João" (a base pode vir de importação em caixa
// alta). Puro, sem PII em log, testável no node do vitest.

/** Tokens que identificam razão social. Comparação sem acento, em caixa alta,
 *  sem pontuação (LTDA. → LTDA; S.A. → SA). */
const PJ_TOKENS: ReadonlySet<string> = new Set([
  "LTDA",
  "LIMITADA",
  "ME",
  "EPP",
  "EIRELI",
  "MEI",
  "S/A",
  "CIA",
  "COMERCIO",
  "COMERCIAL",
  "INDUSTRIA",
  "INDUSTRIAL",
  "SERVICO",
  "SERVICOS",
  "EMPRESA",
  "EMPRESAS",
  "EMPREENDIMENTOS",
  "PARTICIPACOES",
  "HOLDING",
  "ASSOCIACAO",
  "CONDOMINIO",
  "COOPERATIVA",
  "SOCIEDADE",
  "DISTRIBUIDORA",
  "TRANSPORTES",
  "TRANSPORTADORA",
  "CONSTRUTORA",
  "INCORPORADORA",
  "REPRESENTACOES",
  "CONSULTORIA",
  "ATACADO",
  "ATACADISTA",
  "VAREJO",
  "AUTOPECAS",
  "IGREJA",
  "&",
])

/** "SA" só conta como PJ quando escrito em CAIXA ALTA no original (S.A., S/A, SA):
 *  o sobrenome "Sá" perde o acento na normalização e viraria falso positivo. */
const PJ_UPPER_ONLY: ReadonlySet<string> = new Set(["SA"])

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "")
}

/** Chave de comparação de um token: sem acento, caixa alta, sem pontuação de
 *  abreviação (ponto/vírgula/parênteses). A barra fica (S/A). */
function tokenKey(token: string): string {
  return stripAccents(token).toUpperCase().replace(/[.,;:()]/g, "")
}

function isLegalEntityToken(token: string): boolean {
  const key = tokenKey(token)
  if (!key) return false
  if (PJ_TOKENS.has(key)) return true
  if (PJ_UPPER_ONLY.has(key)) {
    // exige o original em caixa alta (S.A. / S/A / SA), nunca "Sá"/"Sa".
    const raw = token.replace(/[.,;:()]/g, "")
    return raw === raw.toUpperCase() && !/[̀-ͯ]/.test(token.normalize("NFD"))
  }
  return false
}

/** true quando o documento (qualquer máscara) tem 14 dígitos = CNPJ. */
export function isCnpjDocument(document: string | null | undefined): boolean {
  const digits = (document ?? "").replace(/\D/g, "")
  return digits.length === 14
}

/** true quando o nome parece razão social (algum token de PJ). */
export function looksLikeLegalEntityName(name: string | null | undefined): boolean {
  const tokens = (name ?? "").trim().split(/\s+/).filter(Boolean)
  return tokens.some(isLegalEntityToken)
}

/** Normaliza a caixa do 1º nome: tudo-maiúsculo ou tudo-minúsculo → Título
 *  ("JOÃO" → "João", "joão" → "João"); caixa mista fica como está ("Fabio"). */
function normalizeCase(token: string): string {
  const upper = token.toLocaleUpperCase("pt-BR")
  const lower = token.toLocaleLowerCase("pt-BR")
  if (token !== upper && token !== lower) return token
  return lower.charAt(0).toLocaleUpperCase("pt-BR") + lower.slice(1)
}

/**
 * Primeiro nome de pessoa física, ou `null` quando não há um nome que se possa
 * usar na saudação (vazio, CNPJ, razão social, 1º token inválido). Nunca lança.
 */
export function firstNameOf(
  name: string | null | undefined,
  document?: string | null,
): string | null {
  const raw = (name ?? "").trim()
  if (!raw) return null
  if (isCnpjDocument(document)) return null
  if (looksLikeLegalEntityName(raw)) return null
  const first = raw.split(/\s+/)[0].replace(/[.,;:]+$/g, "")
  if (!first) return null
  if (/\d/.test(first)) return null
  // iniciais/abreviação ("P.S.", "J.M."): ponto interno não é nome.
  if (first.includes(".")) return null
  if (!/^\p{L}/u.test(first)) return null
  const letters = stripAccents(first).replace(/[^A-Za-z]/g, "")
  if (letters.length < 2) return null
  return normalizeCase(first)
}
