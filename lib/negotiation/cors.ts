// CORS por tenant para as rotas públicas do chat: além da origin própria,
// somente origins presentes em tenant_chat_config.allowed_origins.

import { appUrl } from "./config"

export function isOriginAllowed(origin: string | null, tenantAllowedOrigins: string[]): boolean {
  if (!origin) return true // same-origin / non-browser
  if (origin === appUrl()) return true
  return tenantAllowedOrigins.includes(origin)
}

export function corsHeaders(origin: string | null, tenantAllowedOrigins: string[]): Record<string, string> {
  if (!origin || !isOriginAllowed(origin, tenantAllowedOrigins)) return {}
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  }
}
