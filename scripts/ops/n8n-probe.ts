/**
 * n8n-probe — sonda de conectividade do fluxo-cérebro n8n (papel A).
 *
 * DECISÃO 2026-09-23 (Fabio): o lado do n8n REMOVEU a autenticação; seguimos
 * "apenas com o endpoint". Portanto o GATE X0 agora é CONECTIVIDADE: basta o
 * endpoint responder 200 a um ping bem-formado. Os casos de auth (assinatura
 * adulterada / timestamp velho / sem Authorization) viram INFORMATIVOS — como o
 * n8n não valida nada, espera-se que TODOS retornem 200; isso é risco aceito
 * (a URL do endpoint é a única proteção e continua sendo segredo).
 *
 * Envia um `ping` ao Webhook trigger em N8N_CHAT_FLOW_URL exercitando o MESMO
 * esquema de headers que a plataforma usa (lib/negotiation/n8n.ts) — a assinatura
 * HMAC e o Basic Auth são enviados quando os envs existem, mas o n8n os ignora.
 *
 * Imprime SOMENTE status HTTP + latência + veredito. NUNCA imprime a URL, o
 * segredo, a senha nem o header Authorization.
 *
 * Uso:  pnpm exec tsx scripts/ops/n8n-probe.ts
 *
 * Envs (nunca hardcode):
 *   N8N_CHAT_FLOW_URL         (obrigatório) URL do Webhook trigger
 *   N8N_WEBHOOK_SECRET        (opcional)    segredo HMAC — enviado se presente
 *   N8N_BASIC_AUTH_USER/…_PASSWORD (opcional) Basic Auth — enviado se presente
 */

import { createHmac, randomUUID } from "node:crypto"

const TIMEOUT_MS = 20_000

type EnvBundle = {
  url: string
  secret: string | null
  basicAuth: string | null // "Basic <base64>" ou null
}

/** Lê as envs. Só N8N_CHAT_FLOW_URL é obrigatória. NUNCA loga valores. */
function readEnv(): EnvBundle {
  const url = process.env.N8N_CHAT_FLOW_URL
  const secret = process.env.N8N_WEBHOOK_SECRET ?? null
  const user = process.env.N8N_BASIC_AUTH_USER
  const password = process.env.N8N_BASIC_AUTH_PASSWORD

  if (!url) {
    console.error("[n8n-probe] env ausente: N8N_CHAT_FLOW_URL")
    process.exit(1)
  }
  // Buffer(...,'utf8') — não btoa — para suportar credenciais não-ASCII.
  const basicAuth =
    user && password ? `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}` : null
  return { url, secret, basicAuth }
}

/** Assinatura HMAC-SHA256 de `${timestamp}.${rawBody}` (mesmo esquema da plataforma). */
function sign(rawBody: string, timestamp: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex")
}

type Case = {
  name: string
  /** true = este caso decide o GATE X0. false = informativo (n8n sem auth). */
  gating: boolean
  expectation: string
  verdict: (status: number) => boolean
  build: (env: EnvBundle, body: string) => { headers: Record<string, string> }
}

const nowSeconds = () => Math.floor(Date.now() / 1000)

function baseHeaders(env: EnvBundle, body: string, ts: string, signature?: string): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    "x-alteapay-timestamp": ts,
    "x-alteapay-event-id": randomUUID(),
  }
  if (env.secret) h["x-alteapay-signature"] = signature ?? sign(body, ts, env.secret)
  if (env.basicAuth) h.Authorization = env.basicAuth
  return h
}

const CASES: Case[] = [
  {
    name: "conectividade (ping bem-formado)",
    gating: true,
    expectation: "200",
    verdict: (s) => s === 200,
    build: (env, body) => ({ headers: baseHeaders(env, body, String(nowSeconds())) }),
  },
  {
    name: "assinatura adulterada [informativo]",
    gating: false,
    expectation: "n8n sem auth → 200",
    verdict: (s) => s === 200,
    build: (env, body) => {
      const ts = String(nowSeconds())
      let sig: string | undefined
      if (env.secret) {
        const good = sign(body, ts, env.secret)
        sig = good.slice(0, -1) + (good.slice(-1) === "0" ? "1" : "0")
      }
      return { headers: baseHeaders(env, body, ts, sig) }
    },
  },
  {
    name: "timestamp velho (-600s) [informativo]",
    gating: false,
    expectation: "n8n sem auth → 200",
    verdict: (s) => s === 200,
    build: (env, body) => ({ headers: baseHeaders(env, body, String(nowSeconds() - 600)) }),
  },
  {
    name: "sem Authorization [informativo]",
    gating: false,
    expectation: "n8n sem auth → 200",
    verdict: (s) => s === 200,
    build: (env, body) => {
      const ts = String(nowSeconds())
      const h = baseHeaders(env, body, ts)
      delete h.Authorization
      return { headers: h }
    },
  },
]

async function runCase(env: EnvBundle, c: Case): Promise<boolean> {
  const body = JSON.stringify({ action: "ping" })
  const { headers } = c.build(env, body)
  const t0 = Date.now()
  let status = 0
  let label = ""
  try {
    const resp = await fetch(env.url, { method: "POST", headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) })
    status = resp.status
    await resp.text().catch(() => "") // drena; conteúdo NÃO é impresso (pode ecoar segredo)
  } catch (err) {
    label = err instanceof Error && err.name === "TimeoutError" ? "timeout" : "network_error"
  }
  const latency = Date.now() - t0
  const kind = c.gating ? "GATE" : "info"
  if (label) {
    console.log(`  [FALHA/${kind}] ${c.name.padEnd(40)} ${label.padEnd(6)} ${latency}ms`)
    return c.gating ? false : true // caso informativo não derruba o gate
  }
  const pass = c.verdict(status)
  const tag = c.gating ? (pass ? "OK  " : "FAIL") : "info"
  console.log(`  [${tag}/${kind}] ${c.name.padEnd(40)} HTTP ${status}  ${latency}ms  (${c.expectation})`)
  return c.gating ? pass : true
}

async function main(): Promise<void> {
  const env = readEnv()
  console.log("[n8n-probe] alvo: N8N_CHAT_FLOW_URL (valor omitido por segurança)")
  console.log("[n8n-probe] GATE = conectividade; casos de auth são informativos (n8n sem auth, aceito):\n")

  const gate = CASES.find((c) => c.gating)!
  const gatePass = await runCase(env, gate)
  for (const c of CASES.filter((c) => !c.gating)) await runCase(env, c)

  console.log(`\n[n8n-probe] GATE X0 (conectividade): ${gatePass ? "PASSA" : "FALHA"}`)
  process.exit(gatePass ? 0 : 1)
}

void main()
