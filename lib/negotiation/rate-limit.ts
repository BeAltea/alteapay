// Rate limiting de janela fixa no Redis do cluster (mesma env REDIS_URL das
// filas BullMQ). Fail-open somente registrado: se o Redis cair, o chat não cai.

import IORedis from "ioredis"

let client: IORedis | null = null

function redis(): IORedis {
  if (!client) {
    const url = process.env.REDIS_URL || "redis://localhost:6379"
    client = new IORedis(url, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
      lazyConnect: true,
      ...(url.startsWith("rediss://") ? { tls: {} } : {}),
    })
    client.on("error", (err) => console.warn("[negotiation:rate-limit] redis error:", err.message))
  }
  return client
}

export interface RateLimitResult {
  allowed: boolean
  remaining: number
}

/**
 * Janela fixa: até `limit` hits por `windowSeconds` para a chave dada.
 * Chaves por IP e por sessão são compostas pelo chamador.
 */
export async function rateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
  try {
    const redisKey = `neg:rl:${key}:${Math.floor(Date.now() / 1000 / windowSeconds)}`
    const count = await redis().incr(redisKey)
    if (count === 1) await redis().expire(redisKey, windowSeconds)
    return { allowed: count <= limit, remaining: Math.max(0, limit - count) }
  } catch {
    return { allowed: true, remaining: limit }
  }
}

export const LIMITS = {
  resolvePerIp: { limit: 10, windowSeconds: 60 },
  messagePerSession: { limit: 20, windowSeconds: 60 },
  messagePerIp: { limit: 40, windowSeconds: 60 },
} as const
