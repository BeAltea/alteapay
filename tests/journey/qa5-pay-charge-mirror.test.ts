// QA rodada 5 (Q2-01, ALTO) — o Pagar nunca pode deixar cobrança ASAAS sem
// espelho local. Prova, pelas bibliotecas REAIS (confirmAccept → closeAgreement
// → charge-inline) com banco em memória e ASAAS mockado:
//  1. o espelho (acordo + aceite offer→agreement + sessão→acordo) existe ANTES do
//     POST /payments;
//  2. função "morta" entre o POST e o write-back → clique repetido NÃO cria 2ª
//     cobrança (idempotência por sessão/oferta → 'processing'), outra oferta
//     também não (guard pending_charge), e a reconciliação pela externalReference
//     espelha a cobrança;
//  3. prazo da função: passado o orçamento, a cobrança não começa (zero escrita
//     antes do fechamento; desfeita se estourar dentro do inline);
//  4. órfão sem cobrança no ASAAS após a janela de graça → cancelado, poll 'failed';
//  5. customer ASAAS conhecido → pula a busca por CPF (latência);
//  6. Server-Timing por etapa.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

const CO = "eeeeeeee-0000-0000-0000-0000000000q5"
const SESSION = "5e550000-0000-0000-0000-000000000001"
const DEBT = "d5000000-0000-4000-8000-000000000001"
const CUST = "c5000000-0000-0000-0000-000000000001"
const OFFER = "0ffe0000-0000-0000-0000-000000000001"
const OFFER2 = "0ffe0000-0000-0000-0000-000000000002"
const ctx = { sessionId: SESSION, companyId: CO, customerId: CUST, debtId: DEBT }

let db: FakeDb
let asaasCustomerPayments: any[] = []
let byExternalRef: Record<string, any> = {}
let lookupThrows = false
let events: string[] = []
const calls: string[] = []
let onCreatePayment: ((params: any) => void) | null = null
let failWriteBack = false

vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    const real = makeFakeSupabase(db)
    return {
      from(table: string) {
        const qb: any = real.from(table)
        if (table === "agreements" && failWriteBack) {
          // simula a função MORTA entre o POST /payments e o write-back
          qb.update = () => { throw new Error("function killed (simulado)") }
        }
        return qb
      },
    }
  },
}))
vi.mock("@/lib/asaas", () => ({
  getAsaasPaymentsForCustomer: async () => { calls.push("list"); return asaasCustomerPayments },
  getAsaasCustomerByCpfCnpj: async () => { calls.push("lookup"); return { id: "cus_found" } },
  updateAsaasCustomer: async () => { calls.push("update_customer"); return { id: "cus_found" } },
  createAsaasCustomer: async () => { calls.push("create_customer"); return { id: "cus_new" } },
  createAsaasPayment: async (params: any) => {
    calls.push("create_payment")
    onCreatePayment?.(params)
    const p = {
      id: `pay_${calls.filter((c) => c === "create_payment").length}`,
      customer: params.customer, status: "PENDING", billingType: params.billingType,
      value: params.value, dueDate: params.dueDate, externalReference: params.externalReference,
      invoiceUrl: `https://asaas/i/${params.externalReference}`, bankSlipUrl: null, pixQrCodeUrl: null,
    }
    byExternalRef[params.externalReference] = p
    return p
  },
  getAsaasPaymentByExternalReference: async (ref: string) => {
    calls.push("lookup_ref")
    if (lookupThrows) throw new Error("asaas down")
    return byExternalRef[ref] ?? null
  },
  getAsaasPayment: async () => null,
}))
vi.mock("@/lib/journey/events", () => ({
  recordEvent: async (e: any) => { events.push(e.type); return { ok: true, duplicate: false } },
}))
vi.mock("@/lib/journey/actions", () => ({
  rejectOffer: async (_c: any, offerId: string, _a: string, reason: string) => {
    const o = db.negotiation_offers!.find((x) => x.id === offerId)
    if (o) { o.status = "rejected"; o.reject_reason = reason }
  },
  registerPaymentClaim: async () => "case",
  debtSummary: async () => ({ agingDays: 40, originalValue: 250 }),
}))
vi.mock("@/lib/negotiation/matrix", () => ({
  resolveMatrixRow: async () => ({ id: "m1", max_discount_pct: 10, max_installments: 3, allowed_billing_types: ["PIX"], proposal_validity_days: 3 }),
}))
vi.mock("@/lib/negotiation/offers", () => ({ validateProposedTerms: () => ({ ok: true }) }))

const TERMS = {
  original_value: 250, discount_pct: 0, discount_value: 0, entry_value: 0, installments: 1,
  installment_value: 250, total_value: 250, billing_type: "PIX", first_due_date: "2026-09-29",
}

function seed() {
  db = {
    tenant_chat_config: [{ company_id: CO, payment_origin: "platform", acknowledgement_enabled: false, allow_payment_without_acknowledgement: true }],
    companies: [{ id: CO, name: "VMAX" }],
    customers: [{ id: CUST, company_id: CO, name: "Teste", document: "11144477735", email: null, phone: null }],
    debts: [{ id: DEBT, company_id: CO, customer_id: CUST, amount: 250, status: "pending", due_date: "2026-08-15" }],
    negotiation_sessions: [{ id: SESSION, company_id: CO, agreement_id: null }],
    negotiation_offers: [
      { id: OFFER, session_id: SESSION, terms: TERMS, status: "presented", valid_until: null },
      { id: OFFER2, session_id: SESSION, terms: TERMS, status: "presented", valid_until: null },
    ],
    negotiation_acceptances: [],
    agreements: [],
    debt_acknowledgement_latest: [],
  }
  asaasCustomerPayments = []
  byExternalRef = {}
  lookupThrows = false
  events = []
  calls.length = 0
  onCreatePayment = null
  failWriteBack = false
}

async function confirm(offerId = OFFER, chargeNotAfter: number | null = null) {
  const { buildAcceptSummary, confirmAccept } = await import("@/lib/journey/closing")
  const pre = await buildAcceptSummary(ctx, offerId)
  if (!pre.ok) throw new Error(pre.error)
  return confirmAccept({ ctx, offerId, termsHash: pre.summary.termsHash, pre: pre.summary, chargeNotAfter })
}

const ageAgreement = (id: string, ms: number) => {
  const ag = db.agreements!.find((a) => a.id === id)!
  ag.created_at = new Date(Date.now() - ms).toISOString()
}

beforeEach(() => {
  seed()
  process.env.CHARGE_MODE = "inline"
})
afterEach(() => {
  delete process.env.CHARGE_MODE
  vi.useRealTimers()
})

describe("espelho ANTES do ASAAS (Q2-01 b)", () => {
  it("no instante do POST /payments o acordo, o aceite offer→agreement e o vínculo sessão→acordo já existem", async () => {
    let snapshot: any = null
    onCreatePayment = (params) => {
      const ag = db.agreements![0]
      snapshot = {
        agreement: ag && { id: ag.id, asaas_payment_id: ag.asaas_payment_id ?? null, origin: ag.origin, offer_id: ag.offer_id },
        acceptance: db.negotiation_acceptances!.find((a) => a.offer_id === OFFER)?.agreement_id ?? null,
        sessionAgreement: db.negotiation_sessions![0].agreement_id,
        offerStatus: db.negotiation_offers!.find((o) => o.id === OFFER)!.status,
        externalReference: params.externalReference,
      }
    }
    const r = await confirm()
    expect(r.ok).toBe(true)
    expect(snapshot.agreement.asaas_payment_id).toBeNull()
    expect(snapshot.agreement.origin).toBe("chat_journey")
    expect(snapshot.acceptance).toBe(snapshot.agreement.id)
    expect(snapshot.sessionAgreement).toBe(snapshot.agreement.id)
    expect(snapshot.offerStatus).toBe("accepted")
    expect(snapshot.externalReference).toBe(`journey_${SESSION}_${OFFER}`)
    // depois do POST, write-back normal
    expect(db.agreements![0].asaas_payment_id).toBe("pay_1")
    // a outra oferta apresentada é superseded (depois da cobrança)
    expect(db.negotiation_offers!.find((o) => o.id === OFFER2)!.status).toBe("superseded")
    expect(events).toEqual(expect.arrayContaining(["offer.accepted", "agreement.created", "payment.generated"]))
  })
})

describe("função morta entre criar no ASAAS e espelhar → nunca 2ª cobrança", () => {
  async function killedMidCharge() {
    failWriteBack = true
    const r = await confirm()
    failWriteBack = false
    // numa função morta nada roda depois do POST: a outra oferta continua
    // apresentada (o fake executa o resto do confirm; desfazemos o supersede).
    db.negotiation_offers!.find((o) => o.id === OFFER2)!.status = "presented"
    return r
  }

  it("o acordo fica pending_charge (sem asaas_payment_id) e a cobrança existe no ASAAS", async () => {
    await killedMidCharge()
    expect(db.agreements).toHaveLength(1)
    expect(db.agreements![0].asaas_payment_id ?? null).toBeNull()
    expect(byExternalRef[`journey_${SESSION}_${OFFER}`]).toBeTruthy()
    const { isPendingCharge } = await import("@/lib/journey/charge-reconcile")
    expect(isPendingCharge(db.agreements![0] as any)).toBe(true)
  })

  it("clique repetido na MESMA oferta → 'processing' idempotente, ZERO POST novo", async () => {
    await killedMidCharge()
    const { paymentCreate } = await import("@/lib/journey/payment-actions")
    const r = await paymentCreate(ctx, OFFER)
    expect(r).toMatchObject({ ok: true, status: "processing", idempotent: true })
    expect(calls.filter((c) => c === "create_payment")).toHaveLength(1)
  })

  it("aceite de OUTRA oferta com o órfão ainda jovem → ALREADY_CHARGED (guard pending_charge), ZERO POST novo", async () => {
    await killedMidCharge()
    // customer ASAAS desconhecido localmente (write-back morreu): o guard ASAAS
    // antigo não veria nada — o guard pending_charge segura.
    const r = await confirm(OFFER2)
    expect(r).toEqual({ ok: false, error: "ALREADY_CHARGED" })
    expect(calls.filter((c) => c === "create_payment")).toHaveLength(1)
  })

  it("reconciliação pela externalReference espelha a cobrança (poll) e depois bloqueia qualquer nova", async () => {
    await killedMidCharge()
    const agId = db.agreements![0].id
    ageAgreement(agId, 25_000)
    const { reconcilePendingCharge } = await import("@/lib/journey/charge-reconcile")
    expect(await reconcilePendingCharge(db.agreements![0] as any)).toBe("linked")
    expect(db.agreements![0].asaas_payment_id).toBe("pay_1")
    expect(db.agreements![0].asaas_invoice_url).toBe(`https://asaas/i/journey_${SESSION}_${OFFER}`)
    // idempotente: 2ª reconciliação não faz nada
    expect(await reconcilePendingCharge(db.agreements![0] as any)).toBe("skip")
    const r = await confirm(OFFER2)
    expect(r).toEqual({ ok: false, error: "ALREADY_CHARGED" })
    expect(calls.filter((c) => c === "create_payment")).toHaveLength(1)
  })

  it("GET /api/chat/payment reconcilia o órfão e entrega o link (ready)", async () => {
    await killedMidCharge()
    ageAgreement(db.agreements![0].id, 25_000)
    process.env.CHAT_JOURNEY_ENABLED = "true"
    vi.doMock("@/lib/negotiation/crypto", () => ({ verifyChatJwt: () => ({ sid: SESSION }), CHAT_COOKIE_NAME: "c" }))
    const { GET } = await import("@/app/api/chat/payment/route")
    const req: any = { cookies: { get: () => ({ value: "jwt" }) } }
    const res = await GET(req)
    const body = await res.json()
    expect(body.status).toBe("ready")
    expect(body.payment.invoiceUrl).toBe(`https://asaas/i/journey_${SESSION}_${OFFER}`)
    vi.doUnmock("@/lib/negotiation/crypto")
  })
})

describe("órfão SEM cobrança no ASAAS (POST nunca chegou)", () => {
  function seedOrphan(ageMs: number) {
    db.agreements!.push({
      id: "ag_orphan", company_id: CO, customer_id: CUST, debt_id: DEBT, origin: "chat_journey",
      offer_id: OFFER, negotiation_session_id: SESSION, status: "active", payment_status: "pending",
      asaas_payment_id: null, created_at: new Date(Date.now() - ageMs).toISOString(),
    })
    db.negotiation_acceptances!.push({ offer_id: OFFER, session_id: SESSION, company_id: CO, agreement_id: "ag_orphan" })
    db.negotiation_sessions![0].agreement_id = "ag_orphan"
    db.debts![0].status = "in_negotiation"
  }

  it("dentro da janela de graça → 'pending' (a request original pode estar viva)", async () => {
    seedOrphan(25_000)
    const { reconcilePendingCharge } = await import("@/lib/journey/charge-reconcile")
    expect(await reconcilePendingCharge(db.agreements![0] as any)).toBe("pending")
    expect(db.agreements![0].status).toBe("active")
  })

  it("passada a janela (inline) → cancelado, dívida volta a pending, poll responde 'failed'", async () => {
    seedOrphan(60_000)
    const { reconcilePendingCharge } = await import("@/lib/journey/charge-reconcile")
    expect(await reconcilePendingCharge(db.agreements![0] as any)).toBe("cancelled")
    expect(db.agreements![0]).toMatchObject({ status: "cancelled", payment_status: "cancelled" })
    expect(db.debts![0].status).toBe("pending")
    process.env.CHAT_JOURNEY_ENABLED = "true"
    vi.doMock("@/lib/negotiation/crypto", () => ({ verifyChatJwt: () => ({ sid: SESSION }), CHAT_COOKIE_NAME: "c" }))
    const { GET } = await import("@/app/api/chat/payment/route")
    const body = await (await GET({ cookies: { get: () => ({ value: "jwt" }) } } as any)).json()
    expect(body).toMatchObject({ status: "failed", reason: "charge_not_created" })
    vi.doUnmock("@/lib/negotiation/crypto")
    const { interpretPaymentPoll } = await import("@/lib/journey/pay-poll")
    expect(interpretPaymentPoll(body).status).toBe("failed")
  })

  it("CHARGE_MODE=queue nunca cancela (o worker pode criar depois)", async () => {
    process.env.CHARGE_MODE = "queue"
    seedOrphan(10 * 60_000)
    const { reconcilePendingCharge } = await import("@/lib/journey/charge-reconcile")
    expect(await reconcilePendingCharge(db.agreements![0] as any)).toBe("pending")
    expect(db.agreements![0].status).toBe("active")
  })

  it("ASAAS indisponível na consulta → 'pending' (nunca cancela no escuro)", async () => {
    seedOrphan(10 * 60_000)
    lookupThrows = true
    const { reconcilePendingCharge } = await import("@/lib/journey/charge-reconcile")
    expect(await reconcilePendingCharge(db.agreements![0] as any)).toBe("pending")
    expect(db.agreements![0].status).toBe("active")
  })

  it("acordo legado (sem origin jornada) nunca é tocado", async () => {
    const { isPendingCharge } = await import("@/lib/journey/charge-reconcile")
    expect(isPendingCharge({ id: "x", origin: null, offer_id: OFFER, negotiation_session_id: SESSION, asaas_payment_id: null, payment_status: "pending" })).toBe(false)
    expect(isPendingCharge({ id: "x", origin: "chat_journey", offer_id: OFFER, negotiation_session_id: SESSION, asaas_payment_id: "pay_1", payment_status: "pending" })).toBe(false)
    expect(isPendingCharge({ id: "x", origin: "chat_journey", offer_id: OFFER, negotiation_session_id: SESSION, asaas_payment_id: null, payment_status: "cancelled" })).toBe(false)
  })

  it("aceite de outra oferta com órfão vencido e sem cobrança → cancela o órfão e cobra normalmente (1 POST)", async () => {
    seedOrphan(60_000)
    const r = await confirm(OFFER2)
    expect(r.ok).toBe(true)
    expect(db.agreements!.find((a) => a.id === "ag_orphan")!.status).toBe("cancelled")
    expect(calls.filter((c) => c === "create_payment")).toHaveLength(1)
  })
})

describe("prazo da função: a cobrança só COMEÇA dentro do orçamento (Q2-01 c)", () => {
  it("prazo vencido antes do fechamento → CHARGE_DEFERRED sem nenhuma escrita nem chamada ASAAS", async () => {
    const r = await confirm(OFFER, Date.now() - 1)
    expect(r).toEqual({ ok: false, error: "CHARGE_DEFERRED" })
    expect(db.agreements).toHaveLength(0)
    expect(db.negotiation_acceptances).toHaveLength(0)
    expect(db.negotiation_offers!.find((o) => o.id === OFFER)!.status).toBe("presented")
    expect(calls.filter((c) => c.startsWith("create") || c.includes("customer"))).toEqual([])
  })

  it("prazo estoura DURANTE o preparo do customer → POST /payments não é enviado e o espelho é desfeito", async () => {
    // o update do customer "demora" além do prazo
    const asaas: any = await import("@/lib/asaas")
    const notAfter = Date.now() + 50
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(Date.now())
    const spy = vi.spyOn(asaas, "updateAsaasCustomer").mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 1_000)
      return { id: "cus_known" }
    })
    db.agreements!.push({ id: "ag_old", company_id: CO, customer_id: CUST, asaas_customer_id: "cus_known", asaas_payment_id: "pay_old", status: "cancelled", payment_status: "cancelled" })
    const r = await confirm(OFFER, notAfter)
    spy.mockRestore()
    expect(r).toEqual({ ok: false, error: "CHARGE_DEFERRED" })
    expect(calls).not.toContain("create_payment")
    const created = db.agreements!.find((a) => a.id !== "ag_old")!
    expect(created).toMatchObject({ status: "cancelled", payment_status: "cancelled" })
    expect(db.negotiation_acceptances).toHaveLength(0)
    expect(db.negotiation_offers!.find((o) => o.id === OFFER)!.status).toBe("presented")
    expect(db.negotiation_sessions![0].agreement_id).toBeNull()
    expect(db.debts![0].status).toBe("pending")
    // o próximo clique (sem prazo estourado) cobra normalmente, 1 POST
    const again = await confirm(OFFER)
    expect(again.ok).toBe(true)
    expect(calls.filter((c) => c === "create_payment")).toHaveLength(1)
  })

  it("paymentCreate com prazo vencido → rótulo curto 'charge_deferred' (503), sem cobrança", async () => {
    const { paymentCreate } = await import("@/lib/journey/payment-actions")
    const r = await paymentCreate(ctx, OFFER, undefined, { chargeNotAfter: Date.now() - 1 })
    expect(r).toMatchObject({ ok: false, status: 503, code: "charge_deferred" })
    expect(db.agreements).toHaveLength(0)
    expect(calls).not.toContain("create_payment")
  })

  it("payChargeStartBudgetMs: default 17 s, configurável, com piso", async () => {
    const { payChargeStartBudgetMs } = await import("@/lib/journey/pay")
    expect(payChargeStartBudgetMs()).toBe(17_000)
    process.env.PAY_CHARGE_START_BUDGET_MS = "15000"
    expect(payChargeStartBudgetMs()).toBe(15_000)
    process.env.PAY_CHARGE_START_BUDGET_MS = "5"
    expect(payChargeStartBudgetMs()).toBe(17_000)
    delete process.env.PAY_CHARGE_START_BUDGET_MS
  })
})

describe("latência: customer ASAAS conhecido pula a busca por CPF", () => {
  it("com asaas_customer_id em acordo anterior → sem lookup; update de supressão mantido; 1 POST", async () => {
    db.agreements!.push({ id: "ag_old", company_id: CO, customer_id: CUST, asaas_customer_id: "cus_known", asaas_payment_id: "pay_old", status: "cancelled", payment_status: "cancelled" })
    const r = await confirm()
    expect(r.ok).toBe(true)
    expect(calls).not.toContain("lookup")
    expect(calls).toContain("update_customer")
    expect(calls.filter((c) => c === "create_payment")).toHaveLength(1)
    const created = db.agreements!.find((a) => a.id !== "ag_old")!
    expect(created.asaas_customer_id).toBe("cus_known")
  })

  it("sem customer conhecido → busca por CPF (comportamento anterior)", async () => {
    await confirm()
    expect(calls).toContain("lookup")
  })
})

describe("Server-Timing por etapa", () => {
  it("runWithTimings coleta as etapas do caminho da cobrança", async () => {
    const { runWithTimings, formatServerTiming } = await import("@/lib/journey/server-timing")
    const { timings } = await runWithTimings(() => confirm())
    const header = formatServerTiming(timings)
    for (const step of ["guard_local", "close", "asaas_customer_lookup", "asaas_customer_update", "asaas_payment", "charge_writeback", "close_events"]) {
      expect(header).toMatch(new RegExp(`${step};dur=\\d+`))
    }
  })

  it("timed fora de runWithTimings só executa", async () => {
    const { timed } = await import("@/lib/journey/server-timing")
    expect(await timed("x", async () => 42)).toBe(42)
  })
})
