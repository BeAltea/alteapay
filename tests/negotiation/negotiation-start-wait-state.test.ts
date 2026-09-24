// D2 — persistência do wait_state no caminho do negotiation.start (§4 do design):
// quando o motor RESPONDE (kickoff síncrono persistido via chatSend), a espera
// acabou → o servidor limpa negotiation_sessions.wait_state para NULL, de modo que
// um RELOAD não recomece a animação de espera (M11). Reusa o stub HTTP do fluxo
// n8n + fake supabase, como negotiation-start.test.ts, mas focado no wait_state.
import { createServer, type Server } from "node:http"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "../journey/_fake-supabase"

const SECRET = "test-neg-start-wait-secret"
const CO = "cccccccc-0000-0000-0000-0000000000wt"
const SID = "5e551011-0000-0000-0000-00000000wait"

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
let respondStatus = 200
let respondBody: unknown = { message: "Workflow was started" }

function seed() {
  db = {
    negotiation_sessions: [
      {
        id: SID, company_id: CO, customer_id: "cust1", debt_id: "debt1",
        primary_debt_id: "debt1", debt_ids: ["debt1"], channel: "web_generic",
        engine: "n8n", identity_verified_at: "2026-09-18T10:00:00Z",
        consent_at: "2026-09-18T10:00:00Z", consent_lgpd_at: "2026-09-18T10:00:00Z",
        fulfillment_mode: "A", engine_owner: "platform",
        // A sessão está ESPERANDO o motor (o clique NEGOCIAR marcou isto).
        wait_state: "aguardando_motor", wait_started_at: "2026-09-24T12:00:00.000Z",
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
    chat_messages: [],
  }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      if (respondStatus !== 200) {
        res.writeHead(respondStatus).end("boom")
        return
      }
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
  respondStatus = 200
  respondBody = { message: "Workflow was started" }
  process.env.N8N_WEBHOOK_SECRET = SECRET
  process.env.N8N_CHAT_FLOW_URL = `http://127.0.0.1:${port}/webhook/chat`
  process.env.NEGOTIATION_ENGINE = "n8n"
  process.env.NEXT_PUBLIC_APP_URL = "https://alteapay.com"
  delete process.env.N8N_EVENT_FLOW_URL
})

function sess() {
  return db.negotiation_sessions?.find((s) => s.id === SID)
}

describe("emitNegotiationStart — limpeza de wait_state ao motor RESPONDER (M11)", () => {
  it("SYNC {reply} persistido → wait_state e wait_started_at voltam a NULL (reload não mostra spinner)", async () => {
    respondBody = { reply: "Vamos negociar sua dívida." }
    expect(sess()?.wait_state).toBe("aguardando_motor")
    const { emitNegotiationStart } = await import("@/lib/negotiation/engine")
    const r = await emitNegotiationStart(SID, "evt-wait-clear")
    expect(r.ok).toBe(true)
    // a bolha do motor entrou no histórico…
    expect((db.chat_messages ?? []).filter((m) => m.n8n_event_id === "evt-wait-clear").length).toBe(1)
    // …e a espera foi limpa no servidor (idle no próximo reload).
    expect(sess()?.wait_state).toBeNull()
    expect(sess()?.wait_started_at).toBeNull()
  })

  it("SYNC {text, buttons} persistido → wait_state também é limpo", async () => {
    respondBody = { text: "Escolha:", buttons: [{ id: 2, label: "À vista", value: "avista" }, { id: 3, label: "Parcelar", value: "parc_3" }] }
    const { emitNegotiationStart } = await import("@/lib/negotiation/engine")
    await emitNegotiationStart(SID, "evt-wait-clear-btn")
    expect(sess()?.wait_state).toBeNull()
  })

  it("corpo ASYNC/vazio (nada a persistir) → wait_state PERMANECE (a espera segue viva até a resposta async)", async () => {
    respondBody = { message: "Workflow was started" }
    const { emitNegotiationStart } = await import("@/lib/negotiation/engine")
    const r = await emitNegotiationStart(SID, "evt-wait-async")
    expect(r.ok).toBe(true)
    // nada foi persistido (parser null) → NÃO limpa a espera; o client segue no
    // degrau e a resposta async (quando vier) é que resolverá.
    expect((db.chat_messages ?? []).length).toBe(0)
    expect(sess()?.wait_state).toBe("aguardando_motor")
  })

  it("POST 5xx (nada persistido) → wait_state PERMANECE (o outbox reentrega; a espera degrada no client aos 15s)", async () => {
    respondStatus = 500
    const { emitNegotiationStart } = await import("@/lib/negotiation/engine")
    const r = await emitNegotiationStart(SID, "evt-wait-500")
    expect(r.ok).toBe(true)
    if (r.ok && "delivered" in r) expect(r.delivered).toBe(false)
    expect(sess()?.wait_state).toBe("aguardando_motor")
  })

  it("idempotência SYNC↔ASYNC não re-arma a espera: 2ª entrega (duplicate) mantém wait_state limpo", async () => {
    respondBody = { reply: "Vamos negociar sua dívida." }
    const { emitNegotiationStart } = await import("@/lib/negotiation/engine")
    await emitNegotiationStart(SID, "evt-wait-idem")
    expect(sess()?.wait_state).toBeNull()
    // re-arma a espera manualmente (simula um novo clique) e reenvia o MESMO
    // event_id: o chatSend devolve duplicate:true (ok) → clear roda de novo,
    // deixando idle (nunca "re-suja" a espera).
    const s = sess()!
    s.wait_state = "aguardando_motor"
    s.wait_started_at = "2026-09-24T12:10:00.000Z"
    await emitNegotiationStart(SID, "evt-wait-idem")
    expect(sess()?.wait_state).toBeNull()
  })
})
