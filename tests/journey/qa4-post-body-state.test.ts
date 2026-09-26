// QA round 4 — R-13/R-22/R-24/R-29 (S3): o CORPO do POST é o próximo estado
// (eco + resultado persistido + prompt + state_time) e o client o aplica na hora;
// um GET em voo desde antes do POST nunca regride o prompt aplicado; "nenhum
// prompt" durante a troca (prompt_pending) não apaga o menu; "Já paguei" na tela
// em ≤ 1 s pelo corpo; a afordância "Já paguei" do pós-link deriva do prompt.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"
import {
  isFencedPoll,
  isPromptPending,
  isStalePoll,
  POST_PROMPT_HOLD_MS,
  PROMPT_PENDING_WINDOW_MS,
  shouldHoldPromptOnNull,
} from "@/lib/journey/poll-order"

process.env.CHAT_JOURNEY_ENABLED = "true"
process.env.NEGOTIATION_JWT_SECRET = "test-secret-qa4-body"

const CO = "eeeeeeee-0000-0000-0000-0000000qa4b1"
const SID = "sess-qa4-body"
const CUST = "cust-qa4-body"
const DEBT = "debt-qa4-body"

let db: FakeDb
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/asaas", () => ({ getAsaasPaymentsForCustomer: async () => [] }))
vi.mock("@/lib/notifications/email", () => ({ sendEmail: async () => ({ ok: true }) }))
vi.mock("@/lib/journey/events", () => ({
  recordEvent: async () => ({ ok: true, duplicate: false }),
  getTimeline: async () => [],
}))
vi.mock("@/lib/negotiation/engine", () => ({
  engineName: () => "disabled",
  emitNegotiationStart: async () => ({ ok: true, delivered: false, reason: "engine_unavailable" }),
}))

function seed() {
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
function getReq(cookieValue: string) {
  return {
    cookies: { get: (name: string) => (name === "alteapay_chat_session" ? { value: cookieValue } : undefined) },
    nextUrl: new URL("http://localhost/api/chat/messages"),
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
function ageClicks(ms = 3000) {
  for (const m of db.chat_messages as Array<{ role?: string; created_at?: string }>) {
    if (m.role === "customer" && m.created_at) m.created_at = new Date(Date.parse(m.created_at) - ms).toISOString()
  }
}

describe("R-22 — cerca de polls e prompt_pending (puro)", () => {
  it("GET(t0) em voo → POST(t1) aplicado → GET(t0) chega depois: cercado (não aplicado), mesmo com server_time maior", () => {
    const fence = 7 // pollSeq no instante em que o corpo do POST foi aplicado
    expect(isFencedPoll(7, fence)).toBe(true) // disparado antes
    expect(isFencedPoll(5, fence)).toBe(true)
    expect(isFencedPoll(8, fence)).toBe(false) // disparado depois
    expect(isFencedPoll(3, null)).toBe(false)
    // e o carimbo de tempo do POST continua valendo para os GETs posteriores
    const applied = { seq: 7, serverTime: "2026-09-26T10:00:05.000Z" }
    expect(isStalePoll({ seq: 8, serverTime: "2026-09-26T10:00:04.000Z" }, applied)).toBe(true)
    expect(isStalePoll({ seq: 8, serverTime: "2026-09-26T10:00:06.000Z" }, applied)).toBe(false)
  })

  it("active_prompt:null não apaga o menu na troca (prompt_pending) nem logo depois de um POST", () => {
    const now = 100_000
    expect(shouldHoldPromptOnNull({ promptPending: true, lastPostPromptAtMs: null, nowMs: now, hasPromptOnScreen: true })).toBe(true)
    expect(shouldHoldPromptOnNull({ promptPending: false, lastPostPromptAtMs: now - 3000, nowMs: now, hasPromptOnScreen: true })).toBe(true)
    expect(shouldHoldPromptOnNull({ promptPending: false, lastPostPromptAtMs: now - POST_PROMPT_HOLD_MS, nowMs: now, hasPromptOnScreen: true })).toBe(false)
    expect(shouldHoldPromptOnNull({ promptPending: true, lastPostPromptAtMs: null, nowMs: now, hasPromptOnScreen: false })).toBe(false)
  })

  it("isPromptPending: último prompt respondido há < 8 s e sem sucessor", () => {
    const now = Date.parse("2026-09-26T10:00:10.000Z")
    const answered = (ms: number) => ({ status: "answered", created_at: "2026-09-26T09:00:00.000Z", answered_at: new Date(now - ms).toISOString() })
    expect(isPromptPending([answered(500)], now)).toBe(true)
    expect(isPromptPending([answered(PROMPT_PENDING_WINDOW_MS)], now)).toBe(false)
    expect(isPromptPending([answered(500), { status: "active", created_at: new Date(now).toISOString() }], now)).toBe(false)
    expect(isPromptPending([], now)).toBe(false)
  })
})

describe("R-13/R-24 — rotas devolvem o próximo estado no corpo", () => {
  beforeEach(seed)

  it("Detalhes: corpo com o menu reaberto (prompt), o resultado persistido (id real) e state_time", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    const p1 = await bootstrap()
    const res = await POST(req(await signed(), { prompt_id: p1.id, button_id: 2 }))
    const b = await res.json()
    const p2 = db.chat_prompts.find((p) => p.status === "active")!
    expect(b.prompt?.id).toBe(p2.id)
    expect(b.prompt?.buttons?.some((x: { id: number }) => x.id === 4)).toBe(true)
    expect(b.outcome?.stage).toBe("detail")
    expect(db.chat_messages.find((m) => m.id === b.outcome.id)?.text).toBe(b.reply)
    expect(b.outcome.prompt_id).toBe(p1.id)
    expect(typeof b.state_time).toBe("string")
    expect(res.headers.get("Server-Timing")).toMatch(/total;dur=\d+/)
  })

  it("Não reconheço: corpo com o menu-volta [98] e o resultado persistido", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    const p1 = await bootstrap()
    const b = await (await POST(req(await signed(), { prompt_id: p1.id, button_id: 0 }))).json()
    expect(b.action).toBe("not_recognized")
    expect(b.prompt?.buttons?.map((x: { id: number }) => x.id)).toEqual([98])
    expect(b.outcome?.stage).toBe("not_recognized")
  })

  it("Voltar (reopen_options) e Já paguei (payment_claim): corpo com o menu ativo e state_time (≤ 1 s na tela, sem poll)", async () => {
    const { POST: REOPEN } = await import("@/app/api/chat/reopen/route")
    await bootstrap()
    const jwt = await signed()
    const back = await REOPEN(req(jwt, { action: "reopen_options" }))
    const bb = await back.json()
    expect(bb.prompt?.kind).toBe("debt_three_options")
    expect(typeof bb.state_time).toBe("string")
    expect(back.headers.get("Server-Timing")).toMatch(/total;dur=\d+/)
    const claim = await (await REOPEN(req(jwt, { action: "payment_claim" }))).json()
    expect(claim.outcome?.id).toBeTruthy()
    expect(claim.echo?.id).toBeTruthy()
    expect(claim.prompt?.kind).toBe("debt_three_options")
  })

  it("GET /api/chat/messages: server_time tirado antes das leituras, prompt_pending e Server-Timing", async () => {
    const { GET } = await import("@/app/api/chat/messages/route")
    const p1 = await bootstrap()
    const before = Date.now()
    const res = await GET(getReq(await signed()))
    const body = await res.json()
    expect(body.active_prompt?.id).toBe(p1.id)
    expect(body.prompt_pending).toBe(false)
    expect(Date.parse(body.server_time)).toBeGreaterThanOrEqual(before - 5)
    expect(res.headers.get("Server-Timing")).toMatch(/messages;dur=\d+.*total;dur=\d+/)
    // troca em curso: o menu foi respondido e o sucessor ainda não existe
    p1.status = "answered"
    p1.answered_at = new Date().toISOString()
    const mid = await (await GET(getReq(await signed()))).json()
    expect(mid.active_prompt).toBeNull()
    expect(mid.prompt_pending).toBe(true)
  })

  it("claim fora da janela de toque múltiplo continua registrando (um caso por sessão reusado)", async () => {
    const { POST: REOPEN } = await import("@/app/api/chat/reopen/route")
    await bootstrap()
    const jwt = await signed()
    const a = await (await REOPEN(req(jwt, { action: "payment_claim" }))).json()
    ageClicks()
    const b = await (await REOPEN(req(jwt, { action: "payment_claim" }))).json()
    expect(b.duplicate).toBeUndefined()
    expect(b.case_id).toBe(a.case_id)
  })
})

describe("chat.tsx — o corpo é aplicado na hora (leitura do fonte)", () => {
  const src = readFileSync(join(__dirname, "..", "..", "components/journey/chat.tsx"), "utf8")

  it("applyActionBody ergue a cerca, aplica eco/resultado (dedup por id) e o prompt", () => {
    expect(src).toContain("function applyActionBody(")
    expect(src).toContain("fenceSeqRef.current = pollSeqRef.current")
    expect(src).toContain("for (const r of fresh) seenIds.current.add(r.id)")
    expect(src).toContain("lastPostPromptAtRef.current = Date.now()")
    expect(src).toContain("if (isFencedPoll(seq, fenceSeqRef.current)) return")
    expect(src).toContain("promptPending: data?.prompt_pending === true")
  })

  it("Já paguei e Voltar leem o corpo; o clique não zera mais o prompt antes do poll quando o corpo o traz", () => {
    expect(src).toMatch(/body: JSON\.stringify\(\{ action: "payment_claim" \}\),\s*\}\)\s*if \(res\.ok\) applyActionBody/)
    expect(src).toMatch(/body: JSON\.stringify\(\{ action: "reopen_options" \}\),\s*\}\)[\s\S]{0,120}applyActionBody/)
    expect(src).toContain("if (asActivePrompt(data?.prompt) && !endedRef.current && data?.transferred !== true) {")
  })

  it("R-29: 'Já paguei' do pós-link deriva do prompt do servidor com link vivo; nunca some até o F5", () => {
    expect(src).toContain('(activePrompt.kind === "post_payment_link" && linkView.hasLiveLink)')
    expect(src).toContain("claimInFlightRef.current = false")
    expect(src).not.toContain("setClaimSent(true)")
  })
})
