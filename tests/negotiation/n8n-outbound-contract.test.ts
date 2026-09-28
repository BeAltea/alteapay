// N8N-14: contrato EXATO dos corpos que a plataforma POSTa ao fluxo n8n
// (chat.turn e negotiation.start). O `1. Main` roteia por `body.event` e lê
// `body.session_id`/`body.company_id`/`body.event_id` no TOPO
// (ops/n8n-sync-fix/09-n8n-routing-handoff.md §1). Um servidor HTTP local faz o
// papel do fluxo e captura corpo cru + headers; a assinatura é verificada sobre
// o corpo EXATO recebido.
import { createHmac } from "node:crypto"
import { createServer, type Server } from "node:http"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "../journey/_fake-supabase"
import type { NegotiationSession } from "@/lib/negotiation/types"

const SECRET = "test-n8n-contract-secret"
const CO = "cccccccc-0000-0000-0000-00000000000e"
const SID = "5e551011-0000-0000-0000-0000000000e1"
const CPF = "11144477735"
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

let db: FakeDb
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/negotiation/matrix", () => ({
  resolveMatrixRow: async () => ({
    id: "m1", max_discount_pct: 20, min_entry_pct: 20, max_installments: 3,
    allowed_billing_types: ["PIX", "BOLETO"], proposal_validity_days: 7,
  }),
}))

interface Captured { raw: string; headers: Record<string, string | string[] | undefined> }
let server: Server
let port: number
let calls: Captured[] = []
let respondBody: unknown = { reply: "ok" }

function seed() {
  db = {
    negotiation_sessions: [
      {
        id: SID, company_id: CO, customer_id: "cust1", debt_id: "debt1",
        primary_debt_id: "debt1", debt_ids: ["debt1"], channel: "web_generic",
        engine: "n8n", identity_verified_at: "2026-09-18T10:00:00Z",
        consent_at: "2026-09-18T10:00:00Z", consent_lgpd_at: "2026-09-18T10:00:00Z",
        fulfillment_mode: "A", engine_owner: "n8n", thread_id: `web_${SID}`,
      },
    ],
    tenant_chat_config: [{ company_id: CO, branding: { brand_name: "VMAX", slug: "vmax" }, payment_origin: "platform", send_document_to_engine: false }],
    companies: [{ id: CO, name: "VMAX LTDA" }],
    customers: [{ id: "cust1", company_id: CO, name: "Fabio Silva", document: "111.444.777-35", phone: "11999998888", email: "fabio@x.com" }],
    debts: [{ id: "debt1", company_id: CO, amount: 100.5, due_date: "2020-01-01" }],
    vmax_invoices: [{ id_company: CO, doc: CPF, fatura: "F1", vencimento: "2020-01-01", saldo: 120.5 }],
    negotiation_offers: [],
    debt_acknowledgement_latest: [{ session_id: SID, debt_id: "debt1", acknowledged: true, button_id: 1, created_at: "2026-09-18T10:05:00Z", prompt_id: "p1" }],
    chat_prompts: [],
    chat_messages: [],
    journey_events: [],
    engine_outbox: [],
  }
}

const session = {
  id: SID, company_id: CO, customer_id: "cust1", debt_id: "debt1",
  thread_id: `web_${SID}`, identity_verified_at: "2026-09-18T10:00:00Z",
  debt_acknowledged_at: "2026-09-18T10:05:00Z", fulfillment_mode: "A",
  outcome: "in_progress", engine_owner: "n8n", engine: "n8n",
} as unknown as NegotiationSession

const debtor = {
  customer_name: "Fabio Silva", document: CPF, debt_id: "debt1", amount: 100.5,
  due_date: "2020-01-01", description: null, aging_days: 100,
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      calls.push({ raw, headers: req.headers })
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(respondBody))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const addr = server.address()
  port = typeof addr === "object" && addr ? addr.port : 0
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

beforeEach(() => {
  seed()
  calls = []
  respondBody = { reply: "ok" }
  process.env.N8N_WEBHOOK_SECRET = SECRET
  process.env.N8N_CHAT_FLOW_URL = `http://127.0.0.1:${port}/webhook/chat`
  process.env.NEGOTIATION_ENGINE = "n8n"
  process.env.NEXT_PUBLIC_APP_URL = "https://alteapay.com"
  delete process.env.N8N_EVENT_FLOW_URL
  delete process.env.MOCK_ALL_INTEGRATIONS
  delete process.env.N8N_BASIC_AUTH_USER
  delete process.env.N8N_BASIC_AUTH_PASSWORD
})

/** Assinatura esperada sobre o corpo EXATO: sha256=<hex HMAC de "${ts}.${body}">. */
function expectSignedOver(c: Captured) {
  const ts = c.headers["x-alteapay-timestamp"] as string
  const sig = c.headers["x-alteapay-signature"] as string
  expect(ts).toMatch(/^\d+$/)
  const expected = "sha256=" + createHmac("sha256", SECRET).update(`${ts}.${c.raw}`, "utf8").digest("hex")
  expect(sig).toBe(expected)
}

async function runTurn(turnRef: string | null, message = "consigo pagar em 2x?") {
  const { engineChat } = await import("@/lib/negotiation/engine")
  await engineChat({
    session, message, channel: "webchat", debtor, tenant: null,
    ...(turnRef ? { turnRef } : {}),
  } as never)
  const c = calls[calls.length - 1]
  return { c, body: JSON.parse(c.raw) as Record<string, unknown> }
}

const CHAT_TURN_TOP_KEYS = [
  // envelope plano (N8N-14)
  "event", "type", "contract_version", "event_id", "timestamp", "occurred_at",
  "session_id", "company_id", "thread_id", "channel", "message", "session_state",
  "callback_url",
  // contexto rico (buildSessionContext, inalterado) + ações
  "session", "tenant", "customer", "debt", "matrix", "offers",
  "debt_acknowledgement", "active_prompt", "agreement", "available_actions",
].sort()

describe("chat.turn (N8N-14) — corpo enviado ao fluxo", () => {
  it("leva event/type/event_id/session_id/company_id no TOPO + blocos aninhados", async () => {
    const { c, body } = await runTurn("msg-1")
    expect(Object.keys(body).sort()).toEqual(CHAT_TURN_TOP_KEYS)
    expect(body.event).toBe("chat.turn")
    expect(body.type).toBe("chat.turn")
    expect(body.contract_version).toBe("1.0")
    expect(body.session_id).toBe(SID)
    expect(body.company_id).toBe(CO)
    expect(body.thread_id).toBe(`web_${SID}`)
    expect(body.channel).toBe("webchat")
    expect(body.message).toBe("consigo pagar em 2x?")
    expect(body.event_id).toMatch(UUID_RE)
    expect(body.timestamp).toBe(body.occurred_at)
    expect(body.callback_url).toBe("https://alteapay.com/api/webhooks/n8n")
    expect(body.session_state).toEqual({
      identity_verified: true, debt_acknowledged: true, fulfillment_mode: "A", outcome: "in_progress",
    })
    // compat: aninhados continuam, coerentes com o topo (escopo do tenant)
    expect((body.session as { id: string }).id).toBe(SID)
    expect((body.tenant as { id: string }).id).toBe(CO)
    // header event-id = event_id do corpo
    expect(c.headers["x-alteapay-event-id"]).toBe(body.event_id)
    expectSignedOver(c)
  })

  it("assinatura verifica pelo mesmo verificador do inbound", async () => {
    const { c } = await runTurn("msg-sig")
    const { verifyN8nRequest } = await import("@/lib/negotiation/n8n")
    expect(
      verifyN8nRequest(c.raw, c.headers["x-alteapay-signature"] as string, c.headers["x-alteapay-timestamp"] as string),
    ).toEqual({ ok: true, matched: "current" }) // N8N-4: saída assina SÓ com o segredo atual
  })

  it("event_id é DETERMINÍSTICO por turno (mesmo turnRef → mesmo id; outro turno → outro id)", async () => {
    const { chatTurnEventId } = await import("@/lib/negotiation/payload")
    const a = (await runTurn("msg-A")).body.event_id
    const a2 = (await runTurn("msg-A")).body.event_id
    const b = (await runTurn("msg-B")).body.event_id
    expect(a).toBe(a2)
    expect(a).not.toBe(b)
    expect(a).toBe(chatTurnEventId(SID, "msg-A"))
  })

  it("sem PII: CPF em claro, telefone, e-mail e nome completo não viajam", async () => {
    const { c, body } = await runTurn("msg-pii")
    expect(c.raw).not.toContain(CPF)
    expect(c.raw).not.toContain("111.444.777-35")
    expect(c.raw).not.toContain("11999998888")
    expect(c.raw).not.toContain("fabio@x.com")
    expect(c.raw).not.toContain("Fabio Silva")
    expect((body.customer as { document: unknown }).document).toBeNull()
  })

  it("fallback (contexto irresolvível) → buildTurnPayload também leva o envelope no topo", async () => {
    db.negotiation_sessions = []
    const { c, body } = await runTurn("msg-fb")
    for (const k of ["event", "type", "contract_version", "event_id", "timestamp", "occurred_at", "session_id", "company_id", "thread_id", "channel", "message", "session_state", "callback_url"]) {
      expect(body, k).toHaveProperty(k)
    }
    expect(body.event).toBe("chat.turn")
    expect(body.session_id).toBe(SID)
    expect(body.company_id).toBe(CO)
    expect(c.headers["x-alteapay-event-id"]).toBe(body.event_id)
    expect((body.debtor as { document: unknown }).document).toBeNull()
    expect(c.raw).not.toContain(CPF)
    expectSignedOver(c)
  })
})

const NEG_START_TOP_KEYS = [
  "type", "event", "contract_version", "event_id", "timestamp", "occurred_at",
  "session_id", "company_id", "thread_id", "channel", "session", "tenant",
  "customer", "debt", "acknowledgement", "matrix", "offers", "available_actions",
  "callback_url",
].sort()

describe("negotiation.start — corpo enviado ao fluxo", () => {
  it("topo plano, event_id do chamador no corpo E no header, assinado sobre o corpo exato", async () => {
    respondBody = { message: "Workflow was started" }
    const { emitNegotiationStart } = await import("@/lib/negotiation/engine")
    const EVT = "0b6f2a7e-1111-4222-8333-444455556666"
    const r = await emitNegotiationStart(SID, EVT)
    expect(r).toEqual({ ok: true, delivered: true, event_id: EVT })
    const c = calls[calls.length - 1]
    const body = JSON.parse(c.raw) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(NEG_START_TOP_KEYS)
    expect(body.event).toBe("negotiation.start")
    expect(body.type).toBe("negotiation.start")
    expect(body.event_id).toBe(EVT)
    expect(body.session_id).toBe(SID)
    expect(body.company_id).toBe(CO)
    expect(body.thread_id).toBe(`web_${SID}`)
    expect(body.channel).toBe("webchat")
    expect(body.timestamp).toBe(body.occurred_at)
    expect(c.headers["x-alteapay-event-id"]).toBe(EVT)
    expectSignedOver(c)
    expect(c.raw).not.toContain(CPF)
    expect(c.raw).not.toContain("11999998888")
  })

  it("mesmo event_id em builds repetidos (reentrega pelo outbox é idempotente)", async () => {
    const { buildNegotiationStartPayload } = await import("@/lib/negotiation/engine")
    const a = await buildNegotiationStartPayload(SID, "evt-same")
    const b = await buildNegotiationStartPayload(SID, "evt-same")
    expect(a!.event_id).toBe("evt-same")
    expect(b!.event_id).toBe(a!.event_id)
  })
})

describe("session.start — envelope canônico", () => {
  it("também leva `event` (fixo) além de `type` (rótulo do tenant)", async () => {
    const { buildEnvelope } = await import("@/lib/negotiation/payload")
    const env = buildEnvelope({
      kind: "session_start",
      eventNames: { session_start: "vmax.session.start" },
      sessionId: SID, companyId: CO, reopenCount: 0, channel: "web_generic",
      sessionState: { identityVerified: true, debtAcknowledged: false, fulfillmentMode: "A", outcome: null },
      debtor: null, debt: null,
      tenant: { fulfillmentMode: "A", officialChannelLabel: null, brandName: "VMAX", publicLinkCode: null },
    })
    expect(env.event).toBe("session.start")
    expect(env.type).toBe("vmax.session.start")
    expect(env.session_id).toBe(SID)
    expect(env.company_id).toBe(CO)
    expect(env.event_id).toBeTruthy()
  })
})
