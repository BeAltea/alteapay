// Tipos compartilhados do CRUD de templates de e-mail (F3).
// Espelham as tabelas de 2026092X_email_templates.sql. Servem tanto ao backend
// (rotas) quanto ao editor (client), garantindo o mesmo contrato dos dois lados.

import type { TemplatePurpose } from "./variables"

export type { TemplatePurpose }

export type TemplateStatus = "draft" | "active" | "archived"

/** Escopo do template: global (visível a todos) ou de um cedente específico. */
export type TemplateScope = "global" | "company"

export interface EmailTemplate {
  id: string
  /** null = template GLOBAL (visível a todos; editável só por super_admin). */
  companyId: string | null
  name: string
  purpose: TemplatePurpose
  status: TemplateStatus
  /** Libera as 5 DEBT_VARIABLES no e-mail de cobrança (default false). */
  allowDebtFields: boolean
  currentVersionId: string | null
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

export interface EmailTemplateVersion {
  id: string
  templateId: string
  version: number
  subject: string
  preheader: string | null
  html: string
  textFallback: string | null
  variablesUsed: string[]
  createdBy: string | null
  createdAt: string
}

/** Um template com a sua versão corrente resolvida (o que o editor abre). */
export interface EmailTemplateWithVersion {
  template: EmailTemplate
  currentVersion: EmailTemplateVersion | null
  /** Se este template é o padrão do cedente para o seu propósito. */
  isDefault?: boolean
}

/** Payload de criação/edição vindo do editor. */
export interface TemplateInput {
  name: string
  scope: TemplateScope
  companyId: string | null
  purpose: TemplatePurpose
  /** Liga as 5 variáveis de débito (só e-mail de cobrança). Default false. */
  allowDebtFields: boolean
  subject: string
  preheader: string
  html: string
  textFallback: string
}

export interface TemplateValidationError {
  field: "name" | "subject" | "html" | "variables" | "purpose" | "scope"
  message: string
}

export interface TemplateValidationResult {
  ok: boolean
  errors: TemplateValidationError[]
  /** Conteúdo já SANITIZADO (pronto para gravar) quando ok=true. */
  sanitized?: {
    subject: string
    preheader: string
    html: string
    textFallback: string
    variablesUsed: string[]
  }
}
