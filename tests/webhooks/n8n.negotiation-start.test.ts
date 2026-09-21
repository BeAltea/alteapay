// H7/H8: handoff ao n8n no reconhecimento "Sim" (startN8nNegotiation) e a
// serialização do payment.status (centavos + from_live_charge no already_charged).
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "../journey/_fake-supabase"

const CO = "eeeeeeee-0000-0000-0000-00000000000b"
const input = { companyId: CO, sessionId: "s1", customerId: "cust1", debtId: "debt1" }

let db: FakeDb
let emitResult: any
let recordedEvents: any[] = []

vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/negotiation/engine", () => ({
  emitNegotiationStart: async () => emitResult,
}))
vi.mock("@/lib/journey/events", () => ({
  recordEvent: async (e: any) => {
    recordedEvents.push(e)
    return { ok: true, duplicate: false }
  },
}))

function reset() {
  db = {
    negotiation_sessions: [{ id: "s1", company_id: CO, engine_owner: "platform" }],
  }
  recordedEvents = []
  emitResult = { ok: true, delivered: true, event_id: "evt-1" }
}

describe("startN8nNegotiation (H7)", () => {
  beforeEach(reset)

  it("disparo entregue → engine_owner='n8n' + evento de auditoria negotiation.start", async () => {
    const { startN8nNegotiation } = await import("@/lib/journey/acknowledgement")
    const r = await startN8nNegotiation(input)
    expect(r.owner).toBe("n8n")
    expect(r.delivered).toBe(true)
    // sessão passa a ser dona do n8n
    const sess = db.negotiation_sessions!.find((s) => s.id === "s1")
    expect(sess!.engine_owner).toBe("n8n")
    // auditoria registra o evento
    const ev = recordedEvents.find((e) => e.payload?.event === "negotiation.start")
    expect(ev).toBeTruthy()
    expect(ev.actor).toBe("n8n")
  })

  it("H8: disparo NÃO entregue (engine_unavailable) → mantém assistido (engine_owner='platform')", async () => {
    emitResult = { ok: true, delivered: false, reason: "engine_unavailable" }
    const { startN8nNegotiation } = await import("@/lib/journey/acknowledgement")
    const r = await startN8nNegotiation(input)
    expect(r.owner).toBe("platform")
    expect(r.delivered).toBe(false)
    const sess = db.negotiation_sessions!.find((s) => s.id === "s1")
    expect(sess!.engine_owner).toBe("platform")
    // auditoria registra o fallback
    const ev = recordedEvents.find((e) => e.payload?.event === "engine_unavailable")
    expect(ev).toBeTruthy()
    expect(ev.payload.reason).toBe("engine_unavailable")
  })

  it("H8: contexto irresolvível (ok:false) → assistido, sem lançar", async () => {
    emitResult = { ok: false, reason: "context_unresolved" }
    const { startN8nNegotiation } = await import("@/lib/journey/acknowledgement")
    const r = await startN8nNegotiation(input)
    expect(r.owner).toBe("platform")
    expect(r.delivered).toBe(false)
  })
})
