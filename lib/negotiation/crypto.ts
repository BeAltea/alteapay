// Primitivas de token do chatbot: token de handoff opaco (só o hash persiste)
// e JWT HS256 curto para o cookie de sessão de chat. Sem dependências externas.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex")
}

export function generateHandoffToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("hex")
  return { token, tokenHash: sha256Hex(token) }
}

function jwtSecret(): string {
  const secret = process.env.NEGOTIATION_JWT_SECRET || process.env.SUPABASE_JWT_SECRET
  if (!secret) throw new Error("NEGOTIATION_JWT_SECRET/SUPABASE_JWT_SECRET não configurado")
  return secret
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url")
}

export interface ChatSessionClaims {
  sid: string // negotiation_sessions.id
  cid: string // company_id
  exp: number // epoch seconds
}

export const CHAT_COOKIE_NAME = "alteapay_chat_session"
export const CHAT_JWT_TTL_SECONDS = 2 * 60 * 60

export function signChatJwt(claims: Omit<ChatSessionClaims, "exp">, ttlSeconds = CHAT_JWT_TTL_SECONDS): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const payload = b64url(
    JSON.stringify({ ...claims, exp: Math.floor(Date.now() / 1000) + ttlSeconds }),
  )
  const signature = createHmac("sha256", jwtSecret()).update(`${header}.${payload}`).digest("base64url")
  return `${header}.${payload}.${signature}`
}

export function verifyChatJwt(token: string): ChatSessionClaims | null {
  const parts = token.split(".")
  if (parts.length !== 3) return null
  const [header, payload, signature] = parts
  const expected = createHmac("sha256", jwtSecret()).update(`${header}.${payload}`).digest()
  const actual = Buffer.from(signature, "base64url")
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as ChatSessionClaims
    if (!claims.sid || !claims.cid) return null
    if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now()) return null
    return claims
  } catch {
    return null
  }
}
