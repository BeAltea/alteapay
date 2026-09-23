// Keep-alive da sessão do chat (à prova de expiração em uso): POST /api/chat/keepalive
// - cookie válido → RE-ASSINA o JWT com um `exp` FRESCO (TTL do tenant), re-seta
//   o cookie httpOnly e bump em negotiation_sessions.last_activity_at;
// - cookie inválido/ausente → 401 (o client abre o modal, nunca redireciona).
// Usa o crypto REAL (assina/verifica de verdade) para provar que o novo exp é
// maior que o antigo — é isso que impede o "<1 min" de voltar.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

const CO = "cccccccc-0000-0000-0000-000000000001"
const SID = "sess_keepalive"

let db: FakeDb

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => makeFakeSupabase(db),
}))

// Segredo do HS256 para o crypto real assinar/verificar.
process.env.NEGOTIATION_JWT_SECRET = "test-secret-keepalive"
process.env.CHAT_JOURNEY_ENABLED = "true"

function reset() {
  db = {
    tenant_chat_config: [{ company_id: CO, session_ttl_minutes: 43200 }], // 30 dias (VMAX)
    negotiation_sessions: [{ id: SID, company_id: CO, last_activity_at: "2020-01-01T00:00:00.000Z" }],
  }
}

function reqWithCookie(cookieValue: string | null) {
  return {
    cookies: {
      get: (name: string) =>
        cookieValue && name === "alteapay_chat_session" ? { value: cookieValue } : undefined,
    },
  } as any
}

describe("POST /api/chat/keepalive", () => {
  beforeEach(reset)

  it("cookie válido → 200, re-assina com exp FRESCO (TTL do tenant) e bump em last_activity_at", async () => {
    const { signChatJwt, verifyChatJwt } = await import("@/lib/negotiation/crypto")
    const { POST } = await import("@/app/api/chat/keepalive/route")

    // Cookie que expira em ~2min: simula o JWT "quase vencendo" em uso.
    const soon = signChatJwt({ sid: SID, cid: CO }, 120)
    const oldExp = verifyChatJwt(soon)!.exp

    const res = await POST(reqWithCookie(soon))
    expect(res.status).toBe(200)

    // Re-setou o cookie httpOnly com um novo valor.
    const setCookie = res.cookies.get("alteapay_chat_session")
    expect(setCookie?.value).toBeTruthy()
    expect(setCookie?.value).not.toBe(soon)
    expect(setCookie?.httpOnly).toBe(true)
    expect(setCookie?.path).toBe("/")

    // O novo exp é MUITO maior (TTL do tenant = 30 dias >> 2min antigos).
    const newClaims = verifyChatJwt(setCookie!.value)!
    expect(newClaims.sid).toBe(SID)
    expect(newClaims.cid).toBe(CO)
    expect(newClaims.exp).toBeGreaterThan(oldExp)
    // maxAge do cookie = session_ttl_minutes * 60.
    expect(setCookie?.maxAge).toBe(43200 * 60)
    // ~30 dias à frente (tolerância de alguns segundos).
    const now = Math.floor(Date.now() / 1000)
    expect(newClaims.exp).toBeGreaterThan(now + 43200 * 60 - 30)

    // Renovou a atividade da sessão (saiu de 2020).
    const sess = db.negotiation_sessions?.find((s) => s.id === SID)
    expect(new Date(sess?.last_activity_at).getTime()).toBeGreaterThan(new Date("2020-01-02").getTime())
  })

  it("sem tenant config → cai no default generoso (30 dias), NÃO em minutos", async () => {
    db.tenant_chat_config = [] // sem config
    const { signChatJwt, verifyChatJwt, CHAT_JWT_TTL_SECONDS } = await import("@/lib/negotiation/crypto")
    const { POST } = await import("@/app/api/chat/keepalive/route")

    const cookie = signChatJwt({ sid: SID, cid: CO }, 120)
    const res = await POST(reqWithCookie(cookie))
    expect(res.status).toBe(200)
    const setCookie = res.cookies.get("alteapay_chat_session")
    expect(setCookie?.maxAge).toBe(CHAT_JWT_TTL_SECONDS)
    const now = Math.floor(Date.now() / 1000)
    expect(verifyChatJwt(setCookie!.value)!.exp).toBeGreaterThan(now + CHAT_JWT_TTL_SECONDS - 30)
  })

  it("cookie ausente → 401 (client abre o modal, não redireciona)", async () => {
    const { POST } = await import("@/app/api/chat/keepalive/route")
    const res = await POST(reqWithCookie(null))
    expect(res.status).toBe(401)
  })

  it("cookie EXPIRADO → 401 (não renova sessão morta)", async () => {
    const { signChatJwt } = await import("@/lib/negotiation/crypto")
    const { POST } = await import("@/app/api/chat/keepalive/route")
    // exp no passado (ttl negativo) → verifyChatJwt rejeita.
    const expired = signChatJwt({ sid: SID, cid: CO }, -10)
    const res = await POST(reqWithCookie(expired))
    expect(res.status).toBe(401)
  })

  it("assinatura adulterada → 401", async () => {
    const { signChatJwt } = await import("@/lib/negotiation/crypto")
    const { POST } = await import("@/app/api/chat/keepalive/route")
    const good = signChatJwt({ sid: SID, cid: CO }, 3600)
    const tampered = good.slice(0, -4) + "AAAA"
    const res = await POST(reqWithCookie(tampered))
    expect(res.status).toBe(401)
  })
})
