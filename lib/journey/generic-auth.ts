// Autenticação genérica por documento (N1, endpoint /t/{slug}/negociar).
//
// Diferente de lib/journey/auth.ts (que autentica DENTRO de um token de
// campanha /c/{token}), aqui não há token: o cliente informa só o documento e o
// servidor resolve quem é (resolver.ts) no company_id do slug.
//
// Mitigações §3 (TODAS obrigatórias):
//   3. Resposta uniforme: inexistente, sem-dívida e bloqueado devolvem a MESMA
//      mensagem, MESMO status e timing equalizado (o padding fica na rota).
//   4. Lock em 2 dimensões INDEPENDENTES: por IP (5 tent/10min → 30min) E por
//      documento (3 erros → 30min). Durável em chat_auth_generic_* (service role).
//   5. Nada antes de autenticar (a rota não expõe valor/credor/faturas).
//   6. Auditoria de toda tentativa com doc_hash + ip_hash (NUNCA o documento).
//   7. Captcha atrás de flag (verifyCaptcha; default OFF).
//   nada é revelado por caminho: sucesso e falha só diferem no cookie.

import { createHash } from "node:crypto"
import { createServiceClient } from "@/lib/supabase/service"
import { signChatJwt, CHAT_COOKIE_NAME } from "@/lib/negotiation/crypto"
import { recordEvent } from "./events"
import { GENERIC_AUTH_MESSAGE } from "./auth"
import { isAcceptableDocument, normalizeDocument } from "./document"
import { resolveByDocument } from "./resolver"

export { GENERIC_AUTH_MESSAGE }

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex")
const docHash = (doc: string) => sha256(normalizeDocument(doc))
const ipHash = (ip: string | null) => (ip ? sha256(ip).slice(0, 32) : null)

// Defaults do §3.4 (podem ser sobrepostos por env). Lidos em tempo de chamada
// para respeitar a configuração por deploy (e permitir testes determinísticos).
const ipMaxAttempts = () => Number(process.env.CHAT_AUTH_IP_MAX_ATTEMPTS || "5")
const ipWindowMin = () => Number(process.env.CHAT_AUTH_IP_WINDOW_MIN || "10")
const IP_LOCK_MIN = 30
const DOC_MAX_ATTEMPTS_DEFAULT = 3
const DOC_LOCK_MIN_DEFAULT = 30

export interface GenericAuthInput {
  companyId: string
  document: string
  consent: boolean
  ip: string | null
  userAgent: string | null
  captchaToken?: string | null
  channel: "web_generic" | "admin_preview"
}

export type GenericAuthResult =
  | { ok: true; sessionId: string; cookieName: string; cookieValue: string; cookieMaxAge: number }
  | { ok: false; message: string }

type Supabase = ReturnType<typeof createServiceClient>

/** Verificação de captcha (Turnstile) atrás de flag. OFF → sempre passa. */
export async function verifyCaptcha(token: string | null | undefined): Promise<boolean> {
  if (process.env.CHAT_CAPTCHA_ENABLED !== "true") return true
  const provider = process.env.CHAT_CAPTCHA_PROVIDER || "turnstile"
  const secret = process.env.CHAT_CAPTCHA_SECRET
  if (!token || !secret) return false
  if (provider !== "turnstile") return false
  try {
    const resp = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret, response: token }),
      signal: AbortSignal.timeout(5000),
    })
    const json = (await resp.json()) as { success?: boolean }
    return Boolean(json.success)
  } catch {
    return false
  }
}

async function isIpLocked(supabase: Supabase, companyId: string, ipH: string | null): Promise<boolean> {
  if (!ipH) return false
  const { data } = await supabase
    .from("chat_auth_generic_locks")
    .select("id")
    .eq("company_id", companyId)
    .eq("scope", "ip")
    .eq("key_hash", ipH)
    .gt("locked_until", new Date().toISOString())
    .limit(1)
  return (data?.length ?? 0) > 0
}

async function isDocLocked(supabase: Supabase, companyId: string, dHash: string): Promise<boolean> {
  const { data } = await supabase
    .from("chat_auth_generic_locks")
    .select("id")
    .eq("company_id", companyId)
    .eq("scope", "document")
    .eq("key_hash", dHash)
    .gt("locked_until", new Date().toISOString())
    .limit(1)
  return (data?.length ?? 0) > 0
}

async function recordAttempt(
  supabase: Supabase,
  companyId: string,
  dHash: string,
  ipH: string | null,
  success: boolean,
  reason: string | null,
): Promise<void> {
  await supabase.from("chat_auth_generic_attempts").insert({
    company_id: companyId,
    doc_hash: dHash,
    ip_hash: ipH,
    success,
    failure_reason: reason, // interno; NUNCA vai ao cliente
  })
}

/** Conta falhas na janela e cria lock durável se estourar o limite da dimensão. */
async function maybeLock(
  supabase: Supabase,
  companyId: string,
  scope: "ip" | "document",
  keyHash: string,
  windowMin: number,
  maxAttempts: number,
  lockMin: number,
): Promise<void> {
  const since = new Date(Date.now() - windowMin * 60_000).toISOString()
  const column = scope === "ip" ? "ip_hash" : "doc_hash"
  const { data } = await supabase
    .from("chat_auth_generic_attempts")
    .select("id")
    .eq("company_id", companyId)
    .eq(column, keyHash)
    .eq("success", false)
    .gte("created_at", since)
  if ((data?.length ?? 0) >= maxAttempts) {
    await supabase.from("chat_auth_generic_locks").insert({
      company_id: companyId,
      scope,
      key_hash: keyHash,
      locked_until: new Date(Date.now() + lockMin * 60_000).toISOString(),
      reason: `${scope}_attempts`,
    })
  }
}

/**
 * Autentica por documento no tenant. O CHAMADOR (rota) equaliza o timing.
 * NUNCA revela por que falhou: qualquer falha → GENERIC_AUTH_MESSAGE.
 */
export async function authenticateByDocument(input: GenericAuthInput): Promise<GenericAuthResult> {
  const supabase = createServiceClient()
  const doc = normalizeDocument(input.document)
  const dHash = docHash(doc)
  const ipH = ipHash(input.ip)

  const { data: cfg } = await supabase
    .from("tenant_chat_config")
    .select("auth_max_attempts, auth_lock_minutes, session_ttl_minutes")
    .eq("company_id", input.companyId)
    .maybeSingle()
  const docMax = cfg?.auth_max_attempts ?? DOC_MAX_ATTEMPTS_DEFAULT
  const docLockMin = cfg?.auth_lock_minutes ?? DOC_LOCK_MIN_DEFAULT

  await recordEvent({ companyId: input.companyId, type: "auth.attempt", actor: "customer", payload: {} })

  // fail: registra tentativa, avalia locks das DUAS dimensões, devolve uniforme.
  const fail = async (reason: string): Promise<GenericAuthResult> => {
    await recordAttempt(supabase, input.companyId, dHash, ipH, false, reason)
    await maybeLock(supabase, input.companyId, "document", dHash, docLockMin, docMax, docLockMin)
    if (ipH) await maybeLock(supabase, input.companyId, "ip", ipH, ipWindowMin(), ipMaxAttempts(), IP_LOCK_MIN)
    await recordEvent({ companyId: input.companyId, type: "auth.failed", actor: "customer", payload: {} })
    return { ok: false, message: GENERIC_AUTH_MESSAGE }
  }

  // Locks são checados PRIMEIRO e retornam a MESMA resposta uniforme (sem
  // revelar o bloqueio) — mas sem contabilizar nova tentativa/lock.
  if (await isIpLocked(supabase, input.companyId, ipH)) return { ok: false, message: GENERIC_AUTH_MESSAGE }
  if (await isDocLocked(supabase, input.companyId, dHash)) return { ok: false, message: GENERIC_AUTH_MESSAGE }

  // captcha (se flag) — falha vira resposta uniforme, contabiliza.
  if (!(await verifyCaptcha(input.captchaToken))) return fail("captcha_failed")
  if (!input.consent) return fail("consent_missing")
  if (!isAcceptableDocument(doc)) return fail("doc_invalid")

  const resolved = await resolveByDocument({ companyId: input.companyId, document: doc })
  if (!resolved) {
    // inexistente OU só-VMAX-sem-customers OU sem dívida aberta: mesma resposta.
    // auth.unresolved é auditoria interna (não distingue os casos para o cliente).
    await recordEvent({ companyId: input.companyId, type: "auth.failed", actor: "customer", payload: { reason: "unresolved" } })
    return fail("unresolved")
  }

  // sucesso: sessão consolidada (todas as dívidas abertas) via handoff helper.
  await recordAttempt(supabase, input.companyId, dHash, ipH, true, null)
  const { createHandoffSession } = await import("@/lib/negotiation/sessions")
  const created = await createHandoffSession({
    company_id: input.companyId,
    customer_id: resolved.customerId,
    debt_id: resolved.primaryDebtId,
    document: doc,
    channel_origin: "direct",
    identity_verified: true,
    debt_acknowledged: false,
  })
  const sessionId = created.session.id
  const now = new Date().toISOString()
  await supabase.from("negotiation_sessions").update({
    debt_ids: resolved.debtIds,
    primary_debt_id: resolved.primaryDebtId,
    channel: input.channel,
    status: "open",
    engine: process.env.NEGOTIATION_ENGINE || "disabled",
    consent_lgpd_at: now,
    consent_lgpd_version: "journey-v1",
    consent_at: now,
    last_activity_at: now,
    user_agent: input.userAgent,
    ip_hash: ipH,
  }).eq("id", sessionId)

  const base = { companyId: input.companyId, customerId: resolved.customerId, debtId: resolved.primaryDebtId, sessionId }
  await recordEvent({ ...base, type: "consent.given", actor: "customer", payload: { version: "journey-v1" } })
  await recordEvent({ ...base, type: "auth.success", actor: "customer" })
  await recordEvent({ ...base, type: "session.started", actor: "system", payload: { channel: input.channel } })

  const ttlSeconds = (cfg?.session_ttl_minutes ?? 60) * 60
  const cookieValue = signChatJwt({ sid: sessionId, cid: input.companyId }, ttlSeconds)
  return { ok: true, sessionId, cookieName: CHAT_COOKIE_NAME, cookieValue, cookieMaxAge: ttlSeconds }
}
