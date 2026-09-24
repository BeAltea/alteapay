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
// N8N_SYNC fix: corpo SYNC variável que o stub devolve (default: async/vazio,
// como o webhook real "Workflow was started" → parser retorna null).
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
      lastRaw = raw
      lastSig = (req.headers["x-alteapay-signature"] as string) ?? null
      lastTs = (req.headers["x-alteapay-timestamp"] as string) ?? null
      if (respondStatus !== 200) {
        res.writeHead(respondStatus).end("boom")
        return
      }
      // corpo variável (default async/vazio); testes SYNC setam respondBody.
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
  lastRaw = ""
  lastSig = null
  lastTs = null
  respondStatus = 200
  respondBody = { message: "Workflow was started" } // default: async/vazio
  process.env.N8N_WEBHOOK_SECRET = SECRET
  process.env.N8N_CHAT_FLOW_URL = `http://127.0.0.1:${port}/webhook/chat`
  process.env.NEGOTIATION_ENGINE = "n8n"
  process.env.NEXT_PUBLIC_APP_URL = "https://alteapay.com"
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

  // ── §C3: entrega DURÁVEL via outbox + fix da assimetria de URL ─────────────

  it("§C3: POST ok → grava a linha no outbox e a marca 'sent' (sem re-POST no flush)", async () => {
    const { emitNegotiationStart } = await import("@/lib/negotiation/engine")
    const r = await emitNegotiationStart(SID, "evt-durable-ok")
    expect(r.ok).toBe(true)
    if (r.ok && "delivered" in r) expect(r.delivered).toBe(true)
    const rows = (db.engine_outbox ?? []).filter((x) => x.event_id === "evt-durable-ok")
    expect(rows.length).toBe(1) // 1 linha por event_id
    expect(rows[0].status).toBe("sent") // marcada como entregue
    expect(rows[0].sent_at).toBeTruthy()
  })

  it("§C3: POST 5xx → a linha do outbox FICA 'pending' (o flush reentregará — entrega CONFIÁVEL)", async () => {
    respondStatus = 500
    const { emitNegotiationStart } = await import("@/lib/negotiation/engine")
    const r = await emitNegotiationStart(SID, "evt-durable-500")
    expect(r.ok).toBe(true)
    if (r.ok && "delivered" in r) expect(r.delivered).toBe(false)
    const rows = (db.engine_outbox ?? []).filter((x) => x.event_id === "evt-durable-500")
    expect(rows.length).toBe(1)
    expect(rows[0].status).toBe("pending") // NÃO perdida: reentrega no próximo flush
  })

  it("§C3: idempotente por event_id — 2 disparos do mesmo event_id → 1 só linha", async () => {
    const { emitNegotiationStart } = await import("@/lib/negotiation/engine")
    await emitNegotiationStart(SID, "evt-idem")
    await emitNegotiationStart(SID, "evt-idem")
    const rows = (db.engine_outbox ?? []).filter((x) => x.event_id === "evt-idem")
    expect(rows.length).toBe(1)
  })

  it("§C3: URL só POR-TENANT (env vazia) → o start VAI ao n8n (fim da assimetria 'não envia nada')", async () => {
    // Antes: kickoff era env-only → tenant-only virava "" → engine_unavailable.
    delete process.env.N8N_CHAT_FLOW_URL
    delete process.env.N8N_EVENT_FLOW_URL
    db.tenant_chat_config[0].n8n_chat_flow_url = `http://127.0.0.1:${port}/webhook/tenant`
    const { emitNegotiationStart } = await import("@/lib/negotiation/engine")
    const r = await emitNegotiationStart(SID, "evt-tenant-url")
    expect(r.ok).toBe(true)
    if (r.ok && "delivered" in r) expect(r.delivered).toBe(true)
    expect(lastRaw).not.toBe("") // POSTou de fato
    expect(JSON.parse(lastRaw).event).toBe("negotiation.start")
  })

  it("§C3: SEM N8N_WEBHOOK_SECRET mas COM URL → ainda dispara (secret deixou de ser hard-gate)", async () => {
    delete process.env.N8N_WEBHOOK_SECRET
    const { emitNegotiationStart } = await import("@/lib/negotiation/engine")
    const r = await emitNegotiationStart(SID, "evt-nosecret")
    expect(r.ok).toBe(true)
    if (r.ok && "delivered" in r) expect(r.delivered).toBe(true)
    expect(lastRaw).not.toBe("") // POST aconteceu mesmo sem secret
    // reset p/ não vazar para os próximos testes (beforeEach re-seta, mas explícito)
    process.env.N8N_WEBHOOK_SECRET = SECRET
  })

  it("§C3: sem NENHUMA URL → enfileira mesmo assim (durável p/ o dia do plug) e reporta unavailable", async () => {
    delete process.env.N8N_CHAT_FLOW_URL
    delete process.env.N8N_EVENT_FLOW_URL
    const { emitNegotiationStart } = await import("@/lib/negotiation/engine")
    const r = await emitNegotiationStart(SID, "evt-nourl-enqueue")
    expect(r.ok).toBe(true)
    if (r.ok && !("delivered" in r && r.delivered)) {
      expect((r as any).reason).toBe("engine_unavailable")
    }
    expect(lastRaw).toBe("") // nada POSTado
    const rows = (db.engine_outbox ?? []).filter((x) => x.event_id === "evt-nourl-enqueue")
    expect(rows.length).toBe(1) // porém enfileirado (durável)
    expect(rows[0].status).toBe("pending")
  })
})

// ── N8N_SYNC fix: RENDER SYNC + callback_url + dedupe compartilhado ──────────
describe("emitNegotiationStart — RENDER SYNC (persistKickoffReply)", () => {
  it("T1/AC1: SYNC {reply} → 1 chat_messages (assistant, engine=n8n, n8n_event_id==event_id)", async () => {
    respondBody = { reply: "Vamos negociar sua dívida." }
    const { emitNegotiationStart } = await import("@/lib/negotiation/engine")
    const r = await emitNegotiationStart(SID, "evt-sync-reply")
    expect(r.ok).toBe(true)
    if (r.ok && "delivered" in r) expect(r.delivered).toBe(true)
    const msgs = (db.chat_messages ?? []).filter((m) => m.n8n_event_id === "evt-sync-reply")
    expect(msgs.length).toBe(1)
    expect(msgs[0].role).toBe("assistant")
    expect(msgs[0].engine).toBe("n8n")
    expect(msgs[0].text).toContain("Vamos negociar sua dívida.")
  })

  it("T1/AC1: aceita a forma enxuta {text}", async () => {
    respondBody = { text: "Olá! Vamos negociar." }
    const { emitNegotiationStart } = await import("@/lib/negotiation/engine")
    const r = await emitNegotiationStart(SID, "evt-sync-text")
    expect(r.ok).toBe(true)
    const msgs = (db.chat_messages ?? []).filter((m) => m.n8n_event_id === "evt-sync-text")
    expect(msgs.length).toBe(1)
    expect(msgs[0].text).toContain("Olá! Vamos negociar.")
  })

  it("T2/AC2: SYNC {text, buttons} → 1 chat_messages + 1 chat_prompts ativo", async () => {
    respondBody = { text: "Escolha:", buttons: [{ id: 2, label: "À vista", value: "avista" }, { id: 3, label: "Parcelar", value: "parc_3" }] }
    const { emitNegotiationStart } = await import("@/lib/negotiation/engine")
    const r = await emitNegotiationStart(SID, "evt-sync-buttons")
    expect(r.ok).toBe(true)
    if (r.ok && "delivered" in r) expect(r.delivered).toBe(true)
    const msgs = (db.chat_messages ?? []).filter((m) => m.n8n_event_id === "evt-sync-buttons")
    expect(msgs.length).toBe(1)
    expect(msgs[0].prompt_id).toBeTruthy()
    const prompts = (db.chat_prompts ?? []).filter((p) => p.status === "active")
    expect(prompts.length).toBe(1)
    expect(prompts[0].buttons.length).toBe(2)
    expect(msgs[0].prompt_id).toBe(prompts[0].id)
  })

  it("T2/AC2: botões INVÁLIDOS → NENHUMA bolha/prompt, delivered:true, sem exceção", async () => {
    respondBody = { text: "Escolha:", buttons: [{ id: 1, label: "x" }, { id: 1, label: "y" }] }
    const { emitNegotiationStart } = await import("@/lib/negotiation/engine")
    const r = await emitNegotiationStart(SID, "evt-sync-badbtn")
    expect(r.ok).toBe(true)
    if (r.ok && "delivered" in r) expect(r.delivered).toBe(true) // best-effort: clique não cai
    const msgs = (db.chat_messages ?? []).filter((m) => m.n8n_event_id === "evt-sync-badbtn")
    expect(msgs.length).toBe(0)
    expect((db.chat_prompts ?? []).length).toBe(0)
  })

  it("T3/AC3: dedupe SYNC↔ASYNC por event_id — chat.send ecoando o event_id → duplicate", async () => {
    respondBody = { reply: "Vamos negociar sua dívida." }
    const { emitNegotiationStart } = await import("@/lib/negotiation/engine")
    await emitNegotiationStart(SID, "evt-shared")
    const before = (db.chat_messages ?? []).filter((m) => m.n8n_event_id === "evt-shared").length
    expect(before).toBe(1)
    // papel B (async) ecoando o MESMO event_id
    const { loadSessionCtx } = await import("@/lib/journey/actions")
    const { chatSend } = await import("@/lib/journey/chat-send")
    const ctx = await loadSessionCtx(SID)
    expect(ctx).not.toBeNull()
    const echo = await chatSend(ctx!, { text: "eco" }, "evt-shared")
    expect(echo.ok).toBe(true)
    if (echo.ok) expect(echo.duplicate).toBe(true)
    const after = (db.chat_messages ?? []).filter((m) => m.n8n_event_id === "evt-shared").length
    expect(after).toBe(1) // sem 2ª bolha
  })

  it("T5/AC5: corpo async/vazio {message:'Workflow was started'} → NENHUMA bolha, outbox sent, delivered:true", async () => {
    respondBody = { message: "Workflow was started" }
    const { emitNegotiationStart } = await import("@/lib/negotiation/engine")
    const r = await emitNegotiationStart(SID, "evt-async-empty")
    expect(r.ok).toBe(true)
    if (r.ok && "delivered" in r) expect(r.delivered).toBe(true)
    expect((db.chat_messages ?? []).filter((m) => m.n8n_event_id === "evt-async-empty").length).toBe(0)
    const rows = (db.engine_outbox ?? []).filter((x) => x.event_id === "evt-async-empty")
    expect(rows[0]?.status).toBe("sent")
  })

  it("T5/AC5: corpo {} e null → NENHUMA bolha (parser null), delivered:true", async () => {
    const { emitNegotiationStart } = await import("@/lib/negotiation/engine")
    respondBody = {}
    const r1 = await emitNegotiationStart(SID, "evt-empty-obj")
    expect(r1.ok).toBe(true)
    respondBody = null
    const r2 = await emitNegotiationStart(SID, "evt-null-body")
    expect(r2.ok).toBe(true)
    expect((db.chat_messages ?? []).length).toBe(0)
  })

  it("T6/AC6: 5xx → delivered:false, outbox pending, NENHUMA bolha, sem exceção", async () => {
    respondStatus = 500
    const { emitNegotiationStart } = await import("@/lib/negotiation/engine")
    const r = await emitNegotiationStart(SID, "evt-sync-500")
    expect(r.ok).toBe(true)
    if (r.ok && "delivered" in r) expect(r.delivered).toBe(false)
    expect((db.chat_messages ?? []).length).toBe(0)
    const rows = (db.engine_outbox ?? []).filter((x) => x.event_id === "evt-sync-500")
    expect(rows[0]?.status).toBe("pending")
  })

  it("T7/AC7: loadSessionCtx null durante a persistência → delivered:true, outbox já 'sent', sem exceção", async () => {
    respondBody = { reply: "Vamos negociar." }
    // força loadSessionCtx a devolver null SÓ na persistência (o payload já foi
    // montado por buildSessionContext antes). markOutboxSent roda ANTES da bolha.
    const actions = await import("@/lib/journey/actions")
    const spy = vi.spyOn(actions, "loadSessionCtx").mockResolvedValue(null)
    const { emitNegotiationStart } = await import("@/lib/negotiation/engine")
    const r = await emitNegotiationStart(SID, "evt-noctx")
    expect(r.ok).toBe(true)
    if (r.ok && "delivered" in r) expect(r.delivered).toBe(true)
    expect(spy).toHaveBeenCalledWith(SID) // a persistência tentou carregar o ctx
    const rows = (db.engine_outbox ?? []).filter((x) => x.event_id === "evt-noctx")
    expect(rows[0]?.status).toBe("sent")
    expect((db.chat_messages ?? []).length).toBe(0) // sem contexto, sem bolha
    spy.mockRestore()
  })

  it("T7/AC7: chatSend lança → clique não cai (delivered:true), outbox 'sent'", async () => {
    respondBody = { reply: "Vamos negociar." }
    const chatSendMod = await import("@/lib/journey/chat-send")
    const spy = vi.spyOn(chatSendMod, "chatSend").mockRejectedValue(new Error("boom"))
    const { emitNegotiationStart } = await import("@/lib/negotiation/engine")
    const r = await emitNegotiationStart(SID, "evt-chatsend-throw")
    expect(r.ok).toBe(true)
    if (r.ok && "delivered" in r) expect(r.delivered).toBe(true)
    expect(spy).toHaveBeenCalledTimes(1) // a persistência chamou chatSend (que lançou)
    const rows = (db.engine_outbox ?? []).filter((x) => x.event_id === "evt-chatsend-throw")
    expect(rows[0]?.status).toBe("sent")
    expect((db.chat_messages ?? []).length).toBe(0) // nada gravado (lançou)
    spy.mockRestore()
  })

  it("AC9: o POST síncrono continua assinado e é o negotiation.start com callback_url", async () => {
    respondBody = { text: "ok" }
    const { emitNegotiationStart } = await import("@/lib/negotiation/engine")
    const { verifyN8nRequest } = await import("@/lib/negotiation/n8n")
    await emitNegotiationStart(SID, "evt-hmac-cb")
    expect(verifyN8nRequest(lastRaw, lastSig, lastTs).ok).toBe(true)
    const sent = JSON.parse(lastRaw)
    expect(sent.event).toBe("negotiation.start")
    expect(sent.event_id).toBe("evt-hmac-cb")
    expect(sent.callback_url).toBe("https://alteapay.com/api/webhooks/n8n")
  })
})

describe("buildNegotiationStartPayload — callback_url (§3)", () => {
  it("T4/AC4: NEXT_PUBLIC_APP_URL sem barra final → .../api/webhooks/n8n", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://alteapay.com"
    const { buildNegotiationStartPayload } = await import("@/lib/negotiation/engine")
    const p = await buildNegotiationStartPayload(SID, "evt-cb-1")
    expect(p!.callback_url).toBe("https://alteapay.com/api/webhooks/n8n")
  })

  it("T4/AC4: NEXT_PUBLIC_APP_URL COM barra final → sem barra dupla", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://alteapay.com/"
    const { buildNegotiationStartPayload } = await import("@/lib/negotiation/engine")
    const p = await buildNegotiationStartPayload(SID, "evt-cb-2")
    expect(p!.callback_url).toBe("https://alteapay.com/api/webhooks/n8n")
  })

  it("T4/AC4: sem NEXT_PUBLIC_APP_URL → callback_url OMITIDO, sem throw", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL
    const { buildNegotiationStartPayload } = await import("@/lib/negotiation/engine")
    const p = await buildNegotiationStartPayload(SID, "evt-cb-3")
    expect(p).not.toBeNull()
    expect(p!.callback_url).toBeUndefined()
    expect("callback_url" in (p as object)).toBe(false)
  })

  it("T8/AC10/AC11: callback_url NÃO introduz PII (doc mascarado; CPF/tel/email nunca em claro)", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://alteapay.com"
    const { buildNegotiationStartPayload } = await import("@/lib/negotiation/engine")
    const p = await buildNegotiationStartPayload(SID, "evt-cb-pii")
    const json = JSON.stringify(p)
    expect(json).toContain("https://alteapay.com/api/webhooks/n8n")
    expect((p!.customer as any).document_masked).toBe("***.444.777-**")
    expect(json).not.toContain("11144477735")
    expect(json).not.toContain("11999998888")
    expect(json).not.toContain("fabio@x.com")
  })
})

// ── parser puro parseKickoffReply (§2.1/§2.2) ────────────────────────────────
describe("parseKickoffReply (parser puro, nunca lança)", () => {
  it("{text} → {text}", async () => {
    const { parseKickoffReply } = await import("@/lib/negotiation/engine")
    expect(parseKickoffReply({ text: "oi" })).toEqual({ text: "oi" })
  })
  it("{reply} alias de text", async () => {
    const { parseKickoffReply } = await import("@/lib/negotiation/engine")
    expect(parseKickoffReply({ reply: "olá" })).toEqual({ text: "olá" })
  })
  it("text prevalece sobre reply quando ambos vêm", async () => {
    const { parseKickoffReply } = await import("@/lib/negotiation/engine")
    expect(parseKickoffReply({ text: "T", reply: "R" })!.text).toBe("T")
  })
  it("{text, buttons} → prompt offer_choice com a mesma pergunta", async () => {
    const { parseKickoffReply } = await import("@/lib/negotiation/engine")
    const r = parseKickoffReply({ text: "Escolha", buttons: [{ id: 2, label: "A" }] })
    expect(r!.prompt).toEqual({ kind: "offer_choice", question: "Escolha", buttons: [{ id: 2, label: "A" }] })
  })
  it("{prompt} explícito tem precedência sobre buttons no topo", async () => {
    const { parseKickoffReply } = await import("@/lib/negotiation/engine")
    const r = parseKickoffReply({ text: "t", prompt: { kind: "payment_method_choice", question: "Q", buttons: [{ id: 2, label: "PIX" }] } })
    expect(r!.prompt!.kind).toBe("payment_method_choice")
    expect(r!.prompt!.question).toBe("Q")
  })
  it("n8n_execution_id é repassado", async () => {
    const { parseKickoffReply } = await import("@/lib/negotiation/engine")
    expect(parseKickoffReply({ text: "x", n8n_execution_id: "exec_9" })!.n8n_execution_id).toBe("exec_9")
  })
  it("{message:'Workflow was started'} → null", async () => {
    const { parseKickoffReply } = await import("@/lib/negotiation/engine")
    expect(parseKickoffReply({ message: "Workflow was started" })).toBeNull()
  })
  it("{}, null, string vazia, não-objeto, array → null (nunca lança)", async () => {
    const { parseKickoffReply } = await import("@/lib/negotiation/engine")
    expect(parseKickoffReply({})).toBeNull()
    expect(parseKickoffReply(null)).toBeNull()
    expect(parseKickoffReply("")).toBeNull()
    expect(parseKickoffReply("texto solto")).toBeNull()
    expect(parseKickoffReply([{ text: "x" }])).toBeNull()
    expect(parseKickoffReply({ text: "   " })).toBeNull() // só espaços
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
