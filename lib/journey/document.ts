// Normalização e validação de CPF/CNPJ (N1). Fonte única para o resolver e a
// autenticação genérica. A validação de DV (isValidCpfCnpj) VIVE em
// lib/journey/auth.ts e é reexportada aqui para não duplicar a regra — este
// módulo acrescenta normalização, classificação e mascaramento.

import { isValidCpfCnpj } from "./auth"

export { isValidCpfCnpj }

export type DocumentKind = "cpf" | "cnpj" | "invalid"

/** Remove tudo que não é dígito. Mesma regra do `regexp_replace(doc,'\D','','g')` do SQL. */
export function normalizeDocument(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\D/g, "")
}

/**
 * Classifica pelo comprimento: 11 = cpf, 14 = cnpj, qualquer outro = invalid.
 * NÃO valida DV (isso é `isValidCpfCnpj`); apenas o tipo estrutural.
 */
export function classify(raw: string | null | undefined): DocumentKind {
  const digits = normalizeDocument(raw)
  if (digits.length === 11) return "cpf"
  if (digits.length === 14) return "cnpj"
  return "invalid"
}

/**
 * Documento aceitável para autenticar: tipo estrutural válido E dígito
 * verificador correto E não é sequência repetida (as duas últimas regras vivem
 * em isValidCpfCnpj). Único ponto de decisão para todas as rotas.
 */
export function isAcceptableDocument(raw: string | null | undefined): boolean {
  const digits = normalizeDocument(raw)
  return classify(digits) !== "invalid" && isValidCpfCnpj(digits)
}

/**
 * Mascara para exibição/telemetria. CPF → ***.456.789-**, CNPJ → **.456.789/****-**.
 * Nunca revela os DVs nem os primeiros dígitos. Documento inválido → "***".
 */
export function maskDocument(raw: string | null | undefined): string {
  const d = normalizeDocument(raw)
  if (d.length === 11) return `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**`
  if (d.length === 14) return `**.${d.slice(2, 5)}.${d.slice(5, 8)}/****-**`
  return "***"
}
