// QA round 3 — QAB2-01 (MÉDIO): GET /api/chat/messages SEM `since` (1ª pintura /
// retomada) devolve as 200 mensagens MAIS NOVAS em ordem ascendente — antes
// devolvia as 200 mais ANTIGAS e, numa thread > 200 linhas, o link recém-entregue
// ficava fora até o 1º poll incremental. COM `since` segue ascendente a partir do corte.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

process.env.CHAT_JOURNEY_ENABLED = "true"
process.env.NEGOTIATION_JWT_SECRET = "test-secret-qa3-latest"
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co"
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key"

const CO = "eeeeeeee-0000-0000-0000-000000qa3lt1"
const SID = "sess-qa3-latest"
const CUST = "cust-qa3-latest"
const DEBT = "debt-qa3-latest"
const TOTAL = 250

let db: FakeDb
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/journey/events", () => ({ recordEvent: async () => ({ ok: true, duplicate: false }), getTimeline: async () => [] }))

const ts = (i: number) => new Date(Date.parse("2026-09-20T00:00:00.000Z") + i * 1000).toISOString()

function seed() {
  const msgs = Array.from({ length: TOTAL }, (_, i) => ({
    id: `msg-${String(i).padStart(3, "0")}`, session_id: SID, company_id: CO,
    role: i % 2 ? "assistant" : "customer", text: `linha ${i}`, button_id: null, prompt_id: null,
    n8n_execution_id: null, engine: "platform", offers_snapshot: null, thread_epoch: 0, archived_at: null,
    created_at: ts(i),
  }))
  db = {
    negotiation_sessions: [{ id: SID, company_id: CO, customer_id: CUST, debt_id: DEBT, agreement_id: null, thread_epoch: 0 }],
    customers: [{ id: CUST, company_id: CO, name: "Fabio Mendes", document: "11144477735" }],
    companies: [{ id: CO, name: "VMAX LTDA" }],
    tenant_chat_config: [{ company_id: CO, branding: { brand_name: "VMAX" } }],
    debts: [{ id: DEBT, company_id: CO, customer_id: CUST, status: "pending", amount: 250, due_date: "2026-08-15" }],
    vmax_invoices: [], agreements: [], chat_prompts: [],
    chat_messages: msgs,
  }
}
async function getMessages(since?: string) {
  const { GET } = await import("@/app/api/chat/messages/route")
  const { signChatJwt } = await import("@/lib/negotiation/crypto")
  const cookie = signChatJwt({ sid: SID, cid: CO }, 3600)
  const res = await GET({
    cookies: { get: (n: string) => (n === "alteapay_chat_session" ? { value: cookie } : undefined) },
    nextUrl: { searchParams: new URLSearchParams(since ? `since=${encodeURIComponent(since)}` : "") },
  } as any)
  return res.json()
}

describe("QAB2-01 — 1º poll traz a janela MAIS RECENTE", () => {
  beforeEach(seed)

  it("sem since: as 200 mais novas, em ordem ascendente (a última linha da thread está presente)", async () => {
    const body = await getMessages()
    const ids = (body.messages as Array<{ id: string }>).map((m) => m.id)
    expect(ids.length).toBe(200)
    expect(ids[0]).toBe("msg-050")
    expect(ids[ids.length - 1]).toBe("msg-249")
    expect([...ids].sort()).toEqual(ids) // ascendente
  })

  it("com since: ascendente a partir do corte", async () => {
    const body = await getMessages(ts(239))
    const ids = (body.messages as Array<{ id: string }>).map((m) => m.id)
    expect(ids[0]).toBe("msg-240")
    expect(ids[ids.length - 1]).toBe("msg-249")
    expect(ids.length).toBe(10)
  })

  it("rota: sem since usa order desc + limit e reverte em memória", async () => {
    const { readFileSync } = await import("node:fs")
    const { join } = await import("node:path")
    const s = readFileSync(join(__dirname, "..", "..", "app/api/chat/messages/route.ts"), "utf8")
    expect(s).toMatch(/base\.order\("created_at", \{ ascending: false \}\)\.limit\(200\)/)
    expect(s).toContain(".reverse()")
  })
})
