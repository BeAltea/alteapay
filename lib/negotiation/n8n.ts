// Integração n8n ⇄ chatbot de negociação.
//
// Segurança do webhook inbound: HMAC-SHA256 de `${timestamp}.${corpo}` com
// N8N_WEBHOOK_SECRET (headers x-alteapay-signature / x-alteapay-timestamp),
// janela de ±300s contra replay e comparação em tempo constante. Os callbacks
// outbound (modo async) são assinados com o MESMO esquema, para o fluxo n8n
// validar a origem.
//
// Rotação sem downtime (N8N-4): o inbound aceita também N8N_WEBHOOK_SECRET_PREVIOUS
// (opcional) enquanto o n8n ainda assina com o segredo antigo; o outbound assina
// SEMPRE e só com o atual. Nenhum segredo, header Authorization ou URL de fluxo
// vai para log, erro ou payload persistido. Idempotência por event_id e cache do resultado do turno
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

/**
 * Segredo ANTERIOR, aceito só na verificação inbound durante a janela de rotação.
 * Vazio (padrão) = rotação desligada. Igual ao atual = ignorado. Nunca usado para
 * assinar.
 */
export function n8nWebhookSecretPrevious(): string {
  const previous = process.env.N8N_WEBHOOK_SECRET_PREVIOUS || ""
  return previous && previous !== n8nWebhookSecret() ? previous : ""
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

function originOf(url: string | null | undefined): string | null {
  if (!url || !url.trim()) return null
  try {
    return new URL(url.trim()).origin
  } catch {
    return null
  }
}

/**
 * true quando `url` está na MESMA origem (esquema+host+porta) de um fluxo n8n
 * configurado por env (N8N_CHAT_FLOW_URL / N8N_EVENT_FLOW_URL /
 * N8N_SESSION_FLOW_URL). Usado para decidir se o Basic Auth pode ir junto numa
 * URL que não veio de env (ex.: callback_url informado pelo próprio fluxo).
 */
export function isConfiguredN8nOrigin(url: string): boolean {
  const target = originOf(url)
  if (!target) return false
  return [process.env.N8N_CHAT_FLOW_URL, process.env.N8N_EVENT_FLOW_URL, process.env.N8N_SESSION_FLOW_URL]
    .map(originOf)
    .some((o) => o === target)
}

/**
 * `callback_url` do modo assíncrono (`session.message` mode=async) aceito SÓ no
 * host n8n configurado (mesma origem de um fluxo por env). A URL chega no corpo
 * de uma chamada; sem esta regra a plataforma postaria um corpo assinado para
 * qualquer destino. Também recusa URL com usuário/senha embutidos. Checado no
 * route (422) e de novo no worker, antes de rodar o turno e sem enviar nada.
 */
export function isAllowedN8nCallbackUrl(url: string | null | undefined): boolean {
  if (!url || !url.trim()) return false
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    return false
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false
  if (parsed.username || parsed.password) return false
  return isConfiguredN8nOrigin(parsed.href)
}

/**
 * Cabeçalhos do callback do modo assíncrono (worker alteapay-n8n → callback_url
 * do fluxo). Mesmo esquema do papel A (HMAC + timestamp + Event-Id + Basic),
 * para o Webhook do n8n que recebe o callback poder exigir autenticação (N8N-5).
 * O Basic Auth SÓ vai quando o callback_url está no host n8n configurado: a URL
 * vem do corpo de uma chamada, e credencial nunca segue para host desconhecido.
 */
export function buildN8nCallbackHeaders(callbackUrl: string, rawBody: string, eventId: string): N8nOutboundHeaders {
  const out = buildN8nOutboundHeaders(rawBody, eventId)
  if (!isConfiguredN8nOrigin(callbackUrl)) delete out.headers["Authorization"]
  return out
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

/** Qual segredo validou a assinatura — só o rótulo, nunca o valor. */
export type N8nSecretSlot = "current" | "previous"

export type N8nVerifyResult = { ok: true; matched: N8nSecretSlot } | { ok: false; status: number; reason: string }

function hmacDigest(rawBody: string, timestamp: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest()
}

function digestEquals(provided: Buffer, expected: Buffer): boolean {
  return provided.length === expected.length && timingSafeEqual(provided, expected)
}

/**
 * Verifica a assinatura inbound contra N8N_WEBHOOK_SECRET e, se configurado,
 * N8N_WEBHOOK_SECRET_PREVIOUS. As duas comparações rodam SEMPRE (tempo constante
 * e sem revelar pelo tempo qual segredo casou). Aceite pelo anterior é logado
 * com o rótulo `previous` — sinal de que o n8n ainda não trocou de credencial.
 */
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
  const provided = Buffer.from(signatureHeader.slice("sha256=".length), "hex")
  const previous = n8nWebhookSecretPrevious()
  const matchesCurrent = digestEquals(provided, hmacDigest(rawBody, timestampHeader, secret))
  // Sem rotação, compara contra um segredo descartável para manter o custo igual.
  const matchesPrevious = digestEquals(provided, hmacDigest(rawBody, timestampHeader, previous || secret + "\0")) && !!previous
  if (matchesCurrent) return { ok: true, matched: "current" }
  if (matchesPrevious) {
    console.warn("[negotiation:n8n] assinatura aceita pelo segredo anterior (N8N_WEBHOOK_SECRET_PREVIOUS); rotação em curso")
    return { ok: true, matched: "previous" }
  }
  return { ok: false, status: 401, reason: "assinatura inválida" }
}

/**
 * Remove de um texto (erro de rede, corpo de resposta do n8n) qualquer valor
 * sensível da integração: os segredos HMAC, as credenciais Basic (em claro e em
 * base64) e a URL/caminho dos fluxos n8n. O n8n devolve o caminho do webhook em
 * erros 404 ("The requested webhook \"POST <caminho>\" is not registered") —
 * e o caminho É o segredo de acesso ao fluxo.
 */
export function scrubN8nSecrets(text: string, extraUrls: Array<string | null | undefined> = []): string {
  const values = new Set<string>()
  const add = (v: string | null | undefined) => {
    if (v && v.length >= 6) values.add(v)
  }
  add(process.env.N8N_WEBHOOK_SECRET)
  add(process.env.N8N_WEBHOOK_SECRET_PREVIOUS)
  add(process.env.N8N_BASIC_AUTH_PASSWORD)
  const basic = n8nBasicAuthHeader()
  if (basic) add(basic.slice("Basic ".length))
  for (const raw of [
    process.env.N8N_CHAT_FLOW_URL,
    process.env.N8N_EVENT_FLOW_URL,
    process.env.N8N_SESSION_FLOW_URL,
    ...extraUrls,
  ]) {
    if (!raw) continue
    add(raw)
    try {
      const u = new URL(raw)
      add(u.pathname.length > 1 ? u.pathname : null)
      for (const seg of u.pathname.split("/")) if (seg.length >= 12) add(seg)
    } catch {
      /* não é URL: já foi adicionado inteiro */
    }
  }
  let out = text
  // mais longos primeiro: a URL inteira antes do caminho, o caminho antes do segmento.
  for (const v of [...values].sort((a, b) => b.length - a.length)) out = out.split(v).join("[REDACTED]")
  return out.replace(/Basic\s+[A-Za-z0-9+/]{8,}={0,2}/g, "Basic [REDACTED]")
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
