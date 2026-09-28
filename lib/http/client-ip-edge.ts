// Middleware de borda (Next middleware = Edge Function da Netlify no
// @netlify/plugin-nextjs 5.x): repassa o IP do cliente às funções Node num
// cabeçalho ASSINADO. Só Web Crypto (sem node:crypto) — roda no runtime edge.
//
// Por que aqui: no route handler do Next na Netlify `request.ip` é undefined e o
// QA (Q1r2-5) viu o salto intermediário da Netlify no lugar do cliente. Já no
// middleware, o plugin monta o NextRequest com `ip: context.ip`
// (edge-runtime/lib/next-request.ts do plugin) — o IP da conexão do cliente
// segundo a própria Netlify. O middleware SEMPRE apaga os cabeçalhos internos
// recebidos e só os reescreve com assinatura HMAC; o route handler só aceita o
// valor se a assinatura conferir (lib/http/client-ip.ts → edgeClientIp).
//
// Inerte (não toca em nada) se TRUSTED_CLIENT_IP_SOURCE não contém "edge".

import {
  EDGE_CLIENT_IP_HEADER,
  EDGE_CLIENT_IP_SIG_HEADER,
  edgeSigningPayload,
  normalizeIp,
  parseClientIpConfig,
} from "./client-ip-shared"

type Env = Record<string, string | undefined>

async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  )
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)))
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("")
}

/**
 * Aplica (in place) os cabeçalhos internos de IP em `request.headers`.
 * Devolve true se a fonte "edge" está ligada (headers foram saneados e, havendo
 * `request.ip`, assinados) — o chamador então repassa os headers da request
 * com `NextResponse.next({ request: { headers } })`. Nunca lança.
 */
export async function applyEdgeClientIp(
  request: { ip?: string | null; headers: Headers },
  env: Env = process.env,
): Promise<boolean> {
  try {
    const cfg = parseClientIpConfig(env)
    if (cfg.mode !== "trusted" || !cfg.sources.includes("edge")) return false
    // Qualquer valor vindo de fora é descartado, assinado ou não.
    request.headers.delete(EDGE_CLIENT_IP_HEADER)
    request.headers.delete(EDGE_CLIENT_IP_SIG_HEADER)
    const ip = normalizeIp(request.ip ?? null)
    if (ip && cfg.edgeSecret) {
      request.headers.set(EDGE_CLIENT_IP_HEADER, ip)
      request.headers.set(EDGE_CLIENT_IP_SIG_HEADER, await hmacHex(cfg.edgeSecret, edgeSigningPayload(ip)))
    }
    return true
  } catch {
    return false
  }
}
