// X3: dedupe por event_id na BORDA do webhook, para ações de jornada cujo retry
// é efeito colateral puro (dispute/payment_claim/human/note → abrem
// negotiation_cases, que não tem event_id UNIQUE). Prova:
//   1) 2ª chamada de dispute.register com o MESMO event_id → duplicate:true e a
//      ação de domínio NÃO roda de novo (nenhum caso novo).
//   2) payment.create NÃO é curto-circuitado na borda: sua idempotência própria
//      por (session_id, offer_id) devolve o MESMO payload (link) no reenvio (§8).

import { beforeEach, describe, expect, it, vi } from "vitest"

// Assinatura/anti-replay e rate-limit fora do escopo deste teste → sempre ok.
vi.mock("@/lib/negotiation/n8n", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>)
  return {
    ...actual,
    verifyN8nRequest: () => ({ ok: true }),
    // markEventSeen: primeira vez por chave → true; repetição → false.
    markEventSeen: vi.fn(async (key: string) => {
      const seen = (globalThis as any).__seen ?? new Set<string>()
      ;(globalThis as any).__seen = seen
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }),
    getCachedTurnResult: async () => null,
    cacheTurnResult: async () => {},
  }
})

vi.mock("@/lib/negotiation/rate-limit", () => ({
  LIMITS: { messagePerSession: { limit: 100, windowSeconds: 60 } },
  rateLimit: async () => ({ allowed: true }),
}))

// Conta quantas vezes cada ação de domínio efetivamente roda.
const calls = { registerDispute: 0, paymentCreate: 0 }

vi.mock("@/lib/journey/actions", () => ({
  loadSessionCtx: async () => ({ sessionId: "sess-1", companyId: "co-1", customerId: "cust-1", debtId: "debt-1" }),
  registerDispute: async () => {
    calls.registerDispute += 1
    return `case-${calls.registerDispute}`
  },
  // não usados neste teste mas importados pelo handler:
  debtSummary: async () => ({}),
  listOffers: async () => [],
  proposeOffer: async () => ({ ok: true, offerId: "o1" }),
  rejectOffer: async () => {},
  registerPaymentClaim: async () => "case-x",
  transferToHuman: async () => "case-y",
  closeSession: async () => {},
}))

vi.mock("@/lib/journey/payment-actions", () => ({
  // O route usa o ponto de entrada único paymentCreateOrExistingLink.
  paymentCreateOrExistingLink: async () => {
    calls.paymentCreate += 1
    // idempotência PRÓPRIA: sempre o mesmo agreement/link (idempotent após a 1ª).
    return {
      ok: true,
      status: "created",
      idempotent: calls.paymentCreate > 1,
      payment: {
        agreement_id: "agr-1", payment_id: "pay_1", billing_type: "PIX",
        pix_copy_paste: "0002...", boleto_url: null, boleto_line: null,
        invoice_url: "https://inv", due_date: "2026-09-30", total_value: 100, installments: 1,
      },
    }
  },
  paymentCreateOrLinkResponseForN8n: (r: any) => ({
    ok: true, idempotent: r.idempotent, status: "created",
    agreement_id: r.payment.agreement_id, asaas_payment_id: r.payment.payment_id,
    total_value: 10000,
  }),
  reaisToCents: (v: number | null) => (v == null ? null : Math.round(v * 100)),
}))

// sessionIsVerified consulta o service client → sessão verificada.
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { identity_verified_at: "2026-09-21T00:00:00Z", status: "active", outcome: "in_progress" } }) }) }),
    }),
  }),
}))

function makeRequest(body: unknown) {
  const raw = JSON.stringify(body)
  return new Request("https://app.test/api/webhooks/n8n", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-alteapay-signature": "sha256=stub",
      "x-alteapay-timestamp": String(Math.floor(Date.now() / 1000)),
      "x-forwarded-for": "10.0.0.1",
    },
    body: raw,
  })
}

describe("X3 — dedupe de ação de jornada na borda", () => {
  beforeEach(() => {
    ;(globalThis as any).__seen = new Set<string>()
    calls.registerDispute = 0
    calls.paymentCreate = 0
  })

  it("dispute.register: 2ª chamada com mesmo event_id → duplicate:true, sem reabrir caso", async () => {
    const { POST } = await import("@/app/api/webhooks/n8n/route")
    const body = {
      action: "dispute.register",
      session_id: "11111111-1111-1111-1111-111111111111",
      event_id: "evt-dispute-0001",
      args: { reason: "não reconheço" },
    }
    const r1 = await POST(makeRequest(body))
    const j1 = await r1.json()
    expect(j1.success).toBe(true)
    expect(j1.case_id).toBe("case-1")

    const r2 = await POST(makeRequest(body))
    const j2 = await r2.json()
    expect(j2.duplicate).toBe(true)
    // a ação de domínio NÃO rodou de novo (nenhum caso novo)
    expect(calls.registerDispute).toBe(1)
  })

  it("payment.create NÃO é curto-circuitado na borda: reenvio devolve o MESMO link (idempotent:true)", async () => {
    const { POST } = await import("@/app/api/webhooks/n8n/route")
    const body = {
      action: "payment.create",
      session_id: "22222222-2222-2222-2222-222222222222",
      event_id: "evt-pay-0001",
      args: { offer_id: "offer-1", billing_type: "PIX" },
    }
    const r1 = await POST(makeRequest(body))
    const j1 = await r1.json()
    expect(j1.ok).toBe(true)
    expect(j1.asaas_payment_id).toBe("pay_1")

    const r2 = await POST(makeRequest(body))
    const j2 = await r2.json()
    // reenvio: mesma resposta com idempotent:true (não um duplicate:true genérico)
    expect(j2.ok).toBe(true)
    expect(j2.asaas_payment_id).toBe("pay_1")
    expect(j2.idempotent).toBe(true)
    // paymentCreate rodou nas DUAS vezes (a idempotência é dele, não da borda)
    expect(calls.paymentCreate).toBe(2)
  })
})
