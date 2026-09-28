// Achados de segurança do POST /api/webhooks/n8n:
//   1. session.create atrás de N8N_SESSION_CREATE_ENABLED (default OFF): 403 com
//      código, sem tocar no banco nem criar sessão/deep link.
//   2. session.message async: callback_url só no host n8n configurado; qualquer
//      outro destino → 422 e nada entra na fila.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/negotiation/n8n", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>)
  return {
    ...actual,
    verifyN8nRequest: () => ({ ok: true }),
    markEventSeen: async () => true,
    getCachedTurnResult: async () => null,
    cacheTurnResult: async () => {},
  }
})

vi.mock("@/lib/negotiation/rate-limit", () => ({
  LIMITS: { messagePerSession: { limit: 100, windowSeconds: 60 } },
  rateLimit: async () => ({ allowed: true }),
}))

vi.mock("@/lib/negotiation/n8n-rate-limit", () => ({
  n8nSignedAllowed: async () => ({ allowed: true }),
  n8nUnsignedAllowed: async () => ({ allowed: true }),
}))

vi.mock("@/lib/negotiation/n8n-correlation", () => ({
  enforceN8nCorrelation: async () => ({ reject: false }),
}))

const calls = { handoff: 0, queued: [] as unknown[], db: 0 }

vi.mock("@/lib/negotiation/sessions", () => ({
  createHandoffSession: async () => {
    calls.handoff += 1
    return {
      session: { id: "sess-new", company_id: CO, thread_id: null, token_expires_at: null, fulfillment_mode: "A" },
      token: "tok",
      deep_link: "https://app.test/negociar/tok",
    }
  },
  applyTurnEffects: async () => {},
  loadSessionDebtContext: async () => null,
  loadTenantConfig: async () => null,
  recordMessage: async () => ({ id: "m1" }),
  updateSession: async () => {},
}))

vi.mock("@/lib/queue/queues", () => ({
  n8nQueue: {
    add: async (_name: string, data: unknown) => {
      calls.queued.push(data)
      return { id: "job-1" }
    },
  },
}))

const S1 = "11111111-1111-4111-8111-111111111111"
const CO = "22222222-2222-4222-8222-222222222222"
const DEBT = "33333333-3333-4333-8333-333333333333"

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => {
    calls.db += 1
    const row = (table: string) => {
      if (table === "negotiation_sessions") {
        return { id: S1, company_id: CO, consent_lgpd_at: "2026-09-28T00:00:00Z", thread_id: "thr-1" }
      }
      if (table === "debts") return { id: DEBT, company_id: CO, customer_id: "cust-1", status: "pending" }
      if (table === "customers") return { id: "cust-1", name: "Fulano de Tal", document: "11144477735" }
      return null
    }
    const chain = (table: string): any => {
      const c: any = {
        select: () => c,
        eq: () => c,
        in: () => c,
        order: () => c,
        limit: () => c,
        maybeSingle: async () => ({ data: row(table) }),
        then: (resolve: (v: unknown) => unknown) => resolve({ data: [row(table)] }),
      }
      return c
    }
    return { from: (t: string) => chain(t) }
  },
}))

import { POST } from "@/app/api/webhooks/n8n/route"

const N8N_HOST = "https://n8n.example.test"
const ENV_KEYS = ["N8N_SESSION_CREATE_ENABLED", "N8N_CHAT_FLOW_URL", "N8N_EVENT_FLOW_URL", "N8N_SESSION_FLOW_URL"] as const
const saved: Record<string, string | undefined> = {}

function makeRequest(body: unknown) {
  return new Request("https://app.test/api/webhooks/n8n", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-alteapay-signature": "sha256=stub",
      "x-alteapay-timestamp": String(Math.floor(Date.now() / 1000)),
    },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  calls.handoff = 0
  calls.queued = []
  calls.db = 0
  for (const k of ENV_KEYS) saved[k] = process.env[k]
  for (const k of ENV_KEYS) delete process.env[k]
  process.env.N8N_CHAT_FLOW_URL = `${N8N_HOST}/webhook/main-path`
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe("session.create atrás de N8N_SESSION_CREATE_ENABLED", () => {
  const create = { action: "session.create", company_id: CO, document: "111.444.777-35", identity_verified: true, consent: true }

  it("flag ausente (default): 403 n8n_session_create_disabled, sem banco e sem sessão", async () => {
    const res = await POST(makeRequest(create))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.code).toBe("n8n_session_create_disabled")
    expect(body.deep_link).toBeUndefined()
    expect(body.token).toBeUndefined()
    expect(calls.handoff).toBe(0)
    expect(calls.db).toBe(0)
  })

  it.each(["off", "false", "0", "", "sim"])("flag=%j continua desligada", async (v) => {
    process.env.N8N_SESSION_CREATE_ENABLED = v
    const res = await POST(makeRequest(create))
    expect(res.status).toBe(403)
    expect(calls.handoff).toBe(0)
  })

  it("flag ON: comportamento anterior (cria a sessão)", async () => {
    process.env.N8N_SESSION_CREATE_ENABLED = "on"
    const res = await POST(makeRequest(create))
    expect(res.status).toBe(200)
    expect((await res.json()).session_id).toBe("sess-new")
    expect(calls.handoff).toBe(1)
  })
})

describe("session.message async: callback_url só no host n8n configurado", () => {
  const msg = (callback_url: string) => ({
    action: "session.message",
    session_id: S1,
    message: "oi",
    mode: "async",
    event_id: "evt-cb-0001",
    callback_url,
  })

  it.each([
    "https://attacker.example/collect",
    "http://n8n.example.test/webhook/cb", // esquema diferente
    "https://n8n.example.test:8443/webhook/cb", // porta diferente
    "https://n8n.example.test.evil.example/webhook/cb", // sufixo
    "https://user:pass@n8n.example.test/webhook/cb", // credencial embutida
    "ftp://n8n.example.test/webhook/cb",
  ])("recusa %s com 422 e não enfileira", async (url) => {
    const res = await POST(makeRequest(msg(url)))
    expect(res.status).toBe(422)
    expect((await res.json()).code).toBe("callback_url_not_allowed")
    expect(calls.queued).toHaveLength(0)
  })

  it("sem nenhum fluxo n8n configurado, recusa até o host antigo", async () => {
    delete process.env.N8N_CHAT_FLOW_URL
    const res = await POST(makeRequest(msg(`${N8N_HOST}/webhook/cb`)))
    expect(res.status).toBe(422)
    expect(calls.queued).toHaveLength(0)
  })

  it("aceita o host n8n configurado (202 + job na fila)", async () => {
    const res = await POST(makeRequest(msg(`${N8N_HOST}/webhook/cb`)))
    expect(res.status).toBe(202)
    expect(calls.queued).toHaveLength(1)
    expect((calls.queued[0] as { callback_url: string }).callback_url).toBe(`${N8N_HOST}/webhook/cb`)
  })
})
