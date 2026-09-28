// Rate limit do POST /api/webhooks/n8n (N8N-12).
//
// Problema: o limite era 120/min por IP, e o "IP" é o salto de proxy da Netlify
// (comum a todo mundo) ou, na melhor hipótese, o IP único do n8n. Com o N8N-13
// o fluxo faz 3–6 callbacks assinados por turno (flow.context, offer.list,
// payment.create, chat.send, flow.state.set) → 429 a ~20 turnos/min no total.
//
// Desenho:
//   1. PRÉ-AUTH (só requisições SEM assinatura válida): balde barato por IP
//      confiável ou, sem IP confiável, um balde comum. Tráfego assinado NUNCA
//      consome esse balde, então lixo/forja não derruba o n8n legítimo.
//   2. PÓS-AUTH (HMAC conferido): limite pela IDENTIDADE autenticada:
//        - por sessão  (N8N_RL_SESSION_PER_MIN, default 60) — as ações flow.*
//          ficam de fora: já têm o limite por sessão do N8N-13
//          (n8n:flow:s:*, 60/min), não dobramos;
//        - por cedente (N8N_RL_COMPANY_PER_MIN, default 3000);
//        - sem sessão nem cedente (ping): N8N_RL_SIGNED_MISC_PER_MIN (default 300).
//   3. N8N_RATE_LIMIT_MODE=legacy → volta ao 120/min por IP de antes (rollback).
//
// Mesma infraestrutura (`rateLimit`, Redis, janela fixa, fail-open).

import { resolveClientIp, trustedClientIpEnabled, type HeaderReader } from "@/lib/http/client-ip"
import { rateLimit } from "@/lib/negotiation/rate-limit"

type Env = Record<string, string | undefined>

const WINDOW_SECONDS = 60

function intEnv(env: Env, name: string, def: number): number {
  const n = Number(env[name])
  return Number.isInteger(n) && n > 0 ? n : def
}

export function n8nRateLimitConfig(env: Env = process.env) {
  return {
    mode: env.N8N_RATE_LIMIT_MODE === "legacy" ? ("legacy" as const) : ("identity" as const),
    legacyIpPerMin: intEnv(env, "N8N_RL_LEGACY_IP_PER_MIN", 120),
    unsignedPerMin: intEnv(env, "N8N_RL_UNSIGNED_PER_MIN", 60),
    sessionPerMin: intEnv(env, "N8N_RL_SESSION_PER_MIN", 60),
    companyPerMin: intEnv(env, "N8N_RL_COMPANY_PER_MIN", 3000),
    signedMiscPerMin: intEnv(env, "N8N_RL_SIGNED_MISC_PER_MIN", 300),
  }
}

/** Telemetria do 429: só a dimensão (nunca IP/sessão em claro). */
function denied(scope: NonNullable<N8nLimitVerdict["scope"]>): N8nLimitVerdict {
  console.warn("[n8n:rate-limit] 429", { scope })
  return { allowed: false, scope }
}

/** Ações que já têm limite por sessão próprio na rota (N8N-13). */
const OWN_SESSION_LIMIT = new Set(["flow.context", "flow.state.set"])

export interface N8nLimitVerdict {
  allowed: boolean
  /** Dimensão que estourou (para log/diagnóstico; nunca PII). */
  scope?: "unsigned" | "ip" | "session" | "company" | "signed_misc"
}

/**
 * Pré-auth: chamado SÓ quando a assinatura NÃO confere (ou falta). Conta a
 * requisição inválida e devolve allowed=false quando o balde estoura (→ 429,
 * antes de qualquer parse/DB). Legacy: sem limite próprio (hoje o inválido
 * volta 401 sem contar).
 */
export async function n8nUnsignedAllowed(headers: HeaderReader, env: Env = process.env): Promise<N8nLimitVerdict> {
  const cfg = n8nRateLimitConfig(env)
  if (cfg.mode === "legacy") return { allowed: true }
  // Só IP de fonte CONFIÁVEL abre balde próprio: no legacy o "IP" é o salto de
  // proxy (comum a todos) ou um XFF que o atacante troca a cada requisição.
  const ip = trustedClientIpEnabled(env) ? resolveClientIp(headers, env) : null
  const r = await rateLimit(`n8n:bad:${ip ?? "global"}`, cfg.unsignedPerMin, WINDOW_SECONDS)
  return r.allowed ? { allowed: true } : denied("unsigned")
}

// Cache sessão → cedente por instância (o cedente de uma sessão nunca muda).
const COMPANY_CACHE_MAX = 5000
const companyCache = new Map<string, string>()

export type CompanyLookup = (sessionId: string) => Promise<string | null>

async function defaultCompanyLookup(sessionId: string): Promise<string | null> {
  const { createServiceClient } = await import("@/lib/supabase/service")
  const { data } = await createServiceClient()
    .from("negotiation_sessions")
    .select("company_id")
    .eq("id", sessionId)
    .maybeSingle()
  return (data as { company_id?: string } | null)?.company_id ?? null
}

async function companyForSession(sessionId: string, lookup: CompanyLookup): Promise<string | null> {
  const hit = companyCache.get(sessionId)
  if (hit) return hit
  try {
    const companyId = await lookup(sessionId)
    if (companyId) {
      if (companyCache.size >= COMPANY_CACHE_MAX) {
        const oldest = companyCache.keys().next().value
        if (oldest !== undefined) companyCache.delete(oldest)
      }
      companyCache.set(sessionId, companyId)
    }
    return companyId
  } catch {
    // Fail-open como o próprio rateLimit: sem cedente, a dimensão não entra.
    return null
  }
}

/** Só para testes. */
export function __resetN8nRateLimitCache(): void {
  companyCache.clear()
}

/**
 * Pós-auth (HMAC conferido): limite pela identidade autenticada do corpo.
 * `body` é o corpo já validado pelo zod da rota (action/session_id/company_id).
 */
export async function n8nSignedAllowed(
  body: { action: string; session_id?: string; company_id?: string },
  headers: HeaderReader,
  opts: { env?: Env; lookupCompany?: CompanyLookup } = {},
): Promise<N8nLimitVerdict> {
  const env = opts.env ?? process.env
  const cfg = n8nRateLimitConfig(env)

  if (cfg.mode === "legacy") {
    const ip = resolveClientIp(headers, env) ?? "unknown"
    const r = await rateLimit(`n8n:ip:${ip}`, cfg.legacyIpPerMin, WINDOW_SECONDS)
    return r.allowed ? { allowed: true } : denied("ip")
  }

  const sessionId = typeof body.session_id === "string" ? body.session_id : null
  let companyId = typeof body.company_id === "string" ? body.company_id : null

  if (sessionId && !OWN_SESSION_LIMIT.has(body.action)) {
    const r = await rateLimit(`n8n:s:${sessionId}`, cfg.sessionPerMin, WINDOW_SECONDS)
    if (!r.allowed) return denied("session")
  }
  if (!companyId && sessionId) {
    companyId = await companyForSession(sessionId, opts.lookupCompany ?? defaultCompanyLookup)
  }
  if (companyId) {
    const r = await rateLimit(`n8n:c:${companyId}`, cfg.companyPerMin, WINDOW_SECONDS)
    return r.allowed ? { allowed: true } : denied("company")
  }
  if (!sessionId) {
    const r = await rateLimit("n8n:signed:misc", cfg.signedMiscPerMin, WINDOW_SECONDS)
    return r.allowed ? { allowed: true } : denied("signed_misc")
  }
  return { allowed: true }
}
