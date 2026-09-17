// Tokens do link seguro /c/{token}: 32 bytes aleatórios, SÓ o hash persiste,
// TTL por tenant, max_uses contra compartilhamento massivo, revogação.
// Reutiliza os primitivos de lib/negotiation/crypto.ts.

import { randomBytes } from "node:crypto"
import { createServiceClient } from "@/lib/supabase/service"
import { sha256Hex } from "@/lib/negotiation/crypto"

export type TokenPurpose = "consult" | "optout" | "block"

export interface CreateAccessTokenInput {
  companyId: string
  customerId: string
  debtIds: string[]
  campaignId?: string | null
  messageId?: string | null
  ttlHours: number
  maxUses?: number
  createdBy?: "campaign" | "admin" | "system"
  purpose?: TokenPurpose
}

export interface CreatedAccessToken {
  id: string
  token: string // em claro, retornado UMA vez (vai para a URL); nunca persistido
  expiresAt: string
}

export async function createAccessToken(input: CreateAccessTokenInput): Promise<CreatedAccessToken> {
  const supabase = createServiceClient()
  const token = randomBytes(32).toString("base64url")
  const expiresAt = new Date(Date.now() + input.ttlHours * 3600_000).toISOString()
  const { data, error } = await supabase
    .from("chat_access_tokens")
    .insert({
      company_id: input.companyId,
      customer_id: input.customerId,
      debt_ids: input.debtIds,
      campaign_id: input.campaignId ?? null,
      message_id: input.messageId ?? null,
      token_hash: sha256Hex(token),
      expires_at: expiresAt,
      max_uses: input.maxUses ?? 20,
      created_by: input.createdBy ?? "campaign",
      purpose: input.purpose ?? "consult",
    })
    .select("id")
    .single()
  if (error) throw new Error(`createAccessToken: ${error.message}`)
  return { id: data.id, token, expiresAt }
}

export interface IssueActionTokensInput {
  companyId: string
  customerId: string
  debtIds: string[]
  campaignId?: string | null
  messageId?: string | null
  ttlHours: number
}

export interface ActionTokens {
  consult: CreatedAccessToken
  optout: CreatedAccessToken
  block: CreatedAccessToken
}

/**
 * Emite os TRÊS tokens de ação do link único (V2/V4): consulta, opt-out e
 * bloqueio. Cada um é um token próprio, de uso único para as ações destrutivas
 * (max_uses=1), sem PII. Os valores em claro nunca descansam no banco (só hash).
 */
export async function issueActionTokens(input: IssueActionTokensInput): Promise<ActionTokens> {
  const [consult, optout, block] = await Promise.all([
    createAccessToken({
      companyId: input.companyId,
      customerId: input.customerId,
      debtIds: input.debtIds,
      campaignId: input.campaignId ?? null,
      messageId: input.messageId ?? null,
      ttlHours: input.ttlHours,
      createdBy: "campaign",
      purpose: "consult",
    }),
    createAccessToken({
      companyId: input.companyId,
      customerId: input.customerId,
      debtIds: input.debtIds,
      campaignId: input.campaignId ?? null,
      messageId: input.messageId ?? null,
      ttlHours: input.ttlHours,
      maxUses: 1,
      createdBy: "campaign",
      purpose: "optout",
    }),
    createAccessToken({
      companyId: input.companyId,
      customerId: input.customerId,
      debtIds: input.debtIds,
      campaignId: input.campaignId ?? null,
      messageId: input.messageId ?? null,
      ttlHours: input.ttlHours,
      maxUses: 1,
      createdBy: "campaign",
      purpose: "block",
    }),
  ])
  return { consult, optout, block }
}

export type TokenValidation =
  | { ok: true; tokenRow: AccessTokenRow }
  | { ok: false; reason: "not_found" | "expired" | "revoked" | "exhausted" }

export interface AccessTokenRow {
  id: string
  company_id: string
  customer_id: string
  debt_ids: string[]
  campaign_id: string | null
  message_id: string | null
  expires_at: string
  max_uses: number
  use_count: number
  first_opened_at: string | null
  revoked_at: string | null
  purpose?: TokenPurpose
  consumed_at?: string | null
}

/** Valida o token em claro; NÃO incrementa uso (ver consumeOpen). */
export async function validateToken(token: string): Promise<TokenValidation> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from("chat_access_tokens")
    .select("id, company_id, customer_id, debt_ids, campaign_id, message_id, expires_at, max_uses, use_count, first_opened_at, revoked_at, purpose, consumed_at")
    .eq("token_hash", sha256Hex(token))
    .maybeSingle()
  if (error || !data) return { ok: false, reason: "not_found" }
  if (data.revoked_at) return { ok: false, reason: "revoked" }
  if (new Date(data.expires_at).getTime() < Date.now()) return { ok: false, reason: "expired" }
  if (data.use_count >= data.max_uses) return { ok: false, reason: "exhausted" }
  return { ok: true, tokenRow: data as AccessTokenRow }
}

/**
 * Valida um token de AÇÃO (opt-out/bloqueio): confere o purpose esperado e que
 * ainda não foi consumido. NÃO marca consumo (isso é atômico no POST).
 */
export async function validateActionToken(
  token: string,
  expectedPurpose: TokenPurpose,
): Promise<TokenValidation> {
  const tv = await validateToken(token)
  if (!tv.ok) return tv
  if ((tv.tokenRow.purpose ?? "consult") !== expectedPurpose) return { ok: false, reason: "not_found" }
  if (tv.tokenRow.consumed_at) return { ok: false, reason: "exhausted" }
  return tv
}

/**
 * Consome um token de ação (uso único). Marca consumed_at só se ainda estava
 * nulo (guard contra corrida / prefetch). Retorna true se ESTA chamada consumiu.
 */
export async function consumeActionToken(tokenId: string): Promise<boolean> {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from("chat_access_tokens")
    .update({ consumed_at: new Date().toISOString(), use_count: 1 })
    .eq("id", tokenId)
    .is("consumed_at", null)
    .select("id")
  return (data?.length ?? 0) > 0
}

/** Registra uma abertura (use_count++, first/last_opened_at). */
export async function consumeOpen(tokenId: string): Promise<void> {
  const supabase = createServiceClient()
  const now = new Date().toISOString()
  const { data } = await supabase
    .from("chat_access_tokens")
    .select("use_count, first_opened_at")
    .eq("id", tokenId)
    .single()
  await supabase
    .from("chat_access_tokens")
    .update({
      use_count: (data?.use_count ?? 0) + 1,
      last_opened_at: now,
      first_opened_at: data?.first_opened_at ?? now,
    })
    .eq("id", tokenId)
}

export async function revokeTokens(filter: {
  companyId: string
  customerId?: string
  debtId?: string
  reason: string
}): Promise<number> {
  const supabase = createServiceClient()
  let q = supabase
    .from("chat_access_tokens")
    .update({ revoked_at: new Date().toISOString(), revoke_reason: filter.reason })
    .is("revoked_at", null)
    .eq("company_id", filter.companyId)
  if (filter.customerId) q = q.eq("customer_id", filter.customerId)
  if (filter.debtId) q = q.contains("debt_ids", [filter.debtId])
  const { data, error } = await q.select("id")
  if (error) throw new Error(`revokeTokens: ${error.message}`)
  return data?.length ?? 0
}
