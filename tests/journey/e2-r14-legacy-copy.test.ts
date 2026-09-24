// E2 · R14 — verificação de que o fluxo de 3 opções substitui o `debt_consult`
// legado no piloto VMAX, e que a copy legada remanescente (mantida no código para
// compatibilidade) foi alinhada a D36 ("pendência" não "dívida"; "Falar com
// atendimento" não "atendente"). Verificação de call-graph + copy — sem tocar a
// fronteira do E1 (ofertas/rota).
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

process.env.CHAT_JOURNEY_ENABLED = "true"

const CO = "eeeeeeee-0000-0000-0000-000000000r14"
const SID = "sess-r14"
const CUST = "cust-r14"
const DEBT = "debt-r14"

let db: FakeDb
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/journey/events", () => ({
  recordEvent: async () => ({ ok: true, duplicate: false }),
  getTimeline: async () => [],
}))

function seed() {
  db = {
    tenant_chat_config: [{ company_id: CO, acknowledgement_enabled: true, show_handoff_button: true, branding: { brand_name: "VMAX" } }],
    companies: [{ id: CO, name: "VMAX LTDA" }],
    customers: [{ id: CUST, company_id: CO, name: "Fabio Mendes", document: "11144477735" }],
    debts: [{ id: DEBT, company_id: CO, customer_id: CUST, status: "pending", amount: 250, due_date: "2020-01-01" }],
    vmax_invoices: [{ id_company: CO, doc: "11144477735", fatura: "F1", vencimento: "2020-01-10", saldo: 250 }],
    negotiation_sessions: [{ id: SID, company_id: CO, customer_id: CUST, debt_id: DEBT }],
    chat_prompts: [],
    chat_messages: [],
  }
}

describe("R14 — o bootstrap do piloto usa 3 opções (não o debt_consult legado)", () => {
  beforeEach(() => seed())

  it("bootstrapThreeOptionsPrompt cria kind 'debt_three_options', nunca 'debt_consult'", async () => {
    const { bootstrapThreeOptionsPrompt } = await import("@/lib/journey/acknowledgement")
    const r = await bootstrapThreeOptionsPrompt({
      companyId: CO, sessionId: SID, customerId: CUST, debtIds: [DEBT], primaryDebtId: DEBT,
    })
    expect(r.ok).toBe(true)
    const kinds = db.chat_prompts.map((p) => p.kind)
    expect(kinds).toContain("debt_three_options")
    expect(kinds).not.toContain("debt_consult")
  })
})

describe("R14 — copy legada alinhada a D36 (compatibilidade, fora do bootstrap)", () => {
  const ackCtx = {
    firstName: "Fabio", creditorName: "VMAX", updatedValue: 250, invoiceCount: 2,
    oldestDueDate: "2020-01-10",
  }

  it("acknowledgementQuestion/consultNegotiateQuestion/debtInfoMessage: 'pendência', nunca 'dívida em seu nome'", async () => {
    const { acknowledgementQuestion, consultNegotiateQuestion, debtInfoMessage } = await import("@/lib/journey/acknowledgement")
    for (const text of [acknowledgementQuestion(ackCtx), consultNegotiateQuestion(ackCtx), debtInfoMessage(ackCtx)]) {
      expect(text).toMatch(/pend[êe]ncia/i)
      expect(text).not.toMatch(/d[ií]vida em seu nome/i)
      // D36: sem ameaça
      expect(text).not.toMatch(/negativa|protesto|judicial|SPC|Serasa/i)
      // cedente identificado (R15)
      expect(text).toContain("VMAX")
    }
  })

  it("botões de handoff legados usam 'Falar com atendimento' (não 'atendente')", async () => {
    const { acknowledgementButtons, consultNegotiateButtons, postConsultButtons } = await import("@/lib/journey/acknowledgement")
    for (const buttons of [acknowledgementButtons(true), consultNegotiateButtons(true), postConsultButtons(true)]) {
      const labels = buttons.map((b) => b.label)
      expect(labels).toContain("Falar com atendimento")
      expect(labels).not.toContain("Falar com atendente")
    }
  })
})
