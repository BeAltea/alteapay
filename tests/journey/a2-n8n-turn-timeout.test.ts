// A2 (N-D2-1) — NEGOTIATION_ENGINE=n8n em produção: o clique num prompt criado
// pelo n8n ("demais prompts") manda um turno ao fluxo com timeout CURTO
// (N8N_CLICK_TIMEOUT_MS). Nenhum clique fica preso 20 s: estourado o deadline, o
// assistido volta (menu de 3 opções reaberto e devolvido no corpo). Em qualquer
// desfecho a sessão termina com um prompt ativo (rede de segurança), inclusive
// com o engine desligado.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

process.env.CHAT_JOURNEY_ENABLED = "true"
process.env.NEGOTIATION_JWT_SECRET = "test-secret-a2-turn"

const CO = "eeeeeeee-0000-0000-0000-0000000a2trn"
const SID = "sess-a2-turn"
const CUST = "cust-a2-turn"
const DEBT = "debt-a2-turn"

let db: FakeDb
let engine: "n8n" | "disabled" = "n8n"
let turnMode: "hang" | "sync" | "throw" = "hang"
let turnCalls = 0

vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/asaas", () => ({ getAsaasPaymentsForCustomer: async () => [] }))
vi.mock("@/lib/notifications/email", () => ({ sendEmail: async () => ({ ok: true }) }))
vi.mock("@/lib/journey/events", () => ({
  recordEvent: async () => ({ ok: true, duplicate: false }),
  getTimeline: async () => [],
}))
vi.mock("@/lib/journey/closing", () => ({
  buildAcceptSummary: async () => ({ ok: true, summary: { termsHash: "h", terms: {}, validUntil: null } }),
  confirmAccept: async () => ({ ok: false, error: "never_called" }),
}))
vi.mock("@/lib/negotiation/engine", () => ({
  engineName: () => engine,
  emitNegotiationStart: async () => ({ ok: true, delivered: false, reason: "engine_unavailable" }),
}))
vi.mock("@/lib/journey/chat-turn", () => ({
  runJourneyTurn: async (_ctx: unknown, label: string) => {
    turnCalls += 1
    if (turnMode === "hang") return new Promise(() => {})
    if (turnMode === "throw") throw new Error("boom")
    return { reply: `n8n respondeu a "${label}"`, offers: [], action: null }
  },
}))

function seed() {
  engine = "n8n"
  turnMode = "hang"
  turnCalls = 0
  process.env.N8N_CLICK_TIMEOUT_MS = "200"
  db = {
    tenant_chat_config: [{
      company_id: CO, payment_origin: "platform", allow_payment_without_acknowledgement: true,
      acknowledgement_enabled: true, show_handoff_button: false, on_debt_not_recognized: "continue",
      official_channel_label: null, official_channel_url: null, branding: { brand_name: "VMAX" },
    }],
    companies: [{ id: CO, name: "VMAX LTDA" }],
    customers: [{ id: CUST, company_id: CO, name: "Fabio Mendes", document: "11144477735" }],
    debts: [{ id: DEBT, company_id: CO, customer_id: CUST, status: "pending", amount: 250, due_date: "2020-01-01" }],
    vmax_invoices: [{ id_company: CO, doc: "11144477735", fatura: "F1", vencimento: "2020-01-10", saldo: 250 }],
    negotiation_sessions: [{ id: SID, company_id: CO, customer_id: CUST, debt_id: DEBT, debt_ids: [DEBT], primary_debt_id: DEBT, agreement_id: null, debt_acknowledged_at: "2026-09-25T10:00:00Z", engine_owner: "n8n", thread_epoch: 0 }],
    negotiation_offers: [],
    negotiation_condition_matrix: [],
    negotiation_acceptances: [],
    // prompt criado pelo n8n (kind desconhecido da plataforma), ATIVO
    chat_prompts: [{
      id: "p-n8n", company_id: CO, session_id: SID, kind: "negotiation_l1", status: "active",
      created_by: "n8n", question: "Quer regularizar?",
      buttons: [{ id: 1, label: "Sim, quero regularizar" }, { id: 0, label: "Não" }],
      context: null, created_at: "2026-09-25T10:00:00.000Z",
    }],
    chat_messages: [],
    debt_acknowledgements: [],
    debt_acknowledgement_latest: [],
    agreements: [],
  }
}

function buttonReq(cookieValue: string | null, body: Record<string, unknown>) {
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
const active = () => db.chat_prompts.find((p) => p.status === "active")

describe("A2 — clique em prompt do n8n com NEGOTIATION_ENGINE=n8n", () => {
  beforeEach(seed)

  it("n8n pendurado → responde no timeout curto com action engine_timeout + menu assistido reaberto no corpo", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    const t0 = Date.now()
    const r = await POST(buttonReq(await signed(), { prompt_id: "p-n8n", button_id: 1 }))
    const ms = Date.now() - t0
    const b = await r.json()
    expect(r.status).toBe(200)
    expect(b.ok).toBe(true)
    expect(b.action).toBe("engine_timeout")
    expect(b.processing).toBe(true)
    expect(ms).toBeLessThan(3000)
    expect(turnCalls).toBe(1)
    // assistido de volta: menu de 3 opções ATIVO e devolvido no corpo (shape do GET)
    expect(b.assisted_reopened).toBe(true)
    expect(b.prompt).toBeTruthy()
    expect(b.prompt.kind).toBe("debt_three_options")
    expect(b.prompt.buttons.map((x: { id: number }) => x.id)).toEqual([4, 1, 2, 0])
    expect(active()!.id).toBe(b.prompt.id)
    // o prompt do n8n foi respondido (eco gravado)
    expect(db.chat_prompts.find((p) => p.id === "p-n8n")!.status).toBe("answered")
    expect(db.chat_messages.some((m) => m.role === "customer" && m.button_id === 1)).toBe(true)
  })

  it("n8n responde a tempo (sync) → reply devolvido; sem prompt ativo após o turno, o assistido é reaberto", async () => {
    turnMode = "sync"
    const { POST } = await import("@/app/api/chat/button/route")
    const b = await (await POST(buttonReq(await signed(), { prompt_id: "p-n8n", button_id: 1 }))).json()
    expect(b.ok).toBe(true)
    expect(b.action).toBeNull()
    expect(b.reply).toContain("n8n respondeu")
    expect(b.processing).toBe(false)
    expect(b.prompt.kind).toBe("debt_three_options")
    expect(b.assisted_reopened).toBe(true)
  })

  it("turno lança → fallback assistido (200 + menu), nunca 500 mudo", async () => {
    turnMode = "throw"
    const { POST } = await import("@/app/api/chat/button/route")
    const r = await POST(buttonReq(await signed(), { prompt_id: "p-n8n", button_id: 1 }))
    const b = await r.json()
    expect(r.status).toBe(200)
    expect(b.ok).toBe(true)
    expect(b.prompt.kind).toBe("debt_three_options")
  })

  it("engine desligado → sem turno ao n8n; ainda assim garante um prompt ativo (assistido)", async () => {
    engine = "disabled"
    const { POST } = await import("@/app/api/chat/button/route")
    const b = await (await POST(buttonReq(await signed(), { prompt_id: "p-n8n", button_id: 0 }))).json()
    expect(b.ok).toBe(true)
    expect(turnCalls).toBe(0)
    expect(b.prompt.kind).toBe("debt_three_options")
    expect(active()!.kind).toBe("debt_three_options")
  })
})
