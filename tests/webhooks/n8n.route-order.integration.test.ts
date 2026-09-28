// Integração (branch integration/n8n-latency-2026-09-28) — ordem dos efeitos
// dentro de POST /api/webhooks/n8n depois da união de N8N-2/4/6/7/12/13/15:
//   1. rate limit pré-auth (só para requisição sem assinatura válida)  N8N-12
//   2. verificação HMAC (segredo atual OU anterior)                     N8N-4
//   3. parse
//   4. adaptador do envelope legado                                     N8N-2
//   5. correlação com evento enviado pela plataforma                    N8N-16
//   6. rate limit por identidade                                        N8N-12
//   7. switch:
//      - chat.send: contrato de botões (rótulo do servidor) → guard de texto
//        (N8N-6) — o guard vê o rótulo do SERVIDOR, não o do n8n;
//      - payment.create: alias (N8N-15 a) → efeito → enriquecimento PIX (N8N-15 b).
import { createHmac } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "../journey/_fake-supabase"
import type { OfferTerms } from "@/lib/negotiation/offers"

const SECRET = "test-secret-integration-current"
process.env.N8N_WEBHOOK_SECRET = SECRET
process.env.N8N_WEBHOOK_SECRET_PREVIOUS = "test-secret-integration-previous"
process.env.CHAT_JOURNEY_ENABLED = "true"
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co"
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key"

const order: string[] = []
const guardSaw: string[][] = []

const CO = "c0c0c0c0-0000-4000-8000-0000000000aa"
const SID = "5e55e55e-0000-4000-8000-0000000000aa"
const ctx = { sessionId: SID, companyId: CO, customerId: "cust-int", debtId: "debt-int" }

let db: FakeDb
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/journey/events", () => ({
  recordEvent: async () => ({ ok: true, duplicate: false }),
  getTimeline: async () => [],
}))
vi.mock("@/lib/journey/context", () => ({ buildSessionContext: async () => null }))
vi.mock("@/lib/negotiation/rate-limit", () => ({
  LIMITS: { messagePerSession: { limit: 20, windowSeconds: 60 } },
  rateLimit: async () => ({ allowed: true, remaining: 10 }),
}))
vi.mock("@/lib/negotiation/n8n-rate-limit", () => ({
  n8nUnsignedAllowed: async () => { order.push("rl_preauth"); return { allowed: true } },
  n8nSignedAllowed: async () => { order.push("rl_identity"); return { allowed: true } },
}))
vi.mock("@/lib/negotiation/n8n", async (orig) => {
  const actual = await (orig() as Promise<typeof import("@/lib/negotiation/n8n")>)
  return {
    ...actual,
    verifyN8nRequest: (...a: Parameters<typeof actual.verifyN8nRequest>) => {
      const v = actual.verifyN8nRequest(...a)
      order.push(v.ok ? `verify:${(v as { matched?: string }).matched}` : "verify:fail")
      return v
    },
    markEventSeen: async () => true,
    getCachedTurnResult: async () => null,
    cacheTurnResult: async () => {},
  }
})
vi.mock("@/lib/negotiation/n8n-buttons", async (orig) => {
  const actual = await (orig() as Promise<typeof import("@/lib/negotiation/n8n-buttons")>)
  return {
    ...actual,
    normalizeLegacyN8nEnvelope: (...a: Parameters<typeof actual.normalizeLegacyN8nEnvelope>) => {
      order.push("legacy_adapter")
      return actual.normalizeLegacyN8nEnvelope(...a)
    },
    prepareN8nPrompt: async (...a: Parameters<typeof actual.prepareN8nPrompt>) => {
      order.push("buttons_contract")
      return actual.prepareN8nPrompt(...a)
    },
  }
})
vi.mock("@/lib/negotiation/n8n-correlation", () => ({
  enforceN8nCorrelation: async (body: { action: string }) => {
    order.push(`correlation:${body.action}`)
    return { reject: false }
  },
}))
vi.mock("@/lib/negotiation/n8n-text-guard", async (orig) => {
  const actual = await (orig() as Promise<typeof import("@/lib/negotiation/n8n-text-guard")>)
  return {
    ...actual,
    guardN8nIngest: async (...a: Parameters<typeof actual.guardN8nIngest>) => {
      order.push("text_guard")
      guardSaw.push([a[1].text, ...(a[1].extra ?? [])])
      return actual.guardN8nIngest(...a)
    },
  }
})
vi.mock("@/lib/journey/actions", () => ({
  loadSessionCtx: async (id: string) => (id === SID ? ctx : null),
  debtSummary: async () => ({}), listOffers: async () => [], rejectOffer: async () => {},
  proposeOffer: async () => ({ ok: true }), registerDispute: async () => "c",
  registerPaymentClaim: async () => "c", transferToHuman: async () => "c", closeSession: async () => {},
}))
vi.mock("@/lib/negotiation/offer-alias", async (orig) => {
  const actual = await (orig() as Promise<typeof import("@/lib/negotiation/offer-alias")>)
  return {
    ...actual,
    resolveOfferIdForSession: async (c: { sessionId: string; companyId: string }, raw: string) => {
      order.push(`alias:${raw}`)
      return { ok: true, offerId: OA, alias: raw }
    },
  }
})
vi.mock("@/lib/journey/payment-actions", () => ({
  paymentCreateOrExistingLink: async (_c: unknown, offerId: string) => {
    order.push(`payment_effect:${offerId}`)
    return { ok: true, code: "created", agreement_id: "agr-1", payment_url: "https://pay.test/x" }
  },
  paymentCreateOrLinkResponseForN8n: (r: Record<string, unknown>) => ({ ok: true, agreement_id: r.agreement_id }),
}))
vi.mock("@/lib/journey/payment-instructions", () => ({
  enrichN8nPaymentResponse: async (b: Record<string, unknown>) => {
    order.push("pix_enrichment")
    return { ...b, pix: { copy_paste: "000201-test" } }
  },
}))

const terms = (t: Partial<OfferTerms>): OfferTerms => ({
  original_value: 180, discount_pct: 0, discount_value: 0, entry_value: 0, installments: 1,
  installment_value: 180, total_value: 180, billing_type: "PIX", first_due_date: "2026-10-04", ...t,
})
const OA = "a7ae147d-0b12-42e1-9c69-cb234417c6a3"
const TA = terms({ discount_pct: 5, discount_value: 9, installment_value: 171, total_value: 171 })

function seed() {
  order.length = 0
  guardSaw.length = 0
  db = {
    negotiation_sessions: [{
      id: SID, company_id: CO, customer_id: ctx.customerId, debt_id: ctx.debtId, debt_ids: [ctx.debtId],
      primary_debt_id: ctx.debtId, outcome: "in_progress", status: "active", thread_epoch: 0,
      identity_verified_at: "2026-09-27T12:00:00Z", engine: null,
    }],
    negotiation_offers: [{ id: OA, session_id: SID, company_id: CO, status: "presented", terms: TA, valid_until: null }],
    chat_prompts: [],
    chat_messages: [],
    debts: [{ id: ctx.debtId, company_id: CO, customer_id: ctx.customerId, status: "pending", amount: 180, due_date: "2026-08-15" }],
    agreements: [],
  }
}

function signed(body: unknown, secret = SECRET) {
  const raw = JSON.stringify(body)
  const ts = String(Math.floor(Date.now() / 1000))
  const sig = "sha256=" + createHmac("sha256", secret).update(`${ts}.${raw}`).digest("hex")
  return new Request("https://app.test/api/webhooks/n8n", {
    method: "POST",
    headers: { "content-type": "application/json", "x-alteapay-timestamp": ts, "x-alteapay-signature": sig },
    body: raw,
  })
}

describe("POST /api/webhooks/n8n — ordem dos efeitos (integração)", () => {
  beforeEach(() => {
    delete process.env.N8N_LEGACY_BUTTONS_ADAPTER
    seed()
  })

  it("chat.send assinado: verify → adaptador → correlação → RL identidade → botões → guard (vê o rótulo do servidor)", async () => {
    const { POST } = await import("@/app/api/webhooks/n8n/route")
    const { offerButtonLabel } = await import("@/lib/journey/acknowledgement")
    const res = await POST(signed({
      action: "chat.send",
      event_id: "evt-int-chat-0001",
      session_id: SID,
      args: {
        text: "Escolha a melhor opção:",
        // rótulo FALSO do n8n (90% / R$ 18,00): o guard recusaria se o visse
        prompt: { kind: "offer_choice", question: "Escolha:", buttons: [{ id: 2, label: "À vista R$ 18,00 (90%)", value: OA }] },
      },
    }))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toMatchObject({ ok: true })
    expect(order).toEqual([
      "verify:current",
      "legacy_adapter",
      "correlation:chat.send",
      "rl_identity",
      "buttons_contract",
      "text_guard",
    ])
    expect(order).not.toContain("rl_preauth")
    // o guard recebeu o rótulo do SERVIDOR, nunca o do n8n
    expect(guardSaw).toHaveLength(1)
    expect(guardSaw[0]).toContain(offerButtonLabel(TA))
    expect(guardSaw[0].join(" ")).not.toContain("18,00")
    const active = db.chat_prompts.filter((p) => p.status === "active")
    expect(active[0].buttons[0].label).toBe(offerButtonLabel(TA))
  })

  it("payment.create assinado com o segredo ANTERIOR: correlação antes do efeito; alias → efeito → PIX na resposta", async () => {
    const { POST } = await import("@/app/api/webhooks/n8n/route")
    const res = await POST(signed({
      action: "payment.create",
      event_id: "evt-int-pay-0001",
      session_id: SID,
      args: { offer_id: "avista", billing_type: "PIX" },
    }, "test-secret-integration-previous"))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(order).toEqual([
      "verify:previous",
      "legacy_adapter",
      "correlation:payment.create",
      "rl_identity",
      "alias:avista",
      `payment_effect:${OA}`,
      "pix_enrichment",
    ])
    expect(json).toMatchObject({ offer_id: OA, offer_alias: "avista", pix: { copy_paste: "000201-test" } })
  })

  it("sem assinatura: RL pré-auth conta a requisição e nada do domínio roda", async () => {
    const { POST } = await import("@/app/api/webhooks/n8n/route")
    const res = await POST(new Request("https://app.test/api/webhooks/n8n", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "chat.send", session_id: SID, args: { text: "oi" } }),
    }))
    expect(res.status).toBe(401)
    expect(order).toEqual(["verify:fail", "rl_preauth"])
  })

  it("saída (outbox/chat.turn) assina só com o segredo ATUAL, mesmo com _PREVIOUS configurado", async () => {
    const { buildN8nOutboundHeaders, verifyN8nRequest } = await import("@/lib/negotiation/n8n")
    const raw = JSON.stringify({ event: "session.start" })
    const { headers } = buildN8nOutboundHeaders(raw, "evt-out")
    const v = verifyN8nRequest(raw, headers["x-alteapay-signature"], headers["x-alteapay-timestamp"])
    expect(v).toMatchObject({ ok: true, matched: "current" })
  })
})
