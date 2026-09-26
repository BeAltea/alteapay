// QA rodada 6 (Q4r2-01, ALTO) — no parcelado o chat dizia "link para pagar
// R$ 243,75" mas o link cobra a 1ª parcela (R$ 81,25). A copy (carta de voz, sem
// travessão) passa a dizer exatamente o que o link cobra; à vista não muda.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

const CO = "eeeeeeee-0000-0000-0000-0000000qa6c1"
const SID = "sess-qa6-copy"
const ctx = { sessionId: SID, companyId: CO, customerId: "cust-qa6-copy", debtId: "debt-qa6-copy" }

let db: FakeDb
const persisted: Array<{ text: string; stage?: string | null; snapshot?: Record<string, unknown> | null }> = []

vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/journey/events", () => ({ recordEvent: async () => ({ ok: true, duplicate: false }), getTimeline: async () => [] }))
vi.mock("@/lib/journey/acknowledgement", () => ({
  buildAckContext: async () => ({ updatedValue: 250 }),
  persistAssistantMessage: async (i: { text: string; stage?: string | null; snapshot?: Record<string, unknown> | null }) => {
    persisted.push(i)
    return `msg-${persisted.length}`
  },
  reopenThreeOptions: async () => ({ ok: true }),
  REOPEN_MENU_QUESTION: "Como prefere seguir?",
}))

const nbsp = (s: string) => s.replace(/ /g, " ")

describe("QA rodada 6 — copy do link parcelado (Q4r2-01)", () => {
  beforeEach(() => {
    db = { chat_prompts: [], negotiation_sessions: [{ id: SID, company_id: CO }] }
    persisted.length = 0
  })

  it("3x: fala da 1ª parcela (R$ 81,25), vencimento dd/mm e o total do acordo; sem travessão", async () => {
    const { payLinkMessageText } = await import("@/lib/journey/pay-poll")
    const text = nbsp(payLinkMessageText({
      link: "https://asaas/i/inst_1", valor: 243.75, vencimentoLink: "2026-10-03", alreadyCharged: false,
      installments: 3, installmentValue: 81.25,
    }))
    expect(text).toBe(
      "Aqui está o link da 1ª parcela: R$ 81,25, com vencimento em 03/10. O acordo é de 3x de R$ 81,25 (total R$ 243,75); as próximas parcelas chegam pelo mesmo canal.\nhttps://asaas/i/inst_1",
    )
    expect(text).not.toMatch(/[—–]/)
    expect(text).not.toMatch(/link para pagar R\$ 243,75/)
  })

  it("2x sem installment_value: a parcela é derivada do total (fallback)", async () => {
    const { payLinkMessageText } = await import("@/lib/journey/pay-poll")
    const text = nbsp(payLinkMessageText({ link: null, valor: 243.76, vencimentoLink: "2026-10-03", alreadyCharged: false, installments: 2 }))
    expect(text).toBe("Aqui está o link da 1ª parcela: R$ 121,88, com vencimento em 03/10. O acordo é de 2x de R$ 121,88 (total R$ 243,76); as próximas parcelas chegam pelo mesmo canal.")
  })

  it("à vista continua igual", async () => {
    const { payLinkMessageText } = await import("@/lib/journey/pay-poll")
    const text = nbsp(payLinkMessageText({ link: null, valor: 237.5, vencimentoLink: "2026-09-29", alreadyCharged: false, installments: 1, installmentValue: 237.5 }))
    expect(text).toBe("Aqui está seu link para pagar R$ 237,50, válido até 29/09/2026.")
    const legacy = nbsp(payLinkMessageText({ link: null, valor: 250, vencimentoLink: "2026-09-29", alreadyCharged: false }))
    expect(legacy).toBe("Aqui está seu link para pagar R$ 250,00, válido até 29/09/2026.")
  })

  it("parcelado já cobrado: destaca o TOTAL do acordo (B-3), nunca a parcela como se fosse o total", async () => {
    const { payLinkMessageText } = await import("@/lib/journey/pay-poll")
    const text = nbsp(payLinkMessageText({ link: null, valor: 243.75, vencimentoLink: "2026-10-03", alreadyCharged: true, installments: 3, installmentValue: 81.25 }))
    expect(text).toBe("Você já tem uma cobrança ativa do acordo de 3x (total R$ 243,75). Use o link abaixo; não é preciso gerar outro.")
  })

  it("outcome persistido (bolha do link) usa installments/installment_amount do acordo", async () => {
    const { deliverPaymentOutcome } = await import("@/lib/journey/pay")
    const out = await deliverPaymentOutcome(ctx, {
      payment: {
        agreement_id: "ag-3x", payment_id: "pay_1", billing_type: "BOLETO", pix_copy_paste: null, boleto_url: null, boleto_line: null,
        invoice_url: "https://asaas/i/pay_1", due_date: "2026-10-03", total_value: 243.75, installments: 3, installment_value: 81.25,
      },
      alreadyCharged: false, valor: 243.75, debtIds: [ctx.debtId],
    })
    expect(out.link).toBe("https://asaas/i/pay_1")
    const bubble = persisted.find((p) => p.stage === "payment_link")!
    expect(nbsp(bubble.text)).toMatch(/^Aqui está o link da 1ª parcela: R\$ 81,25, com vencimento em 03\/10\. O acordo é de 3x de R\$ 81,25 \(total R\$ 243,75\)/)
    expect(bubble.snapshot).toMatchObject({ installments: 3, installment_value: 81.25, valor: 243.75 })
  })
})
