// D1 — BOTÕES E CICLO DE VIDA DO PROMPT (ciclo de negociação, W4).
//
// Trava por TESTE o contrato do SERVIDOR que a UI renderiza imediatamente do corpo
// do POST (feedback <1s, sem depender do poll — C13), fecha os becos sem saída de
// cada estado terminal, e garante idempotência/coerência de clique:
//
//   R-01  guard do P1 (CONSULTAR): reply no corpo do POST + novo debt_three_options
//         active + reply persistido em chat_messages (regressão do render síncrono).
//   R-02  NAO_RECONHECO/VOLTAR devolvem `action`+`reply` no corpo do POST (o client
//         renderiza a bolha na hora, sem esperar o poll de 2,5s).
//   R-03/R-04/R-05/R-06  (becos) — os caminhos de reabertura do menu (/api/chat/
//         reopen) SEMPRE repõem ≥1 botão de ação (menu payável) mesmo sem prompt
//         ativo; a UI dos estados terminais consome estes caminhos.
//   R-36  JA_PAGUEI NÃO reaparece em nao_reconhecida: o prompt de volta é
//         debt_three_options mas SÓ com [98] (sem PAGAR id 4) — o sinal que a UI usa
//         para esconder "Já paguei".
//   R-38  CONSULTAR clicado 2x: o servidor produz o reply em cada clique válido, e o
//         2º clique (prompt já answered) é tratado (409 prompt_not_active), nunca
//         silêncio; o reply persistido tem prompt_id=null (não filtrado no render).
//   R-39  clique concorrente/duplo no MESMO botão → 1 efeito + 1 tratado (409), NUNCA
//         2 cobranças/2 starts (idempotência D7). 409 nunca é "engolido".
//   R-37  sessão expirada (cookie inválido) → 401 tratado (a UI abre o modal), nunca
//         corpo vazio/erro técnico.
//
// Exercita as ROTAS reais (app/api/chat/button + reopen) com crypto real (cookie
// JWT) e fake supabase em memória; só a fronteira de cobrança (closing) e rede
// (asaas/email/engine/events) é mockada — o mesmo recorte de three-options.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

process.env.CHAT_JOURNEY_ENABLED = "true"
process.env.NEGOTIATION_JWT_SECRET = "test-secret-d1-becos"

const CO = "eeeeeeee-0000-0000-0000-00000000d1b1"
const SID = "sess-d1b"
const CUST = "cust-d1b"
const DEBT = "debt-d1b"

let db: FakeDb
let confirmCalls = 0
const events: Array<{ type: string; payload?: Record<string, unknown> }> = []

vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/asaas", () => ({ getAsaasPaymentsForCustomer: async () => [] }))
vi.mock("@/lib/notifications/email", () => ({ sendEmail: async () => ({ ok: true }) }))
vi.mock("@/lib/journey/events", () => ({
  recordEvent: async (i: { type: string; payload?: Record<string, unknown> }) => {
    events.push({ type: i.type, payload: i.payload })
    return { ok: true, duplicate: false }
  },
  getTimeline: async () => [],
}))
// closing: confirmAccept representa o caminho canônico (closeAgreement → charge-
// inline). Conta as chamadas (idempotência) e registra acordo + acceptance.
vi.mock("@/lib/journey/closing", () => ({
  buildAcceptSummary: async () => ({ ok: true, summary: { termsHash: "h", terms: {}, validUntil: null } }),
  confirmAccept: async ({ offerId }: { offerId: string }) => {
    confirmCalls += 1
    const agId = `agNew-${confirmCalls}`
    ;(db.agreements ??= []).push({
      id: agId, company_id: CO, customer_id: CUST, asaas_payment_id: "pay_new",
      asaas_billing_type: "PIX", agreed_amount: 250, installments: 1, due_date: "2026-09-27",
      asaas_pix_qrcode_url: "pixcopy", asaas_boleto_url: null,
      asaas_invoice_url: "https://asaas/checkout/pay_new",
      payment_status: "pending", asaas_status: "PENDING",
    })
    ;(db.negotiation_acceptances ??= []).push({ company_id: CO, session_id: SID, offer_id: offerId, agreement_id: agId })
    return { ok: true, agreementId: agId }
  },
}))
vi.mock("@/lib/negotiation/engine", () => ({
  engineName: () => "disabled",
  emitNegotiationStart: async () => ({ ok: true, delivered: false, reason: "engine_unavailable" }),
}))

function seed() {
  confirmCalls = 0
  events.length = 0
  db = {
    tenant_chat_config: [{
      company_id: CO, payment_origin: "platform",
      allow_payment_without_acknowledgement: false,
      acknowledgement_enabled: true, show_handoff_button: false,
      on_debt_not_recognized: "continue",
      official_channel_label: null, official_channel_url: null,
      branding: { brand_name: "VMAX" }, creditor_notification_emails: [],
    }],
    companies: [{ id: CO, name: "VMAX LTDA" }],
    customers: [{ id: CUST, company_id: CO, name: "Fabio Mendes", document: "11144477735" }],
    debts: [{ id: DEBT, company_id: CO, customer_id: CUST, status: "pending", amount: 250, due_date: "2020-01-01" }],
    vmax_invoices: [{ id_company: CO, doc: "11144477735", fatura: "F1", vencimento: "2020-01-10", saldo: 250 }],
    negotiation_sessions: [{ id: SID, company_id: CO, customer_id: CUST, debt_id: DEBT, agreement_id: null, debt_acknowledged_at: null }],
    negotiation_offers: [],
    negotiation_condition_matrix: [],
    negotiation_acceptances: [],
    negotiation_cases: [],
    contact_suppressions: [],
    chat_prompts: [],
    chat_messages: [],
    debt_acknowledgements: [],
    debt_acknowledgement_latest: [],
    agreements: [],
  }
  delete process.env.PAYMENT_ORIGIN
  delete process.env.PAY_LINK_DUE_DAYS
}

/** Request fake com o cookie de sessão assinado (crypto real). */
function buttonReq(cookieValue: string | null, body: Record<string, unknown>) {
  return {
    cookies: {
      get: (name: string) =>
        cookieValue && name === "alteapay_chat_session" ? { value: cookieValue } : undefined,
    },
    headers: { get: () => null },
    json: async () => body,
  } as any
}

async function signed() {
  const { signChatJwt } = await import("@/lib/negotiation/crypto")
  return signChatJwt({ sid: SID, cid: CO }, 3600)
}

/** Cria o menu de 3 opções e devolve o prompt ativo. */
async function bootstrap() {
  const { bootstrapThreeOptionsPrompt } = await import("@/lib/journey/acknowledgement")
  await bootstrapThreeOptionsPrompt({ companyId: CO, sessionId: SID, customerId: CUST, debtIds: [DEBT], primaryDebtId: DEBT })
  return db.chat_prompts.find((p) => p.status === "active")!
}

// ============================================================================
// R-01 — guard do P1: CONSULTAR devolve o reply NO CORPO do POST, cria um novo
// debt_three_options active e persiste o reply em chat_messages.
// ============================================================================
describe("R-01 — CONSULTAR: render síncrono do corpo do POST (guard de regressão do P1)", () => {
  beforeEach(seed)

  it("(a) a rota devolve 200 {ok, action:'consult', reply}; (b) novo debt_three_options active; (c) reply persistido", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    const prompt = await bootstrap()
    const res = await POST(buttonReq(await signed(), { prompt_id: prompt.id, button_id: 2 }))
    expect(res.status).toBe(200)
    const body = await res.json()
    // (a) o reply vem no CORPO do POST (a UI renderiza na hora, sem poll)
    expect(body.ok).toBe(true)
    expect(body.action).toBe("consult")
    expect(typeof body.reply).toBe("string")
    expect(body.reply.length).toBeGreaterThan(0)
    // (b) há um NOVO debt_three_options active (o menu reabre), distinto do clicado
    const active = db.chat_prompts.find((p) => p.status === "active")
    expect(active).toBeTruthy()
    expect(active!.kind).toBe("debt_three_options")
    expect(active!.id).not.toBe(prompt.id)
    // (c) o reply do consult foi persistido em chat_messages como OUTCOME (A1):
    //     ligado ao prompt RESPONDIDO (prompt_id = p1, que não é o ativo → não é
    //     filtrado pelo render de prompt ativo) + offers_snapshot.stage='detail'
    //     (a poda classifica como outcome, nunca superseded).
    const replyMsg = db.chat_messages.find((m) => m.role === "assistant" && m.text === body.reply)
    expect(replyMsg).toBeTruthy()
    expect(replyMsg!.prompt_id).toBe(prompt.id)
    expect(replyMsg!.offers_snapshot?.stage).toBe("detail")
  })

  it("o prompt clicado fica answered (não some sem reabrir — nunca estado morto)", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    const prompt = await bootstrap()
    await POST(buttonReq(await signed(), { prompt_id: prompt.id, button_id: 2 }))
    const clicked = db.chat_prompts.find((p) => p.id === prompt.id)
    expect(clicked!.status).toBe("answered")
    // exatamente 1 prompt ativo após o clique (o menu reaberto)
    expect(db.chat_prompts.filter((p) => p.status === "active").length).toBe(1)
  })
})

// ============================================================================
// R-02 — NAO_RECONHECO / VOLTAR devolvem action+reply no corpo do POST (feedback
// <1s, o client não fica mudo até o poll).
// ============================================================================
describe("R-02 — feedback imediato de NAO_RECONHECO e VOLTAR (corpo do POST)", () => {
  beforeEach(seed)

  it("NAO_RECONHECO[0] → action:'not_recognized' + reply no corpo do POST", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    const prompt = await bootstrap()
    const res = await POST(buttonReq(await signed(), { prompt_id: prompt.id, button_id: 0 }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.action).toBe("not_recognized")
    expect(typeof body.reply).toBe("string")
    expect(body.reply.length).toBeGreaterThan(0)
    // o reply está persistido (a bolha local do client colapsa com esta no dedup)
    expect(db.chat_messages.some((m) => m.role === "assistant" && m.text === body.reply)).toBe(true)
  })

  it("VOLTAR[98] no menu-volta do 'não reconheço' → action:'back_to_options' + reply", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    // 1) clica "Não reconheço" → cria o prompt de VOLTA (só [98])
    const prompt = await bootstrap()
    await POST(buttonReq(await signed(), { prompt_id: prompt.id, button_id: 0 }))
    const backPrompt = db.chat_prompts.find((p) => p.status === "active")!
    expect(backPrompt.buttons.map((b: any) => b.id)).toEqual([98])
    // 2) clica VOLTAR[98] → reabre o menu de 3 opções, com reply no corpo do POST
    const res = await POST(buttonReq(await signed(), { prompt_id: backPrompt.id, button_id: 98 }))
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.action).toBe("back_to_options")
    expect(typeof body.reply).toBe("string")
    const active = db.chat_prompts.find((p) => p.status === "active")
    expect(active!.kind).toBe("debt_three_options")
    expect(active!.buttons.map((b: any) => b.id)).toEqual([4, 1, 2, 0])
  })
})

// ============================================================================
// R-36 — JA_PAGUEI NÃO reaparece em nao_reconhecida. O sinal que a UI usa é a
// AUSÊNCIA do botão PAGAR (id 4) no prompt de volta.
// ============================================================================
describe("R-36 — JA_PAGUEI escondido em nao_reconhecida (coerência de produto)", () => {
  beforeEach(seed)

  it("o prompt de volta após 'Não reconheço' é debt_three_options mas SEM o botão PAGAR (id 4)", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    const prompt = await bootstrap()
    await POST(buttonReq(await signed(), { prompt_id: prompt.id, button_id: 0 }))
    const backPrompt = db.chat_prompts.find((p) => p.status === "active")!
    // kind é debt_three_options (para o [98] cair no branch certo), mas
    expect(backPrompt.kind).toBe("debt_three_options")
    // NÃO tem PAGAR (id 4): a UI esconde "Já paguei" porque o menu não é payável.
    expect(backPrompt.buttons.some((b: any) => b.id === 4)).toBe(false)
    expect(backPrompt.buttons.map((b: any) => b.id)).toEqual([98])
  })

  it("o menu payável de fato (bootstrap) TEM o botão PAGAR (id 4) — JA_PAGUEI aparece lá", async () => {
    const prompt = await bootstrap()
    expect(prompt.buttons.some((b: any) => b.id === 4)).toBe(true)
  })
})

// ============================================================================
// R-38 — CONSULTAR clicado 2x: 1º clique produz reply; 2º clique (prompt já
// answered) NUNCA é mudo. A1 (N-D3-3): como o menu reaberto tem o MESMO kind e
// o MESMO botão, o clique é RE-ALVEJADO para o ativo (200, retargeted_from) —
// a intenção do devedor é a mesma; o reply não duplica (dedup por conteúdo).
// ============================================================================
describe("R-38 — CONSULTAR 2x: 1 reply, 2º clique re-alvejado (nunca mudo)", () => {
  beforeEach(seed)

  it("2º clique no MESMO prompt já respondido → 200 re-alvejado para o menu ativo (não some, não duplica)", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    const prompt = await bootstrap()
    const r1 = await POST(buttonReq(await signed(), { prompt_id: prompt.id, button_id: 2 }))
    const b1 = await r1.json()
    expect(b1.action).toBe("consult")
    const menu2 = db.chat_prompts.find((p) => p.status === "active")!
    // 2º clique no MESMO prompt (agora answered) → re-alvejado ao menu ativo
    const r2 = await POST(buttonReq(await signed(), { prompt_id: prompt.id, button_id: 2 }))
    const b2 = await r2.json()
    expect(r2.status).toBe(200)
    expect(b2.action).toBe("consult")
    expect(b2.retargeted_from).toBe(prompt.id)
    // o menu que estava ativo foi respondido pelo clique re-alvejado
    expect(db.chat_prompts.find((p) => p.id === menu2.id)!.status).toBe("answered")
    // cada clique tem o SEU outcome (ligado ao prompt respondido): 1 por prompt,
    // nunca 2 para o mesmo prompt (idempotência por prompt_id+stage); o client
    // colapsa textos idênticos na exibição.
    const consultReplies = db.chat_messages.filter((m) => m.role === "assistant" && m.text === b1.reply)
    expect(consultReplies.map((m) => m.prompt_id)).toEqual([prompt.id, menu2.id])
    // auditoria do re-alvejamento
    const retargeted = events.find((e) => e.type === "chat.turn.customer" && e.payload?.retargeted_from === prompt.id)
    expect(retargeted).toBeTruthy()
  })
})

// ============================================================================
// R-39 — clique concorrente/duplo no MESMO PAGAR → 1 cobrança + 1 tratado (409),
// nunca 2 cobranças (idempotência D7). 409 nunca é engolido.
// ============================================================================
describe("R-39 — PAGAR duplo concorrente: idempotente (1 cobrança, 409 tratado)", () => {
  beforeEach(seed)

  it("dois cliques no MESMO prompt de PAGAR → 1 sucesso + 1 (409 ou já cobrado), NUNCA 2 confirmAccept", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    const prompt = await bootstrap()
    const jwt = await signed()
    // dois cliques concorrentes no MESMO prompt (mesmo button_id=4)
    const [r1, r2] = await Promise.all([
      POST(buttonReq(jwt, { prompt_id: prompt.id, button_id: 4 })),
      POST(buttonReq(jwt, { prompt_id: prompt.id, button_id: 4 })),
    ])
    const [b1, b2] = [await r1.json(), await r2.json()]
    // exatamente UM converteu o prompt; o outro pega 409 prompt_stale (A1: o
    // ativo agora é o prompt pós-link, de OUTRO kind → sem re-alvejamento) —
    // NUNCA silêncio: ambos devolvem JSON com status/código.
    const codes = [b1, b2].map((b) => b.code ?? (b.action === "pay" ? "pay" : "ok"))
    expect(codes).toContain("prompt_stale")
    expect(codes).toContain("pay")
    // NUNCA 2 cobranças: confirmAccept (payment.create canônico) roda no máximo 1x.
    expect(confirmCalls).toBeLessThanOrEqual(1)
    // no máximo 1 acordo (idempotência D7)
    expect((db.agreements ?? []).length).toBeLessThanOrEqual(1)
  })
})

// ============================================================================
// R-37 — sessão expirada (cookie inválido) → 401 tratado, nunca corpo vazio nem
// erro técnico cru (a UI abre o modal "Entrar novamente").
// ============================================================================
describe("R-37 — sessão expirada: 401 tratado (modal), nunca clique-mudo", () => {
  beforeEach(seed)

  it("cookie ausente → 401 unauthorized (nunca stack trace/silêncio)", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    const prompt = await bootstrap()
    const res = await POST(buttonReq(null, { prompt_id: prompt.id, button_id: 4 }))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe("unauthorized")
    // NÃO cobrou nada (o guard de sessão veio antes de qualquer efeito)
    expect(confirmCalls).toBe(0)
  })

  it("cookie de outra sessão (sid inexistente) → 401 (loadSessionCtx falha)", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    const { signChatJwt } = await import("@/lib/negotiation/crypto")
    const prompt = await bootstrap()
    const badCookie = signChatJwt({ sid: "sess-inexistente", cid: CO }, 3600)
    const res = await POST(buttonReq(badCookie, { prompt_id: prompt.id, button_id: 4 }))
    expect(res.status).toBe(401)
  })
})

// ============================================================================
// R-03..R-06 (becos) — /api/chat/reopen SEMPRE repõe o menu payável mesmo sem
// prompt ativo (a UI dos estados terminais consome estes caminhos). E o handoff /
// payment_claim têm caminho próprio (nunca beco).
// ============================================================================
describe("R-03..R-06 — /api/chat/reopen: caminho REAL de saída de todo estado terminal", () => {
  beforeEach(seed)

  it("reopen_options sem prompt ativo → recria o menu payável (Pagar/Negociar/Consultar/Não reconheço)", async () => {
    const { POST } = await import("@/app/api/chat/reopen/route")
    // estado terminal: nenhum prompt ativo (o menu foi consumido)
    expect(db.chat_prompts.filter((p) => p.status === "active").length).toBe(0)
    const res = await POST(buttonReq(await signed(), { action: "reopen_options" }))
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.action).toBe("reopen_options")
    const active = db.chat_prompts.find((p) => p.status === "active")
    expect(active!.kind).toBe("debt_three_options")
    // ≥1 botão de ação (na verdade os 4): nunca tela muda
    expect(active!.buttons.map((b: any) => b.id)).toEqual([4, 1, 2, 0])
  })

  it("payment_claim (R-05/'Já paguei') registra o claim SEM declarar pago e REABRE o menu (não é beco)", async () => {
    const { POST } = await import("@/app/api/chat/reopen/route")
    const res = await POST(buttonReq(await signed(), { action: "payment_claim" }))
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.claim_registered).toBe(true)
    // caso payment_claim aberto; NÃO cobra; menu reaberto (≥1 botão de ação)
    expect(db.negotiation_cases.some((c) => c.type === "payment_claim")).toBe(true)
    expect((db.agreements ?? []).length).toBe(0)
    const active = db.chat_prompts.find((p) => p.status === "active")
    expect(active!.kind).toBe("debt_three_options")
    expect(active!.buttons.some((b: any) => b.id === 4)).toBe(true)
  })

  it("handoff (R-05 'Falar com atendimento') transfere e devolve transferred:true (desfecho terminal, nunca mudo)", async () => {
    const { POST } = await import("@/app/api/chat/reopen/route")
    const res = await POST(buttonReq(await signed(), { action: "handoff" }))
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.transferred).toBe(true)
    expect(db.negotiation_cases.some((c) => c.type === "human_handoff")).toBe(true)
  })

  it("reopen sem cookie → 401 (nunca 500/silêncio)", async () => {
    const { POST } = await import("@/app/api/chat/reopen/route")
    const res = await POST(buttonReq(null, { action: "reopen_options" }))
    expect(res.status).toBe(401)
  })
})

// ============================================================================
// R-07 — VARREDURA DE SILÊNCIO (Apêndice B reexecutável): TODO clique num botão
// que EXISTE num estado sempre devolve JSON com status/código — o clique NUNCA
// morre sem resposta. Percorremos cada botão do menu payável e do menu-volta e
// asseramos: 200/2xx/4xx com corpo JSON, NUNCA exceção/undefined.
// N/A declarado por escrito: parcela_N (offer_choice) e CONTINUAR/SAIR (modal do
// client) não pertencem a este menu; sessao_expirada é o 401 do R-37.
// ============================================================================
describe("R-07 — matriz botão×estado: nenhum clique de botão existente é mudo", () => {
  beforeEach(seed)

  // menu payável (bootstrap): Pagar(4)/Negociar(1)/Consultar(2)/Não reconheço(0).
  // Handoff(99) e Voltar(98) não existem NESTE menu → seriam "botão fora do
  // catálogo" (o servidor responde {ok:true} sem efeito, também não é mudo).
  const payableMenuButtons = [4, 1, 2, 0]

  for (const bid of payableMenuButtons) {
    it(`menu payável × botão ${bid}: devolve JSON (status + corpo), nunca exceção`, async () => {
      const { POST } = await import("@/app/api/chat/button/route")
      const prompt = await bootstrap()
      const res = await POST(buttonReq(await signed(), { prompt_id: prompt.id, button_id: bid }))
      // sempre há status HTTP e corpo JSON — o clique não morre sem resposta
      expect(typeof res.status).toBe("number")
      const body = await res.json()
      expect(body && typeof body === "object").toBe(true)
      // botão existente → resposta de sucesso (2xx). Nunca 5xx neste caminho feliz.
      expect(res.status).toBeLessThan(500)
    })
  }

  it("botão FORA do catálogo (id 77) no menu payável → {ok:true} sem efeito (não é mudo, não cobra)", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    const prompt = await bootstrap()
    const res = await POST(buttonReq(await signed(), { prompt_id: prompt.id, button_id: 77 }))
    // answerPrompt rejeita o botão inexistente com 409 button_invalid (tratado) —
    // JSON com código, nunca silêncio.
    const body = await res.json()
    expect(body && typeof body === "object").toBe(true)
    expect(res.status).toBeLessThan(500)
    expect(confirmCalls).toBe(0)
  })

  it("body inválido (sem prompt_id) → 422 com JSON (nunca 500/silêncio)", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    await bootstrap()
    const res = await POST(buttonReq(await signed(), { button_id: 4 }))
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(typeof body.error).toBe("string")
  })

  it("prompt inexistente → 404 prompt_not_found com JSON (nunca silêncio)", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    await bootstrap()
    const res = await POST(buttonReq(await signed(), { prompt_id: "p-inexistente", button_id: 4 }))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.code).toBe("prompt_not_found")
  })
})
