// D1/Frente A+B: session.start no login.
//  - buildSessionStartEnvelope prefere o snapshot (1 leitura indexada); cai no
//    buildAckContext quando não há snapshot.
//  - emitSessionStart grava no outbox; engine 'disabled' → 'skipped_engine_disabled'
//    (nunca envia).
//  - aging_days bate com o due_date do snapshot/ack.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "../journey/_fake-supabase"
import { agingDays } from "@/lib/negotiation/config"
import { formatBRL } from "@/lib/negotiation/payload"

let db: FakeDb
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => makeFakeSupabase(db),
}))

const CO = "cccccccc-0000-0000-0000-000000000003"
const SID = "5e551011-0000-0000-0000-000000000001"
const CPF = "39044455705"

function baseInput() {
  return {
    sessionId: SID,
    companyId: CO,
    customerId: "cust1",
    document: CPF,
    debtIds: ["debt1", "debt2"],
    reopenCount: 0,
    channel: "web_public_link",
    threadId: `web_${SID}`,
    identityVerified: true,
    debtAcknowledged: false,
    fulfillmentMode: "A",
    outcome: "in_progress" as string | null,
    settled: false,
  }
}

function seedTenant() {
  db.tenant_chat_config = [
    {
      company_id: CO,
      official_channel_label: "Portal VMAX",
      branding: { brand_name: "VMAX" },
      public_link_code: "k7Qm3Xb9Rt",
      n8n_event_names: null,
      fulfillment_mode: "A",
    },
  ]
  db.companies = [{ id: CO, name: "VMAX LTDA" }]
}

function reset() {
  db = {}
  seedTenant()
  process.env.NEXT_PUBLIC_APP_URL = "https://alteapay.com"
  delete process.env.NEGOTIATION_ENGINE
  process.env.N8N_CHAT_FLOW_URL = "https://n8n.example/webhook/flow"
  process.env.N8N_WEBHOOK_SECRET = "s3cr3t"
  vi.restoreAllMocks()
}

describe("buildSessionStartEnvelope", () => {
  beforeEach(reset)
  afterEach(() => vi.restoreAllMocks())

  it("prefere o snapshot (payload_ready) — 1 leitura, sem I/O de ack/agreements", async () => {
    db.debtor_engine_snapshot = [
      {
        company_id: CO,
        document_digits: CPF,
        open_amount_cents: 123456,
        oldest_original_due_date: "2025-07-08",
        open_invoice_count: 3,
        has_live_charge: true,
        payload_ready: true,
      },
    ]
    const { buildSessionStartEnvelope } = await import("@/lib/negotiation/engine")
    const env = await buildSessionStartEnvelope(baseInput())
    expect(env).not.toBeNull()
    expect(env!.type).toBe("session.start")
    expect(env!.debt!.amount).toBe(1234.56) // cents/100
    expect(env!.debt!.amount_cents).toBe(123456)
    expect(env!.debt!.amount_formatted).toBe(formatBRL(1234.56))
    expect(env!.debt!.invoice_count).toBe(3)
    expect(env!.debt!.has_live_charge).toBe(true)
    expect(env!.debt!.aging_days).toBe(agingDays("2025-07-08"))
    expect(env!.tenant.official_channel_label).toBe("Portal VMAX")
    expect(env!.tenant.chat_link).toBe("https://alteapay.com/n/k7Qm3Xb9Rt")
    expect(env!.debtor!.document_masked).toBe("***.444.557-**")
    expect(env!.debtor!.document).toBeNull()
  })

  it("sem snapshot → cai no buildAckContext (debts + vmax_invoices)", async () => {
    db.debtor_engine_snapshot = []
    db.debts = [
      { id: "debt1", company_id: CO, amount: 1000, due_date: "2025-01-01" },
      { id: "debt2", company_id: CO, amount: 234.56, due_date: "2025-02-01" },
    ]
    db.customers = [{ id: "cust1", company_id: CO, name: "Fabio Silva", document: CPF }]
    db.vmax_invoices = [{ id_company: CO, doc: CPF, vencimento: "2025-01-01" }]
    db.agreements = []
    const { buildSessionStartEnvelope } = await import("@/lib/negotiation/engine")
    const env = await buildSessionStartEnvelope(baseInput())
    expect(env!.debt!.amount).toBeCloseTo(1234.56, 2)
    expect(env!.debt!.amount_cents).toBe(123456)
    expect(env!.debt!.due_date).toBe("2025-01-01")
    expect(env!.debt!.has_live_charge).toBe(false)
  })

  it("settled → debt = null (nada a negociar)", async () => {
    const { buildSessionStartEnvelope } = await import("@/lib/negotiation/engine")
    const env = await buildSessionStartEnvelope({ ...baseInput(), settled: true })
    expect(env!.debt).toBeNull()
    expect(env!.type).toBe("session.start")
  })
})

describe("emitSessionStart — gating", () => {
  beforeEach(() => {
    reset()
    db.debtor_engine_snapshot = [
      {
        company_id: CO,
        document_digits: CPF,
        open_amount_cents: 10000,
        oldest_original_due_date: "2025-01-01",
        open_invoice_count: 1,
        has_live_charge: false,
        payload_ready: true,
      },
    ]
    db.engine_outbox = []
  })
  afterEach(() => vi.restoreAllMocks())

  it("engine 'disabled' (default) → outbox 'skipped_engine_disabled', não envia", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const { emitSessionStart } = await import("@/lib/negotiation/engine")
    const res = await emitSessionStart(baseInput())
    expect(res.ok).toBe(true)
    if (res.ok && res.enqueued) {
      expect(res.status).toBe("skipped_engine_disabled")
    }
    expect(db.engine_outbox[0].status).toBe("skipped_engine_disabled")
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("engine 'n8n' + n8n fora do ar → outbox 'pending' (evento não se perde)", async () => {
    process.env.NEGOTIATION_ENGINE = "n8n"
    vi.spyOn(globalThis, "fetch").mockRejectedValue(Object.assign(new Error("down"), { name: "TypeError" }))
    const { emitSessionStart } = await import("@/lib/negotiation/engine")
    const res = await emitSessionStart(baseInput())
    expect(res.ok).toBe(true)
    const row = db.engine_outbox[0]
    // gravou o evento (não perdeu); ficou pendente para reentrega
    expect(row.event_type).toBe("session.start")
    expect(row.status).toBe("pending")
  })

  it("event_id determinístico: dois emits da MESMA abertura não duplicam", async () => {
    const { emitSessionStart } = await import("@/lib/negotiation/engine")
    await emitSessionStart(baseInput())
    await emitSessionStart(baseInput())
    expect(db.engine_outbox.length).toBe(1)
  })
})
