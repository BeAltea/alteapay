// E2 (onda "3 opções", correção WF-6) — R2 + R5 + R15 (+ R14 verificado à parte).
//
//  R2 "Falar com atendimento" (N-01 ALTO): transferToHuman NUNCA encerra em
//     silêncio — persiste uma MENSAGEM ao devedor com o próximo passo (canal
//     WhatsApp AlteaPay), sem número em claro, sem "Sessão encerrada" seca (D36).
//  R5 "Já paguei / enviar comprovante": handlePaymentClaim REGISTRA o payment_claim
//     (conferência pela equipe) e orienta o comprovante SEM declarar pago (D6/M15).
//  R15 cedente: resolveCreditorName usa companies.name (VMAX) e só cai em "Credor"
//     quando realmente ausente — nunca "empresa credora"/""/terceiro.
//
// Exercita as libs REAIS (lib/journey/actions + persistAssistantMessage real) com
// fake supabase em memória; só a fronteira de rede (events/email) é mockada.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

process.env.CHAT_JOURNEY_ENABLED = "true"

const CO = "eeeeeeee-0000-0000-0000-0000000000e2"
const SID = "sess-e2"
const CUST = "cust-e2"
const DEBT = "debt-e2"
const ctx = { sessionId: SID, companyId: CO, customerId: CUST, debtId: DEBT }

let db: FakeDb
const events: Array<{ type: string; payload?: Record<string, unknown> }> = []

vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/journey/events", () => ({
  recordEvent: async (i: { type: string; payload?: Record<string, unknown> }) => {
    events.push({ type: i.type, payload: i.payload })
    return { ok: true, duplicate: false }
  },
  getTimeline: async () => [],
}))
// e-mail de aviso ao cedente: não dispara rede nos testes.
vi.mock("@/lib/notifications/email", () => ({ sendEmail: async () => ({ ok: true }) }))

function seed(opts: { companyName?: string | null; brandName?: string | null } = {}) {
  events.length = 0
  const branding = opts.brandName === undefined ? { brand_name: "VMAX" } : (opts.brandName ? { brand_name: opts.brandName } : {})
  db = {
    tenant_chat_config: [{ company_id: CO, branding, creditor_notification_emails: [] }],
    companies: [{ id: CO, name: opts.companyName === undefined ? "VMAX LTDA" : opts.companyName }],
    customers: [{ id: CUST, company_id: CO, name: "Fabio Mendes", document: "11144477735" }],
    debts: [{ id: DEBT, company_id: CO, customer_id: CUST, status: "pending", amount: 250, due_date: "2020-01-01" }],
    negotiation_sessions: [{ id: SID, company_id: CO, customer_id: CUST, debt_id: DEBT }],
    negotiation_cases: [],
    contact_suppressions: [],
    chat_prompts: [],
    chat_messages: [],
    debt_acknowledgements: [],
    debt_acknowledgement_latest: [],
  }
}

// ============================================================================
// R15 — nome real do cedente (companies.name / branding), fallback só se ausente.
// ============================================================================
describe("R15 — resolveCreditorName (cedente identificado, nunca genérico à toa)", () => {
  beforeEach(() => seed())

  it("usa branding.brand_name quando presente (precedência canônica)", async () => {
    const { resolveCreditorName } = await import("@/lib/journey/actions")
    const r = await resolveCreditorName({ companyId: CO })
    expect(r).toEqual({ name: "VMAX", hasRealName: true })
  })

  it("cai em companies.name (VMAX) quando não há branding", async () => {
    seed({ brandName: null }) // sem brand_name, companies.name = "VMAX LTDA"
    const { resolveCreditorName } = await import("@/lib/journey/actions")
    const r = await resolveCreditorName({ companyId: CO })
    expect(r).toEqual({ name: "VMAX LTDA", hasRealName: true })
  })

  it("só cai em 'Credor' (genérico) quando não há brand_name NEM companies.name", async () => {
    seed({ brandName: null, companyName: null })
    const { resolveCreditorName } = await import("@/lib/journey/actions")
    const r = await resolveCreditorName({ companyId: CO })
    // fallback seguro (anti-GNLink): nunca "empresa credora"/""/terceiro, e sinaliza dado ausente.
    expect(r.name).toBe("Credor")
    expect(r.hasRealName).toBe(false)
  })
})

// ============================================================================
// R2 — "Falar com atendimento" comunica o próximo passo (nunca silêncio).
// ============================================================================
describe("R2 — transferToHuman persiste mensagem ao devedor (N-01)", () => {
  beforeEach(() => seed())

  it("persiste UMA mensagem de assistente com o próximo passo + canal (nunca 'Sessão encerrada' seca)", async () => {
    const { transferToHuman } = await import("@/lib/journey/actions")
    const caseId = await transferToHuman(ctx, "handoff_button", "customer")
    expect(typeof caseId).toBe("string")

    const msgs = db.chat_messages.filter((m) => m.role === "assistant")
    expect(msgs.length).toBe(1)
    const text = msgs[0].text as string
    // comunica a transferência + nomeia o canal (WhatsApp AlteaPay)
    expect(text).toMatch(/atendimento/i)
    expect(text).toMatch(/WhatsApp/i)
    // NÃO cai em silêncio nem em copy de sessão encerrada
    expect(text).not.toMatch(/Sess[aã]o encerrada/i)
    expect(text.trim().length).toBeGreaterThan(0)
  })

  it("usa o cedente REAL (VMAX) na mensagem, não 'Credor'/'empresa credora' (R15)", async () => {
    const { transferToHuman } = await import("@/lib/journey/actions")
    await transferToHuman(ctx, "handoff_button", "customer")
    const text = db.chat_messages.find((m) => m.role === "assistant")!.text as string
    expect(text).toContain("VMAX")
    expect(text).not.toMatch(/empresa credora/i)
  })

  it("copy D36: sem ameaça (negativação/protesto/judicial/SPC) e sem número de WhatsApp em claro", async () => {
    const { humanHandoffReply } = await import("@/lib/journey/actions")
    const text = humanHandoffReply("VMAX")
    expect(text).not.toMatch(/negativa|protesto|judicial|SPC|Serasa|cart[oó]rio|a[cç][aã]o judicial/i)
    // nenhum telefone/whatsapp em claro (número real não foi fornecido)
    expect(text).not.toMatch(/\+?\d[\d\s().-]{7,}/)
  })

  it("registra o caso human_handoff e a suppressão (efeitos preservados)", async () => {
    const { transferToHuman } = await import("@/lib/journey/actions")
    await transferToHuman(ctx, "handoff_button", "customer")
    expect(db.negotiation_cases.some((c) => c.type === "human_handoff")).toBe(true)
    expect(db.contact_suppressions.length).toBe(1)
    expect(events.some((e) => e.type === "human.transfer")).toBe(true)
  })
})

// ============================================================================
// R5 — "Já paguei / enviar comprovante": registra payment_claim SEM declarar pago.
// ============================================================================
describe("R5 — handlePaymentClaim (registra claim, orienta comprovante, sem declarar pago)", () => {
  beforeEach(() => seed())

  it("abre um caso payment_claim e registra o evento (conferência da equipe)", async () => {
    const { handlePaymentClaim } = await import("@/lib/journey/actions")
    const r = await handlePaymentClaim(ctx, "customer")
    expect(r.ok).toBe(true)
    expect(typeof r.caseId).toBe("string")
    // case aberto do tipo payment_claim
    expect(db.negotiation_cases.some((c) => c.type === "payment_claim")).toBe(true)
    expect(events.some((e) => e.type === "payment_claim.registered")).toBe(true)
  })

  it("persiste a orientação ao devedor SEM declarar pago (D6/M15) — nunca 'pagamento confirmado/recebido'", async () => {
    const { handlePaymentClaim } = await import("@/lib/journey/actions")
    await handlePaymentClaim(ctx, "customer")
    const msg = db.chat_messages.find((m) => m.role === "assistant")
    expect(msg).toBeTruthy()
    const text = msg!.text as string
    // orienta o comprovante e a conferência
    expect(text).toMatch(/comprovante/i)
    expect(text).toMatch(/conferir|confer[êe]ncia|equipe/i)
    // NUNCA declara pago (D6/M15)
    expect(text).not.toMatch(/pagamento (confirmado|recebido)|quitad[oa]|est[aá] pago/i)
  })

  it("NÃO cobra nem fecha acordo nem suprime o contato (diferente do handoff) — devedor segue no menu", async () => {
    const { handlePaymentClaim } = await import("@/lib/journey/actions")
    await handlePaymentClaim(ctx, "customer")
    // sem acordo/cobrança
    expect((db.agreements ?? []).length).toBe(0)
    // NÃO suprime o contato (payment_claim não encerra a conversa)
    expect((db.contact_suppressions ?? []).length).toBe(0)
  })

  it("usa o cedente REAL (VMAX) na orientação (R15)", async () => {
    const { handlePaymentClaim, paymentClaimReply } = await import("@/lib/journey/actions")
    await handlePaymentClaim(ctx, "customer")
    const text = db.chat_messages.find((m) => m.role === "assistant")!.text as string
    expect(text).toContain("VMAX")
    // copy pura também sem ameaça (D36)
    expect(paymentClaimReply("VMAX")).not.toMatch(/negativa|protesto|judicial|SPC|Serasa/i)
  })
})
