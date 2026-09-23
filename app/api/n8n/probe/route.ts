// Probe do fluxo-cérebro n8n (papel A) — GATE X0. Roda no runtime de PRODUÇÃO
// (onde os N8N_* existem), exercitando o MESMO esquema de headers da plataforma
// (lib/negotiation/n8n.ts). Devolve SOMENTE status/latência/veredito por caso —
// NUNCA a URL, o segredo, a senha ou o header Authorization. Auth server-a-servidor
// por Bearer CRON_SECRET.
//
// DECISÃO 2026-09-23 (Fabio): o lado do n8n REMOVEU a autenticação; seguimos
// "apenas com o endpoint". Portanto o GATE X0 é CONECTIVIDADE (o endpoint responde
// 200 a um ping). Os casos de auth são INFORMATIVOS — o n8n não valida nada, então
// espera-se 200 em todos; é risco aceito (a URL é a única proteção e segue segredo).
import { NextRequest, NextResponse } from "next/server"
import { createHmac, randomUUID } from "node:crypto"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const TIMEOUT_MS = 20_000
const nowSeconds = () => Math.floor(Date.now() / 1000)
const sign = (rawBody: string, ts: string, secret: string) =>
  "sha256=" + createHmac("sha256", secret).update(`${ts}.${rawBody}`, "utf8").digest("hex")

interface Env {
  url: string
  secret: string | null
  basicAuth: string | null
}

type Case = {
  name: string
  gating: boolean // true = decide o GATE X0; false = informativo
  expectation: string
  verdict: (status: number) => boolean
  headers: (env: Env, body: string) => Record<string, string>
}

function baseHeaders(env: Env, body: string, ts: string, signature?: string): Record<string, string> {
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
    headers: (env, body) => baseHeaders(env, body, String(nowSeconds())),
  },
  {
    name: "assinatura adulterada [informativo]",
    gating: false,
    expectation: "n8n sem auth (aceito)",
    verdict: (s) => s === 200,
    headers: (env, body) => {
      const ts = String(nowSeconds())
      let sig: string | undefined
      if (env.secret) {
        const good = sign(body, ts, env.secret)
        sig = good.slice(0, -1) + (good.slice(-1) === "0" ? "1" : "0")
      }
      return baseHeaders(env, body, ts, sig)
    },
  },
  {
    name: "timestamp fora da janela (-600s) [informativo]",
    gating: false,
    expectation: "n8n sem auth (aceito)",
    verdict: (s) => s === 200,
    headers: (env, body) => baseHeaders(env, body, String(nowSeconds() - 600)),
  },
  {
    name: "sem Authorization [informativo]",
    gating: false,
    expectation: "n8n sem auth (aceito)",
    verdict: (s) => s === 200,
    headers: (env, body) => {
      const h = baseHeaders(env, body, String(nowSeconds()))
      delete h.Authorization
      return h
    },
  },
]

export async function POST(request: NextRequest) {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const url = process.env.N8N_CHAT_FLOW_URL
  if (!url) return NextResponse.json({ ok: false, error: "env ausente", missing: ["N8N_CHAT_FLOW_URL"] }, { status: 500 })

  const secret = process.env.N8N_WEBHOOK_SECRET ?? null
  const user = process.env.N8N_BASIC_AUTH_USER
  const password = process.env.N8N_BASIC_AUTH_PASSWORD
  const env: Env = {
    url,
    secret,
    basicAuth: user && password ? `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}` : null,
  }
  const body = JSON.stringify({ action: "ping" })

  const results: Array<{ name: string; gating: boolean; expected: string; status: number | null; error: string | null; latency_ms: number; verdict: string }> = []
  for (const c of CASES) {
    const t0 = Date.now()
    let status: number | null = null
    let error: string | null = null
    try {
      const resp = await fetch(env.url, { method: "POST", headers: c.headers(env, body), body, signal: AbortSignal.timeout(TIMEOUT_MS) })
      status = resp.status
      await resp.text().catch(() => "") // drena; NÃO retorna o corpo (pode ecoar segredo)
    } catch (e) {
      error = e instanceof Error && e.name === "TimeoutError" ? "timeout" : "network_error"
    }
    const ok = status != null && c.verdict(status)
    results.push({
      name: c.name,
      gating: c.gating,
      expected: c.expectation,
      status,
      error,
      latency_ms: Date.now() - t0,
      verdict: c.gating ? (ok ? "GATE_OK" : "GATE_FAIL") : "info",
    })
  }

  const gate = results.find((r) => r.gating)
  const gatePass = gate?.verdict === "GATE_OK"
  return NextResponse.json({ ok: true, gate_x0: gatePass ? "PASSA" : "FALHA", gatePass, note: "n8n sem auth (aceito 2026-09-23); GATE = conectividade", results })
}
