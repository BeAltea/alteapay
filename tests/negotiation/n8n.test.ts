// Segurança do webhook n8n: assinatura HMAC, janela de timestamp e
// comparação em tempo constante (lib/negotiation/n8n.ts).

import { beforeEach, describe, expect, it } from "vitest"

import { signN8nPayload, verifyN8nRequest } from "@/lib/negotiation/n8n"

const SECRET = "test-n8n-secret"
const BODY = JSON.stringify({ action: "ping" })

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

describe("n8n webhook security", () => {
  beforeEach(() => {
    process.env.N8N_WEBHOOK_SECRET = SECRET
  })

  it("aceita assinatura válida dentro da janela", () => {
    const ts = String(nowSeconds())
    const sig = signN8nPayload(BODY, ts)
    expect(verifyN8nRequest(BODY, sig, ts)).toEqual({ ok: true })
  })

  it("rejeita corpo adulterado", () => {
    const ts = String(nowSeconds())
    const sig = signN8nPayload(BODY, ts)
    const tampered = JSON.stringify({ action: "session.status", session_id: "x" })
    const result = verifyN8nRequest(tampered, sig, ts)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(401)
  })

  it("rejeita assinatura de outro secret", () => {
    const ts = String(nowSeconds())
    const sig = signN8nPayload(BODY, ts, "outro-secret")
    expect(verifyN8nRequest(BODY, sig, ts).ok).toBe(false)
  })

  it("rejeita timestamp fora da janela (replay)", () => {
    const stale = String(nowSeconds() - 301)
    const sig = signN8nPayload(BODY, stale)
    const result = verifyN8nRequest(BODY, sig, stale)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain("timestamp")
  })

  it("aceita timestamp no limite da janela", () => {
    const edge = String(nowSeconds() - 299)
    const sig = signN8nPayload(BODY, edge)
    expect(verifyN8nRequest(BODY, sig, edge).ok).toBe(true)
  })

  it("rejeita timestamp não-inteiro ou ausente", () => {
    const ts = String(nowSeconds())
    const sig = signN8nPayload(BODY, ts)
    expect(verifyN8nRequest(BODY, sig, null).ok).toBe(false)
    expect(verifyN8nRequest(BODY, sig, "abc").ok).toBe(false)
  })

  it("rejeita header sem prefixo sha256=", () => {
    const ts = String(nowSeconds())
    const sig = signN8nPayload(BODY, ts).replace("sha256=", "")
    expect(verifyN8nRequest(BODY, sig, ts).ok).toBe(false)
  })

  it("responde 503 quando o secret não está configurado", () => {
    delete process.env.N8N_WEBHOOK_SECRET
    const ts = String(nowSeconds())
    const result = verifyN8nRequest(BODY, "sha256=00", ts)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(503)
  })

  it("assinatura muda com o timestamp (binding anti-replay)", () => {
    const a = signN8nPayload(BODY, "1000000000")
    const b = signN8nPayload(BODY, "1000000001")
    expect(a).not.toEqual(b)
  })
})
