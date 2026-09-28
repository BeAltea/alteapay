// N8N-12 — consumidores do IP (contact-lead, /api/negotiation/*) seguem a flag
// TRUSTED_CLIENT_IP_SOURCE: desligada → chave de hoje; ligada → IP confiável.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const hdr = { current: new Headers() }
vi.mock("next/headers", () => ({
  headers: () => hdr.current,
  cookies: () => ({ get: () => undefined, set: () => {} }),
}))
vi.mock("@/lib/notifications/sendgrid", () => ({ sendEmailViaSendGrid: async () => ({ success: true }) }))

const keys: string[] = []
vi.mock("@/lib/negotiation/rate-limit", () => ({
  LIMITS: {
    resolvePerIp: { limit: 10, windowSeconds: 60 },
    messagePerSession: { limit: 20, windowSeconds: 60 },
    messagePerIp: { limit: 40, windowSeconds: 60 },
  },
  rateLimit: async (key: string) => { keys.push(key); return { allowed: true, remaining: 1 } },
}))
vi.mock("@/lib/negotiation/sessions", () => ({
  getSessionFromCookie: async () => null, loadSessionDebtContext: async () => null,
  loadTenantConfig: async () => null, resolveHandoffToken: async () => ({ ok: false }), updateSession: async () => {},
}))
vi.mock("@/lib/negotiation/engine", () => ({ engineSessionInit: async () => {} }))

const CLIENT_A = "198.51.100.10"
const CLIENT_B = "198.51.100.11"
const HOP = "100.64.7.7"

const lead = (i: number) => ({
  nome: "Fulano de Tal", email: `f${i}@example.com`, telefone: "11999998888", organizacao: "Org Teste",
  tipo: "empresa" as const, mensagem: "Mensagem de teste suficiente.", consentimento: true as const,
})

describe("contact-lead segue a fonte de IP", () => {
  beforeEach(() => { process.env.CONTACT_FORM_DRY_RUN = "true"; vi.resetModules() })
  afterEach(() => { delete process.env.TRUSTED_CLIENT_IP_SOURCE; delete process.env.CONTACT_FORM_DRY_RUN })

  it("flag desligada (hoje): todos atrás do mesmo salto dividem 5/min", async () => {
    const { submitContactLead } = await import("@/app/actions/contact-lead")
    const results = []
    for (let i = 0; i < 6; i++) {
      hdr.current = new Headers({ "x-forwarded-for": `${i % 2 ? CLIENT_A : CLIENT_B}, ${HOP}` })
      results.push((await submitContactLead(lead(i) as any)).ok)
    }
    expect(results).toEqual([true, true, true, true, true, false])
  })

  it("flag netlify: cada cliente real tem o próprio balde; XFF forjado não abre balde novo", async () => {
    process.env.TRUSTED_CLIENT_IP_SOURCE = "netlify"
    const { submitContactLead } = await import("@/app/actions/contact-lead")
    for (let i = 0; i < 5; i++) {
      hdr.current = new Headers({ "x-nf-client-connection-ip": CLIENT_A, "x-forwarded-for": `9.9.9.${i}, ${HOP}` })
      expect((await submitContactLead(lead(i) as any)).ok).toBe(true)
    }
    hdr.current = new Headers({ "x-nf-client-connection-ip": CLIENT_A, "x-forwarded-for": `1.2.3.4, ${HOP}` })
    expect((await submitContactLead(lead(9) as any)).ok).toBe(false)
    hdr.current = new Headers({ "x-nf-client-connection-ip": CLIENT_B, "x-forwarded-for": HOP })
    expect((await submitContactLead(lead(10) as any)).ok).toBe(true)
  })
})

describe("/api/negotiation/session/resolve — chave do rate limit", () => {
  beforeEach(() => { keys.length = 0 })
  afterEach(() => { delete process.env.TRUSTED_CLIENT_IP_SOURCE })

  const call = async (h: Record<string, string>) => {
    const { POST } = await import("@/app/api/negotiation/session/resolve/route")
    await POST(new Request("https://app.test/api/negotiation/session/resolve", {
      method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify({ token: "x" }),
    }))
    return keys[keys.length - 1]
  }

  it("flag desligada → chave de hoje (último do XFF = salto)", async () => {
    expect(await call({ "x-nf-client-connection-ip": "", "x-forwarded-for": `${CLIENT_A}, ${HOP}` })).toBe(`resolve:${HOP}`)
  })
  it("flag netlify → IP da borda; sem ele → balde comum 'unknown' (igual a hoje)", async () => {
    process.env.TRUSTED_CLIENT_IP_SOURCE = "netlify"
    expect(await call({ "x-nf-client-connection-ip": CLIENT_A, "x-forwarded-for": `6.6.6.6, ${HOP}` })).toBe(`resolve:${CLIENT_A}`)
    expect(await call({ "x-forwarded-for": `${CLIENT_A}, ${HOP}` })).toBe("resolve:unknown")
  })
})
