// Probe do fluxo-cérebro n8n (papel A) — GATE X0. Roda no runtime de PRODUÇÃO
// (onde os N8N_* existem), exercitando o MESMO esquema HMAC+Basic Auth da plataforma
// (lib/negotiation/n8n.ts). Devolve SOMENTE status/latência/veredito por caso — NUNCA
// a URL, o segredo, a senha ou o header Authorization. Auth server-a-servidor por
// Bearer CRON_SECRET. Espelha scripts/ops/n8n-probe.ts.
import { NextRequest, NextResponse } from "next/server"
import { createHmac, randomUUID } from "node:crypto"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const TIMEOUT_MS = 20_000
const nowSeconds = () => Math.floor(Date.now() / 1000)
const sign = (rawBody: string, ts: string, secret: string) =>
  "sha256=" + createHmac("sha256", secret).update(`${ts}.${rawBody}`, "utf8").digest("hex")

interface Env { url: string; secret: string; basicAuth: string }

type Case = {
  name: string
  expectation: string
  verdict: (status: number) => boolean
  headers: (env: Env, body: string) => Record<string, string>
}

const CASES: Case[] = [
  {
    name: "ok (assinado + Basic Auth)",
    expectation: "200",
    verdict: (s) => s === 200,
    headers: (env, body) => {
      const ts = String(nowSeconds())
      return { "Content-Type": "application/json", "x-alteapay-signature": sign(body, ts, env.secret), "x-alteapay-timestamp": ts, "x-alteapay-event-id": randomUUID(), Authorization: env.basicAuth }
    },
  },
  {
    name: "assinatura adulterada",
    expectation: "recusa 401/403",
    verdict: (s) => s === 401 || s === 403,
    headers: (env, body) => {
      const ts = String(nowSeconds())
      const good = sign(body, ts, env.secret)
      const tampered = good.slice(0, -1) + (good.slice(-1) === "0" ? "1" : "0")
      return { "Content-Type": "application/json", "x-alteapay-signature": tampered, "x-alteapay-timestamp": ts, "x-alteapay-event-id": randomUUID(), Authorization: env.basicAuth }
    },
  },
  {
    name: "timestamp fora da janela (-600s)",
    expectation: "recusa 401/403",
    verdict: (s) => s === 401 || s === 403,
    headers: (env, body) => {
      const ts = String(nowSeconds() - 600)
      return { "Content-Type": "application/json", "x-alteapay-signature": sign(body, ts, env.secret), "x-alteapay-timestamp": ts, "x-alteapay-event-id": randomUUID(), Authorization: env.basicAuth }
    },
  },
  {
    name: "sem Authorization",
    expectation: "401",
    verdict: (s) => s === 401,
    headers: (env, body) => {
      const ts = String(nowSeconds())
      return { "Content-Type": "application/json", "x-alteapay-signature": sign(body, ts, env.secret), "x-alteapay-timestamp": ts, "x-alteapay-event-id": randomUUID() }
    },
  },
]

export async function POST(request: NextRequest) {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const url = process.env.N8N_CHAT_FLOW_URL
  const secret = process.env.N8N_WEBHOOK_SECRET
  const user = process.env.N8N_BASIC_AUTH_USER
  const password = process.env.N8N_BASIC_AUTH_PASSWORD
  const missing = [
    !url && "N8N_CHAT_FLOW_URL",
    !secret && "N8N_WEBHOOK_SECRET",
    !user && "N8N_BASIC_AUTH_USER",
    !password && "N8N_BASIC_AUTH_PASSWORD",
  ].filter(Boolean)
  if (missing.length) return NextResponse.json({ ok: false, error: "envs ausentes", missing }, { status: 500 })

  const env: Env = { url: url!, secret: secret!, basicAuth: `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}` }
  const body = JSON.stringify({ action: "ping" })

  const results: Array<{ name: string; expected: string; status: number | null; error: string | null; latency_ms: number; pass: boolean }> = []
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
    results.push({ name: c.name, expected: c.expectation, status, error, latency_ms: Date.now() - t0, pass: status != null && c.verdict(status) })
  }

  const allPass = results.every((r) => r.pass)
  return NextResponse.json({ ok: true, gate_x0: allPass ? "PASSA" : "FALHA", allPass, results })
}
