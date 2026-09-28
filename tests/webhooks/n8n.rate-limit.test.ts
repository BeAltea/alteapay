// N8N-12 — rate limit do /api/webhooks/n8n pela IDENTIDADE autenticada (sessão
// e cedente), não pelo IP do salto de proxy. Contador em memória no lugar do
// Redis (mesma semântica de janela fixa do rateLimit real).
import { createHmac } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const SECRET = "test-secret-n8n12"
process.env.N8N_WEBHOOK_SECRET = SECRET

const counters = new Map<string, number>()
vi.mock("@/lib/negotiation/rate-limit", () => ({
  LIMITS: { messagePerSession: { limit: 20, windowSeconds: 60 } },
  rateLimit: async (key: string, limit: number) => {
    const n = (counters.get(key) ?? 0) + 1
    counters.set(key, n)
    return { allowed: n <= limit, remaining: Math.max(0, limit - n) }
  },
}))

vi.mock("@/lib/negotiation/n8n", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>)
  return { ...actual, markEventSeen: async () => true, getCachedTurnResult: async () => null, cacheTurnResult: async () => {} }
})

const COMPANY = "c0c0c0c0-0000-4000-8000-000000000001"
const lookups = { n: 0 }
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            lookups.n += 1
            return { data: { company_id: COMPANY } }
          },
        }),
      }),
    }),
  }),
}))

const domain = { runs: 0 }
vi.mock("@/lib/journey/actions", () => ({
  loadSessionCtx: async (id: string) => ({ sessionId: id, companyId: COMPANY, customerId: "cust", debtId: "debt" }),
  debtSummary: async () => { domain.runs += 1; return {} },
  listOffers: async () => { domain.runs += 1; return [] },
  rejectOffer: async () => { domain.runs += 1 },
  proposeOffer: async () => ({ ok: true }), registerDispute: async () => "c", registerPaymentClaim: async () => "c",
  transferToHuman: async () => "c", closeSession: async () => {},
}))
vi.mock("@/lib/journey/events", () => ({ getTimeline: async () => { domain.runs += 1; return [] } }))
vi.mock("@/lib/journey/n8n-flow", () => ({
  flowContext: async (ctx: { sessionId: string }) => { domain.runs += 1; return { session: { id: ctx.sessionId } } },
  setFlowState: async () => { domain.runs += 1; return { ok: true, duplicate: false, state: { step: "x" } } },
}))

// N8N-16 (correlação) roda antes do rate limit por identidade e faz suas
// próprias leituras; aqui ela é neutra para contar só o lookup do N8N-12.
vi.mock("@/lib/negotiation/n8n-correlation", () => ({
  enforceN8nCorrelation: async () => ({ reject: false }),
}))

const N8N_IP = "34.95.10.10" // o n8n sai sempre do MESMO IP

function req(body: unknown, opts: { sig?: "ok" | "bad" | "none"; ip?: string } = {}) {
  const raw = JSON.stringify(body)
  const ts = String(Math.floor(Date.now() / 1000))
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-alteapay-timestamp": ts,
    "x-forwarded-for": opts.ip ?? N8N_IP,
  }
  const sig = opts.sig ?? "ok"
  if (sig !== "none") {
    const hex = createHmac("sha256", sig === "bad" ? "wrong" : SECRET).update(`${ts}.${raw}`).digest("hex")
    headers["x-alteapay-signature"] = `sha256=${hex}`
  }
  return new Request("https://app.test/api/webhooks/n8n", { method: "POST", headers, body: raw })
}

const sid = (i: number) => `5e55e55e-0000-4000-8000-${String(i).padStart(12, "0")}`

/** Os 6 callbacks de um turno do fluxo (N8N-13). */
const turnCalls = (s: string) => [
  { action: "flow.context", session_id: s },
  { action: "debt.summary", session_id: s },
  { action: "offer.list", session_id: s },
  { action: "offer.reject", session_id: s, args: { offer_id: "parc_3" } },
  { action: "journey.timeline", session_id: s },
  { action: "flow.state.set", session_id: s, args: { step: "negotiation_l1" } },
]

const ENV_KEYS = [
  "N8N_RATE_LIMIT_MODE", "N8N_RL_COMPANY_PER_MIN", "N8N_RL_SESSION_PER_MIN",
  "N8N_RL_UNSIGNED_PER_MIN", "TRUSTED_CLIENT_IP_SOURCE",
]

describe("N8N-12 — rate limit do webhook n8n por identidade", () => {
  beforeEach(async () => {
    counters.clear()
    lookups.n = 0
    domain.runs = 0
    const { __resetN8nRateLimitCache } = await import("@/lib/negotiation/n8n-rate-limit")
    __resetN8nRateLimitCache()
  })
  afterEach(() => { for (const k of ENV_KEYS) delete process.env[k] })

  it("200 turnos/min × 6 callbacks do MESMO IP, sessões distintas → nenhum 429", async () => {
    const { POST } = await import("@/app/api/webhooks/n8n/route")
    const statuses = new Map<number, number>()
    for (let t = 0; t < 200; t++) {
      for (const body of turnCalls(sid(t))) {
        const r = await POST(req(body))
        statuses.set(r.status, (statuses.get(r.status) ?? 0) + 1)
      }
    }
    expect(statuses.get(429) ?? 0).toBe(0)
    expect(statuses.get(200)).toBe(1200)
    expect(domain.runs).toBe(1200)
    // a dimensão por cedente contou todas as chamadas; o lookup sessão→cedente é cacheado
    expect(counters.get(`n8n:c:${COMPANY}`)).toBe(1200)
    expect(lookups.n).toBe(200)
    // o balde por IP antigo não existe mais
    expect([...counters.keys()].some((k) => k.startsWith("n8n:ip:"))).toBe(false)
  })

  it("a mesma carga no modo legacy (120/min por IP) estouraria — prova do N8N-12", async () => {
    process.env.N8N_RATE_LIMIT_MODE = "legacy"
    const { POST } = await import("@/app/api/webhooks/n8n/route")
    let first429 = -1
    let i = 0
    outer: for (let t = 0; t < 30; t++) {
      for (const body of turnCalls(sid(t))) {
        i += 1
        if ((await POST(req(body))).status === 429) { first429 = i; break outer }
      }
    }
    expect(first429).toBe(121) // ~20 turnos
  })

  it("uma sessão acima do teto por sessão → 429 (as demais seguem)", async () => {
    const { POST } = await import("@/app/api/webhooks/n8n/route")
    const s = sid(9001)
    for (let i = 0; i < 60; i++) {
      expect((await POST(req({ action: "debt.summary", session_id: s }))).status).toBe(200)
    }
    const over = await POST(req({ action: "debt.summary", session_id: s }))
    expect(over.status).toBe(429)
    expect(domain.runs).toBe(60)
    expect((await POST(req({ action: "debt.summary", session_id: sid(9002) }))).status).toBe(200)
  })

  it("flow.* usa o limite por sessão do N8N-13 (não dobrado pelo N8N-12)", async () => {
    const { POST } = await import("@/app/api/webhooks/n8n/route")
    const s = sid(9100)
    for (let i = 0; i < 60; i++) await POST(req({ action: "flow.context", session_id: s }))
    expect(counters.get(`n8n:s:${s}`)).toBeUndefined()
    expect((await POST(req({ action: "flow.context", session_id: s }))).status).toBe(429)
    // outras ações da mesma sessão têm o próprio balde
    expect((await POST(req({ action: "offer.list", session_id: s }))).status).toBe(200)
  })

  it("teto por cedente (env) → 429 mesmo com sessões novas", async () => {
    process.env.N8N_RL_COMPANY_PER_MIN = "10"
    const { POST } = await import("@/app/api/webhooks/n8n/route")
    for (let i = 0; i < 10; i++) {
      expect((await POST(req({ action: "offer.list", session_id: sid(i) }))).status).toBe(200)
    }
    expect((await POST(req({ action: "offer.list", session_id: sid(99) }))).status).toBe(429)
  })

  it("session.create conta no cedente do corpo, sem lookup", async () => {
    process.env.N8N_RL_COMPANY_PER_MIN = "1"
    const { n8nSignedAllowed } = await import("@/lib/negotiation/n8n-rate-limit")
    const h = new Headers()
    expect((await n8nSignedAllowed({ action: "session.create", company_id: COMPANY }, h)).allowed).toBe(true)
    expect(await n8nSignedAllowed({ action: "session.create", company_id: COMPANY }, h)).toMatchObject({ allowed: false, scope: "company" })
    expect(lookups.n).toBe(0)
  })

  it("flood sem assinatura / assinatura errada → 429 cedo, sem tocar no domínio; o n8n legítimo segue", async () => {
    const { POST } = await import("@/app/api/webhooks/n8n/route")
    const statuses: number[] = []
    for (let i = 0; i < 100; i++) {
      const r = await POST(req({ action: "debt.summary", session_id: sid(i) }, { sig: i % 2 ? "none" : "bad", ip: `203.0.113.${i}` }))
      statuses.push(r.status)
    }
    expect(statuses.slice(0, 60).every((s) => s === 401)).toBe(true)
    expect(statuses.slice(60).every((s) => s === 429)).toBe(true)
    expect(domain.runs).toBe(0)
    expect(lookups.n).toBe(0)
    // XFF variado não abre baldes novos (sem IP confiável → balde comum)
    expect(counters.get("n8n:bad:global")).toBe(100)
    // tráfego assinado nunca consome o balde pré-auth
    expect((await POST(req({ action: "debt.summary", session_id: sid(1) }))).status).toBe(200)
  })

  it("com IP confiável ligado, o balde pré-auth é por IP de verdade", async () => {
    process.env.TRUSTED_CLIENT_IP_SOURCE = "netlify"
    process.env.N8N_RL_UNSIGNED_PER_MIN = "3"
    const { n8nUnsignedAllowed } = await import("@/lib/negotiation/n8n-rate-limit")
    const bad = new Headers({ "x-nf-client-connection-ip": "198.51.100.1" })
    const other = new Headers({ "x-nf-client-connection-ip": "198.51.100.2" })
    for (let i = 0; i < 3; i++) expect((await n8nUnsignedAllowed(bad)).allowed).toBe(true)
    expect((await n8nUnsignedAllowed(bad)).allowed).toBe(false)
    expect((await n8nUnsignedAllowed(other)).allowed).toBe(true)
  })

  it("legacy: inválido volta 401 sem contar (comportamento de hoje)", async () => {
    process.env.N8N_RATE_LIMIT_MODE = "legacy"
    const { POST } = await import("@/app/api/webhooks/n8n/route")
    for (let i = 0; i < 80; i++) {
      expect((await POST(req({ action: "debt.summary", session_id: sid(1) }, { sig: "none" }))).status).toBe(401)
    }
    expect(counters.size).toBe(0)
  })

  it("ping assinado (sem sessão/cedente) usa o balde signed:misc", async () => {
    const { n8nSignedAllowed } = await import("@/lib/negotiation/n8n-rate-limit")
    await n8nSignedAllowed({ action: "ping" }, new Headers())
    expect(counters.get("n8n:signed:misc")).toBe(1)
  })
})
