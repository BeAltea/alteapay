// N8N-13: flow.context / flow.state.set — o fluxo n8n lê e grava o próprio
// estado NA PLATAFORMA (nunca num banco paralelo). Prova:
//   - contexto escopado pela sessão (company_id da sessão), valores em centavos,
//     PII mínima (1º nome + doc mascarado; nunca doc em claro/hash/telefone/e-mail,
//     nem com as duas flags do tenant ligadas);
//   - dívida aberta/fechada pelo status REAL de produção (pending/in_negotiation);
//   - o vencimento é o de produção (não o do banco paralelo);
//   - flow.state.set valida step/status, recusa PII e rascunho grande, grava em
//     journey_events sem customer_id e é lido de volta pelo flow.context;
//   - o mesmo event_id reenviado gera o MESMO event_id de jornada (idempotente).
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

const CO = "cccccccc-0000-0000-0000-000000000013"
const OTHER_CO = "dddddddd-0000-0000-0000-000000000013"
const SID = "5e551013-0000-0000-0000-000000000001"
const CTX = { sessionId: SID, companyId: CO, customerId: "cust1", debtId: "debt1" }

let db: FakeDb
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => makeFakeSupabase(db),
}))
vi.mock("@/lib/negotiation/matrix", () => ({
  resolveMatrixRow: async () => ({
    id: "m-43d", max_discount_pct: 5, min_entry_pct: 0, max_installments: 3,
    allowed_billing_types: ["PIX", "BOLETO", "CREDIT_CARD"], proposal_validity_days: 3,
  }),
}))

function seed(opts: { debtStatus?: string; cfg?: Record<string, unknown> } = {}) {
  db = {
    negotiation_sessions: [
      {
        id: SID, company_id: CO, customer_id: "cust1", debt_id: "debt1",
        primary_debt_id: "debt1", debt_ids: ["debt1"], channel: "web_generic",
        engine: "n8n", identity_verified_at: "2026-09-27T10:00:00Z",
        consent_at: "2026-09-27T10:00:00Z", status: "active", outcome: "in_progress",
      },
    ],
    tenant_chat_config: [
      {
        company_id: CO, branding: { brand_name: "VMAX" },
        payment_origin: "n8n", send_document_to_engine: true, // as 2 flags: flow.context ainda mascara
        ...(opts.cfg ?? {}),
      },
    ],
    companies: [{ id: CO, name: "VMAX LTDA" }],
    customers: [
      { id: "cust1", company_id: CO, name: "Fabio Silva Teste", document: "111.444.777-35", phone: "11999998888", email: "fabio@x.com" },
    ],
    debts: [
      { id: "debt1", company_id: CO, amount: 250, due_date: "2026-08-15", status: opts.debtStatus ?? "pending" },
    ],
    vmax_invoices: [],
    negotiation_offers: [
      {
        id: "off-1", session_id: SID, status: "presented", valid_until: null, created_at: "2026-09-27T10:00:00Z",
        terms: { discount_pct: 5, entry_value: 0, installments: 1, installment_value: 237.5, total_value: 237.5, billing_type: "PIX", first_due_date: "2026-09-30" },
      },
    ],
    debt_acknowledgement_latest: [],
    chat_prompts: [],
    journey_events: [],
  }
}

describe("N8N-13 flow.context", () => {
  beforeEach(() => seed())

  it("dívida de produção em centavos, vencimento real e aberta", async () => {
    const { flowContext } = await import("@/lib/journey/n8n-flow")
    const ctx = await flowContext(CTX)
    expect(ctx).not.toBeNull()
    expect(ctx!.debt.original_value).toBe(25000)
    expect(ctx!.debt.updated_value).toBe(25000)
    expect(ctx!.debt.due_date).toBe("2026-08-15")
    expect(ctx!.debt.status).toBe("pending")
    expect(ctx!.debt.open).toBe(true)
    expect(ctx!.matrix?.max_discount_pct).toBe(5)
    expect(ctx!.offers[0].terms.total_value).toBe(23750) // centavos
    expect(ctx!.session.company_id).toBe(CO)
    expect(ctx!.creditor.name).toBe("VMAX")
  })

  it("PII mínima: 1º nome + doc mascarado, nunca doc em claro/hash/telefone/e-mail", async () => {
    const { flowContext } = await import("@/lib/journey/n8n-flow")
    const ctx = await flowContext(CTX)
    expect(ctx!.customer).toEqual({
      id: "cust1", first_name: "Fabio", document_type: "cpf", document_masked: "***.444.777-**",
    })
    const json = JSON.stringify(ctx)
    expect(json).not.toContain("11144477735")
    expect(json).not.toContain("11999998888")
    expect(json).not.toContain("fabio@x.com")
    expect(json).not.toContain("Silva")
    expect(json).not.toContain("document_hash")
  })

  it("dívida paga/cancelada → open:false", async () => {
    seed({ debtStatus: "paid" })
    const { flowContext } = await import("@/lib/journey/n8n-flow")
    expect((await flowContext(CTX))!.debt.open).toBe(false)
    seed({ debtStatus: "cancelled" })
    expect((await flowContext(CTX))!.debt.open).toBe(false)
    seed({ debtStatus: "in_negotiation" })
    expect((await flowContext(CTX))!.debt.open).toBe(true)
  })

  it("company_id vem da sessão: contexto de outra empresa não volta", async () => {
    const { flowContext } = await import("@/lib/journey/n8n-flow")
    expect(await flowContext({ ...CTX, companyId: OTHER_CO })).toBeNull()
  })

  it("sem estado do fluxo: flow_state null; bootstrap_step segue o reconhecimento da plataforma", async () => {
    const { flowContext } = await import("@/lib/journey/n8n-flow")
    let ctx = await flowContext(CTX)
    expect(ctx!.flow_state).toBeNull()
    expect(ctx!.bootstrap_step).toBeNull()
    db.debt_acknowledgement_latest.push({
      session_id: SID, debt_id: "debt1", acknowledged: true, button_id: 1, created_at: "2026-09-27T10:01:00Z", prompt_id: "p1",
    })
    ctx = await flowContext(CTX)
    expect(ctx!.bootstrap_step).toBe("debt_recognition")
  })
})

describe("N8N-13 flow.state.set", () => {
  beforeEach(() => seed())

  it("grava o passo em journey_events (actor n8n, sem customer_id) e o flow.context o devolve", async () => {
    const { setFlowState, flowContext } = await import("@/lib/journey/n8n-flow")
    const oa = { original_debt: { amount: 25000, currency: "BRL", due_date: "2026-08-15" }, settlement_offer: { discount_percentage: 5 } }
    const r = await setFlowState(CTX, { step: "negotiation_l1", status: "pending", active: true, ongoing_agreement: oa }, "evt-l1-0001")
    expect(r.ok).toBe(true)
    expect(db.journey_events).toHaveLength(1)
    const row = db.journey_events[0]
    expect(row.event_type).toBe("n8n.flow_step")
    expect(row.actor).toBe("n8n")
    expect(row.company_id).toBe(CO)
    expect(row.session_id).toBe(SID)
    expect(row.customer_id).toBeNull()

    const ctx = await flowContext(CTX)
    expect(ctx!.flow_state).toMatchObject({ step: "negotiation_l1", status: "pending", active: true, ongoing_agreement: oa })
    expect(ctx!.bootstrap_step).toBeNull()
  })

  it("o último passo vence", async () => {
    const { setFlowState, getFlowState } = await import("@/lib/journey/n8n-flow")
    await setFlowState(CTX, { step: "negotiation_l1", status: "pending" }, "evt-a-000001")
    // occurred_at distinto (o fake ordena por ele)
    db.journey_events[0].occurred_at = "2026-09-27T10:00:00.000Z"
    await setFlowState(CTX, { step: "payment_method", status: "pending", active: true }, "evt-b-000001")
    db.journey_events[1].occurred_at = "2026-09-27T10:00:05.000Z"
    expect((await getFlowState(CTX))!.step).toBe("payment_method")
  })

  it("mesmo event_id+step+status → mesmo event_id de jornada (reenvio idempotente)", async () => {
    const { setFlowState } = await import("@/lib/journey/n8n-flow")
    await setFlowState(CTX, { step: "negotiation_l2", status: "pending" }, "evt-retry-0001")
    await setFlowState(CTX, { step: "negotiation_l2", status: "pending" }, "evt-retry-0001")
    expect(db.journey_events[0].event_id).toBe(db.journey_events[1].event_id) // UNIQUE no banco real → 2ª é duplicata
    await setFlowState(CTX, { step: "negotiation_l2", status: "accepted" }, "evt-retry-0001")
    expect(db.journey_events[2].event_id).not.toBe(db.journey_events[0].event_id)
  })

  it("valida step/status e recusa PII e rascunho grande", async () => {
    const { setFlowState } = await import("@/lib/journey/n8n-flow")
    const bad = await setFlowState(CTX, { step: "qualquer_coisa" })
    expect(bad).toMatchObject({ ok: false, status: 422, code: "FLOW_STATE_INVALID" })
    const badStatus = await setFlowState(CTX, { step: "negotiation_l1", status: "DROP TABLE" })
    expect(badStatus).toMatchObject({ ok: false, code: "FLOW_STATE_INVALID" })
    const pii = await setFlowState(CTX, { step: "negotiation_l1", ongoing_agreement: { cpf: "11144477735" } })
    expect(pii).toMatchObject({ ok: false, code: "PII_NOT_ALLOWED" })
    const big = await setFlowState(CTX, { step: "negotiation_l1", ongoing_agreement: { note: "x".repeat(5000) } })
    expect(big).toMatchObject({ ok: false, code: "FLOW_STATE_TOO_LARGE" })
    expect(db.journey_events).toHaveLength(0)
  })

  it("valores decimais no rascunho não disparam o filtro de PII", async () => {
    const { setFlowState } = await import("@/lib/journey/n8n-flow")
    const r = await setFlowState(CTX, { step: "payment_terms", ongoing_agreement: { selected_agreement: { negotiated_amount: 237.5, installment_amount: 79.16666666666667 } } })
    expect(r.ok).toBe(true)
  })
})
