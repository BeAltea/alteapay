// Onda "3 opções" — trilha D1 (§6.1/§6.2/M2–M7). Menu pós-login Pagar › Negociar
// › Não reconheço; reconhecimento IMPLÍCITO (mode='implicit') ao Pagar/Negociar;
// encaminhamento ao cedente com FALLBACK SEGURO (nunca vazio/"null"/GNLink) e
// volta às opções. Exercita as bibliotecas reais com fake supabase em memória; só
// a fronteira de cobrança (closing/confirmAccept + lib/asaas) é mockada.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

process.env.CHAT_JOURNEY_ENABLED = "true"

const CO = "eeeeeeee-0000-0000-0000-0000000003op"
const SID = "sess-3op"
const CUST = "cust-3op"
const DEBT = "debt-3op"
const ctx = { sessionId: SID, companyId: CO, customerId: CUST, debtId: DEBT }

let db: FakeDb
let confirmCalls = 0
const events: Array<{ type: string; payload?: Record<string, unknown> }> = []

vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/asaas", () => ({ getAsaasPaymentsForCustomer: async () => [] }))
vi.mock("@/lib/journey/events", () => ({
  recordEvent: async (i: { type: string; payload?: Record<string, unknown> }) => {
    events.push({ type: i.type, payload: i.payload })
    return { ok: true, duplicate: false }
  },
  getTimeline: async () => [],
}))
// closing mock: confirmAccept representa o caminho canônico (closeAgreement →
// charge-inline). Registra acordo + acceptance como o real faria (idempotência).
vi.mock("@/lib/journey/closing", () => ({
  buildAcceptSummary: async () => ({ ok: true, summary: { termsHash: "h", terms: {}, validUntil: null } }),
  confirmAccept: async ({ offerId }: { offerId: string }) => {
    confirmCalls += 1
    const agId = "agNew"
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
// negotiation.start: não queremos disparar rede nos testes do NEGOCIAR.
vi.mock("@/lib/negotiation/engine", () => ({
  engineName: () => "disabled",
  emitNegotiationStart: async () => ({ ok: true, delivered: false, reason: "engine_unavailable" }),
}))

const MATRIX = {
  id: "mx-1", company_id: CO, name: "default", priority: 1, active: true,
  valid_from: null, valid_to: null, aging_min_days: 0, aging_max_days: null,
  aging_basis: "oldest_due", max_discount_pct: 30, installment_discount_pct: 10,
  min_entry_pct: 20, max_installments: 3, min_installment_value: 10,
  allowed_billing_types: ["PIX", "BOLETO"], proposal_validity_days: 7,
  retry_after_days: 3, max_retries: 2, min_debt_value: 0,
}

/** Recalcula a "view" debt_acknowledgement_latest a partir do append-log. */
function refreshView() {
  const rows = db.debt_acknowledgements ?? []
  const latest = new Map<string, any>()
  for (const r of rows) {
    const key = `${r.session_id}|${r.debt_id}`
    const cur = latest.get(key)
    if (!cur || r.created_at >= cur.created_at) latest.set(key, r)
  }
  db.debt_acknowledgement_latest = [...latest.values()]
}

function seed(opts: { channelLabel?: string | null; channelUrl?: string | null; allowNoAck?: boolean } = {}) {
  confirmCalls = 0
  events.length = 0
  db = {
    tenant_chat_config: [{
      company_id: CO, payment_origin: "platform",
      allow_payment_without_acknowledgement: opts.allowNoAck ?? false,
      acknowledgement_enabled: true, show_handoff_button: false,
      on_debt_not_recognized: "continue",
      official_channel_label: opts.channelLabel ?? null,
      official_channel_url: opts.channelUrl ?? null,
      branding: { brand_name: "VMAX" },
    }],
    companies: [{ id: CO, name: "VMAX LTDA" }],
    customers: [{ id: CUST, company_id: CO, name: "Fabio Mendes", document: "11144477735" }],
    debts: [{ id: DEBT, company_id: CO, customer_id: CUST, status: "pending", amount: 250, due_date: "2020-01-01" }],
    vmax_invoices: [{ id_company: CO, doc: "11144477735", fatura: "F1", vencimento: "2020-01-10", saldo: 250 }],
    negotiation_sessions: [{ id: SID, company_id: CO, customer_id: CUST, debt_id: DEBT, agreement_id: null, debt_acknowledged_at: null }],
    negotiation_offers: [],
    negotiation_condition_matrix: [MATRIX],
    negotiation_acceptances: [],
    chat_prompts: [],
    chat_messages: [],
    debt_acknowledgements: [],
    debt_acknowledgement_latest: [],
    agreements: [],
  }
  delete process.env.PAYMENT_ORIGIN
  delete process.env.PAY_LINK_DUE_DAYS
}

// ============================================================================
// (a) bootstrap do menu pós-login: 3 botões na ordem Pagar(4)/Negociar(1)/Não
//     reconheço(0) + mensagem-resumo com valor/vencimento, sem clique.
// ============================================================================
describe("bootstrap do menu de 3 opções (§6.1)", () => {
  beforeEach(() => seed())

  it("cria prompt debt_three_options com 4 botões na ordem Pagar→Negociar→Consultar→Não reconheço", async () => {
    const { bootstrapThreeOptionsPrompt } = await import("@/lib/journey/acknowledgement")
    const r = await bootstrapThreeOptionsPrompt({ companyId: CO, sessionId: SID, customerId: CUST, debtIds: [DEBT], primaryDebtId: DEBT })
    expect(r.ok && r.created).toBe(true)
    const prompt = db.chat_prompts[0]
    expect(prompt.kind).toBe("debt_three_options")
    // ordem contratual (Pagar › Negociar › Consultar › Não reconheço) — NÃO a ordem dos ids
    expect(prompt.buttons.map((b: any) => b.id)).toEqual([4, 1, 2, 0])
    // rótulo do Pagar carrega o valor canônico (M3) — R$ 250,00
    expect(prompt.buttons[0].label).toContain("Quero pagar")
    expect(prompt.buttons[0].label).toContain("250")
    expect(prompt.buttons[1].label).toBe("Quero negociar")
    expect(prompt.buttons[2].label).toBe("Consultar dívida")
    expect(prompt.buttons[3].label).toBe("Não reconheço esta dívida")
  })

  it("a mensagem-resumo (T1/R-24) identifica cedente+AlteaPay, SEM valor e SEM 'desconsiderar'", async () => {
    const { bootstrapThreeOptionsPrompt } = await import("@/lib/journey/acknowledgement")
    await bootstrapThreeOptionsPrompt({ companyId: CO, sessionId: SID, customerId: CUST, debtIds: [DEBT], primaryDebtId: DEBT })
    const msg = db.chat_messages.find((m) => m.role === "assistant")
    expect(msg).toBeTruthy()
    expect(msg!.text).toContain("VMAX")
    // T1 (carta de voz §10.2): AlteaPay identificada como operadora do canal.
    expect(msg!.text).toContain("AlteaPay")
    // R-12: o VALOR sai da fala (mora no card fixo e no rótulo do botão PAGAR).
    expect(msg!.text).not.toContain("R$")
    // R-25/C10: NADA de "se já pagou desconsidere" na abertura (virou o botão "Já paguei").
    expect(msg!.text).not.toContain("desconsiderar")
    expect(msg!.text).not.toContain("desconsidere")
    // R-24: sem alegria forçada (emoji / "Tudo bem?").
    expect(msg!.text).not.toContain("🙂")
    expect(msg!.text).not.toContain("Tudo bem?")
    // reconhecimento NÃO é gravado no bootstrap (só apresenta)
    expect((db.debt_acknowledgements ?? []).length).toBe(0)
  })

  it("idempotente: com prompt ATIVO não recria (reload não duplica o menu)", async () => {
    const { bootstrapThreeOptionsPrompt } = await import("@/lib/journey/acknowledgement")
    await bootstrapThreeOptionsPrompt({ companyId: CO, sessionId: SID, customerId: CUST, debtIds: [DEBT], primaryDebtId: DEBT })
    const r2 = await bootstrapThreeOptionsPrompt({ companyId: CO, sessionId: SID, customerId: CUST, debtIds: [DEBT], primaryDebtId: DEBT })
    expect(r2.ok).toBe(true)
    if (r2.ok) expect(r2.created).toBe(false)
    expect(db.chat_prompts.filter((p) => p.status === "active").length).toBe(1)
  })

  it("acknowledgement_enabled=false → não cria menu (reason:'disabled')", async () => {
    db.tenant_chat_config = [{ company_id: CO, acknowledgement_enabled: false, branding: { brand_name: "VMAX" } }]
    const { bootstrapThreeOptionsPrompt } = await import("@/lib/journey/acknowledgement")
    const r = await bootstrapThreeOptionsPrompt({ companyId: CO, sessionId: SID, customerId: CUST, debtIds: [DEBT], primaryDebtId: DEBT })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.created).toBe(false)
    expect(db.chat_prompts.length).toBe(0)
  })

  it("firstName vazio → saudação genérica (nunca 'Olá, .'/'null')", async () => {
    const { threeOptionsSummary } = await import("@/lib/journey/acknowledgement")
    const msg = threeOptionsSummary({ firstName: "", creditorName: "VMAX", updatedValue: 100, invoiceCount: 1, oldestDueDate: "2020-01-10" })
    // T1 (carta de voz §10.2): variante sem nome cai em "Olá." (nunca "Olá, ."/"null").
    expect(msg.startsWith("Olá.")).toBe(true)
    expect(msg).not.toContain("Olá, .")
    expect(msg).not.toContain("Oi, !")
    expect(msg).not.toContain("null")
  })
})

// ============================================================================
// (b) reconhecimento IMPLÍCITO ao clicar Pagar/Negociar (mode='implicit') e o
//     desbloqueio do payment.create.
// ============================================================================
describe("reconhecimento IMPLÍCITO (M4)", () => {
  beforeEach(() => seed())

  it("recognizeImplicit grava acknowledged=true, mode='implicit', button_id=4 (Pagar)", async () => {
    const { recognizeImplicit } = await import("@/lib/journey/acknowledgement")
    await recognizeImplicit({ companyId: CO, sessionId: SID, customerId: CUST, debtId: DEBT, promptId: "p1", buttonId: 4, source: "chat_three_options_pay" })
    const ack = (db.debt_acknowledgements ?? [])[0]
    expect(ack.acknowledged).toBe(true)
    expect(ack.mode).toBe("implicit")
    expect(ack.button_id).toBe(4)
    expect(ack.source).toBe("chat_three_options_pay")
  })

  it("implícito (Negociar=1) é DISTINTO do explícito ('Sim')", async () => {
    const { recognizeImplicit, recordAcknowledgement } = await import("@/lib/journey/acknowledgement")
    const { createPrompt } = await import("@/lib/journey/prompts")
    // explícito: prompt de reconhecimento + "Sim" (button 1)
    const p = await createPrompt({ companyId: CO, sessionId: SID, kind: "debt_acknowledgement", question: "Reconhece?", buttons: [{ id: 1, label: "Sim" }, { id: 0, label: "Não" }] })
    if (!p.ok) throw new Error("seed")
    await recordAcknowledgement({ companyId: CO, sessionId: SID, customerId: CUST, debtId: DEBT, promptId: p.prompt.id, buttonId: 1 })
    // implícito: clique Negociar (button 1) no menu de 3 opções
    await recognizeImplicit({ companyId: CO, sessionId: SID, customerId: CUST, debtId: DEBT, promptId: "p3op", buttonId: 1, source: "chat_three_options_negotiate" })
    const modes = (db.debt_acknowledgements ?? []).map((a) => a.mode)
    expect(modes).toContain("explicit")
    expect(modes).toContain("implicit")
  })

  it("o reconhecimento implícito destrava o guard de payment.create (D18)", async () => {
    const { recognizeImplicit, assertAcknowledgedForPayment } = await import("@/lib/journey/acknowledgement")
    // antes: sem reconhecimento → bloqueado
    const before = await assertAcknowledgedForPayment({ companyId: CO, sessionId: SID, debtId: DEBT })
    expect(before).toEqual({ ok: false, code: "debt_not_acknowledged" })
    // clique Pagar → implícito
    await recognizeImplicit({ companyId: CO, sessionId: SID, customerId: CUST, debtId: DEBT, promptId: "p1", buttonId: 4, source: "chat_three_options_pay" })
    refreshView()
    const after = await assertAcknowledgedForPayment({ companyId: CO, sessionId: SID, debtId: DEBT })
    expect(after.ok).toBe(true)
  })

  it("Pagar de ponta-a-ponta: implícito + payService cobra pelo caminho canônico (link + valor)", async () => {
    const { recognizeImplicit } = await import("@/lib/journey/acknowledgement")
    const { payService } = await import("@/lib/journey/pay")
    await recognizeImplicit({ companyId: CO, sessionId: SID, customerId: CUST, debtId: DEBT, promptId: "p1", buttonId: 4, source: "chat_three_options_pay" })
    refreshView()
    const r = await payService(ctx)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.valor).toBe(250)
      expect(r.link).toBe("https://asaas/checkout/pay_new")
    }
    expect(confirmCalls).toBe(1)
  })
})

// ============================================================================
// (d) 409 de payment.create bloqueado enquanto "não reconhecida" (D18).
// ============================================================================
describe("payment.create bloqueado sem reconhecimento (D18)", () => {
  beforeEach(() => seed())

  it("sem reconhecimento (nem implícito), payService devolve debt_not_acknowledged e NÃO cobra", async () => {
    const { payService } = await import("@/lib/journey/pay")
    const r = await payService(ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe("debt_not_acknowledged")
    expect(confirmCalls).toBe(0)
  })
})

// ============================================================================
// (c) "Não reconheço": copy do cedente + FALLBACK SEGURO + volta.
// ============================================================================
describe("encaminhamento ao cedente (§6.2/M6)", () => {
  beforeEach(() => seed())

  it("FALLBACK SEGURO (VMAX label NULL): nunca vazio/'null'/outro cedente; cita {credor}", async () => {
    const { resolveCreditorChannel, notRecognizedReply } = await import("@/lib/journey/acknowledgement")
    const channel = await resolveCreditorChannel({ companyId: CO, customerId: CUST, debtId: DEBT })
    expect(channel.hasConfig).toBe(false)
    expect(channel.creditorName).toBe("VMAX") // da fonte canônica (branding)
    const reply = notRecognizedReply(channel)
    expect(reply).not.toContain("null")
    expect(reply).not.toContain("undefined")
    expect(reply).toContain("VMAX")
    // fallback: canal informado na fatura / site oficial do credor
    expect(reply).toContain("informado na sua fatura")
    // nunca promete pagamento; AlteaPay não é responsável pela dívida
    expect(reply).toContain("não vamos gerar nenhum pagamento")
    // R-46 (carta de voz): AlteaPay opera o canal; o dono do contrato é o credor.
    expect(reply).toContain("A AlteaPay opera o canal de negociação")
    // R-46/C10: sem "Obrigado por avisar" (muleta) nem "se já pagou desconsidere".
    expect(reply).not.toContain("Obrigado por avisar")
    expect(reply).not.toContain("desconsidere")
  })

  it("COM config: usa o canal oficial semeado (label + url)", async () => {
    seed({ channelLabel: "SAC VMAX 0800-123", channelUrl: "https://vmax.example/sac" })
    const { resolveCreditorChannel, notRecognizedReply } = await import("@/lib/journey/acknowledgement")
    const channel = await resolveCreditorChannel({ companyId: CO, customerId: CUST, debtId: DEBT })
    expect(channel.hasConfig).toBe(true)
    const reply = notRecognizedReply(channel)
    expect(reply).toContain("canal oficial: SAC VMAX 0800-123")
    expect(reply).toContain("https://vmax.example/sac")
    expect(reply).not.toContain("informado na sua fatura") // variação com config
  })

  it("Não reconheço grava ack NEGATIVO (button 0) e bloqueia payment.create depois (D18)", async () => {
    const { handleDebtNotRecognized, assertAcknowledgedForPayment } = await import("@/lib/journey/acknowledgement")
    await handleDebtNotRecognized({ companyId: CO, sessionId: SID, customerId: CUST, debtId: DEBT, promptId: "p1", buttonId: 0 })
    const ack = (db.debt_acknowledgements ?? [])[0]
    expect(ack.acknowledged).toBe(false)
    expect(ack.button_id).toBe(0)
    refreshView()
    const guard = await assertAcknowledgedForPayment({ companyId: CO, sessionId: SID, debtId: DEBT })
    expect(guard).toEqual({ ok: false, code: "debt_not_acknowledged" })
  })

  it("volta [98] reabre o menu de 3 opções (M7 — não é beco sem saída)", async () => {
    const { reopenThreeOptions } = await import("@/lib/journey/acknowledgement")
    const back = await reopenThreeOptions({ companyId: CO, sessionId: SID, customerId: CUST, debtIds: [DEBT], primaryDebtId: DEBT })
    expect(back.ok).toBe(true)
    const active = db.chat_prompts.find((p) => p.status === "active")
    expect(active?.kind).toBe("debt_three_options")
    expect(active?.buttons.map((b: any) => b.id)).toEqual([4, 1, 2, 0])
  })
})

// ============================================================================
// buttons.ts: ordenação e ids do menu de 3 opções.
// ============================================================================
describe("buttons — ordenação do menu de 3 opções", () => {
  it("sortButtons respeita `order` (Pagar,Negociar,Consultar,Não reconheço) e não o id (4,1,2,0)", async () => {
    const { threeOptionsButtons, sortButtons } = await import("@/lib/journey/buttons").then(async (m) => ({
      sortButtons: m.sortButtons,
      threeOptionsButtons: (await import("@/lib/journey/acknowledgement")).threeOptionsButtons,
    }))
    const sorted = sortButtons(threeOptionsButtons(250, false))
    expect(sorted.map((b) => b.id)).toEqual([4, 1, 2, 0])
  })

  it("sortButtons legado (sem `order`) mantém sort por id crescente", async () => {
    const { sortButtons } = await import("@/lib/journey/buttons")
    const sorted = sortButtons([{ id: 99, label: "z" }, { id: 0, label: "n" }, { id: 1, label: "s" }])
    expect(sorted.map((b) => b.id)).toEqual([0, 1, 99])
  })
})

// ============================================================================
// Ajustes 2026-09-24 (Fabio): resumo OBJETIVO (só o valor), "Consultar dívida"
// (vencimento + serviço do cedente sob demanda) e reset do chat após 24h.
// ============================================================================
describe("resumo objetivo + Consultar + reset 24h", () => {
  beforeEach(() => seed())

  it("threeOptionsSummary (T1/R-12): sem VALOR e sem vencimento na fala; convida a seguir", async () => {
    const { threeOptionsSummary, buildAckContext } = await import("@/lib/journey/acknowledgement")
    const s = threeOptionsSummary(await buildAckContext({ companyId: CO, customerId: CUST, debtIds: [DEBT] }))
    // R-12: o valor mora no card fixo e no rótulo do botão PAGAR, NÃO na fala.
    expect(s).not.toContain("250")
    expect(s).not.toContain("R$")
    expect(s).not.toContain("Vencimento original")
    expect(s).toMatch(/prefere seguir/i)
  })

  it("debtConsultReply (T4/R-27): vencimento + serviço do cedente + caminho de volta", async () => {
    const { debtConsultReply, buildAckContext } = await import("@/lib/journey/acknowledgement")
    const r = debtConsultReply(await buildAckContext({ companyId: CO, customerId: CUST, debtIds: [DEBT] }))
    // T4: "vencimento original em {venc}" e "refere-se a um serviço da {credor}".
    expect(r).toMatch(/vencimento original em/i)
    expect(r).toMatch(/serviço da/i)
    expect(r).toContain("VMAX")
    // R-12: sem valor na fala (mora no card/rótulo).
    expect(r).not.toContain("R$")
    // a carta pede sempre oferecer caminho: a frase termina convidando a escolher.
    expect(r).toMatch(/escolher abaixo/i)
  })

  it("Consultar [2]: sequência do clique gera a resposta + reabre o menu (não fica mudo)", async () => {
    const ack = await import("@/lib/journey/acknowledgement")
    const { answerPrompt } = await import("@/lib/journey/prompts")
    // 1) bootstrap do menu
    await ack.bootstrapThreeOptionsPrompt({ companyId: CO, sessionId: SID, customerId: CUST, debtIds: [DEBT], primaryDebtId: DEBT })
    const p1 = db.chat_prompts.find((p) => p.status === "active")!
    expect(p1.buttons.map((b: any) => b.id)).toContain(2)
    const msgsBefore = db.chat_messages.length
    // 2) simula o branch BTN_CONSULT do button/route.ts
    const answered = await answerPrompt({ sessionId: SID, companyId: CO, promptId: p1.id, buttonId: 2 })
    expect(answered.ok).toBe(true)
    const reply = ack.debtConsultReply(await ack.buildAckContext({ companyId: CO, customerId: CUST, debtIds: [DEBT] }))
    await ack.persistAssistantMessage({ companyId: CO, sessionId: SID, text: reply })
    const reopened = await ack.reopenThreeOptions({ companyId: CO, sessionId: SID, customerId: CUST, debtIds: [DEBT], primaryDebtId: DEBT })
    expect(reopened.ok).toBe(true)
    // 3) a resposta do consult foi persistida E há um novo menu ativo
    expect(db.chat_messages.some((m) => m.text === reply)).toBe(true)
    expect(db.chat_messages.length).toBeGreaterThan(msgsBefore)
    const active = db.chat_prompts.find((p) => p.status === "active")
    expect(active).toBeTruthy()
    expect(active!.id).not.toBe(p1.id)
    expect(active!.buttons.map((b: any) => b.id)).toEqual([4, 1, 2, 0])
  })

  // R-01 — GUARD DE REGRESSÃO do P1 (render síncrono do corpo do POST). Falha se:
  //  (a) o consult deixar de vir no corpo do POST (action:'consult' + reply);
  //  (b) não houver debt_three_options active após o clique;
  //  (c) o reply não persistir em chat_messages (com prompt_id null — não filtrado
  //      pelo render de prompt ativo, chat.tsx:942-944).
  // Exercita a ROTA real (não só as libs) para travar o contrato que a UI consome.
  it("R-01 guard: CONSULTAR devolve reply no corpo do POST + menu active + reply persistido (prompt_id null)", async () => {
    const { bootstrapThreeOptionsPrompt } = await import("@/lib/journey/acknowledgement")
    const { POST } = await import("@/app/api/chat/button/route")
    const { signChatJwt } = await import("@/lib/negotiation/crypto")
    process.env.NEGOTIATION_JWT_SECRET = "test-secret-3op-r01"
    await bootstrapThreeOptionsPrompt({ companyId: CO, sessionId: SID, customerId: CUST, debtIds: [DEBT], primaryDebtId: DEBT })
    const prompt = db.chat_prompts.find((p) => p.status === "active")!
    const cookie = signChatJwt({ sid: SID, cid: CO }, 3600)
    const req = {
      cookies: { get: (n: string) => (n === "alteapay_chat_session" ? { value: cookie } : undefined) },
      headers: { get: () => null },
      json: async () => ({ prompt_id: prompt.id, button_id: 2 }),
    } as any
    const res = await POST(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    // (a) reply no corpo do POST
    expect(body.action).toBe("consult")
    expect(typeof body.reply).toBe("string")
    expect(body.reply.length).toBeGreaterThan(0)
    // (b) novo debt_three_options active após o clique
    const active = db.chat_prompts.find((p) => p.status === "active")
    expect(active!.kind).toBe("debt_three_options")
    expect(active!.id).not.toBe(prompt.id)
    // (c) reply persistido, com prompt_id null (não some no render de prompt ativo)
    const replyMsg = db.chat_messages.find((m) => m.role === "assistant" && m.text === body.reply)
    expect(replyMsg).toBeTruthy()
    expect(replyMsg!.prompt_id == null).toBe(true)
  })

  // C3 — DECISÃO G3 D.3 (fim do DELETE): o reset de 24h PRESERVA as linhas.
  // Substitui a antiga asserção de length===0 por asserção de PRESERVAÇÃO +
  // thread_epoch+1 + arquivamento (archived_at). SELECT antes/depois = MESMAS
  // linhas (agora arquivadas na época anterior).
  it("reset 24h PRESERVA (não deleta): arquiva as linhas velhas e incrementa thread_epoch", async () => {
    const { resetStaleChatIfInactive } = await import("@/lib/journey/acknowledgement")
    const old = new Date(Date.now() - 25 * 3_600_000).toISOString()
    db.chat_messages = [{ id: "m1", session_id: SID, company_id: CO, role: "assistant", text: "velho", created_at: old }]
    db.chat_prompts = [{ id: "p1", session_id: SID, company_id: CO, kind: "debt_three_options", status: "active", buttons: [], created_at: old }]
    // sessão começa na época 0 (default da migration 20260935).
    db.negotiation_sessions[0].thread_epoch = 0

    expect(await resetStaleChatIfInactive(SID, CO)).toBe(true)

    // PRESERVAÇÃO: as linhas continuam no banco (NUNCA deletadas) — SELECT antes/
    // depois retorna as mesmas linhas (mesma contagem, mesmo conteúdo).
    expect(db.chat_messages.length).toBe(1)
    expect(db.chat_prompts.length).toBe(1)
    expect(db.chat_messages[0].id).toBe("m1")
    expect(db.chat_prompts[0].id).toBe("p1")
    // ARQUIVADAS (archived_at setado, UPDATE não DELETE) na época anterior.
    expect(db.chat_messages[0].archived_at).toBeTruthy()
    expect(db.chat_prompts[0].archived_at).toBeTruthy()
    // prompt da época velha deixa de estar 'active' (não vive na thread nova).
    expect(db.chat_prompts[0].status).toBe("superseded")
    // thread_epoch da sessão foi incrementado (0 → 1): abre uma thread nova.
    expect(db.negotiation_sessions[0].thread_epoch).toBe(1)
  })

  it("reset 24h: histórico recente (<24h) NÃO rotaciona (época e linhas intactas)", async () => {
    const { resetStaleChatIfInactive } = await import("@/lib/journey/acknowledgement")
    const fresh = new Date(Date.now() - 60_000).toISOString()
    db.chat_messages = [{ id: "m2", session_id: SID, company_id: CO, role: "assistant", text: "novo", created_at: fresh }]
    db.negotiation_sessions[0].thread_epoch = 0
    expect(await resetStaleChatIfInactive(SID, CO)).toBe(false)
    expect(db.chat_messages.length).toBe(1)
    expect(db.chat_messages[0].archived_at == null).toBe(true)
    expect(db.negotiation_sessions[0].thread_epoch).toBe(0)
  })
})
