// R4 — E2E de laboratório do RECONHECIMENTO + pagamento comandado (variante A).
// Exercita as bibliotecas reais com DB em memória (fake supabase) e integrações
// mockadas. Cobre os casos do spec R4:
//   - Sim completo → payment.create cobra (guard passa);
//   - Não com continue → registra, não bloqueia navegação, MAS bloqueia payment.create;
//   - payment.create após "Não" recusado (409 debt_not_acknowledged);
//   - reenvio de payment.create → mesmo agreement/link, idempotent:true, 0 cobrança nova;
//   - clique antigo (prompt superseded) → 409 prompt_not_active;
//   - chat.send do n8n aparece nas mensagens.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

process.env.MOCK_ALL_INTEGRATIONS = "1"
process.env.CHAT_JOURNEY_ENABLED = "true"

const CO = "aaaaaaaa-0000-0000-0000-0000000000aa"
const SID = "sess-r"
const CUST = "cust-r"
const DEBT = "debt-r"
const ctx = { sessionId: SID, companyId: CO, customerId: CUST, debtId: DEBT }

let db: FakeDb
let chargeAdds = 0
let asaasPayments: any[] = []

vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/queue/queues", () => ({
  chargeQueue: { add: async () => { chargeAdds++; return { id: `job_${chargeAdds}` } } },
  n8nQueue: { add: async () => ({ id: "j" }) },
}))
vi.mock("@/lib/asaas", () => ({ getAsaasPaymentsForCustomer: async () => asaasPayments }))
vi.mock("@/lib/journey/events", () => ({
  recordEvent: async () => ({ ok: true, duplicate: false }),
  getTimeline: async () => [],
}))
// close-agreement é o caminho real de cobrança; mockamos só a fronteira ASAAS.
vi.mock("@/lib/negotiation/close-agreement", () => ({
  closeAgreement: async () => {
    chargeAdds++
    const id = `ag_${chargeAdds}`
    ;(db.agreements ??= []).push({
      id, company_id: CO, customer_id: CUST, debt_id: DEBT,
      asaas_payment_id: `pay_${chargeAdds}`, asaas_billing_type: "PIX",
      asaas_pix_qrcode_url: "pix-code", asaas_invoice_url: "inv", agreed_amount: 80,
      installments: 1, due_date: "2026-10-01", payment_status: "pending", asaas_status: "PENDING",
    })
    return { ok: true, agreement_id: id, message: "ok", terms: {} }
  },
}))

function refreshView() {
  const rows = db.debt_acknowledgements ?? []
  const latest = new Map<string, any>()
  for (const r of rows) {
    const key = `${r.session_id}|${r.debt_id}`
    const cur = latest.get(key)
    if (!cur || r.created_at >= cur.created_at) latest.set(key, r)
  }
  db.debt_acknowledgement_latest = [...latest.values()]
}

function seed() {
  chargeAdds = 0
  asaasPayments = []
  db = {
    tenant_chat_config: [{ company_id: CO, branding: { brand_name: "VMAX" }, payment_origin: "platform", on_debt_not_recognized: "continue", acknowledgement_enabled: true, allow_payment_without_acknowledgement: false }],
    companies: [{ id: CO, name: "VMAX LTDA" }],
    customers: [{ id: CUST, company_id: CO, name: "Fabio", document: "11144477735" }],
    debts: [{ id: DEBT, company_id: CO, customer_id: CUST, status: "pending", amount: 100, due_date: "2020-01-01" }],
    vmax_invoices: [{ id_company: CO, doc: "11144477735", fatura: "F1", vencimento: "2020-01-01", saldo: 100 }],
    negotiation_sessions: [{ id: SID, company_id: CO, customer_id: CUST, debt_id: DEBT, debt_acknowledged_at: null, agreement_id: null, identity_verified_at: new Date().toISOString() }],
    // matriz vigente: acomoda a oferta à vista (20% desc., PIX) para a revalidação
    // de matriz do payment.create (fora da matriz → 422) passar no caminho feliz.
    negotiation_condition_matrix: [{
      id: "mx-1", company_id: CO, name: "default", priority: 1, active: true,
      valid_from: null, valid_to: null, aging_min_days: 0, aging_max_days: null,
      aging_basis: "oldest_due", max_discount_pct: 30, installment_discount_pct: 10,
      min_entry_pct: 20, max_installments: 3, min_installment_value: 10,
      allowed_billing_types: ["PIX", "BOLETO"], proposal_validity_days: 7,
      retry_after_days: 3, max_retries: 2, min_debt_value: 0,
    }],
    negotiation_offers: [{ id: "off-1", company_id: CO, session_id: SID, customer_id: CUST, debt_id: DEBT, status: "presented", valid_until: null, terms: { original_value: 100, discount_pct: 20, discount_value: 20, entry_value: 0, total_value: 80, installments: 1, installment_value: 80, billing_type: "PIX", first_due_date: "2026-10-01" } }],
    negotiation_acceptances: [],
    chat_prompts: [],
    chat_messages: [],
    debt_acknowledgements: [],
    debt_acknowledgement_latest: [],
    agreements: [],
  }
}

async function ackPrompt() {
  const { bootstrapAcknowledgementPrompt } = await import("@/lib/journey/acknowledgement")
  const r = await bootstrapAcknowledgementPrompt({ companyId: CO, sessionId: SID, customerId: CUST, debtIds: [DEBT], primaryDebtId: DEBT })
  if (!r.ok || !r.created) throw new Error("bootstrap failed")
  return r.prompt.id
}

describe("E2E reconhecimento — SIM completo até cobrança", () => {
  beforeEach(seed)

  it("bootstrap → clique 1 (Sim) → payment.create cobra 1x", async () => {
    const promptId = await ackPrompt()
    expect(db.chat_prompts[0].kind).toBe("debt_acknowledgement")

    const { recordAcknowledgement } = await import("@/lib/journey/acknowledgement")
    const ack = await recordAcknowledgement({ companyId: CO, sessionId: SID, customerId: CUST, debtId: DEBT, promptId, buttonId: 1 })
    expect(ack.ok && ack.acknowledged).toBe(true)
    refreshView()

    const { paymentCreate } = await import("@/lib/journey/payment-actions")
    const r = await paymentCreate(ctx, "off-1")
    expect(r.ok).toBe(true)
    if (r.ok && r.status === "created") {
      expect(r.idempotent).toBe(false)
      expect(r.payment.payment_id).toBe("pay_1")
    }
    expect(chargeAdds).toBe(1)
  })
})

describe("E2E reconhecimento — NÃO (continue) bloqueia pagamento", () => {
  beforeEach(seed)

  it("clique 0 (Não) registra e NÃO bloqueia navegação; payment.create → 409 debt_not_acknowledged", async () => {
    const promptId = await ackPrompt()
    const { recordAcknowledgement } = await import("@/lib/journey/acknowledgement")
    const ack = await recordAcknowledgement({ companyId: CO, sessionId: SID, customerId: CUST, debtId: DEBT, promptId, buttonId: 0 })
    expect(ack.ok).toBe(true)
    if (ack.ok) expect(ack.onNotRecognized).toBe("continue") // navegação livre
    refreshView()

    const { paymentCreate } = await import("@/lib/journey/payment-actions")
    const r = await paymentCreate(ctx, "off-1")
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.status).toBe(409)
      expect(r.code).toBe("debt_not_acknowledged")
    }
    expect(chargeAdds).toBe(0) // nada foi cobrado
  })
})

describe("E2E reconhecimento — idempotência do payment.create (session,offer)", () => {
  beforeEach(seed)

  it("reenvio → mesmo agreement/link, idempotent:true, 0 cobrança nova", async () => {
    const promptId = await ackPrompt()
    const { recordAcknowledgement } = await import("@/lib/journey/acknowledgement")
    await recordAcknowledgement({ companyId: CO, sessionId: SID, customerId: CUST, debtId: DEBT, promptId, buttonId: 1 })
    refreshView()

    const { paymentCreate } = await import("@/lib/journey/payment-actions")
    // 1ª chamada: como confirmAccept real grava acceptances, semeamos o registro
    // que confirmAccept criaria (o mock de closeAgreement cria o agreement).
    const first = await paymentCreate(ctx, "off-1")
    expect(first.ok).toBe(true)
    const firstAgreement = first.ok && first.status === "created" ? first.payment.agreement_id : null

    // registra o aceite (o que confirmAccept faz) para simular a 2ª chamada idempotente
    db.negotiation_acceptances.push({ company_id: CO, session_id: SID, offer_id: "off-1", agreement_id: firstAgreement })

    const second = await paymentCreate(ctx, "off-1")
    expect(second.ok).toBe(true)
    if (second.ok && second.status === "created") {
      expect(second.idempotent).toBe(true)
      expect(second.payment.agreement_id).toBe(firstAgreement)
    }
    expect(chargeAdds).toBe(1) // 0 cobrança nova
  })
})

describe("E2E reconhecimento — clique antigo e chat.send", () => {
  beforeEach(seed)

  it("clique num prompt superseded → 409 prompt_not_active", async () => {
    const oldPrompt = await ackPrompt()
    // uma nova pergunta supersede a anterior
    const { promptAsk } = await import("@/lib/journey/chat-send")
    await promptAsk(ctx, { kind: "generic_yes_no", question: "Outra?", buttons: [{ id: 1, label: "Sim" }, { id: 0, label: "Não" }] })

    const { answerPrompt } = await import("@/lib/journey/prompts")
    const r = await answerPrompt({ sessionId: SID, companyId: CO, promptId: oldPrompt, buttonId: 1 })
    expect(r).toEqual({ ok: false, status: 409, code: "prompt_not_active" })
  })

  it("chat.send do n8n aparece nas mensagens da sessão", async () => {
    const { chatSend } = await import("@/lib/journey/chat-send")
    await chatSend(ctx, { text: "Segue seu PIX.", n8n_execution_id: "exec_9" }, "evt-cs")
    const msg = (db.chat_messages ?? []).find((m) => m.text === "Segue seu PIX.")
    expect(msg).toBeTruthy()
    expect(msg?.role).toBe("assistant")
    expect(msg?.n8n_execution_id).toBe("exec_9")
  })
})
