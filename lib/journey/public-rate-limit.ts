// Rate-limit do LINK ÚNICO público /n/{code} (§3 do Hub). TRÊS dimensões
// independentes, todas duráveis e sem PII em claro (só hashes):
//
//   1. IP        — PUBLIC_AUTH_IP_MAX_ATTEMPTS falhas / PUBLIC_AUTH_IP_WINDOW_MIN
//                  → lock progressivo 10 → 30 → 60 min (reincidência sobe o degrau).
//   2. DOCUMENTO — mesmo limite por doc_hash (bloqueio por documento).
//   3. CEDENTE/hora — teto de tentativas por company/hora
//                  (PUBLIC_AUTH_TENANT_HOURLY_CAP). Acima → modo DEGRADADO
//                  (a rota exige captcha + espera) + evento de alerta.
//
// Persistência reaproveita chat_auth_generic_attempts/locks (service role, RLS
// fecha o select ao painel). As tentativas do link público são marcadas com
// failure_reason prefixado `nlink:` para telemetria; o teto por hora conta TODAS
// as tentativas do tenant (sucesso incluso) na janela — é um teto de VOLUME, não
// de erro.
//
// Este módulo NÃO decide auth: só mede e bloqueia. O chamador (generic-auth /
// route) invoca na ORDEM exata: captcha → IP → documento → teto do cedente.

import { createHash } from "node:crypto"
import { createServiceClient } from "@/lib/supabase/service"
import { normalizeDocument } from "./document"

type Supabase = ReturnType<typeof createServiceClient>

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex")
export const docHashOf = (doc: string) => sha256(normalizeDocument(doc))
export const ipHashOf = (ip: string | null | undefined) =>
  ip ? sha256(ip).slice(0, 32) : null

// Marcador de canal nas tentativas do link público (isola do /t/ genérico).
const NLINK_PREFIX = "nlink:"

// Defaults do §3 (env sobrepõe; lidos em tempo de chamada p/ testes/deploy).
const ipMaxAttempts = () => Number(process.env.PUBLIC_AUTH_IP_MAX_ATTEMPTS || "5")
const ipWindowMin = () => Number(process.env.PUBLIC_AUTH_IP_WINDOW_MIN || "10")
const docMaxAttempts = () =>
  Number(process.env.PUBLIC_AUTH_DOC_MAX_ATTEMPTS || process.env.PUBLIC_AUTH_IP_MAX_ATTEMPTS || "5")
const docWindowMin = () =>
  Number(process.env.PUBLIC_AUTH_DOC_WINDOW_MIN || process.env.PUBLIC_AUTH_IP_WINDOW_MIN || "10")
const tenantHourlyCap = () => Number(process.env.PUBLIC_AUTH_TENANT_HOURLY_CAP || "300")

// Bloqueio progressivo: 1ª vez 10min, 2ª 30min, 3ª+ 60min (por dimensão/chave).
const PROGRESSIVE_LOCK_MIN = [10, 30, 60] as const

function lockMinutesForCount(priorLocks: number): number {
  const idx = Math.min(priorLocks, PROGRESSIVE_LOCK_MIN.length - 1)
  return PROGRESSIVE_LOCK_MIN[idx]
}

/** true se existe lock ativo para a chave (ip/doc) do tenant. */
async function isLocked(
  supabase: Supabase,
  companyId: string,
  scope: "ip" | "document",
  keyHash: string | null,
): Promise<boolean> {
  if (!keyHash) return false
  const { data } = await supabase
    .from("chat_auth_generic_locks")
    .select("id")
    .eq("company_id", companyId)
    .eq("scope", scope)
    .eq("key_hash", keyHash)
    .gt("locked_until", new Date().toISOString())
    .limit(1)
  return (data?.length ?? 0) > 0
}

/** Conta falhas do link público na janela para uma dimensão. */
async function countFailuresInWindow(
  supabase: Supabase,
  companyId: string,
  column: "ip_hash" | "doc_hash",
  keyHash: string,
  windowMin: number,
): Promise<number> {
  const since = new Date(Date.now() - windowMin * 60_000).toISOString()
  const { data } = await supabase
    .from("chat_auth_generic_attempts")
    .select("id, failure_reason")
    .eq("company_id", companyId)
    .eq(column, keyHash)
    .eq("success", false)
    .gte("created_at", since)
  // Só as do link público (failure_reason prefixado). Sucesso não conta.
  return (data ?? []).filter((r) => String(r.failure_reason ?? "").startsWith(NLINK_PREFIX)).length
}

/** Nº de locks já criados para a chave (base do degrau progressivo). */
async function priorLockCount(
  supabase: Supabase,
  companyId: string,
  scope: "ip" | "document",
  keyHash: string,
): Promise<number> {
  const { data } = await supabase
    .from("chat_auth_generic_locks")
    .select("id")
    .eq("company_id", companyId)
    .eq("scope", scope)
    .eq("key_hash", keyHash)
  return data?.length ?? 0
}

async function createLock(
  supabase: Supabase,
  companyId: string,
  scope: "ip" | "document",
  keyHash: string,
  lockMin: number,
): Promise<void> {
  await supabase.from("chat_auth_generic_locks").insert({
    company_id: companyId,
    scope,
    key_hash: keyHash,
    locked_until: new Date(Date.now() + lockMin * 60_000).toISOString(),
    reason: `${NLINK_PREFIX}${scope}_rate`,
  })
}

export interface RegisterAttemptInput {
  companyId: string
  docHash: string
  ipHash: string | null
  success: boolean
  reason: string // interno (auditoria); NUNCA vai ao cliente
}

/** Registra uma tentativa do link público (auditoria). Marca sempre com o
 *  prefixo do canal para o rate-limit e o teto por hora isolarem o /n/. */
export async function registerPublicAttempt(input: RegisterAttemptInput): Promise<void> {
  const supabase = createServiceClient()
  await supabase.from("chat_auth_generic_attempts").insert({
    company_id: input.companyId,
    doc_hash: input.docHash,
    ip_hash: input.ipHash,
    success: input.success,
    failure_reason: `${NLINK_PREFIX}${input.reason}`,
  })
}

export type RateLimitDecision =
  | { blocked: false; degraded: boolean }
  | { blocked: true; scope: "ip" | "document"; degraded: boolean }

/**
 * Avalia as três dimensões ANTES de tentar autenticar. Só LÊ estado de lock e
 * teto (não conta esta tentativa; a contagem/lock acontece em `onFailure`).
 * `degraded` = teto do cedente/hora estourado → a rota deve exigir captcha+espera.
 */
export async function evaluatePublicRateLimit(input: {
  companyId: string
  docHash: string
  ipHash: string | null
}): Promise<RateLimitDecision> {
  const supabase = createServiceClient()

  // 1) IP lock
  if (await isLocked(supabase, input.companyId, "ip", input.ipHash)) {
    return { blocked: true, scope: "ip", degraded: false }
  }
  // 2) documento lock
  if (await isLocked(supabase, input.companyId, "document", input.docHash)) {
    return { blocked: true, scope: "document", degraded: false }
  }
  // 3) teto do cedente/hora → não bloqueia, mas liga o modo degradado.
  const degraded = await isTenantOverHourlyCap(supabase, input.companyId)
  return { blocked: false, degraded }
}

/** true se o tenant estourou o teto de tentativas/hora (VOLUME, sucesso incluso). */
export async function isTenantOverHourlyCap(
  supabase: Supabase,
  companyId: string,
): Promise<boolean> {
  const since = new Date(Date.now() - 60 * 60_000).toISOString()
  const { data } = await supabase
    .from("chat_auth_generic_attempts")
    .select("id, failure_reason")
    .eq("company_id", companyId)
    .gte("created_at", since)
  const total = (data ?? []).filter((r) =>
    String(r.failure_reason ?? "").startsWith(NLINK_PREFIX),
  ).length
  return total >= tenantHourlyCap()
}

/**
 * Após uma FALHA de auth, contabiliza e cria lock progressivo se a janela
 * estourar — nas duas dimensões (IP e documento) INDEPENDENTES. A tentativa em
 * si já foi registrada por `registerPublicAttempt`.
 */
export async function onPublicFailure(input: {
  companyId: string
  docHash: string
  ipHash: string | null
}): Promise<void> {
  const supabase = createServiceClient()

  // documento
  const docFails = await countFailuresInWindow(
    supabase, input.companyId, "doc_hash", input.docHash, docWindowMin(),
  )
  if (docFails >= docMaxAttempts()) {
    const prior = await priorLockCount(supabase, input.companyId, "document", input.docHash)
    await createLock(supabase, input.companyId, "document", input.docHash, lockMinutesForCount(prior))
  }

  // IP (só se houver ip_hash)
  if (input.ipHash) {
    const ipFails = await countFailuresInWindow(
      supabase, input.companyId, "ip_hash", input.ipHash, ipWindowMin(),
    )
    if (ipFails >= ipMaxAttempts()) {
      const prior = await priorLockCount(supabase, input.companyId, "ip", input.ipHash)
      await createLock(supabase, input.companyId, "ip", input.ipHash, lockMinutesForCount(prior))
    }
  }
}
