// D1/Frente A: outbox transacional (outbox.ts).
//  - engine 'disabled' (default de prod) → linha nasce 'skipped_engine_disabled'
//    e NUNCA é enviada (fetch nem é chamado).
//  - engine plugado mas n8n fora do ar → linha fica 'pending' (não perde o evento;
//    o flush reentrega). O reconhecimento (nossos dados) independe disso.
//  - idempotência por event_id: o mesmo event_id não duplica linha.
//  - flush ordenado marca 'sent' quando o n8n responde 2xx.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "../journey/_fake-supabase"
import type { CanonicalEnvelope } from "@/lib/negotiation/payload"

let db: FakeDb
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => makeFakeSupabase(db),
}))

const CO = "cccccccc-0000-0000-0000-000000000003"
const SID = "5e551011-0000-0000-0000-000000000001"

function envelope(over: Partial<CanonicalEnvelope> = {}): CanonicalEnvelope {
  return {
    type: "session.start",
    contract_version: "1.0",
    event_id: "evt_deterministic_0001",
    occurred_at: "2026-09-23T12:00:00.000Z",
    thread_id: `web_${SID}`,
    session_id: SID,
    company_id: CO,
    channel: "webchat",
    message: null,
    button: null,
    session_state: { identity_verified: true, debt_acknowledged: false, fulfillment_mode: "A", outcome: "in_progress" },
    debtor: {
      id: "cust1",
      name: "Fabio",
      document: null,
      document_masked: "***.444.557-**",
      document_hash: "a".repeat(64),
    },
    debt: {
      id: "debt1",
      amount: 100,
      amount_cents: 10000,
      amount_formatted: "R$ 100,00",
      currency: "BRL",
      due_date: "2025-01-01",
      description: null,
      aging_days: 100,
      invoice_count: 1,
      has_live_charge: false,
    },
    tenant: {
      fulfillment_mode: "A",
      official_channel_label: "Portal VMAX",
      brand_name: "VMAX",
      chat_link: "https://alteapay.com/n/abc",
    },
    ...over,
  }
}

function reset() {
  db = { engine_outbox: [] }
  delete process.env.NEGOTIATION_ENGINE
  process.env.N8N_CHAT_FLOW_URL = "https://n8n.example/webhook/flow"
  process.env.N8N_WEBHOOK_SECRET = "s3cr3t"
  delete process.env.AGENT_URL
  vi.restoreAllMocks()
}

describe("enqueueEvent — gating por engine", () => {
  beforeEach(reset)
  afterEach(() => vi.restoreAllMocks())

  it("engine 'disabled' (default) → 'skipped_engine_disabled', não envia", async () => {
    // sem NEGOTIATION_ENGINE → engineName() = 'disabled'
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const { enqueueEvent } = await import("@/lib/negotiation/outbox")
    const res = await enqueueEvent({ sessionId: SID, companyId: CO, envelope: envelope() })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.status).toBe("skipped_engine_disabled")
      expect(res.created).toBe(true)
    }
    // a linha existe com o status gated
    const row = db.engine_outbox[0]
    expect(row.status).toBe("skipped_engine_disabled")
    expect(row.next_attempt_at).toBeNull()
    // NUNCA chamou o n8n
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("idempotência: mesmo event_id não duplica linha", async () => {
    const { enqueueEvent } = await import("@/lib/negotiation/outbox")
    const first = await enqueueEvent({ sessionId: SID, companyId: CO, envelope: envelope() })
    const second = await enqueueEvent({ sessionId: SID, companyId: CO, envelope: envelope() })
    expect(first.ok && first.created).toBe(true)
    expect(second.ok && second.created).toBe(false)
    expect(db.engine_outbox.length).toBe(1)
  })
})

describe("dispatch/flush — n8n plugado", () => {
  beforeEach(() => {
    reset()
    process.env.NEGOTIATION_ENGINE = "n8n"
  })
  afterEach(() => vi.restoreAllMocks())

  it("n8n fora do ar → linha permanece 'pending' (evento não se perde)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(Object.assign(new Error("down"), { name: "TypeError" }))
    const { enqueueEvent, dispatchOutboxRow } = await import("@/lib/negotiation/outbox")
    const enq = await enqueueEvent({ sessionId: SID, companyId: CO, envelope: envelope() })
    expect(enq.ok && enq.status).toBe("pending")
    if (enq.ok) {
      const status = await dispatchOutboxRow({ id: enq.id, payload: envelope(), attempts: 0, status: "pending" })
      expect(status).toBe("pending")
    }
    const row = db.engine_outbox[0]
    expect(row.status).toBe("pending")
    expect(row.attempts).toBe(1)
    expect(row.next_attempt_at).not.toBeNull() // backoff agendado
    // rótulo técnico curto, sem segredo/URL
    expect(row.last_error).toBe("network_error")
  })

  it("n8n responde 2xx → 'sent'", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )
    const { enqueueEvent, dispatchOutboxRow } = await import("@/lib/negotiation/outbox")
    const enq = await enqueueEvent({ sessionId: SID, companyId: CO, envelope: envelope() })
    if (enq.ok) {
      const status = await dispatchOutboxRow({ id: enq.id, payload: envelope(), attempts: 0, status: "pending" })
      expect(status).toBe("sent")
    }
    const row = db.engine_outbox[0]
    expect(row.status).toBe("sent")
    expect(row.sent_at).not.toBeNull()
  })

  it("4xx permanente (não 408/429) → 'failed' sem reentrega", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("bad", { status: 400 }))
    const { enqueueEvent, dispatchOutboxRow } = await import("@/lib/negotiation/outbox")
    const enq = await enqueueEvent({ sessionId: SID, companyId: CO, envelope: envelope() })
    if (enq.ok) {
      const status = await dispatchOutboxRow({ id: enq.id, payload: envelope(), attempts: 0, status: "pending" })
      expect(status).toBe("failed")
    }
    expect(db.engine_outbox[0].status).toBe("failed")
  })

  it("flushOutbox entrega os pendentes e marca 'sent'", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }))
    const { enqueueEvent, flushOutbox } = await import("@/lib/negotiation/outbox")
    await enqueueEvent({ sessionId: SID, companyId: CO, envelope: envelope({ event_id: "e1" }) })
    await enqueueEvent({ sessionId: SID, companyId: CO, envelope: envelope({ event_id: "e2", type: "chat.turn" }) })
    const res = await flushOutbox({ sessionId: SID })
    expect(res.sent).toBe(2)
    expect(db.engine_outbox.every((r) => r.status === "sent")).toBe(true)
  })
})
