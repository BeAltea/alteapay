// Camada de acesso a dados dos templates (CRUD + versionamento).
//
// Regras de versionamento (E8):
//   - salvar (create/update) SEMPRE cria uma nova VERSÃO imutável e aponta
//     current_version_id para ela (nunca sobrescreve uma versão existente);
//   - editar um template já usado → nova versão (a antiga fica no histórico);
//   - restaurar = criar uma NOVA versão com o conteúdo de uma versão antiga;
//   - arquivar em vez de apagar (status='archived').
//
// Sempre passa pelo validador (`validateTemplateInput`) ANTES de gravar — o
// conteúdo persistido já está sanitizado e sem variáveis proibidas.

import { createServiceClient } from "@/lib/supabase/service"
import { validateTemplateInput } from "./validate"
import type {
  EmailTemplate,
  EmailTemplateVersion,
  EmailTemplateWithVersion,
  TemplateInput,
  TemplateValidationResult,
} from "./types"
import type { TemplatePurpose } from "./variables"

type ServiceClient = ReturnType<typeof createServiceClient>

// ------- mapeamento row (snake_case) → objeto (camelCase) -------

function mapTemplate(row: any): EmailTemplate {
  return {
    id: row.id,
    companyId: row.company_id ?? null,
    name: row.name,
    purpose: row.purpose,
    status: row.status,
    allowDebtFields: row.allow_debt_fields === true,
    currentVersionId: row.current_version_id ?? null,
    createdBy: row.created_by ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapVersion(row: any): EmailTemplateVersion {
  return {
    id: row.id,
    templateId: row.template_id,
    version: row.version,
    subject: row.subject,
    preheader: row.preheader ?? null,
    html: row.html,
    textFallback: row.text_fallback ?? null,
    variablesUsed: row.variables_used ?? [],
    createdBy: row.created_by ?? null,
    createdAt: row.created_at,
  }
}

// ------- leitura -------

/**
 * Lista templates VISÍVEIS ao super_admin: todos os globais + os de qualquer
 * cedente (super_admin é cross-tenant). Inclui a versão corrente e a flag de padrão.
 */
export async function listTemplates(
  supabase: ServiceClient,
  opts?: { companyId?: string | null; includeArchived?: boolean },
): Promise<EmailTemplateWithVersion[]> {
  let query = supabase.from("email_templates").select("*").order("updated_at", { ascending: false })
  if (opts?.companyId !== undefined) {
    if (opts.companyId === null) query = query.is("company_id", null)
    else query = query.eq("company_id", opts.companyId)
  }
  if (!opts?.includeArchived) query = query.neq("status", "archived")

  const { data: templates, error } = await query
  if (error) throw new Error(`Falha ao listar templates: ${error.message}`)

  const rows = (templates ?? []) as any[]
  if (rows.length === 0) return []

  const versionIds = rows.map((r) => r.current_version_id).filter((id): id is string => Boolean(id))
  const versionsById = new Map<string, EmailTemplateVersion>()
  if (versionIds.length > 0) {
    const { data: versions } = await supabase
      .from("email_template_versions")
      .select("*")
      .in("id", versionIds)
    for (const v of (versions ?? []) as any[]) versionsById.set(v.id, mapVersion(v))
  }

  const { data: defaults } = await supabase.from("email_template_defaults").select("template_id")
  const defaultTemplateIds = new Set((defaults ?? []).map((d: any) => d.template_id))

  // Mapeia POR TEMPLATE com guarda: uma linha malformada (ex.: um seed gravado
  // direto no banco, como o template de cobrança da VMAX com dados do débito) NÃO
  // pode derrubar a listagem inteira — pula-se a linha problemática e o painel
  // segue de pé com os demais templates.
  const out: EmailTemplateWithVersion[] = []
  for (const row of rows) {
    try {
      out.push({
        template: mapTemplate(row),
        currentVersion: row.current_version_id ? versionsById.get(row.current_version_id) ?? null : null,
        isDefault: defaultTemplateIds.has(row.id),
      })
    } catch (e) {
      console.warn(`[email/templates] linha ignorada na listagem (id=${row?.id ?? "?"}): ${e instanceof Error ? e.message : "erro"}`)
    }
  }
  return out
}

export async function getTemplate(
  supabase: ServiceClient,
  templateId: string,
): Promise<EmailTemplateWithVersion | null> {
  const { data: row, error } = await supabase.from("email_templates").select("*").eq("id", templateId).maybeSingle()
  if (error) throw new Error(`Falha ao carregar template: ${error.message}`)
  if (!row) return null

  let currentVersion: EmailTemplateVersion | null = null
  if (row.current_version_id) {
    const { data: v } = await supabase
      .from("email_template_versions")
      .select("*")
      .eq("id", row.current_version_id)
      .maybeSingle()
    if (v) currentVersion = mapVersion(v)
  }
  const { data: def } = await supabase
    .from("email_template_defaults")
    .select("template_id")
    .eq("template_id", templateId)
    .maybeSingle()

  return { template: mapTemplate(row), currentVersion, isDefault: Boolean(def) }
}

export async function listVersions(
  supabase: ServiceClient,
  templateId: string,
): Promise<EmailTemplateVersion[]> {
  const { data, error } = await supabase
    .from("email_template_versions")
    .select("*")
    .eq("template_id", templateId)
    .order("version", { ascending: false })
  if (error) throw new Error(`Falha ao listar versões: ${error.message}`)
  return ((data ?? []) as any[]).map(mapVersion)
}

async function nextVersionNumber(supabase: ServiceClient, templateId: string): Promise<number> {
  const { data } = await supabase
    .from("email_template_versions")
    .select("version")
    .eq("template_id", templateId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle()
  return ((data?.version as number | undefined) ?? 0) + 1
}

// ------- escrita -------

export interface WriteResult {
  ok: boolean
  validation?: TemplateValidationResult
  template?: EmailTemplate
  version?: EmailTemplateVersion
  error?: string
}

/** Cria um template NOVO + sua versão 1. Valida antes de gravar. */
export async function createTemplate(
  supabase: ServiceClient,
  input: TemplateInput,
  actorId: string | null,
): Promise<WriteResult> {
  const validation = validateTemplateInput(input)
  if (!validation.ok || !validation.sanitized) return { ok: false, validation }

  const companyId = input.scope === "global" ? null : input.companyId

  const { data: tRow, error: tErr } = await supabase
    .from("email_templates")
    .insert({
      company_id: companyId,
      name: input.name.trim(),
      purpose: input.purpose,
      allow_debt_fields: input.allowDebtFields === true,
      status: "draft",
      created_by: actorId,
    })
    .select("*")
    .single()

  if (tErr) {
    // 23505 = unique_violation (nome duplicado no escopo).
    if ((tErr as any).code === "23505") {
      return { ok: false, error: "Já existe um template com esse nome neste escopo." }
    }
    return { ok: false, error: `Falha ao criar template: ${tErr.message}` }
  }

  const s = validation.sanitized
  const { data: vRow, error: vErr } = await supabase
    .from("email_template_versions")
    .insert({
      template_id: tRow.id,
      version: 1,
      subject: s.subject,
      preheader: s.preheader || null,
      html: s.html,
      text_fallback: s.textFallback || null,
      variables_used: s.variablesUsed,
      created_by: actorId,
    })
    .select("*")
    .single()

  if (vErr) return { ok: false, error: `Falha ao criar versão: ${vErr.message}` }

  await supabase
    .from("email_templates")
    .update({ current_version_id: vRow.id, updated_at: new Date().toISOString() })
    .eq("id", tRow.id)

  return {
    ok: true,
    validation,
    template: { ...mapTemplate(tRow), currentVersionId: vRow.id },
    version: mapVersion(vRow),
  }
}

/**
 * Edita um template existente: metadados no template + NOVA versão imutável
 * (nunca sobrescreve a atual). Valida antes de gravar.
 */
export async function updateTemplate(
  supabase: ServiceClient,
  templateId: string,
  input: TemplateInput,
  actorId: string | null,
): Promise<WriteResult> {
  const validation = validateTemplateInput(input)
  if (!validation.ok || !validation.sanitized) return { ok: false, validation }

  const { data: existing, error: exErr } = await supabase
    .from("email_templates")
    .select("*")
    .eq("id", templateId)
    .maybeSingle()
  if (exErr) return { ok: false, error: `Falha ao carregar template: ${exErr.message}` }
  if (!existing) return { ok: false, error: "Template não encontrado." }
  if (existing.status === "archived") return { ok: false, error: "Não é possível editar um template arquivado." }

  const companyId = input.scope === "global" ? null : input.companyId
  const s = validation.sanitized
  const version = await nextVersionNumber(supabase, templateId)

  const { data: vRow, error: vErr } = await supabase
    .from("email_template_versions")
    .insert({
      template_id: templateId,
      version,
      subject: s.subject,
      preheader: s.preheader || null,
      html: s.html,
      text_fallback: s.textFallback || null,
      variables_used: s.variablesUsed,
      created_by: actorId,
    })
    .select("*")
    .single()
  if (vErr) return { ok: false, error: `Falha ao criar versão: ${vErr.message}` }

  const { data: tRow, error: tErr } = await supabase
    .from("email_templates")
    .update({
      name: input.name.trim(),
      purpose: input.purpose,
      allow_debt_fields: input.allowDebtFields === true,
      company_id: companyId,
      current_version_id: vRow.id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", templateId)
    .select("*")
    .single()
  if (tErr) {
    if ((tErr as any).code === "23505") {
      return { ok: false, error: "Já existe um template com esse nome neste escopo." }
    }
    return { ok: false, error: `Falha ao atualizar template: ${tErr.message}` }
  }

  return { ok: true, validation, template: mapTemplate(tRow), version: mapVersion(vRow) }
}

/**
 * Duplica um template (com a versão corrente vira a versão 1 do novo). O nome
 * ganha sufixo " (cópia)" e o status volta a draft.
 */
export async function duplicateTemplate(
  supabase: ServiceClient,
  templateId: string,
  actorId: string | null,
): Promise<WriteResult> {
  const current = await getTemplate(supabase, templateId)
  if (!current) return { ok: false, error: "Template não encontrado." }
  const v = current.currentVersion
  if (!v) return { ok: false, error: "Template sem versão para duplicar." }

  const input: TemplateInput = {
    name: `${current.template.name} (cópia)`,
    scope: current.template.companyId ? "company" : "global",
    companyId: current.template.companyId,
    purpose: current.template.purpose,
    allowDebtFields: current.template.allowDebtFields,
    subject: v.subject,
    preheader: v.preheader ?? "",
    html: v.html,
    textFallback: v.textFallback ?? "",
  }
  return createTemplate(supabase, input, actorId)
}

/**
 * Restaura uma versão antiga: cria uma NOVA versão com o conteúdo dela e aponta
 * current_version_id (a versão antiga permanece intacta no histórico).
 */
export async function restoreVersion(
  supabase: ServiceClient,
  templateId: string,
  versionId: string,
  actorId: string | null,
): Promise<WriteResult> {
  const { data: src, error } = await supabase
    .from("email_template_versions")
    .select("*")
    .eq("id", versionId)
    .eq("template_id", templateId)
    .maybeSingle()
  if (error) return { ok: false, error: `Falha ao carregar versão: ${error.message}` }
  if (!src) return { ok: false, error: "Versão não encontrada." }

  const { data: template } = await supabase.from("email_templates").select("*").eq("id", templateId).maybeSingle()
  if (!template) return { ok: false, error: "Template não encontrado." }

  const input: TemplateInput = {
    name: template.name,
    scope: template.company_id ? "company" : "global",
    companyId: template.company_id ?? null,
    purpose: template.purpose,
    allowDebtFields: template.allow_debt_fields === true,
    subject: src.subject,
    preheader: src.preheader ?? "",
    html: src.html,
    textFallback: src.text_fallback ?? "",
  }
  return updateTemplate(supabase, templateId, input, actorId)
}

/** Muda o status (active/archived/draft). Arquivar ≠ apagar. */
export async function setStatus(
  supabase: ServiceClient,
  templateId: string,
  status: "draft" | "active" | "archived",
): Promise<{ ok: boolean; error?: string }> {
  const { error } = await supabase
    .from("email_templates")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", templateId)
  if (error) return { ok: false, error: `Falha ao alterar status: ${error.message}` }
  return { ok: true }
}

/** Define o template padrão de um cedente para um propósito (upsert 1-por-par). */
export async function setDefault(
  supabase: ServiceClient,
  companyId: string,
  templateId: string,
  purpose: TemplatePurpose,
  actorId: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const { error } = await supabase
    .from("email_template_defaults")
    .upsert(
      { company_id: companyId, template_id: templateId, purpose, updated_by: actorId, updated_at: new Date().toISOString() },
      { onConflict: "company_id,purpose" },
    )
  if (error) return { ok: false, error: `Falha ao definir padrão: ${error.message}` }
  return { ok: true }
}
