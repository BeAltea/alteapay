// N7: autenticação genérica. Resposta uniforme (inexistente/sem-dívida/bloqueado
// = mesma mensagem); locks IP e documento INDEPENDENTES; consent obrigatório;
// captcha atrás de flag; documento inválido recusado; sucesso emite cookie.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

const CO = "dddddddd-0000-0000-0000-000000000004"

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
  // por padrão NÃO há sessão reutilizável → cai no caminho de criação (asserções
  // existentes). O teste de reuso liga um valor não-nulo abaixo.
  findReusableOpenSession: async () => reusableResult,
  reopenSession: async (input: any) => {
    reopenCalls.push(input)
    const sess = db.negotiation_sessions?.find((s) => s.id === input.sessionId)
    if (sess) {
      sess.last_activity_at = new Date().toISOString()
      sess.reopen_count = input.currentReopenCount + 1
      sess.channel = input.channel
    }
  },
}))
vi.mock("@/lib/journey/events", () => ({ recordEvent: async () => ({ ok: true, duplicate: false }) }))
vi.mock("@/lib/negotiation/crypto", () => ({
  signChatJwt: () => "signed.jwt.token",
  CHAT_COOKIE_NAME: "alteapay_chat_session",
}))

const VALID_CPF = "11144477735"

function reset() {
  db = {
    tenant_chat_config: [{ company_id: CO, auth_max_attempts: 3, auth_lock_minutes: 30, session_ttl_minutes: 60 }],
    // createHandoffSession é mockado; a linha existe para o update pós-sucesso.
    negotiation_sessions: [{ id: "sess_new", company_id: CO }],
  }
  resolveResult = {
    kind: "open",
    debtor: {
      customerId: "cust1", customerName: "Fabio", document: VALID_CPF,
      debtIds: ["d1"], primaryDebtId: "d1", totalOpen: 100, agingDays: 30, invoiceCount: 1, oldestDueDate: "2020-01-01",
    },
  }
  reusableResult = null
  reopenCalls.length = 0
  process.env.CHAT_CAPTCHA_ENABLED = "false"
  delete process.env.CHAT_AUTH_IP_MAX_ATTEMPTS
  delete process.env.CHAT_AUTH_IP_WINDOW_MIN
}

async function auth(over: Partial<Parameters<typeof import("@/lib/journey/generic-auth").authenticateByDocument>[0]> = {}) {
  const { authenticateByDocument } = await import("@/lib/journey/generic-auth")
  return authenticateByDocument({
    companyId: CO, document: VALID_CPF, consent: true, ip: "1.2.3.4",
    userAgent: "test", captchaToken: null, channel: "web_generic", ...over,
  })
}

describe("authenticateByDocument", () => {
  beforeEach(reset)

  it("sucesso: resolve, cria sessão, emite cookie e grava colunas da onda", async () => {
    const r = await auth()
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.cookieValue).toBe("signed.jwt.token")
      expect(r.sessionId).toBe("sess_new")
    }
    // sessão atualizada com debt_ids/primary/channel/status
    const sess = db.negotiation_sessions?.find((s) => s.id === "sess_new")
    expect(sess?.channel).toBe("web_generic")
    expect(sess?.status).toBe("open")
    expect(sess?.primary_debt_id).toBe("d1")
    // atento: NUNCA grava o documento em claro na attempt
    const okAttempt = db.chat_auth_generic_attempts?.find((a) => a.success)
    expect(okAttempt?.doc_hash).toHaveLength(64)
    expect(JSON.stringify(okAttempt)).not.toContain(VALID_CPF)
  })

  const UNIFORM = "Não foi possível confirmar seus dados. Verifique e tente novamente."

  it("resposta uniforme: inexistente e sem-dívida devolvem a MESMA mensagem", async () => {
    resolveResult = { kind: "none" }
    const r = await auth()
    expect(r).toEqual({ ok: false, message: UNIFORM })
  })

  it("resposta uniforme: documento inválido devolve a MESMA mensagem", async () => {
    const r = await auth({ document: "11144477736" }) // DV errado
    expect(r).toEqual({ ok: false, message: UNIFORM })
  })

  it("consent obrigatório", async () => {
    const r = await auth({ consent: false })
    expect(r).toEqual({ ok: false, message: UNIFORM })
  })

  it("lock por DOCUMENTO após max tentativas (independente do IP)", async () => {
    resolveResult = { kind: "none" }
    // 3 falhas do mesmo doc em IPs diferentes → lock por documento
    await auth({ ip: "9.9.9.1" })
    await auth({ ip: "9.9.9.2" })
    await auth({ ip: "9.9.9.3" })
    const docLock = db.chat_auth_generic_locks?.find((l) => l.scope === "document")
    expect(docLock).toBeTruthy()
    // agora mesmo com dados válidos e IP novo, o documento bloqueado responde uniforme
    resolveResult = { kind: "open", debtor: { customerId: "c", customerName: "x", document: VALID_CPF, debtIds: ["d1"], primaryDebtId: "d1", totalOpen: 1, agingDays: 1, invoiceCount: 1, oldestDueDate: null } }
    const r = await auth({ ip: "9.9.9.9" })
    expect(r).toEqual({ ok: false, message: UNIFORM })
  })

  it("lock por IP após max tentativas (independente do documento) — só com AUTH_IP_LOCK_ENABLED=true", async () => {
    // QA rodada 6 (Q1r2-5): a dimensão IP do lock é telemetria por padrão; este
    // teste cobre o caminho religado explicitamente.
    process.env.AUTH_IP_LOCK_ENABLED = "true"
    try {
      process.env.CHAT_AUTH_IP_MAX_ATTEMPTS = "3"
      resolveResult = { kind: "none" }
      // 3 falhas do mesmo IP com documentos válidos diferentes
      await auth({ document: "11144477735", ip: "5.5.5.5" })
      await auth({ document: "52998224725", ip: "5.5.5.5" })
      await auth({ document: "11444777000161", ip: "5.5.5.5" })
      const ipLock = db.chat_auth_generic_locks?.find((l) => l.scope === "ip")
      expect(ipLock).toBeTruthy()
    } finally {
      delete process.env.AUTH_IP_LOCK_ENABLED
    }
  })

  it("captcha desligado por padrão não bloqueia", async () => {
    const r = await auth({ captchaToken: null })
    expect(r.ok).toBe(true)
  })

  // --- A1.1 reuso de sessão ---------------------------------------------------

  it("reuso: 2ª auth do MESMO cliente dentro do TTL reusa o session_id (sem criar nova)", async () => {
    // simula uma sessão aberta e recente do mesmo (company, customer)
    reusableResult = {
      id: "sess_existing",
      status: "open",
      last_activity_at: new Date().toISOString(),
      reopen_count: 0,
    }
    db.negotiation_sessions = [{ id: "sess_existing", company_id: CO, status: "open", reopen_count: 0 }]

    const r = await auth()
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.sessionId).toBe("sess_existing") // MESMO id, não "sess_new"
    // reabriu (bump), não criou
    expect(reopenCalls.length).toBe(1)
    expect(reopenCalls[0]).toMatchObject({ sessionId: "sess_existing", currentReopenCount: 0 })
    const sess = db.negotiation_sessions?.find((s) => s.id === "sess_existing")
    expect(sess?.reopen_count).toBe(1) // incrementado
  })

  it("sem sessão reutilizável (fora do TTL / fechada) → cria nova", async () => {
    reusableResult = null // findReusableOpenSession não achou candidata dentro do TTL
    const r = await auth()
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.sessionId).toBe("sess_new")
    expect(reopenCalls.length).toBe(0)
  })

  it("cliente DIFERENTE → nova sessão (não reusa a de outro devedor)", async () => {
    // findReusableOpenSession filtra por customer_id; para outro cliente devolve null
    reusableResult = null
    resolveResult = {
      kind: "open",
      debtor: {
        customerId: "cust2", customerName: "Outro", document: VALID_CPF,
        debtIds: ["d9"], primaryDebtId: "d9", totalOpen: 50, agingDays: 10, invoiceCount: 1, oldestDueDate: null,
      },
    }
    const r = await auth()
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.sessionId).toBe("sess_new")
    expect(reopenCalls.length).toBe(0)
  })
})
