// A2 (N-D2-8 / N-D2-7):
//  - recordEvent: o event_id derivado por (tipo, ids, segundo) ganha um
//    DISCRIMINADOR do payload (offer_id/prompt_id/button_id/…) — eventos
//    legítimos no mesmo segundo (3 offer.presented) não colapsam em 1; o mesmo
//    evento repetido continua idempotente;
//  - engine_outbox ausente (PGRST205, produção): enqueueEvent/flushOutbox viram
//    no-ops EXPLÍCITOS (log 1x por processo), sem repetir a round-trip falha.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

const CO = "eeeeeeee-0000-0000-0000-0000000a2evt"
const SID = "sess-a2-evt"

let db: FakeDb
let outboxMissing = false

const MISSING = { code: "PGRST205", message: "Could not find the table 'public.engine_outbox' in the schema cache" }

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => {
    const fake = makeFakeSupabase(db)
    return {
      from(table: string) {
        if (table === "engine_outbox" && outboxMissing) {
          // builder cujos terminais devolvem o erro de tabela ausente
          const b: any = {}
          for (const m of ["select", "eq", "in", "gt", "gte", "lt", "or", "order", "limit", "insert", "update", "delete", "not", "is", "filter"]) {
            b[m] = () => b
          }
          b.maybeSingle = async () => ({ data: null, error: MISSING })
          b.single = async () => ({ data: null, error: MISSING })
          b.then = (resolve: (r: unknown) => void) => resolve({ data: null, error: MISSING })
          return b
        }
        return fake.from(table)
      },
    }
  },
}))
vi.mock("@/lib/journey/negotiation-state", () => ({ applyJourneyEventToState: async () => {} }))

describe("recordEvent — discriminador do event_id (N-D2-8)", () => {
  beforeEach(() => {
    db = { journey_events: [] }
  })

  it("3 offer.presented no MESMO segundo com offer_ids distintos → 3 event_ids distintos", async () => {
    const { recordEvent } = await import("@/lib/journey/events")
    const occurredAt = "2026-09-25T14:01:35.000Z"
    for (const offerId of ["off-a", "off-b", "off-c"]) {
      const r = await recordEvent({
        companyId: CO, sessionId: SID, type: "offer.presented", actor: "system", occurredAt,
        payload: { offer_id: offerId, installments: 1, total: 100 },
      })
      expect(r.ok).toBe(true)
    }
    const ids = new Set(db.journey_events.map((e) => e.event_id))
    expect(ids.size).toBe(3)
  })

  it("o MESMO evento (mesmo payload, mesmo segundo) deriva o MESMO event_id (idempotência preservada)", async () => {
    const { recordEvent } = await import("@/lib/journey/events")
    const occurredAt = "2026-09-25T14:01:35.100Z"
    await recordEvent({ companyId: CO, sessionId: SID, type: "prompt.ask" as any, actor: "system", occurredAt, payload: { prompt_id: "p1", kind: "x" } })
    await recordEvent({ companyId: CO, sessionId: SID, type: "prompt.ask" as any, actor: "system", occurredAt: "2026-09-25T14:01:35.900Z", payload: { prompt_id: "p1", kind: "x" } })
    expect(db.journey_events[0].event_id).toBe(db.journey_events[1].event_id)
    // sem payload discriminável → comportamento legado (tipo+ids+segundo)
    await recordEvent({ companyId: CO, sessionId: SID, type: "debt.viewed", actor: "customer", occurredAt })
    await recordEvent({ companyId: CO, sessionId: SID, type: "debt.viewed", actor: "customer", occurredAt: "2026-09-25T14:01:35.500Z" })
    const viewed = db.journey_events.filter((e) => e.event_type === "debt.viewed")
    expect(viewed[0].event_id).toBe(viewed[1].event_id)
  })

  it("eventId explícito continua vencendo o derivado", async () => {
    const { recordEvent } = await import("@/lib/journey/events")
    await recordEvent({ companyId: CO, sessionId: SID, type: "offer.presented", actor: "system", eventId: "offer.presented|x", payload: { offer_id: "x" } })
    expect(db.journey_events[0].event_id).toBe("offer.presented|x")
  })
})

describe("engine_outbox ausente → no-ops explícitos (N-D2-7)", () => {
  beforeEach(async () => {
    db = { engine_outbox: [] }
    outboxMissing = true
    process.env.NEGOTIATION_ENGINE = "n8n"
    process.env.N8N_CHAT_FLOW_URL = "http://127.0.0.1:9/flow"
    const { resetOutboxAvailability } = await import("@/lib/negotiation/outbox")
    resetOutboxAvailability()
  })

  it("enqueueEvent devolve ok:false engine_outbox_unavailable e loga 1x; a 2ª chamada é no-op sem nova round-trip", async () => {
    const outbox = await import("@/lib/negotiation/outbox")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const envelope = { type: "session.start", event_id: "evt-1", session_id: SID, company_id: CO } as any
    const a = await outbox.enqueueEvent({ sessionId: SID, companyId: CO, envelope })
    expect(a).toEqual({ ok: false, error: "engine_outbox_unavailable" })
    expect(outbox.outboxKnownUnavailable()).toBe(true)
    const outboxWarns = () => warn.mock.calls.filter((c) => String(c[0]).includes("engine_outbox ausente")).length
    expect(outboxWarns()).toBe(1)
    const b = await outbox.enqueueEvent({ sessionId: SID, companyId: CO, envelope: { ...envelope, event_id: "evt-2" } })
    expect(b).toEqual({ ok: false, error: "engine_outbox_unavailable" })
    expect(outboxWarns()).toBe(1) // logado UMA vez por processo
    const flush = await outbox.flushOutbox({ sessionId: SID })
    expect(flush).toEqual({ scanned: 0, sent: 0, failed: 0, pending: 0 })
  })

  it("isOutboxUnavailableError reconhece PGRST205/42P01 e a mensagem de tabela ausente", async () => {
    const { isOutboxUnavailableError } = await import("@/lib/negotiation/outbox")
    expect(isOutboxUnavailableError(MISSING)).toBe(true)
    expect(isOutboxUnavailableError({ code: "42P01", message: "relation engine_outbox does not exist" })).toBe(true)
    expect(isOutboxUnavailableError({ code: "23505", message: "duplicate key" })).toBe(false)
    expect(isOutboxUnavailableError(null)).toBe(false)
  })

  it("com a tabela presente nada muda (a memória de indisponibilidade só liga no erro)", async () => {
    outboxMissing = false
    const outbox = await import("@/lib/negotiation/outbox")
    outbox.resetOutboxAvailability()
    const envelope = { type: "session.start", event_id: "evt-ok", session_id: SID, company_id: CO } as any
    const r = await outbox.enqueueEvent({ sessionId: SID, companyId: CO, envelope })
    expect(r.ok).toBe(true)
    expect(outbox.outboxKnownUnavailable()).toBe(false)
    expect(db.engine_outbox.length).toBe(1)
  })
})
