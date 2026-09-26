// Correção B10 (A1, ALTO) — o "Sincronizar com ASAAS" (/api/asaas/sync-payments)
// e o worker asaas-sync quitavam o acordo PARCELADO pelo status da parcela 1.
// Agora vale o parcelamento inteiro (GET /installments/{id}/payments): só quita
// com TODAS as parcelas pagas; ASAAS indisponível → não quita; cancelamento de
// parcela com outra já paga → acordo mantido (M4).
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

let db: FakeDb = {}
let installmentList: Array<{ id: string; status: string; deleted?: boolean }> | null = null
let parcelOne: { status: number; body: Record<string, unknown> } = { status: 200, body: {} }

vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: (t: string) => makeFakeSupabase(db).from(t) }) }))
vi.mock("@/lib/supabase/url", () => ({ getServerSupabaseUrl: () => "http://fake" }))
vi.mock("next/headers", () => ({ headers: async () => ({ get: () => null }) }))
vi.mock("@/lib/asaas", () => ({ getAsaasInstallmentPayments: async () => installmentList }))

function seed() {
  db = {
    agreements: [{
      id: "ag-3x", company_id: "co", debt_id: "debt-1", user_id: null, agreed_amount: 243.75,
      asaas_payment_id: "pay_1", asaas_subscription_id: "inst_abc", installments: 3,
      status: "active", payment_status: "pending", asaas_status: "PENDING", asaas_last_synced_at: null,
    }],
    debts: [{ id: "debt-1", status: "in_agreement", external_id: "vmax-1" }],
    VMAX: [{ id: "vmax-1", negotiation_status: "EM_ANDAMENTO" }],
    notifications: [],
  }
}

async function runSync() {
  const { POST } = await import("@/app/api/asaas/sync-payments/route")
  const req = { headers: { get: () => null }, json: async () => ({ agreementId: "ag-3x" }) } as any
  return POST(req)
}
const ag = () => db.agreements[0]
const P = (id: string, status: string) => ({ id, status })

describe("Correção B10 (A1) — sync ASAAS não quita parcelado pela parcela 1", () => {
  beforeEach(() => {
    process.env.ASAAS_API_KEY = "test"
    seed()
    installmentList = null
    parcelOne = { status: 200, body: { id: "pay_1", status: "RECEIVED", value: 81.25, installment: "inst_abc" } }
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify(parcelOne.body), { status: parcelOne.status, headers: { "content-type": "application/json" } }),
    )
  })

  it("parcela 1 RECEIVED num 3x (2 e 3 em aberto) → status, dívida e VMAX intactos", async () => {
    installmentList = [P("pay_1", "RECEIVED"), P("pay_2", "PENDING"), P("pay_3", "PENDING")]
    const res = await runSync()
    expect(res.status).toBe(200)
    expect(ag().status).toBe("active")
    expect(ag().payment_status).toBe("pending")
    expect(ag().payment_received_at).toBeUndefined()
    expect(db.debts[0].status).toBe("in_agreement")
    expect(db.VMAX[0].negotiation_status).toBe("EM_ANDAMENTO")
    expect(ag().asaas_last_synced_at).toBeTruthy()
  })

  it("parcelamento indisponível no ASAAS → nunca quita no escuro", async () => {
    installmentList = null
    await runSync()
    expect(ag().status).toBe("active")
    expect(db.debts[0].status).toBe("in_agreement")
  })

  it("todas as parcelas pagas → quita (completed, dívida paid, VMAX PAGO)", async () => {
    installmentList = [P("pay_1", "RECEIVED"), P("pay_2", "CONFIRMED"), P("pay_3", "RECEIVED")]
    await runSync()
    expect(ag().status).toBe("completed")
    expect(db.debts[0].status).toBe("paid")
    expect(db.VMAX[0].negotiation_status).toBe("PAGO")
  })

  it("M4: parcela 1 DELETED (404) com a parcela 2 já paga → acordo NÃO é cancelado nem a dívida reaberta", async () => {
    parcelOne = { status: 404, body: {} }
    installmentList = [P("pay_1", "PENDING"), P("pay_2", "RECEIVED"), P("pay_3", "PENDING")]
    await runSync()
    expect(ag().status).toBe("active")
    expect(db.debts[0].status).toBe("in_agreement")
  })

  it("à vista (1x) continua quitando pelo status da cobrança", async () => {
    ag().installments = 1
    ag().asaas_subscription_id = null
    await runSync()
    expect(ag().status).toBe("completed")
    expect(db.debts[0].status).toBe("paid")
  })
})

describe("Correção B10 (A1) — worker asaas-sync (applyAsaasSyncResult)", () => {
  beforeEach(seed)

  it("parcela 1 RECEIVED num 3x → acordo e dívida intactos; held", async () => {
    const { applyAsaasSyncResult } = await import("@/lib/queue/workers/asaas-sync-apply")
    const r = await applyAsaasSyncResult(makeFakeSupabase(db), {
      agreementId: "ag-3x", debtId: "debt-1", payment: { id: "pay_1", status: "RECEIVED", installment: "inst_abc" },
      listPayments: async () => [P("pay_1", "RECEIVED"), P("pay_2", "PENDING"), P("pay_3", "PENDING")],
    })
    expect(r.held).toBe("installment_not_fully_paid")
    expect(ag().status).toBe("active")
    expect(db.debts[0].status).toBe("in_agreement")
  })

  it("todas pagas → aplica como antes", async () => {
    const { applyAsaasSyncResult } = await import("@/lib/queue/workers/asaas-sync-apply")
    const r = await applyAsaasSyncResult(makeFakeSupabase(db), {
      agreementId: "ag-3x", debtId: "debt-1", payment: { id: "pay_3", status: "RECEIVED" },
      listPayments: async () => [P("pay_1", "RECEIVED"), P("pay_2", "RECEIVED"), P("pay_3", "RECEIVED")],
    })
    expect(r.held).toBeNull()
    expect(ag().status).toBe("paid")
    expect(db.debts[0].status).toBe("paid")
  })

  it("checkInstallmentHold (regra única): pago parcial segura; todas pagas passa; cancelamento com parcela paga segura", async () => {
    const { checkInstallmentHold } = await import("@/lib/asaas-installments")
    const list = async () => [P("a", "RECEIVED"), P("b", "PENDING")]
    expect((await checkInstallmentHold({ installments: 2, installmentId: "i", status: "RECEIVED", listPayments: list })).hold).toBe(true)
    expect((await checkInstallmentHold({ installments: 2, installmentId: "i", status: "PAYMENT_RECEIVED", listPayments: async () => null, knownPaidPaymentIds: ["a", "b"] })).hold).toBe(false)
    expect((await checkInstallmentHold({ installments: 2, installmentId: "i", status: "PAYMENT_DELETED", listPayments: list })).hold).toBe(true)
    expect((await checkInstallmentHold({ installments: 2, installmentId: "i", status: "OVERDUE", listPayments: list })).hold).toBe(false)
    expect((await checkInstallmentHold({ installments: 1, installmentId: null, status: "RECEIVED", listPayments: list })).hold).toBe(false)
  })
})
