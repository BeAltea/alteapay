// Worker alteapay-n8n (modo async): o callback_url é conferido de novo, ANTES de
// rodar o turno. Fora do host n8n configurado → nenhum turno, nenhum fetch,
// nenhum retry (o job termina com refused). No host configurado → entrega
// assinada como antes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/queue/worker-manager", () => ({
  WorkerManager: { registerWorker: () => ({}) },
}))

vi.mock("@/lib/queue/config", () => ({
  QUEUE_CONFIG: { n8n: { name: "alteapay-n8n" } },
}))

const calls = { turns: 0, db: 0 }

vi.mock("@/lib/negotiation/turn", () => ({
  runChatbotTurn: async () => {
    calls.turns += 1
    return { reply: "ok", events: [], action: null }
  },
}))

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => {
    calls.db += 1
    const c: any = {
      select: () => c,
      eq: () => c,
      maybeSingle: async () => ({ data: { id: "s-1", company_id: "co-1" } }),
    }
    return { from: () => c }
  },
}))

vi.mock("@/lib/negotiation/n8n", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>)
  return { ...actual, getCachedTurnResult: async () => null, cacheTurnResult: async () => {} }
})

import { processN8nJob, type N8nJobData } from "@/lib/queue/workers/n8n.worker"

const N8N_HOST = "https://n8n.example.test"
const KEYS = ["N8N_WEBHOOK_SECRET", "N8N_CHAT_FLOW_URL", "N8N_EVENT_FLOW_URL", "N8N_SESSION_FLOW_URL"] as const
const saved: Record<string, string | undefined> = {}
let fetchMock: ReturnType<typeof vi.fn>

function job(callback_url: string) {
  return { id: "42", data: { session_id: "s-1", message: "oi", callback_url, event_id: "evt-1" } as N8nJobData } as any
}

beforeEach(() => {
  calls.turns = 0
  calls.db = 0
  for (const k of KEYS) saved[k] = process.env[k]
  for (const k of KEYS) delete process.env[k]
  process.env.N8N_WEBHOOK_SECRET = "test-n8n-secret"
  process.env.N8N_CHAT_FLOW_URL = `${N8N_HOST}/webhook/main-path`
  fetchMock = vi.fn(async () => new Response("{}", { status: 200 }))
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe("processN8nJob — callback_url", () => {
  it.each([
    "https://attacker.example/collect",
    "https://n8n.example.test.evil.example/webhook/cb",
    "https://user:pass@n8n.example.test/webhook/cb",
    "não é url",
  ])("recusa %s sem turno e sem POST", async (url) => {
    const r = await processN8nJob(job(url))
    expect(r).toEqual({ delivered: false, refused: "callback_url_not_allowed" })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(calls.turns).toBe(0)
    expect(calls.db).toBe(0)
  })

  it("não loga a URL recusada", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await processN8nJob(job("https://attacker.example/secret-path-123"))
    const logged = warn.mock.calls.flat().join(" ")
    expect(logged).not.toContain("attacker.example")
    expect(logged).not.toContain("secret-path-123")
    warn.mockRestore()
  })

  it("host n8n configurado: roda o turno e entrega assinado", async () => {
    const r = await processN8nJob(job(`${N8N_HOST}/webhook/cb`))
    expect(r).toEqual({ delivered: true, cached: true })
    expect(calls.turns).toBe(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${N8N_HOST}/webhook/cb`)
    expect((init.headers as Record<string, string>)["x-alteapay-signature"]).toMatch(/^sha256=/)
  })
})
