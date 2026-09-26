// QA rodada 6 (Q4r2-03) — lado da jornada: parcela intermediária paga NUNCA vira
// `payment.paid` (estágio 'paid'), nem fecha a sessão, suprime ou revoga tokens.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

let db: FakeDb
const events: string[] = []
const suppressions: unknown[] = []
const revoked: unknown[] = []
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/journey/events", () => ({ recordEvent: async (i: { type: string }) => { events.push(i.type); return { ok: true, duplicate: false } } }))
vi.mock("@/lib/journey/suppressions", () => ({ addSuppression: async (i: unknown) => { suppressions.push(i) } }))
vi.mock("@/lib/journey/tokens", () => ({ revokeTokens: async (i: unknown) => { revoked.push(i) } }))
vi.mock("@/lib/notifications/email", () => ({ sendEmail: async () => ({ ok: true }) }))

describe("QA rodada 6 — jornada e parcelas (Q4r2-03)", () => {
  beforeEach(() => {
    process.env.CHAT_JOURNEY_ENABLED = "true"
    events.length = 0; suppressions.length = 0; revoked.length = 0
    db = {
      agreements: [{ id: "ag-3x", company_id: "co", customer_id: "cu", debt_id: "de", negotiation_session_id: "se", agreed_amount: 243.75 }],
      negotiation_sessions: [{ id: "se", outcome: "in_progress" }],
      tenant_chat_config: [{ company_id: "co", creditor_notification_emails: [] }],
    }
  })

  it("parcela intermediária paga → só 'payment.installment_paid'; sessão segue aberta", async () => {
    const { journeyOnPaymentEvent } = await import("@/lib/journey/reconciliation")
    await journeyOnPaymentEvent({ eventType: "PAYMENT_RECEIVED", paymentId: "pay_2", agreementId: "ag-3x", installmentIndex: 2, partialInstallmentPaid: true })
    expect(events).toEqual(["payment.installment_paid"])
    expect(db.negotiation_sessions[0].outcome).toBe("in_progress")
    expect(suppressions.length).toBe(0)
    expect(revoked.length).toBe(0)
  })

  it("última parcela paga → payment.paid (como antes)", async () => {
    const { journeyOnPaymentEvent } = await import("@/lib/journey/reconciliation")
    await journeyOnPaymentEvent({ eventType: "PAYMENT_RECEIVED", paymentId: "pay_3", agreementId: "ag-3x", installmentIndex: 3, partialInstallmentPaid: false })
    expect(events).toContain("payment.paid")
    expect(db.negotiation_sessions[0].outcome).toBe("agreement_closed")
  })
})
