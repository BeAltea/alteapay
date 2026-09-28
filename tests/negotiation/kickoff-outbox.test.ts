// N8N-10: kickoff confiável via engine_outbox.
//  - login: session.start é GRAVADO no outbox e a 1ª entrega sai FORA do caminho
//    da resposta (o login não espera o n8n, nem com o n8n pendurado);
//  - dreno: pendente → 'sent' com o corpo/headers assinados de sempre;
//  - retry/backoff exponencial e teto de tentativas → 'failed';
//  - dedup: mesmo event_id não duplica linha; dois drenos concorrentes não postam
//    a mesma linha (reivindicação compare-and-set);
//  - tabela ausente: no-op explícito (sem POST, sem exceção) e reavaliado depois
//    do prazo de recheck;
//  - rota de cron (Bearer CRON_SECRET) e drenador do worker.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "../journey/_fake-supabase"
import type { CanonicalEnvelope } from "@/lib/negotiation/payload"

let db: FakeDb
let outboxMissing = false
const MISSING = { code: "PGRST205", message: "Could not find the table 'public.engine_outbox' in the schema cache" }

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => {
    const fake = makeFakeSupabase(db)
    return {
      from(table: string) {
        if (table === "engine_outbox" && outboxMissing) {
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

// Login (generic-auth): isola o que não é do outbox.
let resolveResult: any = null
vi.mock("@/lib/journey/resolver", () => ({ resolveByDocument: async () => resolveResult }))
vi.mock("@/lib/negotiation/sessions", () => ({
  createHandoffSession: async () => ({ session: { id: SID }, token: "tok", deep_link: "x" }),
  findReusableOpenSession: async () => null,
  reopenSession: async () => {},
}))
vi.mock("@/lib/journey/events", () => ({ recordEvent: async () => ({ ok: true, duplicate: false }) }))
vi.mock("@/lib/negotiation/crypto", () => ({ signChatJwt: () => "signed.jwt", CHAT_COOKIE_NAME: "alteapay_chat_session" }))
vi.mock("@/lib/journey/acknowledgement", () => ({
  bootstrapThreeOptionsSafe: async () => {},
  bootstrapSettledSafe: async () => {},
  buildAckContext: async () => ({ updatedValue: 100, oldestDueDate: "2025-01-01", invoiceCount: 1 }),
}))

const CO = "cccccccc-0000-0000-0000-00000000n810"
const SID = "5e551011-0000-0000-0000-00000000n810"
const CPF = "11144477735"
const FLOW = "https://n8n.example/webhook/flow"

function envelope(over: Partial<CanonicalEnvelope> = {}): CanonicalEnvelope {
  return {
    event: "session.start",
    type: "session.start",
    contract_version: "1.0",
    event_id: "evt_kickoff_0001",
    occurred_at: "2026-09-27T12:00:00.000Z",
    thread_id: `web_${SID}`,
    session_id: SID,
    company_id: CO,
    channel: "webchat",
    message: null,
    button: null,
    session_state: { identity_verified: true, debt_acknowledged: false, fulfillment_mode: "A", outcome: "in_progress" },
    debtor: { id: "cust1", name: "Fabio", document: null, document_masked: "***.444.777-**", document_hash: "a".repeat(64) },
    debt: null,
    tenant: { fulfillment_mode: "A", official_channel_label: null, brand_name: "VMAX", chat_link: null },
    ...over,
  }
}

function pendingRow(over: Record<string, unknown> = {}) {
  const payload = envelope()
  return {
    id: "row-1",
    session_id: SID,
    company_id: CO,
    event_type: "session.start",
    event_id: payload.event_id,
    payload,
    status: "pending",
    attempts: 0,
    last_error: null,
    next_attempt_at: null,
    sent_at: null,
    created_at: "2026-09-27T12:00:00.000Z",
    ...over,
  }
}

function sessionStartInput() {
  return {
    sessionId: SID,
    companyId: CO,
    customerId: "cust1",
    document: CPF,
    debtIds: ["debt1"],
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

/** fetch que só responde depois de `ms` (ou nunca, se ms=Infinity). */
function slowFetch(ms: number, status = 200) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(
    () =>
      new Promise((resolve) => {
        if (Number.isFinite(ms)) setTimeout(() => resolve(new Response("{}", { status })), ms)
      }) as Promise<Response>,
  )
}

async function flushMicrotasks(times = 20) {
  for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r))
}

beforeEach(async () => {
  db = {
    engine_outbox: [],
    tenant_chat_config: [{ company_id: CO, auth_max_attempts: 3, auth_lock_minutes: 30, session_ttl_minutes: 60, n8n_event_names: null }],
    companies: [{ id: CO, name: "VMAX" }],
    customers: [{ id: "cust1", company_id: CO, name: "Fabio Silva" }],
    negotiation_sessions: [{ id: SID, company_id: CO, reopen_count: 0, fulfillment_mode: "A", outcome: "in_progress" }],
    debtor_engine_snapshot: [],
    agreements: [],
  }
  outboxMissing = false
  process.env.NEGOTIATION_ENGINE = "n8n"
  process.env.N8N_CHAT_FLOW_URL = FLOW
  process.env.N8N_WEBHOOK_SECRET = "s3cr3t"
  process.env.CHAT_JOURNEY_ENABLED = "true"
  process.env.CHAT_CAPTCHA_ENABLED = "false"
  process.env.CRON_SECRET = "cron-secret-test"
  delete process.env.N8N_EVENT_FLOW_URL
  delete process.env.ENGINE_OUTBOX_MAX_ATTEMPTS
  delete process.env.ENGINE_OUTBOX_BACKOFF_BASE_MS
  delete process.env.ENGINE_OUTBOX_RECHECK_MS
  delete process.env.ENGINE_OUTBOX_DRAIN_INTERVAL_MS
  resolveResult = {
    kind: "open",
    debtor: {
      customerId: "cust1", customerName: "Fabio", document: CPF,
      debtIds: ["debt1"], primaryDebtId: "debt1", totalOpen: 100, agingDays: 30, invoiceCount: 1, oldestDueDate: "2025-01-01",
    },
  }
  const { resetOutboxAvailability } = await import("@/lib/negotiation/outbox")
  resetOutboxAvailability()
})
afterEach(() => vi.restoreAllMocks())

describe("login → session.start no outbox, sem esperar o n8n", () => {
  it("enfileira o session.start como 'pending' e devolve antes do POST terminar", async () => {
    const fetchSpy = slowFetch(Infinity) // n8n pendurado
    const { emitSessionStart } = await import("@/lib/negotiation/engine")
    const t0 = Date.now()
    const res = await emitSessionStart(sessionStartInput())
    expect(Date.now() - t0).toBeLessThan(500)
    expect(res).toMatchObject({ ok: true, enqueued: true, status: "pending" })
    expect(db.engine_outbox).toHaveLength(1)
    const row = db.engine_outbox[0]
    expect(row.event_type).toBe("session.start")
    expect(row.payload.event).toBe("session.start")
    expect(row.payload.session_id).toBe(SID)
    expect(row.payload.company_id).toBe(CO)
    // a 1ª tentativa começou por trás (reivindicada), mas ninguém a esperou
    await flushMicrotasks()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(row.attempts).toBe(1)
    expect(row.status).toBe("pending")
  })

  it("authenticateByDocument com o n8n pendurado responde rápido e deixa a linha no outbox", async () => {
    slowFetch(Infinity)
    const { authenticateByDocument } = await import("@/lib/journey/generic-auth")
    const t0 = Date.now()
    const r = await authenticateByDocument({
      companyId: CO, document: CPF, consent: true, ip: "1.2.3.4",
      userAgent: "test", captchaToken: null, channel: "web_generic",
    })
    expect(r.ok).toBe(true)
    expect(Date.now() - t0).toBeLessThan(1000) // POST ao n8n (até 2,5 s) não entra na conta
    expect(db.engine_outbox.filter((x) => x.event_type === "session.start")).toHaveLength(1)
  })

  it("engine 'disabled' → linha 'skipped_engine_disabled' e nenhum POST", async () => {
    delete process.env.NEGOTIATION_ENGINE
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const { emitSessionStart } = await import("@/lib/negotiation/engine")
    await emitSessionStart(sessionStartInput())
    await flushMicrotasks()
    expect(db.engine_outbox[0].status).toBe("skipped_engine_disabled")
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe("dreno", () => {
  it("pendente → 'sent'; corpo estável e assinado, x-alteapay-event-id = event_id", async () => {
    db.engine_outbox.push(pendingRow())
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }))
    const { flushOutbox } = await import("@/lib/negotiation/outbox")
    const { stableStringify } = await import("@/lib/negotiation/payload")
    const res = await flushOutbox()
    expect(res).toEqual({ scanned: 1, sent: 1, failed: 0, pending: 0 })
    const row = db.engine_outbox[0]
    expect(row.status).toBe("sent")
    expect(row.sent_at).toBeTruthy()
    expect(row.attempts).toBe(1)
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(FLOW)
    expect(init.body).toBe(stableStringify(row.payload))
    const headers = init.headers as Record<string, string>
    expect(headers["x-alteapay-event-id"]).toBe(row.event_id)
    expect(headers["x-alteapay-signature"]).toMatch(/^sha256=|^[0-9a-f]{64}$/)
  })

  it("URL por tenant vence a env (mesma resolução do negotiation.start)", async () => {
    db.tenant_chat_config[0].n8n_chat_flow_url = "https://n8n.example/webhook/tenant"
    db.engine_outbox.push(pendingRow())
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }))
    const { flushOutbox } = await import("@/lib/negotiation/outbox")
    await flushOutbox()
    expect(fetchSpy.mock.calls[0][0]).toBe("https://n8n.example/webhook/tenant")
  })

  it("orçamento esgotado → não inicia novas entregas (ficam para o próximo dreno)", async () => {
    db.engine_outbox.push(pendingRow({ id: "a", event_id: "e-a" }), pendingRow({ id: "b", event_id: "e-b" }))
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }))
    const { flushOutbox } = await import("@/lib/negotiation/outbox")
    const res = await flushOutbox({ budgetMs: 0 })
    expect(res).toEqual({ scanned: 2, sent: 0, failed: 0, pending: 2 })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe("retry / backoff / teto", () => {
  it("5xx → 'pending' com backoff exponencial; no teto → 'failed'", async () => {
    process.env.ENGINE_OUTBOX_BACKOFF_BASE_MS = "1000"
    process.env.ENGINE_OUTBOX_MAX_ATTEMPTS = "3"
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("down", { status: 503 }))
    const { dispatchOutboxRow } = await import("@/lib/negotiation/outbox")
    db.engine_outbox.push(pendingRow())
    const row = db.engine_outbox[0]

    const delays: number[] = []
    for (let i = 0; i < 2; i++) {
      const before = Date.now()
      const st = await dispatchOutboxRow({ ...row } as any)
      expect(st).toBe("pending")
      expect(row.last_error).toBe("http_503")
      delays.push(new Date(row.next_attempt_at).getTime() - before)
    }
    expect(row.attempts).toBe(2)
    // 1000 * 2^0 e 1000 * 2^1 (com folga de relógio)
    expect(delays[0]).toBeGreaterThanOrEqual(900)
    expect(delays[0]).toBeLessThan(1500)
    expect(delays[1]).toBeGreaterThanOrEqual(1900)
    expect(delays[1]).toBeLessThan(2500)

    const last = await dispatchOutboxRow({ ...row } as any)
    expect(last).toBe("failed")
    expect(row.status).toBe("failed")
    expect(row.attempts).toBe(3)
    expect(row.next_attempt_at).toBeNull()
  })

  it("timeout/erro de rede → 'pending' (reentrega), 4xx permanente → 'failed'", async () => {
    const { dispatchOutboxRow } = await import("@/lib/negotiation/outbox")
    db.engine_outbox.push(pendingRow({ id: "net", event_id: "e-net" }), pendingRow({ id: "bad", event_id: "e-bad" }))
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(Object.assign(new Error("x"), { name: "TimeoutError" }))
    expect(await dispatchOutboxRow({ ...db.engine_outbox[0] } as any)).toBe("pending")
    expect(db.engine_outbox[0].last_error).toBe("timeout")
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("no", { status: 400 }))
    expect(await dispatchOutboxRow({ ...db.engine_outbox[1] } as any)).toBe("failed")
  })
})

describe("dedup", () => {
  it("mesmo event_id (reentrada do login) não cria 2ª linha nem 2º POST", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }))
    const { emitSessionStart } = await import("@/lib/negotiation/engine")
    await emitSessionStart(sessionStartInput())
    await emitSessionStart(sessionStartInput())
    await flushMicrotasks()
    expect(db.engine_outbox).toHaveLength(1)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it("dois drenos concorrentes na MESMA linha → um único POST (compare-and-set)", async () => {
    db.engine_outbox.push(pendingRow())
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }))
    const { dispatchOutboxRow } = await import("@/lib/negotiation/outbox")
    const snapshot = { ...db.engine_outbox[0] } // os dois leram attempts=0
    const [a, b] = await Promise.all([dispatchOutboxRow({ ...snapshot } as any), dispatchOutboxRow({ ...snapshot } as any)])
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect([a, b].sort()).toEqual(["pending", "sent"])
    expect(db.engine_outbox[0].status).toBe("sent")
  })

  it("linha já 'sent' ou 'skipped_engine_disabled' nunca é reenviada", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const { dispatchOutboxRow } = await import("@/lib/negotiation/outbox")
    expect(await dispatchOutboxRow(pendingRow({ status: "sent" }) as any)).toBe("sent")
    expect(await dispatchOutboxRow(pendingRow({ status: "skipped_engine_disabled" }) as any)).toBe("skipped_engine_disabled")
    expect(fetchSpy).not.toHaveBeenCalled()
  })

})

describe("tabela ausente (migration pendente) → no-op explícito", () => {
  it("login não posta, não lança e não grava; flush devolve zeros", async () => {
    outboxMissing = true
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const { emitSessionStart } = await import("@/lib/negotiation/engine")
    const { flushOutbox, outboxKnownUnavailable } = await import("@/lib/negotiation/outbox")
    const res = await emitSessionStart(sessionStartInput())
    expect(res).toEqual({ ok: true, enqueued: false, reason: "context_unresolved" })
    await flushMicrotasks()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(outboxKnownUnavailable()).toBe(true)
    expect(await flushOutbox()).toEqual({ scanned: 0, sent: 0, failed: 0, pending: 0 })
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("engine_outbox ausente"))).toHaveLength(1)
  })

  it("depois do prazo de recheck, um processo quente volta a usar a tabela (migration aplicada)", async () => {
    process.env.ENGINE_OUTBOX_RECHECK_MS = "0"
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const { enqueueEvent, outboxKnownUnavailable } = await import("@/lib/negotiation/outbox")
    outboxMissing = true
    expect(await enqueueEvent({ sessionId: SID, companyId: CO, envelope: envelope() })).toEqual({
      ok: false,
      error: "engine_outbox_unavailable",
    })
    outboxMissing = false // migration aplicada
    expect(outboxKnownUnavailable()).toBe(false)
    const again = await enqueueEvent({ sessionId: SID, companyId: CO, envelope: envelope() })
    expect(again.ok).toBe(true)
    expect(db.engine_outbox).toHaveLength(1)
  })

  it("rota de cron com a tabela ausente responde 200 com zeros", async () => {
    outboxMissing = true
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const { POST } = await import("@/app/api/cron/flush-engine-outbox/route")
    const resp = await POST(new Request("http://x/api/cron/flush-engine-outbox", {
      method: "POST",
      headers: { authorization: "Bearer cron-secret-test" },
    }))
    expect(resp.status).toBe(200)
    expect(await resp.json()).toEqual({ ok: true, scanned: 0, sent: 0, failed: 0, pending: 0 })
  })
})

describe("rota de cron /api/cron/flush-engine-outbox", () => {
  const call = async (auth?: string) => {
    const { POST } = await import("@/app/api/cron/flush-engine-outbox/route")
    return POST(new Request("http://x/api/cron/flush-engine-outbox", {
      method: "POST",
      headers: auth ? { authorization: auth } : {},
    }))
  }

  it("sem/errado Bearer → 401; CRON_SECRET vazio → 401 sempre", async () => {
    expect((await call()).status).toBe(401)
    expect((await call("Bearer nope")).status).toBe(401)
    process.env.CRON_SECRET = ""
    expect((await call("Bearer ")).status).toBe(401)
    expect((await call("Bearer undefined")).status).toBe(401)
  })

  it("Bearer correto → drena e devolve só contagens", async () => {
    db.engine_outbox.push(pendingRow())
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }))
    vi.spyOn(console, "log").mockImplementation(() => {})
    const resp = await call("Bearer cron-secret-test")
    expect(resp.status).toBe(200)
    expect(await resp.json()).toEqual({ ok: true, scanned: 1, sent: 1, failed: 0, pending: 0 })
    expect(db.engine_outbox[0].status).toBe("sent")
  })

  it("engine 'disabled' → não drena", async () => {
    delete process.env.NEGOTIATION_ENGINE
    db.engine_outbox.push(pendingRow())
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const resp = await call("Bearer cron-secret-test")
    expect(await resp.json()).toEqual({ ok: true, skipped: "engine_disabled" })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe("drenador do worker (Fargate)", () => {
  it("desligado sem motor n8n no processo ou com intervalo 0", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    const { startEngineOutboxDrainer } = await import("@/lib/queue/workers/engine-outbox.drainer")
    delete process.env.NEGOTIATION_ENGINE
    expect(startEngineOutboxDrainer()).toBeNull()
    process.env.NEGOTIATION_ENGINE = "n8n"
    process.env.ENGINE_OUTBOX_DRAIN_INTERVAL_MS = "0"
    expect(startEngineOutboxDrainer()).toBeNull()
  })

  it("ligado: uma rodada entrega os pendentes", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    db.engine_outbox.push(pendingRow())
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }))
    const { startEngineOutboxDrainer } = await import("@/lib/queue/workers/engine-outbox.drainer")
    const drainer = startEngineOutboxDrainer()
    expect(drainer).not.toBeNull()
    await drainer!.tick()
    drainer!.stop()
    expect(db.engine_outbox[0].status).toBe("sent")
  })
})
