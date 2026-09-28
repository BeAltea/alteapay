// N8N-13: ações flow.context / flow.state.set na borda /api/webhooks/n8n.
//   - exigem a MESMA assinatura HMAC das irmãs (sem assinatura / assinatura
//     errada → 401; a ação nem roda);
//   - escopo pela sessão (sessão inexistente → 404);
//   - rate limit por sessão (429);
//   - erros de validação do estado viram 4xx com `code` estável.
import { createHmac } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"

const SECRET = "test-secret-n8n13"
process.env.N8N_WEBHOOK_SECRET = SECRET

const limits = { flowAllowed: true }
vi.mock("@/lib/negotiation/rate-limit", () => ({
  LIMITS: { messagePerSession: { limit: 100, windowSeconds: 60 } },
  rateLimit: async (key: string) => ({ allowed: key.startsWith("n8n:flow:s:") ? limits.flowAllowed : true }),
}))

vi.mock("@/lib/negotiation/n8n", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>)
  return { ...actual, markEventSeen: async () => true, getCachedTurnResult: async () => null, cacheTurnResult: async () => {} }
})

const SID = "13131313-1313-1313-1313-131313131313"
const calls = { context: 0, set: [] as Array<{ args: unknown; eventId?: string }> }

vi.mock("@/lib/journey/actions", () => ({
  loadSessionCtx: async (id: string) =>
    id === SID ? { sessionId: SID, companyId: "co-13", customerId: "cust-13", debtId: "debt-13" } : null,
  // importados (destructuring) pelo handler de jornada; não usados aqui:
  debtSummary: async () => ({}), listOffers: async () => [], proposeOffer: async () => ({ ok: true }),
  rejectOffer: async () => {}, registerDispute: async () => "c", registerPaymentClaim: async () => "c",
  transferToHuman: async () => "c", closeSession: async () => {},
}))

vi.mock("@/lib/journey/n8n-flow", () => ({
  flowContext: async (ctx: { sessionId: string; companyId: string }) => {
    calls.context += 1
    return {
      session: { id: ctx.sessionId, company_id: ctx.companyId },
      debt: { id: "debt-13", status: "pending", open: true, updated_value: 25000, due_date: "2026-08-15" },
      customer: { id: "cust-13", first_name: "Fabio", document_type: "cpf", document_masked: "***.444.777-**" },
      flow_state: null,
      bootstrap_step: null,
    }
  },
  setFlowState: async (_ctx: unknown, args: any, eventId?: string) => {
    calls.set.push({ args, eventId })
    if (args?.step === "bogus") {
      return { ok: false, status: 422, code: "FLOW_STATE_INVALID", message: "step: inválido" }
    }
    return {
      ok: true, duplicate: false,
      state: { step: args.step, status: args.status ?? null, active: true, ongoing_agreement: null, updated_at: "2026-09-27T00:00:00Z" },
    }
  },
}))

function signed(body: unknown, opts: { badSig?: boolean; noSig?: boolean } = {}) {
  const raw = JSON.stringify(body)
  const ts = String(Math.floor(Date.now() / 1000))
  const sig = createHmac("sha256", opts.badSig ? "wrong" : SECRET).update(`${ts}.${raw}`).digest("hex")
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-alteapay-timestamp": ts,
    "x-forwarded-for": "10.0.0.13",
  }
  if (!opts.noSig) headers["x-alteapay-signature"] = `sha256=${sig}`
  return new Request("https://app.test/api/webhooks/n8n", { method: "POST", headers, body: raw })
}

describe("N8N-13 — flow.context / flow.state.set na borda", () => {
  beforeEach(() => {
    calls.context = 0
    calls.set = []
    limits.flowAllowed = true
  })

  it("flow.context assinado → 200 com o contexto da sessão (company_id da sessão)", async () => {
    const { POST } = await import("@/app/api/webhooks/n8n/route")
    const r = await POST(signed({ action: "flow.context", session_id: SID, event_id: "evt-ctx-0001" }))
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.success).toBe(true)
    expect(j.session.company_id).toBe("co-13")
    expect(j.debt).toMatchObject({ open: true, updated_value: 25000, due_date: "2026-08-15" })
    expect(j.customer.document_masked).toBe("***.444.777-**")
  })

  it("sem assinatura ou com assinatura errada → 401 e a ação não roda", async () => {
    const { POST } = await import("@/app/api/webhooks/n8n/route")
    const body = { action: "flow.context", session_id: SID }
    expect((await POST(signed(body, { noSig: true }))).status).toBe(401)
    expect((await POST(signed(body, { badSig: true }))).status).toBe(401)
    expect(calls.context).toBe(0)
  })

  it("sessão desconhecida → 404", async () => {
    const { POST } = await import("@/app/api/webhooks/n8n/route")
    const r = await POST(signed({ action: "flow.context", session_id: "99999999-9999-9999-9999-999999999999" }))
    expect(r.status).toBe(404)
    expect(calls.context).toBe(0)
  })

  it("rate limit por sessão → 429", async () => {
    limits.flowAllowed = false
    const { POST } = await import("@/app/api/webhooks/n8n/route")
    const r = await POST(signed({ action: "flow.state.set", session_id: SID, args: { step: "negotiation_l1" } }))
    expect(r.status).toBe(429)
    expect(calls.set).toHaveLength(0)
  })

  it("flow.state.set repassa args e event_id; devolve o estado gravado", async () => {
    const { POST } = await import("@/app/api/webhooks/n8n/route")
    const r = await POST(signed({
      action: "flow.state.set", session_id: SID, event_id: "evt-step-0001",
      args: { step: "negotiation_l2", status: "pending" },
    }))
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.flow_state).toMatchObject({ step: "negotiation_l2", status: "pending" })
    expect(calls.set[0]).toEqual({ args: { step: "negotiation_l2", status: "pending" }, eventId: "evt-step-0001" })
  })

  it("flow.state.set inválido → 422 com code estável", async () => {
    const { POST } = await import("@/app/api/webhooks/n8n/route")
    const r = await POST(signed({ action: "flow.state.set", session_id: SID, args: { step: "bogus" } }))
    expect(r.status).toBe(422)
    const j = await r.json()
    expect(j.code).toBe("FLOW_STATE_INVALID")
  })
})
