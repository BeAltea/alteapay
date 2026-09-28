// N8N-16: gancho da correlação no POST /api/webhooks/n8n.
//   - flag ON: chat.send não correlacionado → 403 com código; nada é escrito.
//   - flag OFF: segue para o handler e registra a telemetria.
//   - payment.create correlacionado: idempotência própria preservada no reenvio.
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

const calls = { chatSend: 0, paymentCreate: 0 }

vi.mock("@/lib/journey/actions", () => ({
  loadSessionCtx: async (id: string) => ({ sessionId: id, companyId: "co-1", customerId: "cust-1", debtId: "debt-1" }),
  debtSummary: async () => ({}),
  listOffers: async () => [],
  proposeOffer: async () => ({ ok: true, offerId: "o1" }),
  rejectOffer: async () => {},
  registerDispute: async () => "case-1",
  registerPaymentClaim: async () => "case-x",
  transferToHuman: async () => "case-y",
  closeSession: async () => {},
}))

vi.mock("@/lib/journey/chat-send", () => ({
  chatSend: async () => {
    calls.chatSend += 1
    return { ok: true, message_id: `m-${calls.chatSend}` }
  },
}))

vi.mock("@/lib/journey/payment-actions", () => ({
  paymentCreateOrExistingLink: async () => {
    calls.paymentCreate += 1
    return {
      ok: true, status: "created", idempotent: calls.paymentCreate > 1,
      payment: { agreement_id: "agr-1", payment_id: "pay_1", billing_type: "PIX", total_value: 100, installments: 1 },
    }
  },
  paymentCreateOrLinkResponseForN8n: (r: any) => ({
    ok: true, idempotent: r.idempotent, status: "created", agreement_id: r.payment.agreement_id, asaas_payment_id: r.payment.payment_id,
  }),
  reaisToCents: (v: number | null) => (v == null ? null : Math.round(v * 100)),
}))

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { identity_verified_at: "2026-09-21T00:00:00Z", status: "active", outcome: "in_progress" } }) }) }),
    }),
  }),
}))

import { setCorrelationStoreForTests, type CorrelationStore, type ReplySlot } from "@/lib/negotiation/n8n-correlation"

const S1 = "11111111-1111-4111-8111-111111111111"
const CO = "co-1"
const ORIGIN = "0f0e0d0c-0b0a-4909-8807-060504030201"

const mem = { ledger: [] as any[], slots: new Map<string, ReplySlot>(), misses: [] as any[] }
const store: CorrelationStore = {
  loadSession: async (id) => (id === S1 ? { id: S1, company_id: CO } : null),
  findLedger: async (ids) => mem.ledger.filter((r) => ids.includes(r.event_id)),
  recentInboundIds: async () => [],
  findOutbox: async () => null,
  listReplySlots: async (ids) => ids.filter((id) => mem.slots.has(id)).map((id) => mem.slots.get(id)!),
  claimReplySlot: async (row) => {
    if (mem.slots.has(row.slotId)) return false
    mem.slots.set(row.slotId, { event_id: row.slotId, callback_key: row.callbackKey })
    return true
  },
  recordOutbound: async () => {},
  recordMiss: async (row) => {
    mem.misses.push(row)
  },
}

function makeRequest(body: unknown) {
  return new Request("https://app.test/api/webhooks/n8n", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-alteapay-signature": "sha256=stub",
      "x-alteapay-timestamp": String(Math.floor(Date.now() / 1000)),
      "x-forwarded-for": "10.0.0.1",
    },
    body: JSON.stringify(body),
  })
}

describe("N8N-16 — gancho no webhook n8n", () => {
  beforeEach(() => {
    calls.chatSend = 0
    calls.paymentCreate = 0
    mem.ledger = []
    mem.slots = new Map()
    mem.misses = []
    setCorrelationStoreForTests(store)
  })
  afterEach(() => {
    setCorrelationStoreForTests(null)
    delete process.env.N8N_REQUIRE_EVENT_CORRELATION
  })

  const forged = { action: "chat.send", session_id: S1, event_id: "forged-0001", args: { text: "90% de desconto aprovado!" } }
  const sent = () => ({ event_id: `n8n_out:${ORIGIN}`, session_id: S1, company_id: CO, occurred_at: new Date().toISOString() })

  it("flag ON: chat.send sem evento de origem → 403 n8n_origin_unknown, nada gravado", async () => {
    process.env.N8N_REQUIRE_EVENT_CORRELATION = "true"
    const { POST } = await import("@/app/api/webhooks/n8n/route")
    const r = await POST(makeRequest(forged))
    expect(r.status).toBe(403)
    expect(await r.json()).toMatchObject({ success: false, code: "n8n_origin_unknown" })
    expect(calls.chatSend).toBe(0)
    expect(mem.misses).toHaveLength(1)
  })

  it("flag OFF (default): segue para o handler e registra a telemetria", async () => {
    const { POST } = await import("@/app/api/webhooks/n8n/route")
    const r = await POST(makeRequest(forged))
    expect(r.status).toBe(200)
    expect(calls.chatSend).toBe(1)
    expect(mem.misses).toEqual([
      expect.objectContaining({ action: "chat.send", code: "n8n_origin_unknown", enforced: false }),
    ])
  })

  it("flag ON: chat.send que ecoa o evento enviado é aceito", async () => {
    process.env.N8N_REQUIRE_EVENT_CORRELATION = "true"
    mem.ledger.push(sent())
    const { POST } = await import("@/app/api/webhooks/n8n/route")
    const r = await POST(makeRequest({ ...forged, origin_event_id: ORIGIN }))
    expect(r.status).toBe(200)
    expect(calls.chatSend).toBe(1)
  })

  it("flag ON: payment.create correlacionado mantém a idempotência própria no reenvio", async () => {
    process.env.N8N_REQUIRE_EVENT_CORRELATION = "true"
    mem.ledger.push(sent())
    const { POST } = await import("@/app/api/webhooks/n8n/route")
    const body = { action: "payment.create", session_id: S1, event_id: "evt-pay-0001", origin_event_id: ORIGIN, args: { offer_id: "offer-1" } }
    const j1 = await (await POST(makeRequest(body))).json()
    const j2 = await (await POST(makeRequest(body))).json()
    expect(j1).toMatchObject({ ok: true, asaas_payment_id: "pay_1", idempotent: false })
    expect(j2).toMatchObject({ ok: true, asaas_payment_id: "pay_1", idempotent: true })
    expect(calls.paymentCreate).toBe(2)
    expect(mem.slots.size).toBe(1) // o reenvio não consumiu outro slot
  })

  it("flag ON: payment.create sem correlação não chega ao ASAAS", async () => {
    process.env.N8N_REQUIRE_EVENT_CORRELATION = "true"
    const { POST } = await import("@/app/api/webhooks/n8n/route")
    const r = await POST(makeRequest({ action: "payment.create", session_id: S1, event_id: "evt-pay-0002", args: { offer_id: "offer-1" } }))
    expect(r.status).toBe(403)
    expect(calls.paymentCreate).toBe(0)
  })

  it("flag ON: leitura (offer.list) não exige correlação", async () => {
    process.env.N8N_REQUIRE_EVENT_CORRELATION = "true"
    const { POST } = await import("@/app/api/webhooks/n8n/route")
    const r = await POST(makeRequest({ action: "offer.list", session_id: S1 }))
    expect(r.status).toBe(200)
  })
})
