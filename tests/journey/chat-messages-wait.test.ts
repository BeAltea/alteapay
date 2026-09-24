// D2 — GET /api/chat/messages agora devolve wait_state + wait_started_at (M11):
// o client reconstrói a máquina de espera no reload a partir desses dois campos.
// Usa o crypto REAL para o cookie e o fake supabase em memória. Prova: o SELECT
// enxuto em negotiation_sessions vem na resposta; nunca vaza PII/offers_snapshot.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

const CO = "cccccccc-0000-0000-0000-00000000w8t1"
const SID = "sess_wait_msgs"

let db: FakeDb

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => makeFakeSupabase(db),
}))

process.env.NEGOTIATION_JWT_SECRET = "test-secret-wait-msgs"
process.env.CHAT_JOURNEY_ENABLED = "true"

function reset() {
  db = {
    chat_messages: [
      {
        id: "m1", company_id: CO, session_id: SID, role: "assistant", text: "Olá!",
        button_id: null, prompt_id: null, n8n_execution_id: null, engine: null,
        offers_snapshot: null, created_at: "2026-09-24T12:00:00.000Z",
      },
    ],
    chat_prompts: [],
    negotiation_sessions: [
      {
        id: SID, company_id: CO,
        wait_state: "aguardando_motor",
        wait_started_at: "2026-09-24T12:00:03.000Z",
      },
    ],
  }
}

function req(cookieValue: string | null, since?: string) {
  const params = new URLSearchParams()
  if (since) params.set("since", since)
  return {
    cookies: {
      get: (name: string) =>
        cookieValue && name === "alteapay_chat_session" ? { value: cookieValue } : undefined,
    },
    nextUrl: { searchParams: params },
  } as any
}

describe("GET /api/chat/messages — wait_state (M11)", () => {
  beforeEach(reset)

  it("devolve wait_state + wait_started_at da sessão (reload restaura a espera)", async () => {
    const { signChatJwt } = await import("@/lib/negotiation/crypto")
    const { GET } = await import("@/app/api/chat/messages/route")
    const res = await GET(req(signChatJwt({ sid: SID, cid: CO }, 3600)))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.wait_state).toBe("aguardando_motor")
    expect(body.wait_started_at).toBe("2026-09-24T12:00:03.000Z")
  })

  it("sessão sem espera (colunas NULL) → wait_state null, wait_started_at null (idle)", async () => {
    db.negotiation_sessions = [{ id: SID, company_id: CO, wait_state: null, wait_started_at: null }]
    const { signChatJwt } = await import("@/lib/negotiation/crypto")
    const { GET } = await import("@/app/api/chat/messages/route")
    const res = await GET(req(signChatJwt({ sid: SID, cid: CO }, 3600)))
    const body = await res.json()
    expect(body.wait_state).toBeNull()
    expect(body.wait_started_at).toBeNull()
  })

  it("resposta continua trazendo messages + active_prompt (sem regressão) e sem offers_snapshot", async () => {
    db.chat_messages![0].offers_snapshot = { payment_ref: { agreement_id: "ag1" }, message_action: null }
    const { signChatJwt } = await import("@/lib/negotiation/crypto")
    const { GET } = await import("@/app/api/chat/messages/route")
    const res = await GET(req(signChatJwt({ sid: SID, cid: CO }, 3600)))
    const body = await res.json()
    expect(Array.isArray(body.messages)).toBe(true)
    expect(body.messages[0].id).toBe("m1")
    // offers_snapshot cru NUNCA vaza ao cliente.
    expect("offers_snapshot" in body.messages[0]).toBe(false)
    expect(body).toHaveProperty("active_prompt")
    expect(body).toHaveProperty("server_time")
  })

  it("isola por company_id: sessão de outro tenant não vaza wait_state", async () => {
    // cookie com cid diferente do da sessão → o SELECT (id + company_id) não casa.
    const { signChatJwt } = await import("@/lib/negotiation/crypto")
    const { GET } = await import("@/app/api/chat/messages/route")
    const res = await GET(req(signChatJwt({ sid: SID, cid: "outro-tenant" }, 3600)))
    const body = await res.json()
    // company_id não bate → sem linha de wait (null), sem erro.
    expect(body.wait_state).toBeNull()
    expect(body.wait_started_at).toBeNull()
  })

  it("cookie ausente → 401 (sem vazar nada)", async () => {
    const { GET } = await import("@/app/api/chat/messages/route")
    const res = await GET(req(null))
    expect(res.status).toBe(401)
  })

  it("CHAT_JOURNEY_ENABLED != true → 404 (flag OFF)", async () => {
    process.env.CHAT_JOURNEY_ENABLED = "false"
    const { signChatJwt } = await import("@/lib/negotiation/crypto")
    const { GET } = await import("@/app/api/chat/messages/route")
    const res = await GET(req(signChatJwt({ sid: SID, cid: CO }, 3600)))
    expect(res.status).toBe(404)
    process.env.CHAT_JOURNEY_ENABLED = "true"
  })
})
