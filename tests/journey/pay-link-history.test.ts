// R7 — link de pagamento PERSISTIDO no histórico (chat_messages). O PAGAR (§6.4)
// devolvia o link só no corpo do POST/payResult volátil; no reload/reuso o link
// "sumia". Agora payService persiste a mensagem do link via persistAssistantMessage
// (idempotente): reload/reuso restaura o link (M11). already_charged reusa a mesma
// persistência sem duplicar; processing NÃO persiste (sem link ainda). NUNCA
// declara pago (M15).
//
// Mesma montagem de mocks do pay.test.ts (só o núcleo do ASAAS é mockado; a
// oferta integral, a matriz, o valor canônico e persistAssistantMessage são REAIS).
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"
import { payLinkMessageText } from "@/lib/journey/pay"

const CO = "eeeeeeee-0000-0000-0000-00000000r7ab"
const SID = "s7"
const CUST = "cust7"
const DEBT = "debt7"
const ctx = { sessionId: SID, companyId: CO, customerId: CUST, debtId: DEBT }

let db: FakeDb
let confirmMode: "created" | "processing" | "already_charged" = "created"

vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/asaas", () => ({ getAsaasPaymentsForCustomer: async () => [] }))
vi.mock("@/lib/journey/events", () => ({ recordEvent: async () => ({ ok: true, duplicate: false }) }))

vi.mock("@/lib/journey/closing", () => ({
  buildAcceptSummary: async () => ({ ok: true, summary: { termsHash: "h", terms: {}, validUntil: null } }),
  confirmAccept: async ({ offerId }: { offerId: string }) => {
    if (confirmMode === "already_charged") return { ok: false, error: "ALREADY_CHARGED" }
    const agId = "agNew"
    if (confirmMode === "created") {
      ;(db.agreements ??= []).push({
        id: agId, company_id: CO, customer_id: CUST, asaas_payment_id: "pay_new",
        asaas_billing_type: "PIX", agreed_amount: 250, installments: 1, due_date: "2026-09-27",
        asaas_pix_qrcode_url: "pixcopy", asaas_boleto_url: null,
        asaas_invoice_url: "https://asaas/checkout/pay_new",
        payment_status: "pending", asaas_status: "PENDING",
      })
    } else {
      ;(db.agreements ??= []).push({
        id: agId, company_id: CO, customer_id: CUST, asaas_payment_id: null,
        agreed_amount: 250, installments: 1, due_date: null, payment_status: "pending",
      })
    }
    ;(db.negotiation_acceptances ??= []).push({ company_id: CO, session_id: SID, offer_id: offerId, agreement_id: agId })
    return { ok: true, agreementId: agId }
  },
}))

const MATRIX = {
  id: "mx-1", company_id: CO, name: "default", priority: 1, active: true,
  valid_from: null, valid_to: null, aging_min_days: 0, aging_max_days: null,
  aging_basis: "oldest_due", max_discount_pct: 30, installment_discount_pct: 10,
  min_entry_pct: 20, max_installments: 3, min_installment_value: 10,
  allowed_billing_types: ["PIX", "BOLETO"], proposal_validity_days: 7,
  retry_after_days: 3, max_retries: 2, min_debt_value: 0,
}

function seed(opts: { live?: boolean } = {}) {
  confirmMode = "created"
  db = {
    tenant_chat_config: [{ company_id: CO, payment_origin: "platform", allow_payment_without_acknowledgement: true, acknowledgement_enabled: true, branding: {} }],
    companies: [{ id: CO, name: "VMAX" }],
    customers: [{ id: CUST, company_id: CO, name: "Fabio Mendes", document: "11144477735" }],
    debts: [{ id: DEBT, company_id: CO, customer_id: CUST, status: "pending", amount: 250, due_date: "2020-01-01" }],
    vmax_invoices: [],
    negotiation_sessions: [{ id: SID, company_id: CO, customer_id: CUST, debt_id: DEBT, agreement_id: null }],
    negotiation_offers: [],
    negotiation_condition_matrix: [MATRIX],
    negotiation_acceptances: [],
    agreements: opts.live
      ? [{
          id: "agLive", company_id: CO, customer_id: CUST, asaas_payment_id: "pay_live",
          payment_status: "pending", asaas_status: "PENDING", asaas_billing_type: "BOLETO",
          agreed_amount: 250, installments: 1, due_date: "2026-11-01",
          asaas_boleto_url: "https://asaas/b/live", asaas_invoice_url: "https://asaas/i/live", asaas_pix_qrcode_url: null,
        }]
      : [],
    debt_acknowledgement_latest: [],
    chat_messages: [],
  }
  delete process.env.PAYMENT_ORIGIN
  delete process.env.PAY_LINK_DUE_DAYS
}

function assistantLinkMessages(link: string) {
  return (db.chat_messages ?? []).filter(
    (m) => m.role === "assistant" && typeof m.text === "string" && m.text.includes(link),
  )
}

describe("payService — link no histórico (R7)", () => {
  beforeEach(() => seed())

  it("sucesso: persiste UMA mensagem de assistente com o link (reload restaura)", async () => {
    const { payService } = await import("@/lib/journey/pay")
    const r = await payService(ctx)
    expect(r.ok).toBe(true)
    const persisted = assistantLinkMessages("https://asaas/checkout/pay_new")
    expect(persisted.length).toBe(1)
    // a copy inclui o valor e NÃO declara pago (M15)
    expect(persisted[0].text).toMatch(/R\$\s?250,00/)
    expect(persisted[0].text.toLowerCase()).not.toMatch(/pagamento (confirmado|recebido)|quitad/)
  })

  it("clique repetido em PAGAR (A1): responde 'já tem cobrança' com o MESMO link e não empilha além disso", async () => {
    const { payService } = await import("@/lib/journey/pay")
    const r1 = await payService(ctx)
    const r2 = await payService(ctx)
    const r3 = await payService(ctx)
    expect(r1.ok && r2.ok && r3.ok).toBe(true)
    if (r1.ok && r2.ok) {
      expect(r1.already_charged).toBe(false)
      // idempotente (mesma oferta já aceita → mesmo acordo/link) = already_charged
      expect(r2.already_charged).toBe(true)
      expect(r2.link).toBe(r1.link)
    }
    const msgs = assistantLinkMessages("https://asaas/checkout/pay_new")
    // 1 "Aqui está" + 1 "Você já tem" (o 3º clique NÃO empilha — dedup 15min)
    expect(msgs.length).toBe(2)
    expect(msgs[1].text).toMatch(/já tem uma cobrança ativa/i)
  })

  it("already_charged: persiste a mensagem com o LINK EXISTENTE (sem 2ª cobrança)", async () => {
    seed({ live: true })
    confirmMode = "already_charged"
    const { payService } = await import("@/lib/journey/pay")
    const r = await payService(ctx)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.already_charged).toBe(true)
    const persisted = assistantLinkMessages("https://asaas/i/live")
    expect(persisted.length).toBe(1)
    expect(persisted[0].text).toMatch(/já tem uma cobrança ativa/i)
    // nenhuma 2ª cobrança criada
    expect((db.agreements ?? []).length).toBe(1)
  })

  it("processing (worker off, sem link): NÃO persiste mensagem de link ainda", async () => {
    confirmMode = "processing"
    const { payService } = await import("@/lib/journey/pay")
    const r = await payService(ctx)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.processing).toBe(true)
    // nenhuma bolha de link (o link nasce depois, pelo poll R3)
    const links = (db.chat_messages ?? []).filter((m) => /https?:\/\//.test(String(m.text)))
    expect(links.length).toBe(0)
  })
})

describe("payLinkMessageText — copy do link (R7, pura)", () => {
  it("novo link (T7/R-29): valor + vencimento + URL, SEM 'Pronto!' e SEM 'já pagou'; reforço de segurança", () => {
    const t = payLinkMessageText({
      link: "https://asaas/checkout/x", valor: 250, vencimentoLink: "2026-09-27", alreadyCharged: false,
    })
    expect(t).toMatch(/R\$\s?250,00/)
    expect(t).toContain("27/09/2026")
    expect(t).toContain("https://asaas/checkout/x")
    // R-29/C10: sem "Pronto!" e sem "se já pagou desconsidere" no ponto de maior conversão.
    expect(t).not.toMatch(/^Pronto!/)
    expect(t.toLowerCase()).not.toContain("já pagou")
    expect(t.toLowerCase()).not.toContain("desconsider")
    // reforço de segurança leve (link pessoal e seguro).
    expect(t).toContain("O link é pessoal e seguro")
  })

  it("already_charged (T8/R-30): reforça 'não é preciso gerar outro', sem 'já pagou'", () => {
    const t = payLinkMessageText({
      link: "https://asaas/i/live", valor: 250, vencimentoLink: null, alreadyCharged: true,
    })
    expect(t).toMatch(/não é preciso gerar outro/i)
    expect(t).toContain("https://asaas/i/live")
    expect(t.toLowerCase()).not.toContain("já pagou")
    expect(t.toLowerCase()).not.toContain("desconsider")
  })

  it("NUNCA declara pago (M15) e sem termos técnicos/ASAAS", () => {
    const t = payLinkMessageText({ link: "https://x/1", valor: 100, vencimentoLink: null, alreadyCharged: false })
    expect(t.toLowerCase()).not.toMatch(/pagamento (confirmado|recebido)|quitad/)
    expect(t).not.toMatch(/\bHTTP\b|status code|n8n/i)
  })
})
