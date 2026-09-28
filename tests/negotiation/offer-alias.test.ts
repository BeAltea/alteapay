// N8N-15 (a) — aliases 'avista' / 'parc_N' no payment.create do n8n.
// Resolução pura + borda do webhook (alias → uuid → mesmo caminho de cobrança).

import { beforeEach, describe, expect, it, vi } from "vitest"
import { parseOfferAlias, pickOfferForAlias, type AliasOfferRow } from "@/lib/negotiation/offer-alias"

const NOW = Date.parse("2026-09-27T12:00:00Z")
const FUTURE = "2026-10-04T12:00:00.000Z"
const PAST = "2026-09-20T12:00:00.000Z"

const U_AVISTA = "aaaaaaaa-0000-4000-8000-000000000001"
const U_PARC2 = "aaaaaaaa-0000-4000-8000-000000000002"
const U_PARC3 = "aaaaaaaa-0000-4000-8000-000000000003"
const U_AI_AVISTA = "aaaaaaaa-0000-4000-8000-000000000009"

function offer(id: string, installments: number, over: Partial<AliasOfferRow> = {}): AliasOfferRow {
  return {
    id,
    status: "presented",
    valid_until: FUTURE,
    source: "system",
    created_at: "2026-09-27T11:00:00Z",
    terms: {
      installments,
      discount_value: installments === 1 ? 29 : 10,
      total_value: installments === 1 ? 171 : 190,
    },
    ...over,
  }
}

/** Conjunto da matriz: à vista + 2x + 3x (mesmo valid_until). */
const matrixSet = () => [offer(U_AVISTA, 1), offer(U_PARC2, 2), offer(U_PARC3, 3)]

describe("parseOfferAlias", () => {
  it("avista → 1 parcela; parc_N → N", () => {
    expect(parseOfferAlias("avista")).toEqual({ raw: "avista", installments: 1 })
    expect(parseOfferAlias("AVISTA")).toEqual({ raw: "avista", installments: 1 })
    expect(parseOfferAlias("parc_3")).toEqual({ raw: "parc_3", installments: 3 })
  })
  it("não-alias → null (uuid, parc_1, parc_0, lixo)", () => {
    expect(parseOfferAlias(U_AVISTA)).toBeNull()
    expect(parseOfferAlias("parc_1")).toBeNull()
    expect(parseOfferAlias("parc_0")).toBeNull()
    expect(parseOfferAlias("parc_x")).toBeNull()
    expect(parseOfferAlias("a vista")).toBeNull()
  })
})

describe("pickOfferForAlias", () => {
  it("'avista' resolve para a oferta à vista apresentada", () => {
    expect(pickOfferForAlias(parseOfferAlias("avista")!, matrixSet(), NOW)).toEqual({
      ok: true, offerId: U_AVISTA, via: "presented",
    })
  })

  it("'parc_3' resolve para a oferta 3x", () => {
    expect(pickOfferForAlias(parseOfferAlias("parc_3")!, matrixSet(), NOW)).toEqual({
      ok: true, offerId: U_PARC3, via: "presented",
    })
  })

  it("alias sem oferta do tipo → OFFER_ALIAS_NOT_FOUND", () => {
    const r = pickOfferForAlias(parseOfferAlias("parc_6")!, matrixSet(), NOW)
    expect(r).toMatchObject({ ok: false, code: "OFFER_ALIAS_NOT_FOUND" })
    expect(pickOfferForAlias(parseOfferAlias("avista")!, [], NOW)).toMatchObject({
      ok: false, code: "OFFER_ALIAS_NOT_FOUND",
    })
  })

  it("ambíguo (n8n propôs um à vista próprio além do da matriz) → OFFER_ALIAS_AMBIGUOUS", () => {
    const rows = [...matrixSet(), offer(U_AI_AVISTA, 1, { source: "ai", valid_until: null })]
    expect(pickOfferForAlias(parseOfferAlias("avista")!, rows, NOW)).toMatchObject({
      ok: false, code: "OFFER_ALIAS_AMBIGUOUS", candidates: 2,
    })
  })

  it("só vencida → OFFER_EXPIRED (nunca cobra oferta vencida)", () => {
    const rows = matrixSet().map((r) => ({ ...r, valid_until: PAST }))
    expect(pickOfferForAlias(parseOfferAlias("avista")!, rows, NOW)).toMatchObject({
      ok: false, code: "OFFER_EXPIRED",
    })
  })

  it("oferta integral do PAGAR (0%/1x, purpose) não conta como 'avista'", () => {
    const integral = offer("aaaaaaaa-0000-4000-8000-00000000000f", 1, {
      terms: { installments: 1, discount_value: 0, total_value: 200, purpose: "pay_integral" },
      valid_until: "2026-09-28T00:00:00.000Z",
    })
    expect(pickOfferForAlias(parseOfferAlias("avista")!, [...matrixSet(), integral], NOW)).toEqual({
      ok: true, offerId: U_AVISTA, via: "presented",
    })
  })

  it("após o aceite (irmãs superseded) o alias cai na oferta aceita do tipo", () => {
    const rows = [
      offer(U_AVISTA, 1, { status: "accepted" }),
      offer(U_PARC2, 2, { status: "superseded" }),
      offer(U_PARC3, 3, { status: "superseded" }),
    ]
    expect(pickOfferForAlias(parseOfferAlias("avista")!, rows, NOW)).toEqual({
      ok: true, offerId: U_AVISTA, via: "accepted",
    })
    // outro tipo, não apresentado nem aceito → não encontrado
    expect(pickOfferForAlias(parseOfferAlias("parc_3")!, rows, NOW)).toMatchObject({
      ok: false, code: "OFFER_ALIAS_NOT_FOUND",
    })
  })
})

// ---------------- borda: POST /api/webhooks/n8n payment.create ----------------

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

const SESSION = "11111111-1111-4111-8111-111111111111"

vi.mock("@/lib/journey/actions", () => ({
  loadSessionCtx: async () => ({ sessionId: SESSION, companyId: "co-1", customerId: "cust-1", debtId: "debt-1" }),
  debtSummary: async () => ({}),
  listOffers: async () => [],
  proposeOffer: async () => ({ ok: true, offerId: "o1" }),
  rejectOffer: async () => {},
  registerDispute: async () => "case",
  registerPaymentClaim: async () => "case",
  transferToHuman: async () => "case",
  closeSession: async () => {},
}))

// Estado em memória: ofertas da sessão + cobranças por oferta (simula a
// idempotência (sessão, oferta) de paymentCreate e o aceite do confirmAccept).
const db = {
  offers: [] as AliasOfferRow[],
  chargesByOffer: new Map<string, string>(),
  asaasCreates: 0,
  seenOfferIds: [] as string[],
}

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      const filters: Record<string, unknown> = {}
      const chain: any = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          filters[col] = val
          return chain
        },
        maybeSingle: async () => ({
          data: { identity_verified_at: "2026-09-21T00:00:00Z", status: "active", outcome: "in_progress" },
        }),
        then: (resolve: (v: unknown) => void) => {
          if (table === "negotiation_offers") {
            expect(filters.session_id).toBe(SESSION)
            expect(filters.company_id).toBe("co-1")
            resolve({ data: db.offers.map((o) => ({ ...o })) })
          } else resolve({ data: [] })
        },
      }
      return chain
    },
  }),
}))

vi.mock("@/lib/journey/payment-actions", () => ({
  paymentCreateOrExistingLink: async (_ctx: unknown, offerId: string) => {
    db.seenOfferIds.push(offerId)
    const known = db.offers.find((o) => o.id === offerId)
    if (!known || (known.status !== "presented" && known.status !== "accepted")) {
      return { ok: false, status: 409, code: "OFFER_NOT_AVAILABLE", message: "OFFER_NOT_AVAILABLE" }
    }
    let payId = db.chargesByOffer.get(offerId)
    const idempotent = Boolean(payId)
    if (!payId) {
      db.asaasCreates += 1
      payId = `pay_${db.asaasCreates}`
      db.chargesByOffer.set(offerId, payId)
      for (const o of db.offers) o.status = o.id === offerId ? "accepted" : o.status === "presented" ? "superseded" : o.status
    }
    return {
      ok: true, status: "created", idempotent,
      payment: {
        agreement_id: `agr-${offerId.slice(-1)}`, payment_id: payId, billing_type: "PIX",
        pix_copy_paste: null, boleto_url: null, boleto_line: null,
        invoice_url: `https://www.asaas.com/i/${payId}`, due_date: "2026-10-04",
        total_value: 171, installments: 1,
      },
    }
  },
  paymentCreateOrLinkResponseForN8n: (r: any) =>
    r.ok
      ? {
          ok: true, idempotent: r.idempotent, status: r.status,
          agreement_id: r.payment.agreement_id, asaas_payment_id: r.payment.payment_id,
          billing_type: r.payment.billing_type, invoice_url: r.payment.invoice_url,
          total_value: 17100, pix_copy_paste: null, pix_qr_code_url: null,
        }
      : { ok: false, code: r.code },
  reaisToCents: (v: number | null) => (v == null ? null : Math.round(v * 100)),
}))

// ASAAS nunca é chamado: as instruções PIX são isoladas neste teste.
vi.mock("@/lib/journey/payment-instructions", () => ({
  enrichN8nPaymentResponse: async (b: Record<string, unknown>) => b,
  enrichN8nPaymentObject: async (p: unknown) => p,
}))

function req(offerId: string, eventId = "evt-00000001") {
  return new Request("https://app.test/api/webhooks/n8n", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-alteapay-signature": "sha256=stub",
      "x-alteapay-timestamp": String(Math.floor(Date.now() / 1000)),
      "x-forwarded-for": "10.0.0.2",
    },
    body: JSON.stringify({ action: "payment.create", session_id: SESSION, event_id: eventId, args: { offer_id: offerId, billing_type: "PIX" } }),
  })
}

describe("payment.create com alias (borda n8n)", () => {
  beforeEach(() => {
    db.offers = matrixSet()
    db.chargesByOffer = new Map()
    db.asaasCreates = 0
    db.seenOfferIds = []
  })

  it("'avista' → uuid da oferta à vista; resposta traz offer_id e offer_alias", async () => {
    const { POST } = await import("@/app/api/webhooks/n8n/route")
    const res = await POST(req("avista"))
    const j = await res.json()
    expect(res.status).toBe(200)
    expect(j).toMatchObject({ ok: true, status: "created", idempotent: false, offer_id: U_AVISTA, offer_alias: "avista" })
    expect(db.seenOfferIds).toEqual([U_AVISTA])
  })

  it("'parc_3' → oferta 3x", async () => {
    const { POST } = await import("@/app/api/webhooks/n8n/route")
    const j = await (await POST(req("parc_3"))).json()
    expect(j.offer_id).toBe(U_PARC3)
    expect(db.seenOfferIds).toEqual([U_PARC3])
  })

  it("alias sem oferta → 409 OFFER_ALIAS_NOT_FOUND, sem chegar à cobrança", async () => {
    const { POST } = await import("@/app/api/webhooks/n8n/route")
    const res = await POST(req("parc_6"))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe("OFFER_ALIAS_NOT_FOUND")
    expect(db.seenOfferIds).toEqual([])
  })

  it("alias ambíguo → 409 OFFER_ALIAS_AMBIGUOUS, sem chegar à cobrança", async () => {
    db.offers.push(offer(U_AI_AVISTA, 1, { source: "ai", valid_until: null }))
    const { POST } = await import("@/app/api/webhooks/n8n/route")
    const res = await POST(req("avista"))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe("OFFER_ALIAS_AMBIGUOUS")
    expect(db.seenOfferIds).toEqual([])
  })

  it("uuid continua funcionando (sem resolução)", async () => {
    const { POST } = await import("@/app/api/webhooks/n8n/route")
    const j = await (await POST(req(U_PARC2))).json()
    expect(j).toMatchObject({ ok: true, status: "created", offer_id: U_PARC2, offer_alias: null })
    expect(db.seenOfferIds).toEqual([U_PARC2])
  })

  it("idempotência cruzada: uuid depois alias (e alias depois uuid) → MESMA cobrança", async () => {
    const { POST } = await import("@/app/api/webhooks/n8n/route")
    const a = await (await POST(req(U_AVISTA, "evt-000000a"))).json()
    const b = await (await POST(req("avista", "evt-000000b"))).json()
    const c = await (await POST(req("avista", "evt-000000a"))).json()
    expect(a.asaas_payment_id).toBe("pay_1")
    expect(b).toMatchObject({ idempotent: true, asaas_payment_id: "pay_1", offer_id: U_AVISTA })
    expect(c).toMatchObject({ idempotent: true, asaas_payment_id: "pay_1" })
    expect(db.asaasCreates).toBe(1)

    // ordem inversa, sessão nova
    db.offers = matrixSet()
    db.chargesByOffer = new Map()
    db.asaasCreates = 0
    const d = await (await POST(req("parc_2", "evt-000000d"))).json()
    const e = await (await POST(req(U_PARC2, "evt-000000e"))).json()
    expect(d.asaas_payment_id).toBe(e.asaas_payment_id)
    expect(e.idempotent).toBe(true)
    expect(db.asaasCreates).toBe(1)
  })
})
