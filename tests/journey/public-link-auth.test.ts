// H4 — Link único público /n/{code}: autenticação por documento.
// Cobre: ordem exata (DV → captcha → rate-limit IP → documento → teto → resolve),
// resposta IDÊNTICA no no_debt (inexistente == sem-dívida), bloqueio neutro,
// sucesso emite cookie, e nunca grava documento em claro.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

const CO = "cccccccc-0000-0000-0000-000000000001"

let db: FakeDb
let resolveResult: any = null
let reusableResult: any = null
const reopenCalls: any[] = []

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => makeFakeSupabase(db),
}))
vi.mock("@/lib/journey/resolver", () => ({
  resolveByDocument: async () => resolveResult,
}))
vi.mock("@/lib/negotiation/sessions", () => ({
  createHandoffSession: async () => ({ session: { id: "sess_new" }, token: "tok", deep_link: "x" }),
  // sem sessão reutilizável por padrão → caminho de criação (asserções existentes).
  findReusableOpenSession: async () => reusableResult,
  reopenSession: async (input: any) => {
    reopenCalls.push(input)
  },
}))
vi.mock("@/lib/journey/events", () => ({ recordEvent: async () => ({ ok: true, duplicate: false }) }))
vi.mock("@/lib/negotiation/crypto", () => ({
  signChatJwt: () => "signed.jwt.token",
  CHAT_COOKIE_NAME: "alteapay_chat_session",
}))
const settledCalls: Array<Record<string, unknown>> = []
vi.mock("@/lib/journey/acknowledgement", () => ({
  bootstrapAckSafe: async () => ({ ok: true }),
  bootstrapSettledSafe: async (input: Record<string, unknown>) => {
    settledCalls.push(input)
  },
}))

const VALID_CPF = "11144477735"
const VALID_CNPJ = "11444777000161"

const NO_DEBT =
  "Não encontramos dívidas cadastradas para negociação com este documento. Se você recebeu uma mensagem nossa, confira se digitou o documento corretamente. Se preferir, fale com nosso atendimento."
const BLOCKED = "Muitas tentativas em sequência. Por segurança, tente novamente em alguns minutos."
const UNIFORM = "Não foi possível confirmar seus dados. Verifique e tente novamente."

function reset() {
  settledCalls.length = 0
  reusableResult = null
  reopenCalls.length = 0
  db = {
    tenant_chat_config: [{ company_id: CO, session_ttl_minutes: 30 }],
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
  delete process.env.PUBLIC_AUTH_IP_MAX_ATTEMPTS
  delete process.env.PUBLIC_AUTH_IP_WINDOW_MIN
  delete process.env.PUBLIC_AUTH_DOC_MAX_ATTEMPTS
  delete process.env.PUBLIC_AUTH_TENANT_HOURLY_CAP
}

async function auth(over: Partial<Parameters<typeof import("@/lib/journey/generic-auth").authenticateByPublicLink>[0]> = {}) {
  const { authenticateByPublicLink } = await import("@/lib/journey/generic-auth")
  return authenticateByPublicLink({
    companyId: CO, document: VALID_CPF, consent: true, ip: "1.2.3.4",
    userAgent: "test", captchaToken: null, ...over,
  })
}

describe("authenticateByPublicLink", () => {
  beforeEach(reset)

  it("sucesso: resolve, cria sessão, emite cookie e nunca grava o documento em claro", async () => {
    const r = await auth()
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.cookieValue).toBe("signed.jwt.token")
      expect(r.sessionId).toBe("sess_new")
      expect(r.cookieName).toBe("alteapay_chat_session")
      expect(r.cookieMaxAge).toBe(30 * 60) // session_ttl_minutes = 30
    }
    const sess = db.negotiation_sessions?.find((s) => s.id === "sess_new")
    expect(sess?.channel).toBe("web_public_link")
    expect(sess?.status).toBe("open")
    // attempt gravada só com hashes
    const okAttempt = db.chat_auth_generic_attempts?.find((a) => a.success)
    expect(okAttempt?.doc_hash).toHaveLength(64)
    expect(JSON.stringify(okAttempt)).not.toContain(VALID_CPF)
  })

  it("aceita CNPJ com DV válido", async () => {
    resolveResult = { kind: "open", debtor: { ...resolveResult.debtor, document: VALID_CNPJ } }
    const r = await auth({ document: VALID_CNPJ })
    expect(r.ok).toBe(true)
  })

  it("no_debt: documento INEXISTENTE e SEM-DÍVIDA NENHUMA devolvem resposta IDÊNTICA", async () => {
    // caso 1: 'none' (inexistente OU só-VMAX OU sem dívida nenhuma)
    resolveResult = { kind: "none" }
    const inexistente = await auth({ document: VALID_CPF, ip: "10.0.0.1" })

    // caso 2: outro documento válido também 'none' (sem dívida nenhuma)
    const semDivida = await auth({ document: VALID_CNPJ, ip: "10.0.0.2" })

    // MESMO ok, MESMO reason, MESMA mensagem — indistinguíveis.
    expect(inexistente).toEqual({ ok: false, reason: "no_debt", message: NO_DEBT })
    expect(semDivida).toEqual({ ok: false, reason: "no_debt", message: NO_DEBT })
    expect(inexistente).toEqual(semDivida)
  })

  it("dívida QUITADA: NÃO é no_debt — cria sessão, emite cookie e empurra a mensagem de quitação", async () => {
    resolveResult = {
      kind: "settled",
      debtor: {
        customerId: "cust1", customerName: "Fabio", document: VALID_CPF,
        paidDebtIds: ["dp1"], totalPaid: 250, oldestDueDate: "2020-01-01", paidAt: "2026-05-10T12:00:00.000Z",
      },
    }
    const r = await auth()
    expect(r.ok).toBe(true) // ENTRA no chat (não no_debt)
    // sessão criada normalmente
    const sess = db.negotiation_sessions?.find((s) => s.id === "sess_new")
    expect(sess?.status).toBe("open")
    expect(sess?.primary_debt_id).toBe("dp1")
    // empurrou a mensagem informativa (não o prompt de reconhecimento)
    expect(settledCalls.length).toBe(1)
    expect(settledCalls[0]).toMatchObject({ totalPaid: 250, paidAt: "2026-05-10T12:00:00.000Z" })
  })

  it("invalid: DV errado NÃO resolve e devolve mensagem uniforme (reason=invalid)", async () => {
    const r = await auth({ document: "11144477736" }) // DV errado
    expect(r).toEqual({ ok: false, reason: "invalid", message: UNIFORM })
  })

  it("invalid: consentimento ausente", async () => {
    const r = await auth({ consent: false })
    expect(r).toEqual({ ok: false, reason: "invalid", message: UNIFORM })
  })

  it("captcha ligado sem token → blocked (neutro, não revela existência)", async () => {
    process.env.CHAT_CAPTCHA_ENABLED = "true"
    process.env.CHAT_CAPTCHA_PROVIDER = "turnstile"
    process.env.CHAT_CAPTCHA_SECRET = "sekret"
    const r = await auth({ captchaToken: null })
    expect(r).toEqual({ ok: false, reason: "blocked", message: BLOCKED })
    delete process.env.CHAT_CAPTCHA_ENABLED
    delete process.env.CHAT_CAPTCHA_SECRET
  })

  it("captcha desligado (default) não bloqueia", async () => {
    const r = await auth({ captchaToken: null })
    expect(r.ok).toBe(true)
  })

  it("reuso: 2ª auth do mesmo cliente dentro do TTL reusa o session_id (link público)", async () => {
    reusableResult = { id: "sess_existing", status: "open", last_activity_at: new Date().toISOString(), reopen_count: 2 }
    const r = await auth()
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.sessionId).toBe("sess_existing")
    expect(reopenCalls.length).toBe(1)
    expect(reopenCalls[0]).toMatchObject({ sessionId: "sess_existing", currentReopenCount: 2, channel: "web_public_link" })
  })

  it("documento bloqueado (lock ativo) → blocked, sem revelar existência", async () => {
    // injeta lock ativo por documento (hash correto derivado no módulo)
    const { docHashOf } = await import("@/lib/journey/public-rate-limit")
    db.chat_auth_generic_locks = [
      {
        company_id: CO,
        scope: "document",
        key_hash: docHashOf(VALID_CPF),
        locked_until: new Date(Date.now() + 30 * 60_000).toISOString(),
        reason: "nlink:document_rate",
      },
    ]
    // mesmo com dívida resolvível, o lock responde blocked (neutro).
    const r = await auth()
    expect(r).toEqual({ ok: false, reason: "blocked", message: BLOCKED })
  })
})
