// qa:e2e-stub — prova do RENDER PATH ponta-a-ponta contra o STUB, SEM produção.
//
// Cenário exato da tarefa QA: emitNegotiationStart POSTa o negotiation.start
// (assinado) a um handler HTTP local que faz o papel do fluxo n8n. O handler
// VERIFICA a assinatura e responde SÍNCRONO com o stub_reply
//   { text: 'Vamos negociar', buttons: [{ id: 2, label: 'À vista' }] }
// — exatamente o que o nó "Respond to Webhook" do fluxo devolverá ({text,
// buttons?}), e a mesma forma enxuta que app/api/dev/n8n-stub/route.ts ecoa a
// partir de `stub_reply`. A partir daí o caminho REAL roda inalterado:
// callN8nFlow captura o corpo → parseKickoffReply normaliza → persistKickoffReply
// grava via chatSend (loadSessionCtx + MESMO event_id do kickoff).
//
// Assere:
//  (a) chat_messages recebeu 1 bolha assistant engine='n8n' com esse texto (+ o
//      prompt de botões vinculado, criado a partir de `buttons`);
//  (b) um segundo chat.send ecoando o MESMO event_id NÃO duplica (dedupe
//      compartilhado SYNC↔ASYNC por event_id).
//
// O handler VERIFICA a assinatura HMAC do nosso lado (mesmo esquema do inbound),
// espelhando o stub real; o teste também confere que o POST foi assinado.
import { createServer, type Server } from "node:http"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "../journey/_fake-supabase"

const SECRET = "test-e2e-stub-secret"
const CO = "cccccccc-0000-0000-0000-0000000000e2"
const SID = "5e551011-0000-0000-0000-0000000000e2"

// stub_reply exato pedido pela tarefa (a forma enxuta {text, buttons?} do recipe).
const STUB_REPLY = { text: "Vamos negociar", buttons: [{ id: 2, label: "À vista" }] }

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
    chat_messages: [],
  }
}

beforeAll(async () => {
  // Handler = fluxo n8n FALSO: verifica HMAC do nosso lado e ECOA `stub_reply`
  // do corpo (idêntico a app/api/dev/n8n-stub/route.ts).
  const { verifyN8nRequest, N8N_SIGNATURE_HEADER, N8N_TIMESTAMP_HEADER } = await import("@/lib/negotiation/n8n")
  server = createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      lastRaw = raw
      lastSig = (req.headers[N8N_SIGNATURE_HEADER] as string) ?? null
      lastTs = (req.headers[N8N_TIMESTAMP_HEADER] as string) ?? null
      const verdict = verifyN8nRequest(raw, lastSig, lastTs)
      if (!verdict.ok) {
        res.writeHead(verdict.status, { "content-type": "application/json" }).end(JSON.stringify({ error: verdict.reason }))
        return
      }
      // Responde SÍNCRONO com stub_reply — exatamente o que o nó "Respond to
      // Webhook" do fluxo n8n devolverá ({text, buttons?}). O corpo recebido é o
      // negotiation.start REAL (assinado); o stub apenas ecoa a resposta fixa.
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(STUB_REPLY))
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
  process.env.N8N_WEBHOOK_SECRET = SECRET
  process.env.N8N_CHAT_FLOW_URL = `http://127.0.0.1:${port}/webhook/chat`
  process.env.NEGOTIATION_ENGINE = "n8n"
  process.env.NEXT_PUBLIC_APP_URL = "https://alteapay.com"
  delete process.env.N8N_EVENT_FLOW_URL
  delete process.env.MOCK_ALL_INTEGRATIONS
})

describe("qa:e2e-stub — RENDER PATH ponta-a-ponta contra o STUB", () => {
  it("(a) stub_reply {text,buttons} → 1 bolha assistant engine='n8n' com o texto + prompt de botões (assinado)", async () => {
    const engine = await import("@/lib/negotiation/engine")

    const r = await engine.emitNegotiationStart(SID, "evt-e2e-stub")
    expect(r.ok).toBe(true)
    if (r.ok && "delivered" in r) expect(r.delivered).toBe(true)

    // POST assinado e válido pela MESMA fórmula do inbound (nenhum segredo/URL logado).
    const { verifyN8nRequest } = await import("@/lib/negotiation/n8n")
    expect(verifyN8nRequest(lastRaw, lastSig, lastTs).ok).toBe(true)
    const sent = JSON.parse(lastRaw)
    expect(sent.event).toBe("negotiation.start")
    expect(sent.event_id).toBe("evt-e2e-stub")

    // (a) exatamente 1 bolha assistant, engine=n8n, texto do stub, event_id = kickoff.
    const msgs = (db.chat_messages ?? []).filter((m) => m.n8n_event_id === "evt-e2e-stub")
    expect(msgs.length).toBe(1)
    expect(msgs[0].role).toBe("assistant")
    expect(msgs[0].engine).toBe("n8n")
    expect(msgs[0].text).toContain("Vamos negociar")

    // o `buttons` do stub virou um prompt ativo vinculado à bolha.
    expect(msgs[0].prompt_id).toBeTruthy()
    const prompts = (db.chat_prompts ?? []).filter((p) => p.status === "active")
    expect(prompts.length).toBe(1)
    expect(prompts[0].id).toBe(msgs[0].prompt_id)
    expect(prompts[0].buttons.length).toBe(1)
    expect(prompts[0].buttons[0]).toMatchObject({ id: 2, label: "À vista" })
  })

  it("(b) 2º chat.send ecoando o MESMO event_id → duplicate:true, sem 2ª bolha (dedupe SYNC↔ASYNC)", async () => {
    const engine = await import("@/lib/negotiation/engine")

    await engine.emitNegotiationStart(SID, "evt-e2e-dedupe")
    const before = (db.chat_messages ?? []).filter((m) => m.n8n_event_id === "evt-e2e-dedupe").length
    expect(before).toBe(1)

    // Papel B (async) ecoando o MESMO event_id do kickoff — o caso real em que o
    // fluxo n8n responde SÍNCRONO e TAMBÉM pelo callback_url com o mesmo event_id.
    const { loadSessionCtx } = await import("@/lib/journey/actions")
    const { chatSend } = await import("@/lib/journey/chat-send")
    const ctx = await loadSessionCtx(SID)
    expect(ctx).not.toBeNull()
    const echo = await chatSend(ctx!, { text: "Vamos negociar (eco)" }, "evt-e2e-dedupe")
    expect(echo.ok).toBe(true)
    if (echo.ok) expect(echo.duplicate).toBe(true)

    const after = (db.chat_messages ?? []).filter((m) => m.n8n_event_id === "evt-e2e-dedupe").length
    expect(after).toBe(1) // sem duplicata
  })
})
