/**
 * n8n-probe — sonda de conectividade + segurança do fluxo-cérebro n8n (papel A).
 *
 * Envia um `ping` ASSINADO ao Webhook trigger em N8N_CHAT_FLOW_URL, exercitando
 * o MESMO esquema que a plataforma usa em produção (lib/negotiation/n8n.ts):
 *   - HMAC-SHA256 de `${timestamp}.${body}` no header x-alteapay-signature
 *     (`sha256=<hex>`), timestamp em segundos em x-alteapay-timestamp, um
 *     x-alteapay-event-id único, e Authorization: Basic base64(user:pass) (UTF-8).
 *
 * Roda 4 casos e imprime SOMENTE status HTTP + latência + veredito. NUNCA
 * imprime a URL, o segredo, a senha nem o header Authorization.
 *
 *   1. ok               — request bem-formado           → espera 200 {ok:true}/{success:true}
 *   2. assinatura ruim  — HMAC adulterado               → o fluxo deve RECUSAR (401/403)
 *   3. timestamp velho  — ts = agora-600s (fora ±300s)  → o fluxo deve RECUSAR (401/403)
 *   4. sem Authorization — Basic Auth omitido           → espera 401 (Basic Auth do n8n)
 *
 * Tudo vem de process.env; envs ausentes → console.error + exit(1).
 *
 * Uso:
 *   pnpm exec tsx scripts/ops/n8n-probe.ts
 *
 * Requer no ambiente (nunca hardcode):
 *   N8N_CHAT_FLOW_URL         URL do Webhook trigger do fluxo-cérebro
 *   N8N_WEBHOOK_SECRET        segredo HMAC compartilhado
 *   N8N_BASIC_AUTH_USER       usuário do Basic Auth do trigger n8n
 *   N8N_BASIC_AUTH_PASSWORD   senha do Basic Auth do trigger n8n
 */

import { createHmac, randomUUID } from "node:crypto"

const TIMEOUT_MS = 20_000

type EnvBundle = {
  url: string
  secret: string
  basicAuth: string // "Basic <base64>"
}

/** Lê e valida as envs. Faltando qualquer uma → erro + exit 1. NUNCA loga valores. */
function readEnv(): EnvBundle {
  const url = process.env.N8N_CHAT_FLOW_URL
  const secret = process.env.N8N_WEBHOOK_SECRET
  const user = process.env.N8N_BASIC_AUTH_USER
  const password = process.env.N8N_BASIC_AUTH_PASSWORD

  const missing: string[] = []
  if (!url) missing.push("N8N_CHAT_FLOW_URL")
  if (!secret) missing.push("N8N_WEBHOOK_SECRET")
  if (!user) missing.push("N8N_BASIC_AUTH_USER")
  if (!password) missing.push("N8N_BASIC_AUTH_PASSWORD")
  if (missing.length > 0) {
    console.error(`[n8n-probe] envs ausentes: ${missing.join(", ")}`)
    process.exit(1)
  }

  // Buffer(...,'utf8') — não btoa — para suportar credenciais não-ASCII.
  const token = Buffer.from(`${user}:${password}`, "utf8").toString("base64")
  return { url: url as string, secret: secret as string, basicAuth: `Basic ${token}` }
}

/** Assinatura HMAC-SHA256 de `${timestamp}.${rawBody}` (mesmo esquema da plataforma). */
function sign(rawBody: string, timestamp: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex")
}

type Case = {
  name: string
  expectation: string
  /** true se o status recebido satisfaz a expectativa deste caso. */
  verdict: (status: number) => boolean
  build: (env: EnvBundle, body: string) => { headers: Record<string, string> }
}

const nowSeconds = () => Math.floor(Date.now() / 1000)

const CASES: Case[] = [
  {
    name: "ok (assinado + Basic Auth)",
    expectation: "200 {ok/success:true}",
    verdict: (s) => s === 200,
    build: (env, body) => {
      const ts = String(nowSeconds())
      return {
        headers: {
          "Content-Type": "application/json",
          "x-alteapay-signature": sign(body, ts, env.secret),
          "x-alteapay-timestamp": ts,
          "x-alteapay-event-id": randomUUID(),
          Authorization: env.basicAuth,
        },
      }
    },
  },
  {
    name: "assinatura adulterada",
    expectation: "recusa (401/403)",
    verdict: (s) => s === 401 || s === 403,
    build: (env, body) => {
      const ts = String(nowSeconds())
      const good = sign(body, ts, env.secret)
      // adultera o último caractere hex mantendo o formato sha256=<hex>
      const last = good.slice(-1)
      const tampered = good.slice(0, -1) + (last === "0" ? "1" : "0")
      return {
        headers: {
          "Content-Type": "application/json",
          "x-alteapay-signature": tampered,
          "x-alteapay-timestamp": ts,
          "x-alteapay-event-id": randomUUID(),
          Authorization: env.basicAuth,
        },
      }
    },
  },
  {
    name: "timestamp fora da janela (-600s)",
    expectation: "recusa (401/403)",
    verdict: (s) => s === 401 || s === 403,
    build: (env, body) => {
      const ts = String(nowSeconds() - 600) // 10 min no passado (janela é ±300s)
      return {
        headers: {
          "Content-Type": "application/json",
          "x-alteapay-signature": sign(body, ts, env.secret), // assinatura válida p/ ESSE ts
          "x-alteapay-timestamp": ts,
          "x-alteapay-event-id": randomUUID(),
          Authorization: env.basicAuth,
        },
      }
    },
  },
  {
    name: "sem Authorization (Basic Auth omitido)",
    expectation: "401",
    verdict: (s) => s === 401,
    build: (env, body) => {
      const ts = String(nowSeconds())
      return {
        headers: {
          "Content-Type": "application/json",
          "x-alteapay-signature": sign(body, ts, env.secret),
          "x-alteapay-timestamp": ts,
          "x-alteapay-event-id": randomUUID(),
          // Authorization propositalmente ausente
        },
      }
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
    const resp = await fetch(env.url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    status = resp.status
    // drena o corpo para liberar a conexão; o conteúdo NÃO é impresso (pode ecoar segredo).
    await resp.text().catch(() => "")
  } catch (err) {
    label = err instanceof Error && err.name === "TimeoutError" ? "timeout" : "network_error"
  }
  const latency = Date.now() - t0

  if (label) {
    // Falha de rede/timeout — sem status. Não é aprovação.
    console.log(`  [FALHA] ${c.name.padEnd(38)} ${label.padEnd(6)} ${latency}ms  (esperado: ${c.expectation})`)
    return false
  }
  const pass = c.verdict(status)
  const tag = pass ? "OK  " : "FAIL"
  console.log(
    `  [${tag}] ${c.name.padEnd(38)} HTTP ${status}  ${latency}ms  (esperado: ${c.expectation})`,
  )
  return pass
}

async function main(): Promise<void> {
  const env = readEnv()
  console.log("[n8n-probe] alvo: N8N_CHAT_FLOW_URL (valor omitido por segurança)")
  console.log("[n8n-probe] ping assinado — 4 casos:\n")

  let allPass = true
  for (const c of CASES) {
    // sequencial para uma leitura de latência limpa por caso
    const pass = await runCase(env, c)
    allPass = allPass && pass
  }

  console.log(`\n[n8n-probe] resultado: ${allPass ? "TODOS OS CASOS OK" : "HÁ CASOS FORA DO ESPERADO"}`)
  process.exit(allPass ? 0 : 1)
}

void main()
