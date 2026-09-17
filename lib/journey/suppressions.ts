// Supressões de contato: opt-out, bloqueio, pago, disputa, atendimento humano.
// TODO caminho de envio (campanha, sendWhatsApp, notificador) consulta
// isSuppressed antes de enfileirar. Escrita idempotente (não duplica ativa).

import { createHash } from "node:crypto"
import { createServiceClient } from "@/lib/supabase/service"

export type SuppressionChannel = "whatsapp" | "sms" | "email" | "all"
export type SuppressionReason = "optout" | "blocked" | "paid" | "dispute" | "human" | "manual" | "legal"
export type SuppressionSource = "voxuy" | "chat" | "webhook" | "admin" | "system"
export type SuppressionScope = "phone" | "customer" | "debt"

export const docHash = (doc: string) =>
  createHash("sha256").update(doc.replace(/\D/g, "")).digest("hex")

export interface IsSuppressedInput {
  companyId: string
  channel: SuppressionChannel
  phoneE164?: string | null
  customerId?: string | null
  debtId?: string | null
}

/** true se QUALQUER supressão ativa (da empresa ou global) cobre o alvo/canal. */
export async function isSuppressed(input: IsSuppressedInput): Promise<boolean> {
  const supabase = createServiceClient()
  const ors: string[] = []
  if (input.phoneE164) ors.push(`phone_e164.eq.${input.phoneE164}`)
  if (input.customerId) ors.push(`customer_id.eq.${input.customerId}`)
  if (input.debtId) ors.push(`debt_id.eq.${input.debtId}`)
  if (ors.length === 0) return false
  const { data, error } = await supabase
    .from("contact_suppressions")
    .select("id, channel, expires_at, company_id")
    .eq("active", true)
    .in("channel", [input.channel, "all"])
    .or(ors.join(","))
    .limit(20)
  if (error) {
    // fail-closed: em erro de leitura, tratamos como suprimido (não enviar é
    // sempre o lado seguro de uma cobrança)
    console.error("[journey] isSuppressed erro (fail-closed):", error.message)
    return true
  }
  const now = Date.now()
  return (data ?? []).some((s) => {
    const companyOk = s.company_id === null || s.company_id === input.companyId
    const notExpired = !s.expires_at || new Date(s.expires_at).getTime() > now
    return companyOk && notExpired
  })
}

export interface AddSuppressionInput {
  companyId: string | null // null = global
  scope: SuppressionScope
  phoneE164?: string | null
  customerId?: string | null
  debtId?: string | null
  document?: string | null
  channel: SuppressionChannel
  reason: SuppressionReason
  source: SuppressionSource
  expiresAt?: string | null
  metadata?: Record<string, unknown>
}

export async function addSuppression(input: AddSuppressionInput): Promise<{ ok: boolean; id?: string }> {
  const supabase = createServiceClient()
  // idempotência prática: não duplicar supressão ativa idêntica
  let dup = supabase
    .from("contact_suppressions")
    .select("id")
    .eq("active", true)
    .eq("scope", input.scope)
    .eq("channel", input.channel)
    .eq("reason", input.reason)
    .limit(1)
  if (input.companyId) dup = dup.eq("company_id", input.companyId)
  else dup = dup.is("company_id", null)
  if (input.phoneE164) dup = dup.eq("phone_e164", input.phoneE164)
  if (input.customerId) dup = dup.eq("customer_id", input.customerId)
  if (input.debtId) dup = dup.eq("debt_id", input.debtId)
  const { data: existing } = await dup
  if (existing && existing.length > 0) return { ok: true, id: existing[0].id }

  const { data, error } = await supabase
    .from("contact_suppressions")
    .insert({
      company_id: input.companyId,
      scope: input.scope,
      phone_e164: input.phoneE164 ?? null,
      customer_id: input.customerId ?? null,
      debt_id: input.debtId ?? null,
      doc_hash: input.document ? docHash(input.document) : null,
      channel: input.channel,
      reason: input.reason,
      source: input.source,
      expires_at: input.expiresAt ?? null,
      metadata: input.metadata ?? {},
    })
    .select("id")
    .single()
  if (error) {
    console.error("[journey] addSuppression falhou:", error.message)
    return { ok: false }
  }
  return { ok: true, id: data.id }
}

/** Desativa supressões (ex.: caso humano resolvido). */
export async function deactivateSuppressions(filter: {
  companyId: string
  customerId?: string
  debtId?: string
  reason?: SuppressionReason
}): Promise<number> {
  const supabase = createServiceClient()
  let q = supabase
    .from("contact_suppressions")
    .update({ active: false })
    .eq("active", true)
    .eq("company_id", filter.companyId)
  if (filter.customerId) q = q.eq("customer_id", filter.customerId)
  if (filter.debtId) q = q.eq("debt_id", filter.debtId)
  if (filter.reason) q = q.eq("reason", filter.reason)
  const { data, error } = await q.select("id")
  if (error) throw new Error(`deactivateSuppressions: ${error.message}`)
  return data?.length ?? 0
}
