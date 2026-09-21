// H7/H8: evento negotiation.start (plataforma → n8n) + roteamento por
// engine_owner. Usa um servidor HTTP local como stub do fluxo n8n (valida o
// HMAC) e um fake-supabase para buildSessionContext.
import { createServer, type Server } from "node:http"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "../journey/_fake-supabase"

const SECRET = "test-neg-start-secret"
const CO = "cccccccc-0000-0000-0000-000000000009"
const SID = "5e551011-0000-0000-0000-0000000000aa"

let db: FakeDb
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/negotiation/matrix", () => ({
  resolveMatrixRow: async () => ({
    id: "m1", max_discount_pct: 20, min_entry_pct: 20, max_installments: 3,
    allowed_billing_types: ["PIX", "BOLETO"], proposal_validity_days: 7,
  }),
}))

let server: Server
let port: number
let lastRaw = ""
let lastSig: string | null = null
let lastTs: string | null = null
let respondStatus = 200

function seed() {
  db = {
    negotiation_sessions: [
      {
        id: SID, company_id: CO, customer_id: "cust1", debt_id: "debt1",
        primary_debt_id: "debt1", debt_ids: ["debt1"], channel: "web_generic",
        engine: "n8n", identity_verified_at: "2026-09-18T10:00:00Z",
        consent_at: "2026-09-18T10:00:00Z", consent_lgpd_at: "2026-09-18T10:00:00Z",
        fulfillment_mode: "A", engine_owner: "platform",
      },
    ],
    tenant_chat_config: [{ company_id: CO, branding: { brand_name: "VMAX", slug: "vmax" }, payment_origin: "platform", send_document_to_engine: false }],
    companies: [{ id: CO, name: "VMAX LTDA" }],
    customers: [{ id: "cust1", company_id: CO, name: "Fabio Silva", document: "111.444.777-35", phone: "11999998888", email: "fabio@x.com" }],
    debts: [{ id: "debt1", company_id: CO, amount: 100.5, due_date: "2020-01-01" }],
    vmax_invoices: [{ id_company: CO, doc: "11144477735", fatura: "F1", vencimento: "2020-01-01", saldo: 120.5 }],
    negotiation_offers: [],
    debt_acknowledgement_latest: [{ session_id: SID, debt_id: "debt1", acknowledged: true, button_id: 1, created_at: "2026-09-18T10:05:00Z", prompt_id: "p1" }],
    chat_prompts: [],
  }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      lastRaw = raw
      lastSig = (req.headers["x-alteapay-signature"] as string) ?? null
      lastTs = (req.headers["x-alteapay-timestamp"] as string) ?? null
      if (respondStatus !== 200) {
        res.writeHead(respondStatus).end("boom")
        return
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const addr = server.address()
  port = typeof addr === "object" && addr ? addr.port : 0
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

beforeEach(() => {
  seed()
  lastRaw = ""
  lastSig = null
  lastTs = null
  respondStatus = 200
  process.env.N8N_WEBHOOK_SECRET = SECRET
  process.env.N8N_CHAT_FLOW_URL = `http://127.0.0.1:${port}/webhook/chat`
  process.env.NEGOTIATION_ENGINE = "n8n"
  delete process.env.N8N_EVENT_FLOW_URL
  delete process.env.MOCK_ALL_INTEGRATIONS
})

describe("buildNegotiationStartPayload (Apêndice B)", () => {
  it("monta o contrato: session/tenant/customer/debt/acknowledgement/matrix/offers/available_actions", async () => {
    const { buildNegotiationStartPayload } = await import("@/lib/negotiation/engine")
    const p = await buildNegotiationStartPayload(SID, "evt-1")
    expect(p).not.toBeNull()
    expect(p!.event).toBe("negotiation.start")
    expect(p!.event_id).toBe("evt-1")
    expect(p!.session_id).toBe(SID)
    expect(p!.company_id).toBe(CO)
    // tenant travado em platform (D17) → payment_origin='platform'
    expect((p!.tenant as any).payment_origin).toBe("platform")
    // valores em CENTAVOS — `debts` só tem `amount` (não existe current_amount
    // em produção): original === updated, ambos derivados de amount.
    expect((p!.debt as any).original_value).toBe(10050)
    expect((p!.debt as any).updated_value).toBe(10050)
    // reconhecimento
    expect(p!.acknowledgement).toEqual({ acknowledged: true, button_id: 1, answered_at: "2026-09-18T10:05:00Z" })
    // available_actions viaja
    expect(p!.available_actions).toContain("payment.create")
    expect(p!.available_actions).toContain("payment.status")
  })

  it("documento MASCARADO + hash; CPF em claro NUNCA sai (payment_origin travado em platform)", async () => {
    const { buildNegotiationStartPayload } = await import("@/lib/negotiation/engine")
    const p = await buildNegotiationStartPayload(SID, "evt-2")
    const json = JSON.stringify(p)
    expect((p!.customer as any).document).toBeNull()
    expect((p!.customer as any).document_masked).toBe("***.444.777-**")
    expect(json).not.toContain("11144477735") // claro
    expect(json).not.toContain("11999998888") // telefone
    expect(json).not.toContain("fabio@x.com") // email
  })

  it("contexto irresolvível → null", async () => {
    db.negotiation_sessions = []
    const { buildNegotiationStartPayload } = await import("@/lib/negotiation/engine")
    expect(await buildNegotiationStartPayload(SID, "evt-x")).toBeNull()
  })
})

describe("emitNegotiationStart (H7/H8)", () => {
  it("dispara assinado (HMAC) e o stub valida a assinatura", async () => {
    const { emitNegotiationStart } = await import("@/lib/negotiation/engine")
    const { verifyN8nRequest } = await import("@/lib/negotiation/n8n")
    const r = await emitNegotiationStart(SID, "evt-hmac")
    expect(r.ok).toBe(true)
    if (r.ok && "delivered" in r) expect(r.delivered).toBe(true)
    // a assinatura enviada é válida pela mesma fórmula do inbound
    const verdict = verifyN8nRequest(lastRaw, lastSig, lastTs)
    expect(verdict.ok).toBe(true)
    // o corpo é o negotiation.start
    expect(JSON.parse(lastRaw).event).toBe("negotiation.start")
    expect(JSON.parse(lastRaw).event_id).toBe("evt-hmac")
  })

  it("H8: n8n não configurado (sem URL) → delivered:false engine_unavailable (não lança)", async () => {
    delete process.env.N8N_CHAT_FLOW_URL
    const { emitNegotiationStart } = await import("@/lib/negotiation/engine")
    const r = await emitNegotiationStart(SID, "evt-nourl")
    expect(r.ok).toBe(true)
    if (r.ok && !("delivered" in r && r.delivered)) {
      expect((r as any).reason).toBe("engine_unavailable")
    }
    expect(lastRaw).toBe("") // nada foi enviado
  })

  it("H8: fluxo n8n responde 500 → delivered:false engine_unavailable (fallback, não lança)", async () => {
    respondStatus = 500
    const { emitNegotiationStart } = await import("@/lib/negotiation/engine")
    const r = await emitNegotiationStart(SID, "evt-500")
    expect(r.ok).toBe(true)
    if (r.ok && "delivered" in r) expect(r.delivered).toBe(false)
  })

  it("usa N8N_EVENT_FLOW_URL quando presente (endpoint de eventos dedicado)", async () => {
    process.env.N8N_EVENT_FLOW_URL = `http://127.0.0.1:${port}/webhook/events`
    const { emitNegotiationStart } = await import("@/lib/negotiation/engine")
    const r = await emitNegotiationStart(SID, "evt-dedicated")
    expect(r.ok).toBe(true)
    if (r.ok && "delivered" in r) expect(r.delivered).toBe(true)
  })
})

describe("resolveEngineForSession (H7/H8 roteamento)", () => {
  it("engine_owner='n8n' com URL → roteia ao fluxo n8n", async () => {
    const { resolveEngineForSession } = await import("@/lib/negotiation/engine")
    expect(resolveEngineForSession("n8n")).toBe("n8n")
  })

  it("engine_owner='n8n' SEM URL → cai no assistido (disabled), sem erro (H8)", async () => {
    delete process.env.N8N_CHAT_FLOW_URL
    const { resolveEngineForSession } = await import("@/lib/negotiation/engine")
    expect(resolveEngineForSession("n8n")).toBe("disabled")
  })

  it("engine_owner='platform'/null → respeita o NEGOTIATION_ENGINE global (fallback)", async () => {
    process.env.NEGOTIATION_ENGINE = "disabled"
    const { resolveEngineForSession } = await import("@/lib/negotiation/engine")
    expect(resolveEngineForSession("platform")).toBe("disabled")
    expect(resolveEngineForSession(null)).toBe("disabled")
    // global n8n continua valendo como default para donos platform
    process.env.NEGOTIATION_ENGINE = "n8n"
    process.env.N8N_CHAT_FLOW_URL = `http://127.0.0.1:${port}/webhook/chat`
    expect(resolveEngineForSession("platform")).toBe("n8n")
  })
})
