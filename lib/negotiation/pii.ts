// Mascaramento de PII (regra inviolável nº 7): nenhum CPF, telefone ou nome
// completo em logs ou em conteúdo redigido de gestão.

export function onlyDigits(value: string | null | undefined): string {
  return (value || "").replace(/\D/g, "")
}

/** "11144477735" → "***.***.***-35" */
export function maskCpf(document: string | null | undefined): string {
  const digits = onlyDigits(document)
  if (!digits) return "***"
  return `***.***.***-${digits.slice(-2)}`
}

/** "Maria da Silva Sousa" → "Maria S." */
export function maskName(name: string | null | undefined): string {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "***"
  if (parts.length === 1) return parts[0]
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`
}

const CPF_RE = /\b\d{3}[.\s]?\d{3}[.\s]?\d{3}[-.\s]?\d{2}\b/g
const CNPJ_RE = /\b\d{2}[.\s]?\d{3}[.\s]?\d{3}[/\s]?\d{4}[-.\s]?\d{2}\b/g
const PHONE_RE = /\b(?:\+?55[\s.-]?)?(?:\(?\d{2}\)?[\s.-]?)?9?\d{4}[\s.-]?\d{4}\b/g
const DOB_RE = /\b(?:\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4})\b/g
const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g

/** Versão da mensagem segura para telas de gestão (content_redacted). */
export function redactPii(text: string): string {
  return text
    .replace(CPF_RE, (m) => maskCpf(m))
    .replace(CNPJ_RE, "**.***.***/****-**")
    .replace(EMAIL_RE, "***@***")
    .replace(DOB_RE, "**/**/****")
    .replace(PHONE_RE, (m) => (onlyDigits(m).length >= 8 ? "(**) *****-**" + onlyDigits(m).slice(-2) : m))
}
