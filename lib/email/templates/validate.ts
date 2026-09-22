// Orquestrador de validação de template (grava → só se passar em TUDO).
// Junta: nome/escopo básicos + allowlist de variáveis + regras de propósito +
// sanitização de HTML. Puro e testável (sem I/O). O backend chama isto ANTES de
// persistir qualquer versão.

import { sanitizeEmailHtml, toPlainText } from "./sanitize"
import {
  extractVariables,
  validateVariables,
  validatePurposeRequirements,
} from "./variables"
import type { TemplateInput, TemplateValidationResult, TemplateValidationError } from "./types"

const MAX_NAME = 120
const MAX_SUBJECT = 200
const MAX_PREHEADER = 200
const MAX_HTML = 200_000

export function validateTemplateInput(input: TemplateInput): TemplateValidationResult {
  const errors: TemplateValidationError[] = []

  // --- Nome ---
  const name = (input.name ?? "").trim()
  if (!name) {
    errors.push({ field: "name", message: "O nome do template é obrigatório." })
  } else if (name.length > MAX_NAME) {
    errors.push({ field: "name", message: `O nome deve ter no máximo ${MAX_NAME} caracteres.` })
  }

  // --- Escopo ---
  if (input.scope === "company" && !input.companyId) {
    errors.push({ field: "scope", message: "Selecione o cedente para um template com escopo de cedente." })
  }
  if (input.scope === "global" && input.companyId) {
    errors.push({ field: "scope", message: "Um template global não pode estar vinculado a um cedente." })
  }

  // --- Assunto ---
  const subject = (input.subject ?? "").trim()
  if (!subject) {
    errors.push({ field: "subject", message: "O assunto é obrigatório." })
  } else if (subject.length > MAX_SUBJECT) {
    errors.push({ field: "subject", message: `O assunto deve ter no máximo ${MAX_SUBJECT} caracteres.` })
  }

  const preheader = (input.preheader ?? "").trim()
  if (preheader.length > MAX_PREHEADER) {
    errors.push({ field: "subject", message: `O pré-header deve ter no máximo ${MAX_PREHEADER} caracteres.` })
  }

  // --- HTML ---
  const html = input.html ?? ""
  if (!html.trim()) {
    errors.push({ field: "html", message: "O corpo HTML é obrigatório." })
  } else if (html.length > MAX_HTML) {
    errors.push({ field: "html", message: "O corpo HTML excede o tamanho máximo permitido." })
  }

  const textFallback = input.textFallback ?? ""

  // --- Variáveis (allowlist + proibidas). Roda em TODOS os campos textuais. ---
  const varResult = validateVariables({ subject, preheader, html, textFallback })
  for (const message of varResult.errors) {
    errors.push({ field: "variables", message })
  }

  // --- Regras de propósito (negotiation exige link_negociacao + link_descadastro). ---
  const purposeResult = validatePurposeRequirements(input.purpose, { subject, preheader, html, textFallback })
  for (const message of purposeResult.errors) {
    errors.push({ field: "purpose", message })
  }

  if (errors.length > 0) {
    return { ok: false, errors }
  }

  // --- Sanitização na GRAVAÇÃO (defesa em profundidade). ---
  const sanitizedHtml = sanitizeEmailHtml(html)
  const finalTextFallback = textFallback.trim() ? textFallback : toPlainText(sanitizedHtml)
  const variablesUsed = extractVariables(subject, preheader, sanitizedHtml, finalTextFallback)

  return {
    ok: true,
    errors: [],
    sanitized: {
      subject,
      preheader,
      html: sanitizedHtml,
      textFallback: finalTextFallback,
      variablesUsed,
    },
  }
}
