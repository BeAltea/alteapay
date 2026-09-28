// Partes PURAS (sem node:crypto, sem Web Crypto) do IP do cliente, usadas tanto
// no runtime Node (route handlers / server actions, `client-ip.ts`) quanto no
// middleware de borda (`client-ip-edge.ts`). Ver o desenho completo em
// ops/negociacao-final/12-rate-limit-e-ip.md (N8N-12 / F-4 / Q1r2-5).

export interface HeaderReader {
  get(name: string): string | null
}

/** Setado pela borda da Netlify a partir da conexão TCP (sobrescreve o do cliente). */
export const NF_CLIENT_IP_HEADER = "x-nf-client-connection-ip"
export const XFF_HEADER = "x-forwarded-for"
/** Cabeçalhos internos escritos pelo NOSSO middleware (Edge Function da Netlify)
 *  a partir de `request.ip` (= `context.ip` da Edge Function). Só valem com a
 *  assinatura HMAC (`CLIENT_IP_HEADER_SECRET`): um cliente que os envie por conta
 *  própria não tem como produzir a assinatura. */
export const EDGE_CLIENT_IP_HEADER = "x-alteapay-client-ip"
export const EDGE_CLIENT_IP_SIG_HEADER = "x-alteapay-client-ip-sig"

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
const IPV6 = /^[0-9a-f:.]+$/i

/** Normaliza e valida um candidato a IP; null se não for um IP plausível. */
export function normalizeIp(raw: string | null | undefined): string | null {
  if (!raw) return null
  let v = raw.trim()
  if (!v || v.length > 45 + 2) return null
  // [v6]:porta ou [v6]
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(v)
  if (bracket) v = bracket[1]
  // v4:porta
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(v)) v = v.slice(0, v.lastIndexOf(":"))
  if (IPV4.test(v)) return v
  if (v.includes(":") && IPV6.test(v) && v.length <= 45) return v.toLowerCase()
  return null
}

/** Fontes confiáveis que podem ser habilitadas (em ordem de preferência). */
export type TrustedIpSource = "edge" | "netlify" | "xff"

export type ClientIpConfig =
  /** Default (flag ausente): comportamento de HOJE, byte a byte. */
  | { mode: "legacy" }
  /** Nenhuma fonte é confiável: sempre null (os chamadores caem no balde comum). */
  | { mode: "none" }
  | { mode: "trusted"; sources: TrustedIpSource[]; proxyHops: number; edgeSecret: string | null }

const SOURCES: readonly TrustedIpSource[] = ["edge", "netlify", "xff"]

/** Segredo mínimo aceito para assinar o cabeçalho de borda. */
export const MIN_EDGE_SECRET_LEN = 32

/**
 * Lê a configuração do ambiente (a cada chamada — testes e deploy mudam env).
 *
 *   TRUSTED_CLIENT_IP_SOURCE  ausente/"legacy" → hoje | "none" | lista ordenada
 *                             de "edge", "netlify", "xff" (ex.: "edge,netlify")
 *   TRUSTED_PROXY_HOPS        nº de proxies confiáveis que ANEXAM ao XFF (default 1)
 *   CLIENT_IP_HEADER_SECRET   segredo HMAC do cabeçalho de borda (fonte "edge")
 *
 * Valor desconhecido/malformado → "legacy" (nunca muda a produção por engano).
 */
export function parseClientIpConfig(env: Record<string, string | undefined> = process.env): ClientIpConfig {
  const raw = (env.TRUSTED_CLIENT_IP_SOURCE ?? "").trim().toLowerCase()
  if (!raw || raw === "legacy") return { mode: "legacy" }
  if (raw === "none") return { mode: "none" }
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean)
  if (parts.length === 0 || parts.some((p) => !SOURCES.includes(p as TrustedIpSource))) {
    return { mode: "legacy" }
  }
  const sources = Array.from(new Set(parts)) as TrustedIpSource[]
  const hopsRaw = Number(env.TRUSTED_PROXY_HOPS ?? "1")
  const proxyHops = Number.isInteger(hopsRaw) && hopsRaw >= 1 && hopsRaw <= 10 ? hopsRaw : 1
  const secret = env.CLIENT_IP_HEADER_SECRET ?? ""
  return {
    mode: "trusted",
    sources,
    proxyHops,
    edgeSecret: secret.length >= MIN_EDGE_SECRET_LEN ? secret : null,
  }
}

/** Conteúdo assinado do cabeçalho de borda (versionado). */
export const edgeSigningPayload = (ip: string) => `v1:${ip}`
