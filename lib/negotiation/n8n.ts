// Integração n8n ⇄ chatbot de negociação.
//
// Segurança do webhook inbound: HMAC-SHA256 de `${timestamp}.${corpo}` com
// N8N_WEBHOOK_SECRET (headers x-alteapay-signature / x-alteapay-timestamp),
// janela de ±300s contra replay e comparação em tempo constante. Os callbacks
// outbound (modo async) são assinados com o MESMO esquema, para o fluxo n8n
// validar a origem. Idempotência por event_id e cache do resultado do turno
// ficam no Redis do cluster (mesma env REDIS_URL das filas).

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto"
import IORedis from "ioredis"

export const N8N_SIGNATURE_HEADER = "x-alteapay-signature"
export const N8N_TIMESTAMP_HEADER = "x-alteapay-timestamp"
export const N8N_EVENT_ID_HEADER = "x-alteapay-event-id"
export const N8N_TIMESTAMP_TOLERANCE_SECONDS = 300

export function n8nWebhookSecret(): string {
  return process.env.N8N_WEBHOOK_SECRET || ""
}

/** Assinatura HMAC-SHA256 de `${timestamp}.${rawBody}` — usada nos dois sentidos. */
export function signN8nPayload(rawBody: string, timestamp: string, secret: string = n8nWebhookSecret()): string {
  return "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex")
}

// ---------------------------------------------------------------------------
// Papel A (plataforma → n8n): Basic Auth em TODA chamada de saída.
//
// O n8n Webhook trigger fica atrás de HTTP Basic Auth. As credenciais vêm
// SEMPRE de process.env (N8N_BASIC_AUTH_USER / N8N_BASIC_AUTH_PASSWORD) e o
// header Authorization NUNCA é logado (redigir em qualquer diagnóstico).
// Usamos Buffer(...,'utf8') — não btoa — para suportar credenciais não-ASCII.

/**
 * Monta o header `Authorization: Basic <base64(user:password)>` a partir de
 * process.env. Retorna `null` quando as credenciais não estão configuradas —
 * o chamador decide se envia sem Basic Auth (n8n sem auth) ou degrada.
 * NUNCA logar o valor de retorno.
 */
export function n8nBasicAuthHeader(): string | null {
  const user = process.env.N8N_BASIC_AUTH_USER
  const password = process.env.N8N_BASIC_AUTH_PASSWORD
  if (!user && !password) return null
  const token = Buffer.from(`${user ?? ""}:${password ?? ""}`, "utf8").toString("base64")
  return `Basic ${token}`
}

/**
 * Cabeçalhos de UMA chamada de saída papel A (chat.turn / negotiation.start /
 * ping). Assina o corpo EXATO (`rawBody`) com o mesmo esquema HMAC do inbound,
 * adiciona o timestamp, um Event-Id único (idempotência do lado do fluxo) e,
 * quando configurado, o Basic Auth.
 *
 * O `rawBody` recebido DEVE ser a string exatamente enviada como corpo do POST
 * (não re-serializar): a assinatura cobre byte-a-byte o que trafega.
 */
export interface N8nOutboundHeaders {
  headers: Record<string, string>
  timestamp: string
  eventId: string
}

/** Novo Event-Id (uuid v4) para uma chamada de saída papel A. */
export function newEventId(): string {
  return randomUUID()
}

export function buildN8nOutboundHeaders(rawBody: string, eventId: string = newEventId()): N8nOutboundHeaders {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    [N8N_SIGNATURE_HEADER]: signN8nPayload(rawBody, timestamp),
    [N8N_TIMESTAMP_HEADER]: timestamp,
    [N8N_EVENT_ID_HEADER]: eventId,
  }
  const auth = n8nBasicAuthHeader()
  if (auth) headers["Authorization"] = auth
  return { headers, timestamp, eventId }
}

/**
 * Redige o header Authorization (e afins) de um objeto de headers para log.
 * Defensivo: usado apenas se algum diagnóstico precisar imprimir headers — o
 * valor real de credencial/segredo NUNCA pode aparecer em log.
 */
export function redactHeadersForLog(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    out[k] = /^authorization$/i.test(k) ? "[REDACTED]" : v
  }
  return out
}

export type N8nVerifyResult = { ok: true } | { ok: false; status: number; reason: string }

export function verifyN8nRequest(
  rawBody: string,
  signatureHeader: string | null,
  timestampHeader: string | null,
  nowMs: number = Date.now(),
): N8nVerifyResult {
  const secret = n8nWebhookSecret()
  if (!secret) return { ok: false, status: 503, reason: "N8N_WEBHOOK_SECRET não configurado" }
  if (!signatureHeader?.startsWith("sha256=") || !timestampHeader) {
    return { ok: false, status: 401, reason: "assinatura ou timestamp ausentes" }
  }
  const ts = Number(timestampHeader)
  if (!Number.isInteger(ts) || Math.abs(nowMs / 1000 - ts) > N8N_TIMESTAMP_TOLERANCE_SECONDS) {
    return { ok: false, status: 401, reason: "timestamp fora da janela" }
  }
  const expected = Buffer.from(
    signN8nPayload(rawBody, timestampHeader, secret).slice("sha256=".length),
    "hex",
  )
  const provided = Buffer.from(signatureHeader.slice("sha256=".length), "hex")
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, status: 401, reason: "assinatura inválida" }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Idempotência e cache de resultado (Redis, fail-open como o rate-limit)

let redisClient: IORedis | null = null
function redis(): IORedis {
  if (!redisClient) {
    const url = process.env.REDIS_URL || "redis://localhost:6379"
    redisClient = new IORedis(url, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
      lazyConnect: true,
      ...(url.startsWith("rediss://") ? { tls: {} } : {}),
    })
    redisClient.on("error", (err) => console.warn("[negotiation:n8n] redis error:", err.message))
  }
  return redisClient
}

const EVENT_SEEN_TTL_SECONDS = 24 * 3600
const RESULT_CACHE_TTL_SECONDS = 3600

/** Marca o event_id como visto; retorna false se já tinha sido processado. */
export async function markEventSeen(eventId: string): Promise<boolean> {
  try {
    const res = await redis().set(`neg:n8n:evt:${eventId}`, "1", "EX", EVENT_SEEN_TTL_SECONDS, "NX")
    return res === "OK"
  } catch {
    return true
  }
}

/** Cache do resultado do turno: retries de callback não re-executam o LLM. */
export async function cacheTurnResult(key: string, result: unknown): Promise<void> {
  try {
    await redis().set(`neg:n8n:res:${key}`, JSON.stringify(result), "EX", RESULT_CACHE_TTL_SECONDS)
  } catch {
    /* melhor esforço */
  }
}

export async function getCachedTurnResult<T>(key: string): Promise<T | null> {
  try {
    const raw = await redis().get(`neg:n8n:res:${key}`)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

// O turno server-side vive em lib/negotiation/turn.ts (runChatbotTurn), que
// chama o engine (fluxo n8n por padrão; agente legado por env). Este módulo
// fica restrito a segurança e idempotência para não criar ciclo de imports
// com o engine.
