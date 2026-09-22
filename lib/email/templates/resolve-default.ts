// F4 — TEMPLATE PADRÃO por cedente no envio por e-mail.
//
// Resolve QUAL template de e-mail de negociação usar para um cedente, na ordem:
//   1. padrão do CEDENTE   (email_template_defaults: company_id, purpose='negotiation')
//   2. padrão GLOBAL       (um template company_id IS NULL, purpose='negotiation',
//                           status='active' — o seed "Negociação — Convite (padrão)")
//   3. convite EMBUTIDO    (buildEmailInviteHtml de lib/journey/email-dispatch)
//
// SEM PII: a resolução carrega só assunto/preheader/html/texto da versão corrente
// (email_template_versions.current_version_id) — nada de valores/documentos. O
// render (renderTemplate) só injeta a ALLOWLIST de variáveis (variables.ts) e
// RE-SANITIZA o HTML (sanitize.ts, defesa em profundidade). Se o corpo não tiver
// os links obrigatórios ({{link_negociacao}} + {{link_descadastro}}) ou aparecer
// alguma variável proibida na renderização, cai no builtin com aviso.

import { createServiceClient } from "@/lib/supabase/service"
import { sanitizeEmailHtml } from "./sanitize"
import {
  BASIC_VARIABLES,
  DEBT_VARIABLES,
  REQUIRED_NEGOTIATION_VARIABLES,
  extractVariables,
  renderVariables,
  type AllowedVariable,
} from "./variables"
import type { DebtEmailContext } from "./render-context"
import { buildEmailInviteHtml } from "@/lib/journey/email-dispatch"

type ServiceClient = ReturnType<typeof createServiceClient>

export type TemplateSource = "cedente" | "global" | "builtin"

/** Template de negociação resolvido, pronto para render. Sem PII. */
export interface ResolvedTemplate {
  source: TemplateSource
  templateId?: string
  versionId?: string
  /** nome do template (para o preview/diagnóstico; não vai no e-mail). */
  name?: string
  /** true quando o template optou por dados do débito (e-mail de cobrança). */
  allowDebtFields?: boolean
  subject: string
  /** preheader (texto oculto do topo do e-mail); pode ser vazio. */
  preheader: string
  html: string
  /** texto alternativo (fallback plain-text). */
  text: string
}

/** Variáveis (allowlist) que o render injeta. Todas OPCIONAIS: ausente = "". */
export type TemplateVars = Partial<Record<AllowedVariable, string>>

const NEGOTIATION_PURPOSE = "negotiation"

/**
 * Um corpo de template só é UTILIZÁVEL como convite de negociação se contém os
 * links obrigatórios ({{link_negociacao}} + {{link_descadastro}}). Sem eles o
 * e-mail seria inútil (sem CTA) ou ilegal (sem opt-out) — então a resolução o
 * DESCARTA e continua a cadeia de fallback (cedente→global→builtin).
 */
function hasRequiredLinks(subject: string, preheader: string, html: string, text: string): boolean {
  const used = new Set(extractVariables(subject, preheader ?? "", html, text ?? ""))
  return REQUIRED_NEGOTIATION_VARIABLES.every((v) => used.has(v))
}

interface TemplateRow {
  id: string
  name: string
  current_version_id: string | null
  status: string
  allow_debt_fields?: boolean | null
}
interface VersionRow {
  id: string
  subject: string
  preheader: string | null
  html: string
  text_fallback: string | null
}

/** Carrega a versão corrente de um template (id + current_version_id). */
async function loadCurrentVersion(
  supabase: ServiceClient,
  template: TemplateRow,
): Promise<ResolvedTemplate | null> {
  if (!template.current_version_id) return null
  const { data: version } = await supabase
    .from("email_template_versions")
    .select("id, subject, preheader, html, text_fallback")
    .eq("id", template.current_version_id)
    .maybeSingle<VersionRow>()
  if (!version) return null

  const subject = version.subject ?? ""
  const preheader = version.preheader ?? ""
  const html = version.html ?? ""
  const text = version.text_fallback ?? ""
  // Descarta o template se o corpo não traz os links obrigatórios (cai no próximo).
  if (!hasRequiredLinks(subject, preheader, html, text)) return null

  return {
    source: "builtin",
    templateId: template.id,
    versionId: version.id,
    name: template.name,
    allowDebtFields: template.allow_debt_fields === true,
    subject,
    preheader,
    html,
    text,
  }
}

/** Padrão do CEDENTE: email_template_defaults(company_id, purpose='negotiation'). */
async function resolveCompanyDefault(
  supabase: ServiceClient,
  companyId: string,
): Promise<ResolvedTemplate | null> {
  const { data: def } = await supabase
    .from("email_template_defaults")
    .select("template_id")
    .eq("company_id", companyId)
    .eq("purpose", NEGOTIATION_PURPOSE)
    .maybeSingle<{ template_id: string }>()
  if (!def?.template_id) return null

  const { data: template } = await supabase
    .from("email_templates")
    .select("id, name, current_version_id, status, allow_debt_fields")
    .eq("id", def.template_id)
    .maybeSingle<TemplateRow>()
  if (!template || template.status === "archived") return null

  const resolved = await loadCurrentVersion(supabase, template)
  if (!resolved) return null
  return { ...resolved, source: "cedente" }
}

/**
 * Padrão GLOBAL: um template company_id IS NULL, purpose='negotiation', não
 * arquivado (o seed "Negociação — Convite (padrão)" cai aqui). Escolhe o mais
 * recentemente atualizado com versão corrente que passe nos links obrigatórios.
 */
async function resolveGlobalDefault(supabase: ServiceClient): Promise<ResolvedTemplate | null> {
  const { data: templates } = await supabase
    .from("email_templates")
    .select("id, name, current_version_id, status, allow_debt_fields")
    .is("company_id", null)
    .eq("purpose", NEGOTIATION_PURPOSE)
    .neq("status", "archived")
    .order("updated_at", { ascending: false })

  for (const template of (templates ?? []) as TemplateRow[]) {
    const resolved = await loadCurrentVersion(supabase, template)
    if (resolved) return { ...resolved, source: "global" }
  }
  return null
}

/**
 * Convite EMBUTIDO (último fallback): reusa o corpo de lib/journey/email-dispatch.
 * Como o builtin não é um template com variáveis {{...}}, expomos um html/subject
 * que o render (renderTemplate) devolve intacto (não há tokens a substituir). O
 * envio real do builtin usa o dispatchEmailInvite existente; aqui o corpo serve
 * de espelho para preview/testes e para o caminho de render uniforme.
 */
function builtinTemplate(vars: {
  firstName?: string
  brandName: string
  creditorName: string
  link: string
}): ResolvedTemplate {
  const html = buildEmailInviteHtml({
    customerName: vars.firstName ?? "",
    brandName: vars.brandName,
    creditorName: vars.creditorName,
    link: vars.link,
  })
  return {
    source: "builtin",
    name: "Convite padrão AlteaPay",
    // Fallback F4: convite embutido NUNCA carrega dados de débito.
    allowDebtFields: false,
    subject: `Negociação disponível - ${vars.creditorName}`,
    preheader: "",
    html,
    text: "",
  }
}

/**
 * Resolve o template de negociação por e-mail para um cedente, na cadeia
 * cedente → global → builtin. NÃO renderiza (não injeta variáveis): devolve o
 * conteúdo cru da versão corrente (ou o builtin). O chamador injeta e sanitiza
 * com renderTemplate. `builtin` traz os dados de branding/link para montar o
 * corpo embutido só quando nenhum template padrão existe.
 */
export async function resolveNegotiationTemplate(
  companyId: string,
  builtin: { firstName?: string; brandName: string; creditorName: string; link: string },
  supabaseOverride?: ServiceClient,
): Promise<ResolvedTemplate> {
  const supabase = supabaseOverride ?? createServiceClient()

  const company = await resolveCompanyDefault(supabase, companyId)
  if (company) return company

  const global = await resolveGlobalDefault(supabase)
  if (global) return global

  return builtinTemplate(builtin)
}

/**
 * Resolve APENAS a FONTE e o NOME do template (para o preview do diálogo), sem
 * montar corpo builtin (não precisa de link/branding). Barato: só as leituras da
 * cadeia. Sempre devolve algo (builtin com o nome "Convite padrão AlteaPay").
 */
export async function resolveNegotiationTemplateInfo(
  companyId: string,
  supabaseOverride?: ServiceClient,
): Promise<{ source: TemplateSource; name: string; templateId?: string; versionId?: string }> {
  const supabase = supabaseOverride ?? createServiceClient()

  const company = await resolveCompanyDefault(supabase, companyId)
  if (company) return { source: "cedente", name: company.name ?? "Padrão do cedente", templateId: company.templateId, versionId: company.versionId }

  const global = await resolveGlobalDefault(supabase)
  if (global) return { source: "global", name: global.name ?? "Padrão global", templateId: global.templateId, versionId: global.versionId }

  return { source: "builtin", name: "Convite padrão AlteaPay" }
}

export interface RenderedTemplate {
  ok: boolean
  subject: string
  html: string
  text: string
  /** true quando o render caiu para o builtin por conteúdo inválido no template. */
  fellBackToBuiltin?: boolean
  /**
   * motivo do fallback/falha — só código, sem PII:
   *   variavel_proibida | sem_links | render_incomplete.
   */
  reason?: string
  /** grupos de variáveis injetados (auditoria C12): ["basic"] | ["basic","debt"]. */
  variableGroups?: ("basic" | "debt")[]
}

const BASIC_SET = new Set<string>(BASIC_VARIABLES)
const DEBT_SET = new Set<string>(DEBT_VARIABLES)

/**
 * Primeira variável NÃO PERMITIDA neste render, considerando o gate de débito:
 *   - básica → sempre permitida;
 *   - débito → só permitida quando allowDebtFields (o banco não deveria ter DEBT
 *     var num template sem allow_debt_fields, mas re-checamos no render);
 *   - qualquer outra → proibida.
 */
function firstForbiddenVariable(
  allowDebtFields: boolean,
  subject: string,
  preheader: string,
  html: string,
  text: string,
): string | null {
  for (const name of extractVariables(subject, preheader ?? "", html, text ?? "")) {
    if (BASIC_SET.has(name)) continue
    if (DEBT_SET.has(name) && allowDebtFields) continue
    return name
  }
  return null
}

/** Escape HTML de um valor interpolado (texto e atributos com aspas duplas). */
function escapeHtmlValue(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/** Sobrou algum token `{{...}}` (ou `{{`/`}}` solto) no conteúdo? */
function hasLeftoverToken(...parts: string[]): boolean {
  return parts.some((p) => p.includes("{{") || p.includes("}}"))
}

/**
 * Renderiza um template resolvido com as variáveis da ALLOWLIST e RE-SANITIZA o
 * HTML (defesa em profundidade — nunca confiar no que veio do banco).
 *
 * DUAS camadas de variável:
 *   - BÁSICAS (7): sempre injetadas (link/nome/marca/…).
 *   - DÉBITO (5): injetadas SÓ quando o template tem allowDebtFields E o chamador
 *     forneceu `debtCtx` (valores já resolvidos por resolveDebtEmailContext). Os
 *     valores de débito são HTML-ESCAPADOS antes de interpolar.
 *
 * Rejeita (fellBackToBuiltin) quando:
 *   - o template referencia uma variável PROIBIDA/desconhecida (gate-aware);
 *   - o corpo perdeu os links obrigatórios.
 *
 * FALHA FECHADA (ok=false, reason='render_incomplete', SEM fallback):
 *   - allowDebtFields mas nenhum debtCtx (o chamador deveria ter excluído o
 *     devedor) → não podemos emitir e-mail com campos de débito vazios;
 *   - sobrou `{{`/`}}` no HTML/texto após o render (varredura final).
 */
export function renderTemplate(
  resolved: ResolvedTemplate,
  vars: TemplateVars,
  builtin?: { firstName?: string; brandName: string; creditorName: string; link: string },
  debtCtx?: DebtEmailContext,
): RenderedTemplate {
  const allowDebtFields = resolved.allowDebtFields === true

  // Guarda: variável não permitida no template persistido (gate-aware).
  const forbidden = firstForbiddenVariable(
    allowDebtFields,
    resolved.subject,
    resolved.preheader,
    resolved.html,
    resolved.text,
  )
  if (forbidden && resolved.source !== "builtin") {
    console.warn(`[email/resolve] template ${resolved.source} descartado: variável fora da allowlist {{${forbidden}}}`)
    if (builtin) {
      const bt = builtinTemplate(builtin)
      return { ok: true, fellBackToBuiltin: true, reason: "variavel_proibida", ...renderResolved(bt, vars) }
    }
    return { ok: false, subject: "", html: "", text: "", reason: "variavel_proibida" }
  }

  // Guarda: perdeu os links obrigatórios (só para templates de cedente/global).
  if (
    resolved.source !== "builtin" &&
    !hasRequiredLinks(resolved.subject, resolved.preheader, resolved.html, resolved.text)
  ) {
    console.warn(`[email/resolve] template ${resolved.source} descartado: sem links obrigatórios`)
    if (builtin) {
      const bt = builtinTemplate(builtin)
      return { ok: true, fellBackToBuiltin: true, reason: "sem_links", ...renderResolved(bt, vars) }
    }
    return { ok: false, subject: "", html: "", text: "", reason: "sem_links" }
  }

  // FALHA FECHADA: template de cobrança sem contexto de débito → não envia. Nunca
  // renderizamos {{valor_divida}} / "R$ 0,00" / "-" / undefined. É o chamador que
  // deveria ter excluído o devedor (ok:false) antes de chegar aqui.
  if (allowDebtFields && resolved.source !== "builtin" && !debtCtx) {
    console.warn(`[email/resolve] template ${resolved.source} com allow_debt_fields sem contexto de débito → render_incomplete`)
    return { ok: false, subject: "", html: "", text: "", reason: "render_incomplete" }
  }

  const rendered = renderResolved(resolved, vars, allowDebtFields ? debtCtx : undefined)

  // Varredura FINAL: qualquer {{ / }} que sobrou (variável não resolvida) → não
  // envia. É um TESTE, não um comentário: um token remanescente é bug de dados.
  if (hasLeftoverToken(rendered.html, rendered.text, rendered.subject)) {
    console.warn(`[email/resolve] token {{...}} remanescente após render → render_incomplete`)
    return { ok: false, subject: "", html: "", text: "", reason: "render_incomplete" }
  }

  return { ok: true, ...rendered }
}

/**
 * Substitui as variáveis (basic + debt quando fornecido) e RE-SANITIZA o HTML.
 * Ordem: escape dos valores de DÉBITO → render → sanitize. Os valores de débito
 * são HTML-escapados (não são URLs; entram como texto), enquanto os básicos
 * (links) seguem o caminho render→sanitize existente (o sanitizador escapa
 * atributos). Devolve os grupos de variáveis efetivamente injetados (C12).
 */
function renderResolved(
  resolved: ResolvedTemplate,
  vars: TemplateVars,
  debtCtx?: DebtEmailContext,
): { subject: string; html: string; text: string; variableGroups: ("basic" | "debt")[] } {
  const safeVars: Record<string, string> = {}
  // básicas: só valores da allowlist entram (nunca PII).
  for (const key of BASIC_VARIABLES) {
    const value = vars[key]
    if (typeof value === "string") safeVars[key] = value
  }
  const groups: ("basic" | "debt")[] = ["basic"]

  // débito: injeta os 5 valores JÁ formatados, HTML-escapados.
  if (debtCtx) {
    safeVars.nome_cliente = escapeHtmlValue(debtCtx.nome_cliente)
    safeVars.documento_mascarado = escapeHtmlValue(debtCtx.documento_mascarado)
    safeVars.valor_divida = escapeHtmlValue(debtCtx.valor_divida)
    safeVars.vencimento_original = escapeHtmlValue(debtCtx.vencimento_original)
    safeVars.qtd_faturas = escapeHtmlValue(debtCtx.qtd_faturas)
    groups.push("debt")
  }

  // Ordem render → sanitize: valores injetados TAMBÉM passam pelo sanitizador.
  const subject = renderVariables(resolved.subject, safeVars)
  const html = sanitizeEmailHtml(renderVariables(resolved.html, safeVars))
  const text = renderVariables(resolved.text ?? "", safeVars)
  return { subject, html, text, variableGroups: groups }
}
