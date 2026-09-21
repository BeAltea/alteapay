// Perfil de contato materializado por devedor (trilha T1).
//
// `contact_profile` classifica o devedor pelos canais disponíveis:
//   'mobile'      → só celular E.164 válido
//   'email_only'  → só e-mail válido
//   'both'        → celular E.164 válido E e-mail válido
//   'none'        → nenhum canal utilizável
//
// A normalização de telefone REUSA toE164Mobile de campaigns.ts — nunca
// reescrita aqui (E.164 BR, 9º dígito, DDD 11-99). O e-mail passa por um regex
// conservador + rejeição de placeholders/domínio interno. Nada de PII em log.

import { createServiceClient } from "@/lib/supabase/service"
import { toE164Mobile } from "@/lib/journey/campaigns"

export type ContactProfile = "mobile" | "email_only" | "both" | "none"

// Placeholders comuns de importação do cedente que NÃO são e-mails reais.
const EMAIL_PLACEHOLDER_PREFIXES = ["naotem", "sememail", "sem@", "nao@"]
// Domínios internos/placeholder que nunca representam contato real do devedor.
const EMAIL_INTERNAL_DOMAINS = [
  "vmax",
  "alteapay",
  "placeholder",
  "example",
  "invalid",
  "local",
  "localhost",
]
// Regex conservador: local@dominio.tld (tld com 2+ letras).
const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/

/** E-mail utilizável: sintaxe válida, não placeholder, não domínio interno. */
export function isEmailValid(email: string | null | undefined): boolean {
  const e = (email ?? "").trim().toLowerCase()
  if (e === "") return false
  if (EMAIL_PLACEHOLDER_PREFIXES.some((p) => e.startsWith(p))) return false
  if (!EMAIL_RE.test(e)) return false
  const domain = e.slice(e.indexOf("@") + 1)
  const label = domain.split(".")[0]
  if (EMAIL_INTERNAL_DOMAINS.includes(label)) return false
  return true
}

export interface DeriveContactProfileInput {
  phone?: string | null
  vmaxPhone1?: string | null
  vmaxPhone2?: string | null
  email?: string | null
}

/**
 * Deriva o perfil de contato. Telefone: customers.phone primeiro; se não gerar
 * celular E.164 válido, tenta o fallback VMAX (Telefone 1, depois Telefone 2).
 */
export function deriveContactProfile(input: DeriveContactProfileInput): ContactProfile {
  const mobile =
    toE164Mobile(input.phone) ??
    toE164Mobile(input.vmaxPhone1) ??
    toE164Mobile(input.vmaxPhone2)
  const hasMobile = mobile !== null
  const hasEmail = isEmailValid(input.email)
  if (hasMobile && hasEmail) return "both"
  if (hasMobile) return "mobile"
  if (hasEmail) return "email_only"
  return "none"
}

const PAGE_SIZE = 1000

interface CustomerRow {
  id: string
  phone: string | null
  email: string | null
  document: string | null
  mobile_e164: string | null
  email_valid: boolean | null
  contact_profile: string | null
}

/**
 * Recomputa mobile_e164/email_valid/contact_profile em lote para uma empresa.
 * Usa customers.phone com fallback VMAX (Telefone 1/2, isolado por id_company),
 * casando por documento normalizado. Idempotente: só grava linhas que mudaram.
 * Retorna { scanned, updated }. Nunca loga telefone/e-mail/documento.
 */
export async function recomputeContactProfile(
  companyId: string,
): Promise<{ scanned: number; updated: number }> {
  const supabase = createServiceClient()

  // Mapa doc-normalizado → celular do fallback VMAX (Telefone 1, senão Telefone 2).
  const vmaxByDoc = new Map<string, string>()
  {
    let page = 0
    for (;;) {
      const { data, error } = await (supabase as any)
        .from("VMAX")
        .select('"CPF/CNPJ", "Telefone 1", "Telefone 2"')
        .eq("id_company", companyId)
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
      if (error) throw new Error(`recomputeContactProfile(VMAX): ${error.message}`)
      const rows = (data ?? []) as Array<Record<string, string | null>>
      for (const r of rows) {
        const doc = (r["CPF/CNPJ"] ?? "").replace(/\D/g, "")
        if (!doc) continue
        const mobile = toE164Mobile(r["Telefone 1"]) ?? toE164Mobile(r["Telefone 2"])
        if (mobile && !vmaxByDoc.has(doc)) vmaxByDoc.set(doc, mobile)
      }
      if (rows.length < PAGE_SIZE) break
      page++
    }
  }

  let scanned = 0
  let updated = 0
  let page = 0
  for (;;) {
    const { data, error } = await (supabase as any)
      .from("customers")
      .select("id, phone, email, document, mobile_e164, email_valid, contact_profile")
      .eq("company_id", companyId)
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
    if (error) throw new Error(`recomputeContactProfile(customers): ${error.message}`)
    const rows = (data ?? []) as CustomerRow[]
    for (const c of rows) {
      scanned++
      const docKey = (c.document ?? "").replace(/\D/g, "")
      const vmaxFallback = docKey ? vmaxByDoc.get(docKey) ?? null : null
      const mobile = toE164Mobile(c.phone) ?? vmaxFallback
      const emailValid = isEmailValid(c.email)
      const profile = deriveContactProfile({
        phone: c.phone,
        // fallback já resolvido acima; passa vazio p/ não recomputar
        vmaxPhone1: vmaxFallback,
        email: c.email,
      })
      if (
        c.mobile_e164 === mobile &&
        c.email_valid === emailValid &&
        c.contact_profile === profile
      ) {
        continue
      }
      const { error: upErr } = await (supabase as any)
        .from("customers")
        .update({ mobile_e164: mobile, email_valid: emailValid, contact_profile: profile })
        .eq("id", c.id)
        .eq("company_id", companyId)
      if (upErr) throw new Error(`recomputeContactProfile(update): ${upErr.message}`)
      updated++
    }
    if (rows.length < PAGE_SIZE) break
    page++
  }

  return { scanned, updated }
}
