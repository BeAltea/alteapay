// N8N-5: o callback do modo assíncrono (worker alteapay-n8n) leva a mesma
// autenticação do papel A (HMAC + timestamp + Event-Id + Basic), com o Basic
// restrito ao host n8n configurado.

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  N8N_EVENT_ID_HEADER,
  N8N_SIGNATURE_HEADER,
  N8N_TIMESTAMP_HEADER,
  buildN8nCallbackHeaders,
  isConfiguredN8nOrigin,
  verifyN8nRequest,
} from "@/lib/negotiation/n8n"

const KEYS = [
  "N8N_WEBHOOK_SECRET",
  "N8N_BASIC_AUTH_USER",
  "N8N_BASIC_AUTH_PASSWORD",
  "N8N_CHAT_FLOW_URL",
  "N8N_EVENT_FLOW_URL",
  "N8N_SESSION_FLOW_URL",
] as const
const saved: Record<string, string | undefined> = {}

const N8N_HOST = "https://n8n.example.test"
const BODY = JSON.stringify({ success: true, event_id: "evt-1", session_id: "s-1", reply: "oi" })
const BASIC = "Basic " + Buffer.from("flow-user:flow-pass", "utf8").toString("base64")

describe("buildN8nCallbackHeaders (N8N-5)", () => {
  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k]
    for (const k of KEYS) delete process.env[k]
    process.env.N8N_WEBHOOK_SECRET = "test-n8n-secret"
    process.env.N8N_BASIC_AUTH_USER = "flow-user"
    process.env.N8N_BASIC_AUTH_PASSWORD = "flow-pass"
    process.env.N8N_CHAT_FLOW_URL = `${N8N_HOST}/webhook/main-path`
  })

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it("callback no host n8n configurado leva Basic, HMAC válido, timestamp e Event-Id", () => {
    const { headers } = buildN8nCallbackHeaders(`${N8N_HOST}/webhook/callback-path`, BODY, "evt-1")
    expect(headers["Authorization"]).toBe(BASIC)
    expect(headers[N8N_EVENT_ID_HEADER]).toBe("evt-1")
    expect(headers["Content-Type"]).toBe("application/json")
    expect(verifyN8nRequest(BODY, headers[N8N_SIGNATURE_HEADER], headers[N8N_TIMESTAMP_HEADER])).toEqual({ ok: true, matched: "current" })
  })

  it("callback para host desconhecido NÃO leva o Basic (credencial não vaza), mas segue assinado", () => {
    const { headers } = buildN8nCallbackHeaders("https://attacker.example/cb", BODY, "evt-1")
    expect(headers["Authorization"]).toBeUndefined()
    expect(verifyN8nRequest(BODY, headers[N8N_SIGNATURE_HEADER], headers[N8N_TIMESTAMP_HEADER]).ok).toBe(true)
  })

  it("mesma origem exige esquema e porta iguais", () => {
    expect(isConfiguredN8nOrigin(`${N8N_HOST}/webhook/x`)).toBe(true)
    expect(isConfiguredN8nOrigin("http://n8n.example.test/webhook/x")).toBe(false)
    expect(isConfiguredN8nOrigin("https://n8n.example.test:8443/webhook/x")).toBe(false)
    expect(isConfiguredN8nOrigin("https://n8n.example.test.evil.example/webhook/x")).toBe(false)
    expect(isConfiguredN8nOrigin("não é url")).toBe(false)
  })

  it("aceita a origem de N8N_EVENT_FLOW_URL e N8N_SESSION_FLOW_URL", () => {
    delete process.env.N8N_CHAT_FLOW_URL
    process.env.N8N_EVENT_FLOW_URL = "https://events.example.test/webhook/e"
    process.env.N8N_SESSION_FLOW_URL = "https://session.example.test/webhook/s"
    expect(isConfiguredN8nOrigin("https://events.example.test/webhook/cb")).toBe(true)
    expect(isConfiguredN8nOrigin("https://session.example.test/webhook/cb")).toBe(true)
    expect(isConfiguredN8nOrigin(`${N8N_HOST}/webhook/cb`)).toBe(false)
  })

  it("sem N8N_BASIC_AUTH_* configurado, não envia Authorization (comportamento anterior)", () => {
    delete process.env.N8N_BASIC_AUTH_USER
    delete process.env.N8N_BASIC_AUTH_PASSWORD
    const { headers } = buildN8nCallbackHeaders(`${N8N_HOST}/webhook/cb`, BODY, "evt-1")
    expect(headers["Authorization"]).toBeUndefined()
    expect(headers[N8N_SIGNATURE_HEADER]).toMatch(/^sha256=[0-9a-f]{64}$/)
  })
})
