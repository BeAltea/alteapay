// IP do cliente para rate limit / auditoria — ÚNICA fonte da plataforma
// (N8N-12 / F-4 / Q1r2-5). Runtime Node (route handlers e server actions).
//
// Regras:
//   - NUNCA o elemento mais à esquerda do X-Forwarded-For (escrito pelo cliente).
//   - Sem fonte confiável → null (o chamador decide: pular a dimensão IP ou usar
//     o balde comum "unknown", que é o comportamento de hoje).
//   - IP em claro nunca vai para log: para telemetria use `clientIpHash` (HMAC
//     com sal secreto).
//
// Flag TRUSTED_CLIENT_IP_SOURCE (ver client-ip-shared.ts). Default = "legacy":
// exatamente a lógica de hoje (x-nf-client-connection-ip › ÚLTIMO do XFF), para
// que o deploy não mude a produção. As fontes confiáveis só entram quando a
// flag é ligada, depois da validação com 2 redes (runbook 12).

import { createHmac, timingSafeEqual } from "node:crypto"

import {
  EDGE_CLIENT_IP_HEADER,
  EDGE_CLIENT_IP_SIG_HEADER,
  NF_CLIENT_IP_HEADER,
  XFF_HEADER,
  edgeSigningPayload,
  normalizeIp,
  parseClientIpConfig,
  type ClientIpConfig,
  type HeaderReader,
  type TrustedIpSource,
} from "./client-ip-shared"

export { normalizeIp, parseClientIpConfig }
export type { ClientIpConfig, HeaderReader, TrustedIpSource }

type Env = Record<string, string | undefined>

/** Comportamento de HOJE (QA rodada 5, Q1-5): borda Netlify › último do XFF › null. */
export function legacyClientIp(headers: HeaderReader): string | null {
  const edge = normalizeIp(headers.get(NF_CLIENT_IP_HEADER))
  if (edge) return edge
  const xff = headers.get(XFF_HEADER)
  if (xff) {
    const parts = xff.split(",").map((p) => p.trim()).filter(Boolean)
    const last = normalizeIp(parts[parts.length - 1])
    if (last) return last
  }
  return null
}

/**
 * Salto "mais à direita não confiável" do XFF. Com `hops` proxies confiáveis
 * anexando ao cabeçalho, o endereço do cliente é o `hops`-ésimo a partir da
 * DIREITA. Se a lista tiver menos elementos que `hops`, ela não passou por
 * todos os proxies confiáveis → null (não há valor em que confiar).
 */
export function xffClientIp(headers: HeaderReader, hops: number): string | null {
  const xff = headers.get(XFF_HEADER)
  if (!xff) return null
  const parts = xff.split(",").map((p) => p.trim()).filter(Boolean)
  if (hops < 1 || parts.length < hops) return null
  return normalizeIp(parts[parts.length - hops])
}

/** Assinatura HMAC-SHA256 (hex) do cabeçalho de borda. Mesmo formato do edge. */
export function signEdgeClientIp(ip: string, secret: string): string {
  return createHmac("sha256", secret).update(edgeSigningPayload(ip)).digest("hex")
}

/** IP escrito pelo middleware de borda, SÓ se a assinatura confere. */
export function edgeClientIp(headers: HeaderReader, secret: string | null): string | null {
  if (!secret) return null
  const ip = normalizeIp(headers.get(EDGE_CLIENT_IP_HEADER))
  const sig = (headers.get(EDGE_CLIENT_IP_SIG_HEADER) ?? "").trim().toLowerCase()
  if (!ip || !/^[0-9a-f]{64}$/.test(sig)) return null
  const expected = Buffer.from(signEdgeClientIp(ip, secret), "hex")
  const got = Buffer.from(sig, "hex")
  return expected.length === got.length && timingSafeEqual(expected, got) ? ip : null
}

function fromSource(
  source: TrustedIpSource,
  headers: HeaderReader,
  cfg: Extract<ClientIpConfig, { mode: "trusted" }>,
): string | null {
  switch (source) {
    case "edge":
      return edgeClientIp(headers, cfg.edgeSecret)
    case "netlify":
      return normalizeIp(headers.get(NF_CLIENT_IP_HEADER))
    case "xff":
      return xffClientIp(headers, cfg.proxyHops)
  }
}

export interface ResolvedClientIp {
  ip: string | null
  /** De onde veio: fonte confiável, "legacy" (flag desligada) ou null. */
  source: TrustedIpSource | "legacy" | null
  mode: ClientIpConfig["mode"]
}

/** Resolve o IP do cliente segundo a flag, dizendo de qual fonte ele veio. */
export function resolveClientIpDetailed(headers: HeaderReader, env: Env = process.env): ResolvedClientIp {
  const cfg = parseClientIpConfig(env)
  if (cfg.mode === "legacy") {
    const ip = legacyClientIp(headers)
    return { ip, source: ip ? "legacy" : null, mode: cfg.mode }
  }
  if (cfg.mode === "none") return { ip: null, source: null, mode: cfg.mode }
  for (const source of cfg.sources) {
    const ip = fromSource(source, headers, cfg)
    if (ip) return { ip, source, mode: cfg.mode }
  }
  return { ip: null, source: null, mode: cfg.mode }
}

/** IP do cliente segundo a flag (null = sem fonte confiável). */
export function resolveClientIp(headers: HeaderReader, env: Env = process.env): string | null {
  return resolveClientIpDetailed(headers, env).ip
}

/** true se uma fonte CONFIÁVEL está ligada (flag ≠ legacy/none). */
export function trustedClientIpEnabled(env: Env = process.env): boolean {
  return parseClientIpConfig(env).mode === "trusted"
}

/**
 * Hash salgado para telemetria (nunca o IP em claro em log). Sal em
 * CLIENT_IP_HASH_SALT; sem sal → null (não há como comparar entre instâncias,
 * então não finge que há).
 */
export function clientIpHash(ip: string | null | undefined, env: Env = process.env): string | null {
  const salt = env.CLIENT_IP_HASH_SALT ?? ""
  if (!ip || salt.length < 16) return null
  return createHmac("sha256", salt).update(ip).digest("hex").slice(0, 16)
}

export interface ClientIpDiagnostics {
  mode: ClientIpConfig["mode"]
  sources: string[]
  proxy_hops: number | null
  resolved: { source: ResolvedClientIp["source"]; hash: string | null; matches_expected: boolean | null }
  netlify: { present: boolean; valid: boolean; hash: string | null; matches_expected: boolean | null }
  edge: { present: boolean; verified: boolean; hash: string | null; matches_expected: boolean | null }
  /** Um item por elemento do XFF (da esquerda p/ direita), só hashes. */
  xff: Array<{ valid: boolean; hash: string | null; matches_expected: boolean | null }>
  legacy: { hash: string | null; matches_expected: boolean | null }
  salted: boolean
}

/**
 * Diagnóstico do F-4: para cada fonte candidata, se existe e o HASH do valor —
 * nunca o IP em claro. Com `expected` (o IP público que o próprio testador vê
 * na rede dele), diz qual fonte bate. Rodado de 2 redes (4G e fibra), mostra
 * qual fonte acompanha a troca de rede e qual fica parada (salto de proxy).
 */
export function clientIpDiagnostics(
  headers: HeaderReader,
  opts: { expected?: string | null; env?: Env } = {},
): ClientIpDiagnostics {
  const env = opts.env ?? process.env
  const cfg = parseClientIpConfig(env)
  const expected = normalizeIp(opts.expected ?? null)
  const match = (ip: string | null) => (expected ? ip === expected : null)
  const h = (ip: string | null) => clientIpHash(ip, env)

  const nfRaw = headers.get(NF_CLIENT_IP_HEADER)
  const nf = normalizeIp(nfRaw)
  const edgeRaw = headers.get(EDGE_CLIENT_IP_HEADER)
  const edgeVerified =
    cfg.mode === "trusted" ? edgeClientIp(headers, cfg.edgeSecret) : null
  const xffParts = (headers.get(XFF_HEADER) ?? "").split(",").map((p) => p.trim()).filter(Boolean)
  const legacy = legacyClientIp(headers)
  const resolved = resolveClientIpDetailed(headers, env)

  return {
    mode: cfg.mode,
    sources: cfg.mode === "trusted" ? cfg.sources : [],
    proxy_hops: cfg.mode === "trusted" ? cfg.proxyHops : null,
    resolved: { source: resolved.source, hash: h(resolved.ip), matches_expected: match(resolved.ip) },
    netlify: { present: Boolean(nfRaw), valid: Boolean(nf), hash: h(nf), matches_expected: match(nf) },
    edge: {
      present: Boolean(edgeRaw),
      verified: Boolean(edgeVerified),
      hash: h(edgeVerified),
      matches_expected: match(edgeVerified),
    },
    xff: xffParts.map((p) => {
      const ip = normalizeIp(p)
      return { valid: Boolean(ip), hash: h(ip), matches_expected: match(ip) }
    }),
    legacy: { hash: h(legacy), matches_expected: match(legacy) },
    salted: (env.CLIENT_IP_HASH_SALT ?? "").length >= 16,
  }
}
