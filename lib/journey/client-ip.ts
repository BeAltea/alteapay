// IP do cliente para rate limit / auditoria (QA rodada 5, Q1-5; N8N-12 / F-4).
//
// Fachada histórica: a lógica mora em `lib/http/client-ip.ts` (fonte única da
// plataforma). `clientIpFromHeaders` segue a flag TRUSTED_CLIENT_IP_SOURCE:
//   - ausente / "legacy" (DEFAULT) → comportamento de hoje, inalterado:
//       1. `x-nf-client-connection-ip`; 2. ÚLTIMO elemento do X-Forwarded-For;
//       3. null. Nunca o 1º elemento do XFF (forjável pelo cliente).
//   - "edge" / "netlify" / "xff" (lista ordenada) → só fontes confiáveis
//     validadas com 2 redes (runbook ops/negociacao-final/12-rate-limit-e-ip.md).
//   - "none" → null sempre.
// Todos os chamadores (chat auth /c /t /n, chat button/session, contact-lead,
// /api/negotiation/*, /api/webhooks/n8n pré-auth) passam por aqui, então ligar
// a flag troca a fonte de IP de todos de uma vez; desligar volta ao de hoje.

import { resolveClientIp, type HeaderReader } from "@/lib/http/client-ip"

export { normalizeIp } from "@/lib/http/client-ip"
export type { HeaderReader } from "@/lib/http/client-ip"

/**
 * QA rodada 6 (Q1r2-5, ALTO) — a dimensão IP do LOCK de autenticação está
 * DESLIGADA por padrão: vira só telemetria (o `ip_hash` continua gravado em cada
 * tentativa), sem bloquear ninguém.
 *
 * Por quê: em produção (Next na Netlify, a88c0f2) o valor do helper legado NÃO
 * é o IP do cliente: o último elemento do `X-Forwarded-For` é um salto
 * intermediário da Netlify, estável há horas e comum a vários clientes. Com a
 * dimensão IP ligada, 5 CPFs inexistentes em 10 min travavam o login de TODOS
 * os devedores atrás desse salto (DoS do link público).
 *
 * Religar é DECISÃO DO USUÁRIO: `AUTH_IP_LOCK_ENABLED=true`, e só depois de
 * TRUSTED_CLIENT_IP_SOURCE apontar para uma fonte confirmada com 2 redes (F-4).
 * Ligado, o lock usa automaticamente o IP de `clientIpFromHeaders` (a fonte
 * confiável); sem IP confiável (null) a dimensão IP simplesmente não entra.
 */
export function ipLockEnabled(): boolean {
  return process.env.AUTH_IP_LOCK_ENABLED === "true"
}

/** IP do cliente segundo TRUSTED_CLIENT_IP_SOURCE (default: lógica de hoje). */
export function clientIpFromHeaders(headers: HeaderReader): string | null {
  return resolveClientIp(headers)
}
