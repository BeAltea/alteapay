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
  ALLOWED_VARIABLES,
  REQUIRED_NEGOTIATION_VARIABLES,
  extractVariables,
  renderVariables,
  type AllowedVariable,
} from "./variables"
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

  return { source: "builtin", templateId: template.id, versionId: version.id, name: template.name, subject, preheader, html, text }
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
    .select("id, name, current_version_id, status")
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
    .select("id, name, current_version_id, status")
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
  /** motivo do fallback (variável proibida / sem links) — só código, sem PII. */
  reason?: string
}

const ALLOWED = new Set<string>(ALLOWED_VARIABLES)

/** Alguma variável FORA da allowlist referenciada no template resolvido? */
function firstForbiddenVariable(subject: string, preheader: string, html: string, text: string): string | null {
  for (const name of extractVariables(subject, preheader ?? "", html, text ?? "")) {
    if (!ALLOWED.has(name)) return name
  }
  return null
}

/**
 * Renderiza um template resolvido com as variáveis da ALLOWLIST e RE-SANITIZA o
 * HTML (defesa em profundidade — nunca confiar no que veio do banco).
 *
 * Rejeita (fellBackToBuiltin) quando:
 *   - o template referencia uma variável PROIBIDA/desconhecida (o banco não
 *     deveria ter isso, mas re-checamos no render e logamos SEM PII);
 *   - o corpo perdeu os links obrigatórios.
 * Nesses casos, se `builtin` for fornecido, devolve o corpo embutido; senão,
 * marca ok=false para o chamador decidir. O builtin (source='builtin') já vem
 * do dispatch e passa direto (não tem tokens {{...}}), mas ainda é sanitizado.
 */
export function renderTemplate(
  resolved: ResolvedTemplate,
  vars: TemplateVars,
  builtin?: { firstName?: string; brandName: string; creditorName: string; link: string },
): RenderedTemplate {
  // Guarda: variável proibida no template persistido (não deveria acontecer).
  const forbidden = firstForbiddenVariable(resolved.subject, resolved.preheader, resolved.html, resolved.text)
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

  return { ok: true, ...renderResolved(resolved, vars) }
}

/** Substitui as variáveis da allowlist e RE-SANITIZA o HTML (ordem render→sanitize). */
function renderResolved(resolved: ResolvedTemplate, vars: TemplateVars): { subject: string; html: string; text: string } {
  // Só valores da allowlist entram no render (nunca PII/valores do débito).
  const safeVars: Record<string, string> = {}
  for (const key of ALLOWED_VARIABLES) {
    const value = vars[key]
    if (typeof value === "string") safeVars[key] = value
  }
  // Ordem render → sanitize: valores injetados TAMBÉM passam pelo sanitizador,
  // então nem a substituição pode introduzir markup perigoso (igual ao preview).
  const subject = renderVariables(resolved.subject, safeVars)
  const html = sanitizeEmailHtml(renderVariables(resolved.html, safeVars))
  const text = renderVariables(resolved.text ?? "", safeVars)
  return { subject, html, text }
}
