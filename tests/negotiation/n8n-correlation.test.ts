// N8N-16: correlação callback n8n ⇄ evento enviado pela plataforma.
import { describe, expect, it } from "vitest"

import {
  COVERED_ACTIONS,
  checkN8nCorrelation,
  correlationRequired,
  enforceN8nCorrelation,
  extractOriginEventId,
  recordN8nOutbound,
  setCorrelationStoreForTests,
  type CorrelationStore,
  type OutboundRecord,
  type ReplySlot,
} from "@/lib/negotiation/n8n-correlation"
import { chatTurnEventId } from "@/lib/negotiation/payload"

const S1 = "11111111-1111-4111-8111-111111111111"
const S2 = "22222222-2222-4222-8222-222222222222"
const C1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const C2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const NOW = Date.parse("2026-09-27T12:00:00Z")
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()

interface Mem {
  sessions: Record<string, { id: string; company_id: string }>
  ledger: OutboundRecord[]
  inbound: { id: string; session_id: string; company_id: string; created_at: string }[]
  outbox: OutboundRecord[]
  slots: Map<string, ReplySlot>
  misses: { action: string; code: string; enforced: boolean }[]
  outbound: { eventId: string; sessionId: string; companyId: string; event: string }[]
  failLedger?: boolean
}

function memStore(m: Partial<Mem> = {}): { store: CorrelationStore; mem: Mem } {
  const mem: Mem = {
    sessions: { [S1]: { id: S1, company_id: C1 }, [S2]: { id: S2, company_id: C1 } },
    ledger: [],
    inbound: [],
    outbox: [],
    slots: new Map(),
    misses: [],
    outbound: [],
    ...m,
  }
  const store: CorrelationStore = {
    loadSession: async (id) => mem.sessions[id] ?? null,
    findLedger: async (ids) => {
      if (mem.failLedger) throw new Error("db down")
      return mem.ledger.filter((r) => ids.includes(r.event_id))
    },
    recentInboundIds: async (sid, cid, since) =>
      mem.inbound
        .filter((r) => r.session_id === sid && r.company_id === cid && r.created_at >= since)
        .map((r) => r.id),
    findOutbox: async (id) => mem.outbox.find((r) => r.event_id === id) ?? null,
    listReplySlots: async (ids) => ids.filter((id) => mem.slots.has(id)).map((id) => mem.slots.get(id)!),
    claimReplySlot: async (row) => {
      if (mem.slots.has(row.slotId)) return false
      mem.slots.set(row.slotId, { event_id: row.slotId, callback_key: row.callbackKey })
      return true
    },
    recordOutbound: async (row) => {
      mem.outbound.push(row)
      mem.ledger.push({ event_id: `n8n_out:${row.eventId}`, session_id: row.sessionId, company_id: row.companyId, occurred_at: new Date(NOW).toISOString() })
    },
    recordMiss: async (row) => {
      mem.misses.push({ action: row.action, code: row.code, enforced: row.enforced })
    },
  }
  return { store, mem }
}

const ORIGIN = "0f0e0d0c-0b0a-4909-8807-060504030201"
const ledgerRow = (over: Partial<OutboundRecord> = {}): OutboundRecord => ({
  event_id: `n8n_out:${ORIGIN}`,
  session_id: S1,
  company_id: C1,
  occurred_at: iso(60_000),
  ...over,
})

function chatSend(over: Record<string, unknown> = {}) {
  return { action: "chat.send", session_id: S1, event_id: "cb-evt-0001", origin_event_id: ORIGIN, args: { text: "oi" }, ...over }
}

async function check(store: CorrelationStore, body: Record<string, unknown>, extra: { maxReplies?: number } = {}) {
  return checkN8nCorrelation(body as never, body, { store, nowMs: NOW, windowSeconds: 900, ...extra })
}

describe("N8N-16 — checkN8nCorrelation", () => {
  it("aceita callback correlacionado ao ledger de saída (negotiation.start)", async () => {
    const { store, mem } = memStore({ ledger: [ledgerRow()] })
    const v = await check(store, chatSend())
    expect(v.ok).toBe(true)
    expect(v).toMatchObject({ covered: true, source: "ledger", replay: false })
    expect(mem.slots.size).toBe(1)
  })

  it("aceita as linhas de auditoria legadas neg_start:<id>", async () => {
    const { store } = memStore({ ledger: [ledgerRow({ event_id: `neg_start:${ORIGIN}` })] })
    expect((await check(store, chatSend())).ok).toBe(true)
  })

  it("aceita chat.turn pelo event_id determinístico da mensagem inbound", async () => {
    const inboundId = "33333333-3333-4333-8333-333333333333"
    const origin = chatTurnEventId(S1, inboundId)
    const { store } = memStore({ inbound: [{ id: inboundId, session_id: S1, company_id: C1, created_at: iso(5_000) }] })
    const v = await check(store, chatSend({ origin_event_id: undefined, event_id: origin }))
    expect(v).toMatchObject({ ok: true, covered: true, source: "chat_turn" })
  })

  it("chat.turn de OUTRA sessão não correlaciona", async () => {
    const inboundId = "33333333-3333-4333-8333-333333333333"
    const originOfS2 = chatTurnEventId(S2, inboundId)
    const { store } = memStore({ inbound: [{ id: inboundId, session_id: S2, company_id: C1, created_at: iso(5_000) }] })
    const v = await check(store, chatSend({ origin_event_id: originOfS2 }))
    expect(v).toMatchObject({ ok: false, code: "n8n_origin_unknown", status: 403 })
  })

  it("recusa sem origin (o caso N8N-16: fluxo disparado por POST não assinado)", async () => {
    const { store } = memStore({ ledger: [ledgerRow()] })
    const v = await check(store, chatSend({ origin_event_id: undefined, event_id: undefined }))
    expect(v).toMatchObject({ ok: false, code: "n8n_origin_missing", status: 403 })
  })

  it("recusa origin desconhecido", async () => {
    const { store } = memStore()
    expect(await check(store, chatSend())).toMatchObject({ ok: false, code: "n8n_origin_unknown" })
  })

  it("recusa evento enviado para OUTRA sessão", async () => {
    const { store } = memStore({ ledger: [ledgerRow({ session_id: S2 })] })
    expect(await check(store, chatSend())).toMatchObject({ ok: false, code: "n8n_origin_wrong_session", status: 403 })
  })

  it("recusa evento de OUTRA empresa", async () => {
    const { store } = memStore({ ledger: [ledgerRow({ company_id: C2 })] })
    expect(await check(store, chatSend())).toMatchObject({ ok: false, code: "n8n_origin_wrong_company", status: 403 })
  })

  it("recusa evento fora da janela", async () => {
    const { store } = memStore({ ledger: [ledgerRow({ occurred_at: iso(901_000) })] })
    expect(await check(store, chatSend())).toMatchObject({ ok: false, code: "n8n_origin_expired", status: 409 })
  })

  it("teto de respostas por evento de origem", async () => {
    const { store } = memStore({ ledger: [ledgerRow()] })
    for (let i = 0; i < 3; i++) {
      expect((await check(store, chatSend({ event_id: `cb-evt-000${i}` }), { maxReplies: 3 })).ok).toBe(true)
    }
    expect(await check(store, chatSend({ event_id: "cb-evt-0009" }), { maxReplies: 3 })).toMatchObject({
      ok: false, code: "n8n_reply_cap", status: 409,
    })
  })

  it("replay do MESMO callback não consome o teto (idempotência a jusante)", async () => {
    const { store, mem } = memStore({ ledger: [ledgerRow()] })
    const first = await check(store, chatSend(), { maxReplies: 1 })
    const replay = await check(store, chatSend(), { maxReplies: 1 })
    expect(first).toMatchObject({ ok: true, replay: false })
    expect(replay).toMatchObject({ ok: true, replay: true })
    expect(mem.slots.size).toBe(1)
    // outro callback (event_id novo) já estoura o teto de 1
    expect(await check(store, chatSend({ event_id: "cb-evt-0002" }), { maxReplies: 1 })).toMatchObject({ code: "n8n_reply_cap" })
  })

  it("flow.state.set é coberto mas não consome o teto", async () => {
    const { store, mem } = memStore({ ledger: [ledgerRow()] })
    const v = await check(store, { action: "flow.state.set", session_id: S1, event_id: "st-0001", origin_event_id: ORIGIN })
    expect(v).toMatchObject({ ok: true, covered: true })
    expect(mem.slots.size).toBe(0)
    expect(await check(store, { action: "flow.state.set", session_id: S1, event_id: "st-0002" })).toMatchObject({ ok: false })
  })

  it("ações de leitura e session.create não são cobertas", async () => {
    const { store } = memStore()
    for (const action of ["ping", "offer.list", "debt.summary", "payment.status", "session.status", "flow.context", "session.create"]) {
      expect(await check(store, { action, session_id: S1 })).toEqual({ ok: true, covered: false })
    }
    expect(COVERED_ACTIONS.has("payment.create")).toBe(true)
    expect(COVERED_ACTIONS.has("human.transfer")).toBe(true)
  })

  it("sessão inexistente não é decidida aqui (o handler responde 404)", async () => {
    const { store } = memStore()
    const v = await check(store, chatSend({ session_id: "99999999-9999-4999-8999-999999999999" }))
    expect(v).toEqual({ ok: true, covered: false })
  })

  it("banco indisponível → n8n_correlation_unavailable (503)", async () => {
    const { store } = memStore({ ledger: [ledgerRow()], failLedger: true })
    expect(await check(store, chatSend())).toMatchObject({ ok: false, code: "n8n_correlation_unavailable", status: 503 })
  })

  it("extractOriginEventId: origin_event_id vence; event_id é o eco de fallback; lixo é ignorado", () => {
    expect(extractOriginEventId({ origin_event_id: ORIGIN, event_id: "x-evt-0001" })).toBe(ORIGIN)
    expect(extractOriginEventId({ event_id: ORIGIN })).toBe(ORIGIN)
    expect(extractOriginEventId({ event_id: "a b" })).toBeNull()
    expect(extractOriginEventId(null)).toBeNull()
  })

  it("recordN8nOutbound grava no ledger e torna o evento correlacionável", async () => {
    const { store, mem } = memStore()
    setCorrelationStoreForTests(store)
    try {
      await recordN8nOutbound({ eventId: ORIGIN, sessionId: S1, companyId: C1, event: "negotiation.start" })
      expect(mem.outbound).toHaveLength(1)
      expect((await check(store, chatSend())).ok).toBe(true)
    } finally {
      setCorrelationStoreForTests(null)
    }
  })
})

describe("N8N-16 — enforceN8nCorrelation (flag)", () => {
  it("flag OFF por padrão", () => {
    expect(correlationRequired({} as unknown as NodeJS.ProcessEnv)).toBe(false)
    expect(correlationRequired({ N8N_REQUIRE_EVENT_CORRELATION: "true" } as unknown as NodeJS.ProcessEnv)).toBe(true)
    expect(correlationRequired({ N8N_REQUIRE_EVENT_CORRELATION: "0" } as unknown as NodeJS.ProcessEnv)).toBe(false)
  })

  it("OFF: não recusa, mas registra a telemetria (sem PII)", async () => {
    const { store, mem } = memStore()
    const body = chatSend()
    const g = await enforceN8nCorrelation(body, body, { store, nowMs: NOW, required: false })
    expect(g).toEqual({ reject: false })
    expect(mem.misses).toEqual([{ action: "chat.send", code: "n8n_origin_unknown", enforced: false }])
  })

  it("ON: recusa não correlacionado com status e código estáveis", async () => {
    const { store, mem } = memStore()
    const body = chatSend()
    const g = await enforceN8nCorrelation(body, body, { store, nowMs: NOW, required: true })
    expect(g).toMatchObject({ reject: true, status: 403, code: "n8n_origin_unknown" })
    expect(mem.misses[0]).toMatchObject({ enforced: true })
  })

  it("ON: aceita correlacionado sem telemetria", async () => {
    const { store, mem } = memStore({ ledger: [ledgerRow()] })
    const body = chatSend()
    expect(await enforceN8nCorrelation(body, body, { store, nowMs: NOW, required: true })).toEqual({ reject: false })
    expect(mem.misses).toHaveLength(0)
  })
})
