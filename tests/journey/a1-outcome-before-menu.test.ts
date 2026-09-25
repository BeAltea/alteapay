// A1 / G3 — o RESULTADO da ação é persistido como OUTCOME (ligado ao clique)
// ANTES de o menu ser reemitido, e o menu que volta é CURTO (sem saudação).
//
//  - Detalhes [2]: resposta com prompt_id do prompt respondido + stage 'detail',
//    gravada ANTES do prompt novo; o menu novo tem a pergunta "Como prefere
//    seguir?" e nenhuma saudação nova; 1 buildAckContext (o reopen reusa);
//  - Não reconheço [0]: reply com prompt_id + stage 'not_recognized' antes do
//    menu-volta;
//  - Já paguei (reopen route): reply com stage 'payment_claim' antes do menu;
//  - a poda (display-class) classifica esses stages como outcome (nunca
//    superseded, mesmo com promptId ≠ ativo) e 'greeting' como guidance.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

process.env.CHAT_JOURNEY_ENABLED = "true"
process.env.NEGOTIATION_JWT_SECRET = "test-secret-a1-outcome"

const CO = "eeeeeeee-0000-0000-0000-0000000a1ou1"
const SID = "sess-a1-outcome"
const CUST = "cust-a1-outcome"
const DEBT = "debt-a1-outcome"

let db: FakeDb
const events: Array<{ type: string; payload?: Record<string, unknown> }> = []

vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/asaas", () => ({ getAsaasPaymentsForCustomer: async () => [] }))
vi.mock("@/lib/notifications/email", () => ({ sendEmail: async () => ({ ok: true }) }))
vi.mock("@/lib/journey/events", () => ({
  recordEvent: async (i: { type: string; payload?: Record<string, unknown> }) => {
    events.push({ type: i.type, payload: i.payload })
    return { ok: true, duplicate: false }
  },
  getTimeline: async () => [],
}))
vi.mock("@/lib/negotiation/engine", () => ({
  engineName: () => "disabled",
  emitNegotiationStart: async () => ({ ok: true, delivered: false, reason: "engine_unavailable" }),
}))

function seed() {
  events.length = 0
  db = {
    tenant_chat_config: [{
      company_id: CO, payment_origin: "platform", allow_payment_without_acknowledgement: false,
      acknowledgement_enabled: true, show_handoff_button: false, on_debt_not_recognized: "continue",
      official_channel_label: null, official_channel_url: null, branding: { brand_name: "VMAX" },
      creditor_notification_emails: [],
    }],
    companies: [{ id: CO, name: "VMAX LTDA" }],
    customers: [{ id: CUST, company_id: CO, name: "Fabio Mendes", document: "11144477735" }],
    debts: [{ id: DEBT, company_id: CO, customer_id: CUST, status: "pending", amount: 250, due_date: "2026-08-15" }],
    vmax_invoices: [{ id_company: CO, doc: "11144477735", fatura: "F1", vencimento: "2026-08-15", saldo: 250 }],
    negotiation_sessions: [{ id: SID, company_id: CO, customer_id: CUST, debt_id: DEBT, agreement_id: null, debt_ids: [DEBT], primary_debt_id: DEBT }],
    negotiation_offers: [], negotiation_condition_matrix: [], negotiation_acceptances: [], negotiation_cases: [],
    contact_suppressions: [], chat_prompts: [], chat_messages: [], debt_acknowledgements: [], debt_acknowledgement_latest: [], agreements: [],
  }
}
function req(cookieValue: string | null, body: Record<string, unknown>) {
  return {
    cookies: { get: (name: string) => (cookieValue && name === "alteapay_chat_session" ? { value: cookieValue } : undefined) },
    headers: { get: () => null },
    json: async () => body,
  } as any
}
async function signed() {
  const { signChatJwt } = await import("@/lib/negotiation/crypto")
  return signChatJwt({ sid: SID, cid: CO }, 3600)
}
async function bootstrap() {
  const { bootstrapThreeOptionsPrompt } = await import("@/lib/journey/acknowledgement")
  await bootstrapThreeOptionsPrompt({ companyId: CO, sessionId: SID, customerId: CUST, debtIds: [DEBT], primaryDebtId: DEBT })
  return db.chat_prompts.find((p) => p.status === "active")!
}
const active = () => db.chat_prompts.find((p) => p.status === "active")!
const assistants = () => db.chat_messages.filter((m) => m.role === "assistant")

describe("Detalhes da dívida [2] — outcome antes do menu curto", () => {
  beforeEach(seed)

  it("resposta (prompt_id do respondido + stage detail) é persistida ANTES do menu novo; menu curto; saudação 1x", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    const p1 = await bootstrap()
    const greetingsBefore = assistants().filter((m) => m.offers_snapshot?.stage === "greeting").length
    expect(greetingsBefore).toBe(1)

    const res = await POST(req(await signed(), { prompt_id: p1.id, button_id: 2 }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.action).toBe("consult")
    // ordem cronológica das bolhas do assistente após a saudação:
    //   [detalhes (outcome, ligado a p1)] → [pergunta curta do menu novo (p2)]
    const after = assistants().filter((m) => m.offers_snapshot?.stage !== "greeting")
    expect(after.length).toBe(2)
    const [detail, question] = after
    expect(detail.text).toBe(body.reply)
    expect(detail.prompt_id).toBe(p1.id)
    expect(detail.offers_snapshot.stage).toBe("detail")
    const p2 = active()
    expect(p2.id).not.toBe(p1.id)
    expect(p2.question).toBe("Como prefere seguir?")
    expect(question.prompt_id).toBe(p2.id)
    expect(question.text).toBe("Como prefere seguir?")
    // NENHUMA saudação nova (G6)
    expect(assistants().filter((m) => m.offers_snapshot?.stage === "greeting").length).toBe(1)
    expect(assistants().filter((m) => /^Olá/.test(m.text)).length).toBe(1)
    // a resposta carrega o id do menu novo (o client pode re-hidratar sem poll)
    expect(body.prompt_id).toBe(p2.id)
    // sem valor na fala (o card tem o valor)
    expect(body.reply).not.toContain("R$")
  })

  it("Detalhes 2x (após o menu reabrir): um outcome por clique (cada um ligado ao SEU prompt); 1 menu ativo; saudação 1x", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    const p1 = await bootstrap()
    await POST(req(await signed(), { prompt_id: p1.id, button_id: 2 }))
    const p2 = active()
    await POST(req(await signed(), { prompt_id: p2.id, button_id: 2 }))
    const details = assistants().filter((m) => m.offers_snapshot?.stage === "detail")
    expect(details.map((m) => m.prompt_id)).toEqual([p1.id, p2.id])
    // o MESMO clique não duplica (idempotência por prompt_id+stage)
    const { persistAssistantMessage } = await import("@/lib/journey/acknowledgement")
    await persistAssistantMessage({ companyId: CO, sessionId: SID, text: details[1].text, promptId: p2.id, stage: "detail" })
    expect(assistants().filter((m) => m.offers_snapshot?.stage === "detail").length).toBe(2)
    expect(db.chat_prompts.filter((p) => p.status === "active").length).toBe(1)
    expect(assistants().filter((m) => m.offers_snapshot?.stage === "greeting").length).toBe(1)
  })
})

describe("Não reconheço [0] e Já paguei — outcome ligado ao clique, antes do menu", () => {
  beforeEach(seed)

  it("Não reconheço: reply com prompt_id + stage not_recognized, gravado antes do menu-volta", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    const p1 = await bootstrap()
    const res = await POST(req(await signed(), { prompt_id: p1.id, button_id: 0 }))
    const body = await res.json()
    expect(body.action).toBe("not_recognized")
    const reply = assistants().find((m) => m.text === body.reply)!
    expect(reply.prompt_id).toBe(p1.id)
    expect(reply.offers_snapshot.stage).toBe("not_recognized")
    const back = active()
    expect(back.buttons.map((b: any) => b.id)).toEqual([98])
    expect(new Date(reply.created_at).getTime()).toBeLessThanOrEqual(new Date(back.created_at).getTime())
  })

  it("Já paguei (POST /api/chat/reopen payment_claim): reply stage payment_claim antes do menu curto; sem saudação nova", async () => {
    const { POST } = await import("@/app/api/chat/reopen/route")
    await bootstrap()
    const res = await POST(req(await signed(), { action: "payment_claim" }))
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.claim_registered).toBe(true)
    const claim = assistants().find((m) => m.offers_snapshot?.stage === "payment_claim")!
    expect(claim).toBeTruthy()
    expect(claim.text).toBe(body.reply)
    // o menu inicial continuava ATIVO (a afordância "Já paguei" fica sob ele) →
    // permanece o mesmo (idempotente), sem saudação nova; a orientação do claim
    // fica ANTES dele na tela (outcome acima do menu).
    const menu = active()
    expect(menu.kind).toBe("debt_three_options")
    expect(db.chat_prompts.filter((p) => p.status === "active").length).toBe(1)
    expect(assistants().filter((m) => m.offers_snapshot?.stage === "greeting").length).toBe(1)
  })

  it("Já paguei com o menu já consumido → menu CURTO reemitido após a orientação", async () => {
    const { POST: BUTTON } = await import("@/app/api/chat/button/route")
    const { POST: REOPEN } = await import("@/app/api/chat/reopen/route")
    const p1 = await bootstrap()
    // consome o menu sem reabrir outro (handoff-like): supersede manualmente
    await BUTTON(req(await signed(), { prompt_id: p1.id, button_id: 2 }))
    for (const p of db.chat_prompts) p.status = "superseded"
    const res = await REOPEN(req(await signed(), { action: "payment_claim" }))
    expect((await res.json()).claim_registered).toBe(true)
    const menu = active()
    expect(menu.question).toBe("Como prefere seguir?")
    expect(menu.context.menu_mode).toBe("reopen")
    expect(assistants().filter((m) => m.offers_snapshot?.stage === "greeting").length).toBe(1)
  })
})

describe("poda: stages viram outcome/guidance (display-class)", () => {
  it("detail/payment_link/not_recognized/payment_claim com promptId ≠ ativo → outcome (nunca superseded)", async () => {
    const { classifyMessage } = await import("@/lib/journey/display-class")
    for (const stage of ["detail", "payment_link", "not_recognized", "payment_claim"]) {
      expect(classifyMessage({ role: "assistant", promptId: "p1", text: "x", stage }, { activePromptId: "p2" })).toBe("outcome")
    }
    // sem stage, a mesma bolha-pergunta de prompt não-ativo continua superseded
    expect(classifyMessage({ role: "assistant", promptId: "p1", text: "x" }, { activePromptId: "p2" })).toBe("superseded")
  })

  it("greeting (sem promptId) → guidance", async () => {
    const { classifyMessage } = await import("@/lib/journey/display-class")
    expect(classifyMessage({ role: "assistant", promptId: null, text: "Olá, Fabio.", stage: "greeting" }, { activePromptId: "p2" })).toBe("guidance")
  })

  it("GET /api/chat/messages expõe `stage` e `action` de offers_snapshot", async () => {
    seed()
    const { GET } = await import("@/app/api/chat/messages/route")
    const { signChatJwt } = await import("@/lib/negotiation/crypto")
    db.chat_messages = [
      { id: "m1", company_id: CO, session_id: SID, role: "assistant", text: "Olá", offers_snapshot: { stage: "greeting" }, created_at: "2026-09-25T10:00:00Z" },
      { id: "m2", company_id: CO, session_id: SID, role: "assistant", text: "link", prompt_id: null,
        offers_snapshot: { stage: "payment_link", message_action: { type: "open_payment_link", label: "Abrir link de pagamento", href: "https://asaas/i/x" } },
        created_at: "2026-09-25T10:01:00Z" },
    ]
    const cookie = signChatJwt({ sid: SID, cid: CO }, 3600)
    const r = await GET({
      cookies: { get: (n: string) => (n === "alteapay_chat_session" ? { value: cookie } : undefined) },
      nextUrl: { searchParams: new URLSearchParams("") },
    } as any)
    const body = await r.json()
    expect(body.messages[0].stage).toBe("greeting")
    expect(body.messages[0].action).toBeUndefined()
    expect(body.messages[1].stage).toBe("payment_link")
    expect(body.messages[1].action.type).toBe("open_payment_link")
    expect(body.messages[1].offers_snapshot).toBeUndefined()
  })
})
