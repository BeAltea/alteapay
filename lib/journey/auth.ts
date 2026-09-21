// Autenticação do devedor no link seguro (D10): CPF completo (DOB opcional por
// tenant), 3 erros → lock, resposta SEMPRE genérica com timing equalizado.
// Sucesso cria/reabre a negotiation_session e emite o cookie JWT existente.

import { createHash } from "node:crypto"
import { createServiceClient } from "@/lib/supabase/service"
import { signChatJwt, CHAT_COOKIE_NAME } from "@/lib/negotiation/crypto"
import { createHandoffSession, loadTenantConfig } from "@/lib/negotiation/sessions"
import { recordEvent } from "./events"
import { bootstrapAckSafe } from "./acknowledgement"
import type { AccessTokenRow } from "./tokens"

export const GENERIC_AUTH_MESSAGE =
  "Não foi possível confirmar seus dados. Verifique e tente novamente."

const onlyDigits = (s: string) => s.replace(/\D/g, "")
const docHash = (doc: string) => createHash("sha256").update(onlyDigits(doc)).digest("hex")
const ipHash = (ip: string | null) =>
  ip ? createHash("sha256").update(ip).digest("hex").slice(0, 32) : null

export function isValidCpfCnpj(d: string): boolean {
  if (/^(\d)\1+$/.test(d)) return false
  if (d.length === 11) {
    const calc = (n: number) => {
      let s = 0
      for (let i = 0; i < n; i++) s += Number(d[i]) * (n + 1 - i)
      const r = (s * 10) % 11
      return r === 10 ? 0 : r
    }
    return calc(9) === Number(d[9]) && calc(10) === Number(d[10])
  }
  if (d.length === 14) {
    const w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
    const w2 = [6, ...w1]
    const calc = (w: number[]) => {
      const s = w.reduce((a, x, i) => a + x * Number(d[i]), 0)
      const r = 11 - (s % 11)
      return r >= 10 ? 0 : r
    }
    return calc(w1) === Number(d[12]) && calc(w2) === Number(d[13])
  }
  return false
}

export interface AuthenticateInput {
  tokenRow: AccessTokenRow
  document: string
  birthDate?: string | null // YYYY-MM-DD
  ip?: string | null
  userAgent?: string | null
  consent: boolean
}

export type AuthenticateResult =
  | { ok: true; sessionId: string; cookieName: string; cookieValue: string; cookieMaxAge: number }
  | { ok: false; message: string }

async function isLocked(supabase: ReturnType<typeof createServiceClient>, tokenId: string, dHash: string): Promise<boolean> {
  const now = new Date().toISOString()
  const { data } = await supabase
    .from("chat_auth_locks")
    .select("id, doc_hash")
    .eq("access_token_id", tokenId)
    .gt("locked_until", now)
    .limit(10)
  return (data ?? []).some((l) => l.doc_hash === null || l.doc_hash === dHash)
}

async function registerFailure(
  supabase: ReturnType<typeof createServiceClient>,
  tokenRow: AccessTokenRow,
  dHash: string,
  ip: string | null,
  reason: string,
  maxAttempts: number,
  lockMinutes: number,
): Promise<void> {
  await supabase.from("chat_auth_attempts").insert({
    company_id: tokenRow.company_id,
    access_token_id: tokenRow.id,
    doc_hash: dHash,
    ip_hash: ipHash(ip ?? null),
    success: false,
    failure_reason: reason, // interno; NUNCA vai para o cliente
  })
  const windowStart = new Date(Date.now() - lockMinutes * 60_000).toISOString()
  const { data: fails } = await supabase
    .from("chat_auth_attempts")
    .select("id, doc_hash")
    .eq("access_token_id", tokenRow.id)
    .eq("success", false)
    .gte("created_at", windowStart)
  const total = fails?.length ?? 0
  const sameDoc = (fails ?? []).filter((f) => f.doc_hash === dHash).length
  if (sameDoc >= maxAttempts || total >= maxAttempts * 2) {
    const lockedUntil = new Date(Date.now() + lockMinutes * 60_000).toISOString()
    await supabase.from("chat_auth_locks").insert({
      company_id: tokenRow.company_id,
      access_token_id: tokenRow.id,
      doc_hash: sameDoc >= maxAttempts ? dHash : null,
      locked_until: lockedUntil,
      reason: sameDoc >= maxAttempts ? "doc_attempts" : "token_attempts",
    })
    await recordEvent({
      companyId: tokenRow.company_id, customerId: tokenRow.customer_id,
      type: "auth.locked", actor: "system",
      payload: { scope: sameDoc >= maxAttempts ? "doc" : "token" },
    })
  }
  await recordEvent({
    companyId: tokenRow.company_id, customerId: tokenRow.customer_id,
    type: "auth.failed", actor: "customer", payload: {},
  })
}

/** Executa a autenticação. O CHAMADOR aplica o padding de tempo (route). */
export async function authenticateDebtor(input: AuthenticateInput): Promise<AuthenticateResult> {
  const supabase = createServiceClient()
  const tokenRow = input.tokenRow
  const doc = onlyDigits(input.document)
  const dHash = docHash(doc)
  const fail = async (reason: string): Promise<AuthenticateResult> => {
    await registerFailure(supabase, tokenRow, dHash, input.ip ?? null, reason,
      cfg?.auth_max_attempts ?? 3, cfg?.auth_lock_minutes ?? 30)
    return { ok: false, message: GENERIC_AUTH_MESSAGE }
  }

  const { data: cfg } = await supabase
    .from("tenant_chat_config")
    .select("auth_require_birth_date, auth_max_attempts, auth_lock_minutes, session_ttl_minutes, fulfillment_mode")
    .eq("company_id", tokenRow.company_id)
    .maybeSingle()

  await recordEvent({
    companyId: tokenRow.company_id, customerId: tokenRow.customer_id,
    type: "auth.attempt", actor: "customer", payload: {},
  })

  if (await isLocked(supabase, tokenRow.id, dHash)) {
    // mesma mensagem, mesmo fluxo (sem revelar lock)
    return { ok: false, message: GENERIC_AUTH_MESSAGE }
  }
  if (!input.consent) return fail("consent_missing")
  if (!isValidCpfCnpj(doc)) return fail("doc_invalid_dv")

  const { data: customer } = await supabase
    .from("customers")
    .select("id, document, birth_date, name")
    .eq("id", tokenRow.customer_id)
    .single()
  if (!customer || onlyDigits(customer.document ?? "") !== doc) return fail("doc_mismatch")

  if (cfg?.auth_require_birth_date) {
    if (!customer.birth_date) return fail("birth_date_missing")
    if (!input.birthDate || input.birthDate !== customer.birth_date) return fail("birth_date_mismatch")
  }

  // sucesso
  await supabase.from("chat_auth_attempts").insert({
    company_id: tokenRow.company_id,
    access_token_id: tokenRow.id,
    doc_hash: dHash,
    ip_hash: ipHash(input.ip ?? null),
    success: true,
  })

  // sessão: reaproveita aberta do mesmo cliente/dívida ou cria via helper existente
  const debtId = tokenRow.debt_ids?.[0] ?? null
  const { data: openSession } = await supabase
    .from("negotiation_sessions")
    .select("id")
    .eq("company_id", tokenRow.company_id)
    .eq("customer_id", tokenRow.customer_id)
    .eq("outcome", "in_progress")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  let sessionId: string
  if (openSession) {
    sessionId = openSession.id
    await supabase.from("negotiation_sessions").update({
      identity_verified_at: new Date().toISOString(),
      consent_lgpd_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", sessionId)
  } else {
    const created = await createHandoffSession({
      company_id: tokenRow.company_id,
      customer_id: tokenRow.customer_id,
      debt_id: debtId,
      document: doc,
      channel_origin: "direct",
      identity_verified: true,
      debt_acknowledged: false,
    })
    sessionId = created.session.id
    await supabase.from("negotiation_sessions").update({
      consent_lgpd_at: new Date().toISOString(),
      consent_lgpd_version: "journey-v1",
      user_agent: input.userAgent ?? null,
      ip_hash: ipHash(input.ip ?? null),
    }).eq("id", sessionId)
  }

  await recordEvent({
    companyId: tokenRow.company_id, customerId: tokenRow.customer_id, debtId,
    sessionId, type: "consent.given", actor: "customer",
    payload: { version: "journey-v1" },
  })
  await recordEvent({
    companyId: tokenRow.company_id, customerId: tokenRow.customer_id, debtId,
    sessionId, type: "auth.success", actor: "customer",
  })
  await recordEvent({
    companyId: tokenRow.company_id, customerId: tokenRow.customer_id, debtId,
    sessionId, type: "session.started", actor: "system",
  })

  // onda R: reconhecimento da dívida é a 1ª interação (determinístico, local).
  const debtIds = (tokenRow.debt_ids?.length ? tokenRow.debt_ids : debtId ? [debtId] : []) as string[]
  await bootstrapAckSafe({
    companyId: tokenRow.company_id,
    sessionId,
    customerId: tokenRow.customer_id,
    debtIds,
    primaryDebtId: debtId,
  })

  const ttlSeconds = (cfg?.session_ttl_minutes ?? 60) * 60
  const cookieValue = signChatJwt({ sid: sessionId, cid: tokenRow.company_id }, ttlSeconds)
  return {
    ok: true, sessionId,
    cookieName: CHAT_COOKIE_NAME, cookieValue, cookieMaxAge: ttlSeconds,
  }
}
