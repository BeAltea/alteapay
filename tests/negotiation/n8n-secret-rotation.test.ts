// N8N-4: rotação sem downtime do segredo HMAC n8n ⇄ plataforma.
// Inbound aceita N8N_WEBHOOK_SECRET ou N8N_WEBHOOK_SECRET_PREVIOUS (tempo
// constante, loga só o rótulo); outbound assina só com o atual; nada de segredo
// em log/erro.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  N8N_SIGNATURE_HEADER,
  buildN8nOutboundHeaders,
  n8nWebhookSecretPrevious,
  scrubN8nSecrets,
  signN8nPayload,
  verifyN8nRequest,
} from "@/lib/negotiation/n8n"

const CURRENT = "current-secret-0123456789abcdef"
const PREVIOUS = "previous-secret-fedcba9876543210"
const OTHER = "attacker-secret-000000000000000"
const BODY = JSON.stringify({ action: "chat.send", session_id: "s-1", args: { text: "oi" } })
const ENV_KEYS = [
  "N8N_WEBHOOK_SECRET",
  "N8N_WEBHOOK_SECRET_PREVIOUS",
  "N8N_BASIC_AUTH_USER",
  "N8N_BASIC_AUTH_PASSWORD",
  "N8N_CHAT_FLOW_URL",
  "N8N_EVENT_FLOW_URL",
  "N8N_SESSION_FLOW_URL",
] as const
const saved: Record<string, string | undefined> = {}

const ts = () => String(Math.floor(Date.now() / 1000))

describe("N8N-4 — rotação do segredo HMAC", () => {
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k]
    for (const k of ENV_KEYS) delete process.env[k]
    process.env.N8N_WEBHOOK_SECRET = CURRENT
    warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  })

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    warn.mockRestore()
  })

  it("aceita assinatura com o segredo ATUAL (matched=current), sem log de rotação", () => {
    process.env.N8N_WEBHOOK_SECRET_PREVIOUS = PREVIOUS
    const t = ts()
    expect(verifyN8nRequest(BODY, signN8nPayload(BODY, t, CURRENT), t)).toEqual({ ok: true, matched: "current" })
    expect(warn).not.toHaveBeenCalled()
  })

  it("aceita assinatura com o segredo ANTERIOR durante a rotação e loga só o rótulo", () => {
    process.env.N8N_WEBHOOK_SECRET_PREVIOUS = PREVIOUS
    const t = ts()
    expect(verifyN8nRequest(BODY, signN8nPayload(BODY, t, PREVIOUS), t)).toEqual({ ok: true, matched: "previous" })
    expect(warn).toHaveBeenCalledTimes(1)
    const logged = warn.mock.calls.flat().join(" ")
    expect(logged).toContain("N8N_WEBHOOK_SECRET_PREVIOUS")
    expect(logged).not.toContain(PREVIOUS)
    expect(logged).not.toContain(CURRENT)
  })

  it("recusa assinatura de um terceiro segredo (nem atual nem anterior)", () => {
    process.env.N8N_WEBHOOK_SECRET_PREVIOUS = PREVIOUS
    const t = ts()
    const r = verifyN8nRequest(BODY, signN8nPayload(BODY, t, OTHER), t)
    expect(r).toEqual({ ok: false, status: 401, reason: "assinatura inválida" })
    expect(JSON.stringify(r)).not.toContain(CURRENT)
  })

  it("recusa corpo adulterado mesmo assinado com o anterior", () => {
    process.env.N8N_WEBHOOK_SECRET_PREVIOUS = PREVIOUS
    const t = ts()
    const sig = signN8nPayload(BODY, t, PREVIOUS)
    expect(verifyN8nRequest(BODY.replace("oi", "90% off"), sig, t).ok).toBe(false)
  })

  it("rotação DESLIGADA (sem _PREVIOUS): o segredo antigo é recusado", () => {
    const t = ts()
    expect(n8nWebhookSecretPrevious()).toBe("")
    expect(verifyN8nRequest(BODY, signN8nPayload(BODY, t, PREVIOUS), t).ok).toBe(false)
    expect(verifyN8nRequest(BODY, signN8nPayload(BODY, t, CURRENT), t)).toEqual({ ok: true, matched: "current" })
  })

  it("_PREVIOUS igual ao atual é ignorado (rotação desligada)", () => {
    process.env.N8N_WEBHOOK_SECRET_PREVIOUS = CURRENT
    expect(n8nWebhookSecretPrevious()).toBe("")
    const t = ts()
    expect(verifyN8nRequest(BODY, signN8nPayload(BODY, t, CURRENT), t)).toEqual({ ok: true, matched: "current" })
  })

  it("só _PREVIOUS configurado (atual ausente) → 503, nunca aceita", () => {
    delete process.env.N8N_WEBHOOK_SECRET
    process.env.N8N_WEBHOOK_SECRET_PREVIOUS = PREVIOUS
    const t = ts()
    const r = verifyN8nRequest(BODY, signN8nPayload(BODY, t, PREVIOUS), t)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(503)
  })

  it("janela de replay vale também para o segredo anterior", () => {
    process.env.N8N_WEBHOOK_SECRET_PREVIOUS = PREVIOUS
    const stale = String(Math.floor(Date.now() / 1000) - 301)
    const r = verifyN8nRequest(BODY, signN8nPayload(BODY, stale, PREVIOUS), stale)
    expect(r.ok).toBe(false)
  })

  it("outbound assina SÓ com o segredo atual, mesmo com _PREVIOUS configurado", () => {
    process.env.N8N_WEBHOOK_SECRET_PREVIOUS = PREVIOUS
    const { headers, timestamp } = buildN8nOutboundHeaders(BODY)
    expect(headers[N8N_SIGNATURE_HEADER]).toBe(signN8nPayload(BODY, timestamp, CURRENT))
    expect(headers[N8N_SIGNATURE_HEADER]).not.toBe(signN8nPayload(BODY, timestamp, PREVIOUS))
  })
})

describe("N8N-4 — scrubN8nSecrets (erros/logs sem segredo)", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k]
    process.env.N8N_WEBHOOK_SECRET = CURRENT
    process.env.N8N_WEBHOOK_SECRET_PREVIOUS = PREVIOUS
    process.env.N8N_BASIC_AUTH_USER = "alteapay-n8n-user"
    process.env.N8N_BASIC_AUTH_PASSWORD = "basic-pass-XYZ-123"
    process.env.N8N_CHAT_FLOW_URL = "https://n8n.example.com/webhook/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0"
  })
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it("redige o caminho do webhook ecoado no 404 do n8n", () => {
    const body = '{"code":404,"message":"The requested webhook \\"POST 0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0\\" is not registered."}'
    const out = scrubN8nSecrets(body)
    expect(out).not.toContain("0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0")
    expect(out).toContain("[REDACTED]")
    expect(out).toContain("is not registered")
  })

  it("redige URL extra (por tenant), segredos e credenciais Basic (claro e base64)", () => {
    const tenantUrl = "https://n8n.example.com/webhook/tenant-flow-abcdef123456"
    const b64 = Buffer.from("alteapay-n8n-user:basic-pass-XYZ-123").toString("base64")
    const text = `url=${tenantUrl} s=${CURRENT} p=${PREVIOUS} pw=basic-pass-XYZ-123 h=Basic ${b64} other=Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==`
    const out = scrubN8nSecrets(text, [tenantUrl])
    for (const v of [tenantUrl, "tenant-flow-abcdef123456", CURRENT, PREVIOUS, "basic-pass-XYZ-123", b64, "QWxhZGRpbjpvcGVuIHNlc2FtZQ=="]) {
      expect(out).not.toContain(v)
    }
  })

  it("texto sem segredo passa intacto", () => {
    expect(scrubN8nSecrets("fluxo indisponível (502)")).toBe("fluxo indisponível (502)")
  })
})
