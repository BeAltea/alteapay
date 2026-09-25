// D2 — CARD FIXO (C1/R-11), RECAP de retomada (C7/R-17/R-42), e C3 PRESERVANDO
// (thread_epoch, filtro do GET, R-08/R-09/R-40). Exercita as libs reais
// (buildPinnedDebt, buildRecap, resetStaleChatIfInactive) e a ROTA real
// GET /api/chat/messages com fake supabase + crypto real (cookie JWT).
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

process.env.CHAT_JOURNEY_ENABLED = "true"
process.env.NEGOTIATION_JWT_SECRET = "test-secret-d2-card"

const CO = "eeeeeeee-0000-0000-0000-0000000d2crd"
const SID = "sess-d2crd"
const CUST = "cust-d2crd"
const DEBT = "debt-d2crd"

let db: FakeDb
const events: Array<{ type: string; payload?: Record<string, unknown> }> = []

vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/journey/events", () => ({
  recordEvent: async (i: { type: string; payload?: Record<string, unknown> }) => {
    events.push({ type: i.type, payload: i.payload })
    return { ok: true, duplicate: false }
  },
  getTimeline: async () => [],
}))

function seed() {
  events.length = 0
  db = {
    tenant_chat_config: [{
      company_id: CO, acknowledgement_enabled: true, show_handoff_button: false,
      branding: { brand_name: "VMAX" },
    }],
    companies: [{ id: CO, name: "VMAX LTDA" }],
    customers: [{ id: CUST, company_id: CO, name: "Fabio Mendes", document: "11144477735" }],
    debts: [{ id: DEBT, company_id: CO, customer_id: CUST, status: "pending", amount: 250, due_date: "2020-01-01" }],
    vmax_invoices: [{ id_company: CO, doc: "11144477735", fatura: "F1", vencimento: "2020-01-10", saldo: 250 }],
    negotiation_sessions: [{
      id: SID, company_id: CO, customer_id: CUST, debt_id: DEBT,
      primary_debt_id: DEBT, debt_ids: [DEBT], thread_epoch: 0,
      wait_state: null, wait_started_at: null,
    }],
    chat_prompts: [],
    chat_messages: [],
    debt_acknowledgements: [],
    debt_acknowledgement_latest: [],
    agreements: [],
  }
}

function makeReq(cookie: string, since?: string) {
  const url = since
    ? `https://x.test/api/chat/messages?since=${encodeURIComponent(since)}`
    : "https://x.test/api/chat/messages"
  return {
    cookies: { get: (n: string) => (n === "alteapay_chat_session" ? { value: cookie } : undefined) },
    nextUrl: new URL(url),
  } as any
}

// ============================================================================
// CARD FIXO (C1 / R-11): buildPinnedDebt reusa buildAckContext (valor = valor
// cobrado) e o GET devolve pinned_debt a cada poll.
// ============================================================================
describe("CARD FIXO do débito (C1/R-11)", () => {
  beforeEach(seed)

  it("buildPinnedDebt monta credor/valor/vencimento/faturas da fonte canônica", async () => {
    const { buildPinnedDebt } = await import("@/lib/journey/pinned-debt")
    const card = await buildPinnedDebt(SID, CO)
    expect(card).toBeTruthy()
    expect(card!.creditor_name).toBe("VMAX")
    expect(card!.updated_value).toBe(250) // reais (buildAckContext soma debts.amount)
    expect(card!.oldest_due_date).toBe("2020-01-10") // vencimento da fatura mais antiga
    expect(card!.invoice_count).toBe(1)
  })

  it("GET /api/chat/messages devolve pinned_debt (sobrevive a reload — vem a cada poll)", async () => {
    const { GET } = await import("@/app/api/chat/messages/route")
    const { signChatJwt } = await import("@/lib/negotiation/crypto")
    const cookie = signChatJwt({ sid: SID, cid: CO }, 3600)
    const res = await GET(makeReq(cookie))
    const body = await res.json()
    expect(body.pinned_debt).toBeTruthy()
    expect(body.pinned_debt.creditor_name).toBe("VMAX")
    expect(body.pinned_debt.updated_value).toBe(250)
  })

  it("buildPinnedDebt sem dívida associada → null (degradação graciosa)", async () => {
    db.negotiation_sessions[0].debt_ids = []
    db.negotiation_sessions[0].primary_debt_id = null
    db.negotiation_sessions[0].debt_id = null
    const { buildPinnedDebt } = await import("@/lib/journey/pinned-debt")
    expect(await buildPinnedDebt(SID, CO)).toBeNull()
  })
})

// ============================================================================
// RECAP de retomada (C7 / R-17 / R-42): montado no servidor a partir das bolhas
// PRESERVADAS; label real do botão clicado (não genérico).
// ============================================================================
describe("RECAP de retomada (C7/R-17/R-42)", () => {
  beforeEach(seed)

  it("sem NENHUMA decisão (pós-login puro) → recap null (a UI mostra o menu)", async () => {
    db.chat_messages = [
      { id: "g1", session_id: SID, company_id: CO, role: "assistant", text: "Olá.", created_at: "2026-09-24T10:00:00Z" },
    ]
    const { buildRecap } = await import("@/lib/journey/recap")
    expect(await buildRecap(SID, CO)).toBeNull()
  })

  it("após decisão + link → state after_link, com label REAL do clique (R-42)", async () => {
    db.chat_messages = [
      { id: "g1", session_id: SID, company_id: CO, role: "assistant", text: "Olá.", created_at: "2026-09-24T10:00:00Z" },
      { id: "c1", session_id: SID, company_id: CO, role: "customer", text: "Quero pagar — R$ 250,00", button_id: 4, created_at: "2026-09-24T10:01:00Z" },
      { id: "o1", session_id: SID, company_id: CO, role: "assistant", text: "Seu link: https://asaas/checkout/pay_1", created_at: "2026-09-24T10:02:00Z" },
    ]
    const { buildRecap } = await import("@/lib/journey/recap")
    const recap = await buildRecap(SID, CO)
    expect(recap).toBeTruthy()
    expect(recap!.state).toBe("after_link")
    expect(recap!.lastDecisionLabel).toBe("Quero pagar — R$ 250,00") // label real, não genérico
  })

  it("wait_state='aguardando_motor' + decisão → state after_negotiate", async () => {
    db.negotiation_sessions[0].wait_state = "aguardando_motor"
    db.chat_messages = [
      { id: "c1", session_id: SID, company_id: CO, role: "customer", text: "Quero negociar", button_id: 1, created_at: "2026-09-24T10:01:00Z" },
    ]
    const { buildRecap } = await import("@/lib/journey/recap")
    const recap = await buildRecap(SID, CO)
    expect(recap!.state).toBe("after_negotiate")
  })

  it("wait_state='nao_reconhecida' → state after_not_recognized", async () => {
    db.negotiation_sessions[0].wait_state = "nao_reconhecida"
    db.chat_messages = [
      { id: "c1", session_id: SID, company_id: CO, role: "customer", text: "Não reconheço esta dívida", button_id: 0, created_at: "2026-09-24T10:01:00Z" },
    ]
    const { buildRecap } = await import("@/lib/journey/recap")
    const recap = await buildRecap(SID, CO)
    expect(recap!.state).toBe("after_not_recognized")
  })

  // Gate-do-integrador (achado MEDIO D1→D2): "Já paguei" NÃO seta wait_state, então
  // o recap detecta o desfecho pela BOLHA PRESERVADA do paymentClaimReply. Sem esta
  // detecção, quem retoma após "Já paguei" caía no recap genérico (after_decision).
  it("após 'Já paguei' (bolha preservada) → state after_payment_claim, mesmo sem wait_state", async () => {
    db.chat_messages = [
      { id: "c1", session_id: SID, company_id: CO, role: "customer", text: "Já paguei", button_id: 5, created_at: "2026-09-24T10:01:00Z" },
      { id: "a1", session_id: SID, company_id: CO, role: "assistant", text: "Registramos que você já pagou este valor. A nossa equipe vai conferir. Guarde o seu comprovante — ele pode ser pedido para dar baixa. Você não precisa fazer mais nada por aqui agora.", created_at: "2026-09-24T10:01:05Z" },
    ]
    const { buildRecap } = await import("@/lib/journey/recap")
    const recap = await buildRecap(SID, CO)
    expect(recap!.state).toBe("after_payment_claim")
    expect(recap!.lastDecisionLabel).toBe("Já paguei")
    // A3: o texto do recap é a saudação de retorno (Apêndice B), igual para todo
    // estado — o desfecho ("já paguei") é o outcome preservado acima do menu.
    expect(recap!.text).toBe("Olá de novo, Fabio. Você já viu os detalhes do valor em aberto. Como prefere seguir?")
  })

  // Precedência: "Já paguei" tem prioridade sobre um link entregue na mesma thread —
  // quem avisou que pagou deve retomar na conferência, não em "seu link está aqui".
  it("'Já paguei' após link → state after_payment_claim (precedência sobre after_link)", async () => {
    db.chat_messages = [
      { id: "c1", session_id: SID, company_id: CO, role: "customer", text: "Quero pagar — R$ 250,00", button_id: 4, created_at: "2026-09-24T10:00:00Z" },
      { id: "o1", session_id: SID, company_id: CO, role: "assistant", text: "Seu link: https://asaas/checkout/pay_1", created_at: "2026-09-24T10:00:30Z" },
      { id: "c2", session_id: SID, company_id: CO, role: "customer", text: "Já paguei", button_id: 5, created_at: "2026-09-24T10:02:00Z" },
      { id: "a2", session_id: SID, company_id: CO, role: "assistant", text: "Registramos que você já pagou este valor. A nossa equipe vai conferir.", created_at: "2026-09-24T10:02:05Z" },
    ]
    const { buildRecap } = await import("@/lib/journey/recap")
    const recap = await buildRecap(SID, CO)
    expect(recap!.state).toBe("after_payment_claim")
  })

  // resolveRecapState puro: precedência (nao_reconhecida > claim > link > negociar).
  it("resolveRecapState respeita a precedência: claim > link, nao_reconhecida > claim", async () => {
    const { resolveRecapState } = await import("@/lib/journey/recap")
    expect(resolveRecapState(null, true, true)).toBe("after_payment_claim") // claim > link
    expect(resolveRecapState("nao_reconhecida", false, true)).toBe("after_not_recognized") // nao_rec > claim
    expect(resolveRecapState(null, true, false)).toBe("after_link")
    expect(resolveRecapState("aguardando_motor", false, false)).toBe("after_negotiate")
  })

  it("GET com `since` (poll incremental) NÃO devolve recap; sem `since` (retomada) devolve", async () => {
    db.chat_messages = [
      { id: "c1", session_id: SID, company_id: CO, role: "customer", text: "Quero pagar — R$ 250,00", button_id: 4, created_at: "2026-09-24T10:01:00Z" },
    ]
    const { GET } = await import("@/app/api/chat/messages/route")
    const { signChatJwt } = await import("@/lib/negotiation/crypto")
    const cookie = signChatJwt({ sid: SID, cid: CO }, 3600)
    // 1º poll (sem since): recap presente
    const first = await (await GET(makeReq(cookie))).json()
    expect(first.recap).toBeTruthy()
    // poll incremental (com since): recap null (não repete)
    const inc = await (await GET(makeReq(cookie, "2026-09-24T10:00:00Z"))).json()
    expect(inc.recap).toBeNull()
  })
})

// ============================================================================
// C3 PRESERVANDO (thread_epoch): o GET filtra a época corrente; épocas antigas
// (arquivadas) ficam no banco mas fora da tela nova (R-08/R-40).
// ============================================================================
describe("C3 filtro de thread_epoch no GET (R-08/R-40)", () => {
  beforeEach(seed)

  it("após rotação: só as linhas da ÉPOCA CORRENTE aparecem; as velhas ficam no banco", async () => {
    // época velha (0), agora arquivada; época nova (1) com uma bolha nova
    db.negotiation_sessions[0].thread_epoch = 1
    db.chat_messages = [
      { id: "old1", session_id: SID, company_id: CO, role: "assistant", text: "conversa velha", thread_epoch: 0, archived_at: "2026-09-24T09:00:00Z", created_at: "2026-09-23T10:00:00Z" },
      { id: "new1", session_id: SID, company_id: CO, role: "assistant", text: "conversa nova", thread_epoch: 1, archived_at: null, created_at: "2026-09-24T10:00:00Z" },
    ]
    const { GET } = await import("@/app/api/chat/messages/route")
    const { signChatJwt } = await import("@/lib/negotiation/crypto")
    const cookie = signChatJwt({ sid: SID, cid: CO }, 3600)
    const body = await (await GET(makeReq(cookie))).json()
    const ids = body.messages.map((m: any) => m.id)
    expect(ids).toContain("new1")
    expect(ids).not.toContain("old1")
    // PRESERVAÇÃO: a linha velha continua no banco (o GET só não a mostra)
    expect(db.chat_messages.some((m) => m.id === "old1")).toBe(true)
  })

  it("compat: thread_epoch null (legado) aparece quando a sessão está na época 0", async () => {
    db.negotiation_sessions[0].thread_epoch = 0
    db.chat_messages = [
      { id: "legacy", session_id: SID, company_id: CO, role: "assistant", text: "sem época", created_at: "2026-09-24T10:00:00Z" },
    ]
    const { GET } = await import("@/app/api/chat/messages/route")
    const { signChatJwt } = await import("@/lib/negotiation/crypto")
    const cookie = signChatJwt({ sid: SID, cid: CO }, 3600)
    const body = await (await GET(makeReq(cookie))).json()
    expect(body.messages.map((m: any) => m.id)).toContain("legacy")
  })

  it("um prompt 'active' arquivado (época velha) NÃO vaza como active_prompt na thread nova", async () => {
    db.negotiation_sessions[0].thread_epoch = 1
    db.chat_prompts = [
      { id: "pold", session_id: SID, company_id: CO, kind: "debt_three_options", question: "?", buttons: [], status: "active", thread_epoch: 0, archived_at: "2026-09-24T09:00:00Z", created_at: "2026-09-23T10:00:00Z" },
    ]
    const { GET } = await import("@/app/api/chat/messages/route")
    const { signChatJwt } = await import("@/lib/negotiation/crypto")
    const cookie = signChatJwt({ sid: SID, cid: CO }, 3600)
    const body = await (await GET(makeReq(cookie))).json()
    expect(body.active_prompt).toBeNull()
  })
})

// ============================================================================
// C3 — inserts carimbam a época corrente (R-08): após rotação, uma bolha/prompt
// novo entra na época nova (não some na thread nova).
// ============================================================================
describe("C3 inserts na época corrente (R-08)", () => {
  beforeEach(seed)

  it("persistAssistantMessage grava thread_epoch da sessão (época > 0)", async () => {
    db.negotiation_sessions[0].thread_epoch = 2
    const { persistAssistantMessage } = await import("@/lib/journey/acknowledgement")
    await persistAssistantMessage({ companyId: CO, sessionId: SID, text: "nova bolha" })
    const msg = db.chat_messages.find((m) => m.text === "nova bolha")
    expect(msg).toBeTruthy()
    expect(msg!.thread_epoch).toBe(2)
  })

  it("createPrompt grava thread_epoch da sessão (época > 0)", async () => {
    db.negotiation_sessions[0].thread_epoch = 3
    const { createPrompt } = await import("@/lib/journey/prompts")
    const r = await createPrompt({
      companyId: CO, sessionId: SID, kind: "debt_three_options",
      question: "?", buttons: [{ id: 4, label: "Pagar", order: 0 }], createdBy: "platform",
    })
    expect(r.ok).toBe(true)
    const prompt = db.chat_prompts.find((p) => p.status === "active")
    expect(prompt!.thread_epoch).toBe(3)
  })

  it("época 0 (default): inserts NÃO incluem thread_epoch (compat pré-migration)", async () => {
    db.negotiation_sessions[0].thread_epoch = 0
    const { persistAssistantMessage } = await import("@/lib/journey/acknowledgement")
    await persistAssistantMessage({ companyId: CO, sessionId: SID, text: "bolha época 0" })
    const msg = db.chat_messages.find((m) => m.text === "bolha época 0")
    // não carimba (época 0 = comportamento de hoje; dispensa a coluna em prod)
    expect(msg!.thread_epoch).toBeUndefined()
  })
})
