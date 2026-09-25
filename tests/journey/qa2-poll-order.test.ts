// QA round 2 — QAA2-06 / QAB1-H4 (BAIXO): polls fora de ordem. O client ignora
// uma resposta de GET /api/chat/messages mais ANTIGA que a última aplicada
// (server_time; empate/ausência → sequência local) — o prompt na tela nunca
// regride ao obsoleto. E `dead_payment_links`/`live:false` se aplicam no delta
// (poll incremental com `since`). Regra pura (poll-order.ts) + rota real + fonte.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

process.env.CHAT_JOURNEY_ENABLED = "true"
process.env.NEGOTIATION_JWT_SECRET = "test-secret-qa2-pollorder"

const CO = "eeeeeeee-0000-0000-0000-000000qa2po1"
const SID = "sess-qa2-pollorder"
const CUST = "cust-qa2-pollorder"
let db: FakeDb
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/journey/pinned-debt", () => ({ buildPinnedDebt: async () => null }))
vi.mock("@/lib/journey/recap", () => ({ buildRecap: async () => null }))

function seed() {
  db = {
    negotiation_sessions: [{ id: SID, company_id: CO, customer_id: CUST, thread_epoch: 0, wait_state: null, wait_started_at: null }],
    chat_prompts: [],
    chat_messages: [],
    agreements: [],
  }
}
async function getMessages(since: string | null) {
  const { GET } = await import("@/app/api/chat/messages/route")
  const { signChatJwt } = await import("@/lib/negotiation/crypto")
  const cookie = signChatJwt({ sid: SID, cid: CO }, 3600)
  const res = await GET({
    cookies: { get: (n: string) => (n === "alteapay_chat_session" ? { value: cookie } : undefined) },
    nextUrl: { searchParams: new URLSearchParams(since ? `since=${encodeURIComponent(since)}` : "") },
  } as any)
  return res.json()
}

describe("QAB1-H4 regra pura — isStalePoll", () => {
  it("sem última aplicada → aplica; server_time mais antigo → ignora; mais novo → aplica", async () => {
    const { isStalePoll } = await import("@/lib/journey/poll-order")
    expect(isStalePoll({ seq: 1, serverTime: "2026-09-25T20:00:00.000Z" }, null)).toBe(false)
    const last = { seq: 2, serverTime: "2026-09-25T20:00:05.000Z" }
    expect(isStalePoll({ seq: 1, serverTime: "2026-09-25T20:00:01.000Z" }, last)).toBe(true) // o 1º (lento) chegou depois do 2º
    expect(isStalePoll({ seq: 3, serverTime: "2026-09-25T20:00:07.000Z" }, last)).toBe(false)
    // relógio do servidor decide mesmo com seq invertida (aba com polls explícitos)
    expect(isStalePoll({ seq: 1, serverTime: "2026-09-25T20:00:09.000Z" }, last)).toBe(false)
  })

  it("empate ou ausência de server_time → decide a sequência local", async () => {
    const { isStalePoll } = await import("@/lib/journey/poll-order")
    const last = { seq: 5, serverTime: "2026-09-25T20:00:05.000Z" }
    expect(isStalePoll({ seq: 4, serverTime: "2026-09-25T20:00:05.000Z" }, last)).toBe(true)
    expect(isStalePoll({ seq: 6, serverTime: "2026-09-25T20:00:05.000Z" }, last)).toBe(false)
    expect(isStalePoll({ seq: 4, serverTime: null }, last)).toBe(true)
    expect(isStalePoll({ seq: 6, serverTime: null }, { seq: 5, serverTime: null })).toBe(false)
    expect(isStalePoll({ seq: 4, serverTime: "not-a-date" }, last)).toBe(true)
  })
})

describe("QAA2-06 — liveness no DELTA (poll incremental com since)", () => {
  beforeEach(seed)

  it("GET com since traz a bolha nova do link com live:false (acordo terminal) e dead_payment_links com o href", async () => {
    db.agreements = [{
      id: "ag-dead", company_id: CO, customer_id: CUST, asaas_payment_id: "pay_dead", status: "cancelled", payment_status: "deleted",
      asaas_invoice_url: "https://asaas/i/dead", asaas_payment_url: null, asaas_boleto_url: null, asaas_pix_qrcode_url: null,
    }]
    db.chat_messages = [
      { id: "m-old", session_id: SID, company_id: CO, role: "assistant", text: "antiga", created_at: "2026-09-25T20:00:00.000Z", offers_snapshot: null },
      {
        id: "m-link", session_id: SID, company_id: CO, role: "assistant", text: "Aqui está seu link para pagar R$ 250,00.\nhttps://asaas/i/dead",
        created_at: "2026-09-25T20:10:00.000Z",
        offers_snapshot: { stage: "payment_link", agreement_id: "ag-dead", message_action: { type: "open_payment_link", label: "Abrir link de pagamento", href: "https://asaas/i/dead" } },
      },
    ]
    const body = await getMessages("2026-09-25T20:05:00.000Z")
    expect(body.messages.map((m: { id: string }) => m.id)).toEqual(["m-link"]) // só o delta
    expect(body.messages[0].action).toMatchObject({ type: "open_payment_link", live: false })
    expect(body.dead_payment_links).toEqual(["https://asaas/i/dead"])
    expect(typeof body.server_time).toBe("string")
  })

  it("GET com since e nenhuma mensagem nova ainda traz dead_payment_links (a bolha já renderizada perde Abrir/Copiar)", async () => {
    db.agreements = [{ id: "ag-dead", company_id: CO, customer_id: CUST, asaas_payment_id: "pay_dead", status: "cancelled", payment_status: "deleted", asaas_invoice_url: "https://asaas/i/dead" }]
    const body = await getMessages("2026-09-25T23:59:59.000Z")
    expect(body.messages).toEqual([])
    expect(body.dead_payment_links).toEqual(["https://asaas/i/dead"])
  })
})

describe("QAB1-H4 client (chat.tsx) — wire-up (leitura do fonte)", () => {
  const src = readFileSync(join(__dirname, "..", "..", "components", "journey", "chat.tsx"), "utf8")
  const poll = src.slice(src.indexOf("async function pollMessages("), src.indexOf("function reconcilePayWait("))

  it("cada poll ganha uma sequência; a resposta mais antiga que a última aplicada é ignorada ANTES de tocar em qualquer estado", () => {
    expect(poll).toContain("const seq = ++pollSeqRef.current")
    const stale = poll.indexOf("if (isStalePoll(stamp, lastAppliedPollRef.current)) return")
    expect(stale).toBeGreaterThan(0)
    expect(poll.indexOf("lastAppliedPollRef.current = stamp")).toBeGreaterThan(stale)
    // nada de estado é aplicado antes do carimbo
    for (const apply of ["rehydrateWait(", "setPinnedDebt(", "setDeadLinkHrefs(", "setMessages(", "setActivePrompt("]) {
      expect(poll.indexOf(apply)).toBeGreaterThan(stale)
    }
  })

  it("dead_payment_links é aplicado em TODO poll aplicado (inclusive com since) e a liveness por mensagem vem do delta", () => {
    expect(poll).toContain("if (Array.isArray(data?.dead_payment_links)) setDeadLinkHrefs(deadHrefs)")
    expect(poll).toContain("isLivePaymentLink(action, deadHrefs)")
  })
})
