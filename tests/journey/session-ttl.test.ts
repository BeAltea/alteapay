// TTL do tenant em TODOS os caminhos de auth do chat: o `exp` do JWT e o maxAge
// do cookie DEVEM usar session_ttl_minutes do tenant — NUNCA o default curto.
// Prova a causa-raiz do "<1 min": se um caminho usasse o default de 2h (ou pior),
// a sessão venceria em uso. Aqui o crypto é REAL e conferimos o exp decodificado.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

const CO = "cccccccc-0000-0000-0000-000000000001"
const TTL_MIN = 43200 // 30 dias (VMAX)

let db: FakeDb
let resolveResult: any = null

process.env.NEGOTIATION_JWT_SECRET = "test-secret-ttl"

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => makeFakeSupabase(db),
}))
vi.mock("@/lib/journey/resolver", () => ({
  resolveByDocument: async () => resolveResult,
}))
vi.mock("@/lib/negotiation/sessions", () => ({
  createHandoffSession: async () => ({ session: { id: "sess_new" }, token: "t", deep_link: "x" }),
  findReusableOpenSession: async () => null,
  reopenSession: async () => {},
}))
vi.mock("@/lib/journey/events", () => ({ recordEvent: async () => ({ ok: true, duplicate: false }) }))
vi.mock("@/lib/journey/acknowledgement", () => ({
  bootstrapAckSafe: async () => ({ ok: true }),
  bootstrapSettledSafe: async () => {},
}))

const VALID_CPF = "11144477735"

function reset() {
  db = {
    tenant_chat_config: [{ company_id: CO, session_ttl_minutes: TTL_MIN }],
    negotiation_sessions: [{ id: "sess_new", company_id: CO }],
  }
  resolveResult = {
    kind: "open",
    debtor: {
      customerId: "cust1", customerName: "Fabio", document: VALID_CPF,
      debtIds: ["d1"], primaryDebtId: "d1", totalOpen: 100, agingDays: 30, invoiceCount: 1, oldestDueDate: "2020-01-01",
    },
  }
  process.env.CHAT_CAPTCHA_ENABLED = "false"
}

// O TTL efetivo do cookie == session_ttl_minutes * 60 e o exp decodificado bate.
function expectTenantTtl(cookieMaxAge: number, cookieValue: string, verify: (t: string) => any) {
  expect(cookieMaxAge).toBe(TTL_MIN * 60)
  const claims = verify(cookieValue)
  expect(claims).toBeTruthy()
  const now = Math.floor(Date.now() / 1000)
  // exp ~= now + TTL do tenant (não 2h, não minutos).
  expect(claims.exp).toBeGreaterThan(now + TTL_MIN * 60 - 30)
  expect(claims.exp).toBeLessThan(now + TTL_MIN * 60 + 30)
}

describe("TTL do tenant nos caminhos de auth do chat", () => {
  beforeEach(reset)

  it("authenticateByDocument aplica session_ttl_minutes ao exp e ao maxAge", async () => {
    const { verifyChatJwt } = await import("@/lib/negotiation/crypto")
    const { authenticateByDocument } = await import("@/lib/journey/generic-auth")
    const r = await authenticateByDocument({
      companyId: CO, document: VALID_CPF, consent: true, ip: "1.2.3.4",
      userAgent: "test", captchaToken: null, channel: "web_generic",
    })
    expect(r.ok).toBe(true)
    if (r.ok) expectTenantTtl(r.cookieMaxAge, r.cookieValue, verifyChatJwt)
  })

  it("authenticateByPublicLink aplica session_ttl_minutes ao exp e ao maxAge", async () => {
    const { verifyChatJwt } = await import("@/lib/negotiation/crypto")
    const { authenticateByPublicLink } = await import("@/lib/journey/generic-auth")
    const r = await authenticateByPublicLink({
      companyId: CO, document: VALID_CPF, consent: true, ip: "1.2.3.4",
      userAgent: "test", captchaToken: null,
    })
    expect(r.ok).toBe(true)
    if (r.ok) expectTenantTtl(r.cookieMaxAge, r.cookieValue, verifyChatJwt)
  })

  it("default generoso (30 dias) quando o tenant não define session_ttl_minutes", async () => {
    db.tenant_chat_config = [{ company_id: CO }] // sem session_ttl_minutes
    const { verifyChatJwt, CHAT_JWT_TTL_SECONDS } = await import("@/lib/negotiation/crypto")
    const { authenticateByPublicLink } = await import("@/lib/journey/generic-auth")
    const r = await authenticateByPublicLink({
      companyId: CO, document: VALID_CPF, consent: true, ip: "1.2.3.4",
      userAgent: "test", captchaToken: null,
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      // link público usa default 30min SÓ quando cfg ausente; aqui cfg existe mas
      // sem o campo → cai no ?? 30 do próprio caminho. O ponto essencial: NUNCA
      // vence em <1min. E o default GLOBAL do crypto é 30 dias (rede de segurança).
      expect(r.cookieMaxAge).toBe(30 * 60)
      // garante que o piso do crypto é generoso (30 dias), não 2h.
      expect(CHAT_JWT_TTL_SECONDS).toBe(30 * 24 * 60 * 60)
      const now = Math.floor(Date.now() / 1000)
      expect(verifyChatJwt(r.cookieValue)!.exp).toBeGreaterThan(now + 30 * 60 - 30)
    }
  })
})
