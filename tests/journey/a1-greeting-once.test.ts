// A1 / G6 / N-D5-7 / N5 — saudação 1x por thread; menu reemitido SEM saudação;
// prompt ativo com a copy atual; invoice_count correto.
//
//  - bootstrap 'initial' (login): UMA bolha de saudação (stage 'greeting', sem
//    prompt_id) por (sessão, thread_epoch) + menu SEM pergunta no bloco;
//  - reopen (Detalhes/Voltar/Já paguei/reopen): menu com a pergunta curta "Como
//    prefere seguir?" e NENHUMA saudação nova;
//  - already_active: question/buttons desatualizados são atualizados IN-PLACE
//    (mesmo id/status) — copy nova chega ao prompt já gravado;
//  - nova época (reset 24h) → saudação de novo (1x na época nova).
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

process.env.CHAT_JOURNEY_ENABLED = "true"

const CO = "eeeeeeee-0000-0000-0000-0000000a1gr1"
const SID = "sess-a1-greet"
const CUST = "cust-a1-greet"
const DEBT = "debt-a1-greet"
const base = { companyId: CO, sessionId: SID, customerId: CUST, debtIds: [DEBT], primaryDebtId: DEBT }

let db: FakeDb
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/journey/events", () => ({ recordEvent: async () => ({ ok: true, duplicate: false }), getTimeline: async () => [] }))

function seed(opts: { invoices?: boolean } = {}) {
  db = {
    tenant_chat_config: [{ company_id: CO, acknowledgement_enabled: true, show_handoff_button: false, branding: { brand_name: "VMAX" } }],
    companies: [{ id: CO, name: "VMAX LTDA" }],
    customers: [{ id: CUST, company_id: CO, name: "Fabio Mendes", document: "11144477735" }],
    debts: [{ id: DEBT, company_id: CO, customer_id: CUST, status: "pending", amount: 250, due_date: "2026-08-15" }],
    vmax_invoices: opts.invoices === false ? [] : [{ id_company: CO, doc: "11144477735", fatura: "F1", vencimento: "2026-08-15", saldo: 250 }],
    negotiation_sessions: [{ id: SID, company_id: CO, customer_id: CUST, debt_id: DEBT, thread_epoch: 0 }],
    chat_prompts: [],
    chat_messages: [],
  }
}

const greetings = () =>
  db.chat_messages.filter((m) => m.role === "assistant" && m.offers_snapshot?.stage === "greeting")
const active = () => db.chat_prompts.find((p) => p.status === "active")

describe("saudação 1x por thread (G6)", () => {
  beforeEach(() => seed())

  it("bootstrap inicial: 1 saudação (stage greeting, sem prompt_id) + menu SEM pergunta no bloco", async () => {
    const { bootstrapThreeOptionsPrompt, threeOptionsSummary, buildAckContext } = await import("@/lib/journey/acknowledgement")
    const r = await bootstrapThreeOptionsPrompt(base)
    expect(r.ok && r.created).toBe(true)
    const g = greetings()
    expect(g.length).toBe(1)
    expect(g[0].prompt_id == null).toBe(true)
    expect(g[0].text).toBe(threeOptionsSummary(await buildAckContext({ companyId: CO, customerId: CUST, debtIds: [DEBT] })))
    // a saudação vem ANTES do prompt (ordem cronológica) e o menu não repete a pergunta
    const menu = active()!
    expect(menu.question).toBe("")
    expect(menu.context.menu_mode).toBe("initial")
    // nenhuma outra bolha do assistente (a pergunta vazia não é persistida)
    expect(db.chat_messages.filter((m) => m.role === "assistant").length).toBe(1)
  })

  it("re-login com menu vivo (already_active) NÃO empilha saudação", async () => {
    const { bootstrapThreeOptionsPrompt } = await import("@/lib/journey/acknowledgement")
    await bootstrapThreeOptionsPrompt(base)
    await bootstrapThreeOptionsPrompt(base)
    await bootstrapThreeOptionsPrompt(base)
    expect(greetings().length).toBe(1)
    expect(db.chat_prompts.filter((p) => p.status === "active").length).toBe(1)
  })

  it("reopen (Detalhes/Voltar/Já paguei): pergunta CURTA e NENHUMA saudação nova", async () => {
    const { bootstrapThreeOptionsPrompt, reopenThreeOptions, REOPEN_MENU_QUESTION } = await import("@/lib/journey/acknowledgement")
    const { answerPrompt } = await import("@/lib/journey/prompts")
    await bootstrapThreeOptionsPrompt(base)
    const p1 = active()!
    await answerPrompt({ sessionId: SID, companyId: CO, promptId: p1.id, buttonId: 2 })
    const back = await reopenThreeOptions(base)
    expect(back.ok).toBe(true)
    if (back.ok) {
      expect(back.reply).toBe(REOPEN_MENU_QUESTION)
      expect(back.reply).toBe("Como prefere seguir?")
    }
    const p2 = active()!
    expect(p2.id).not.toBe(p1.id)
    expect(p2.question).toBe("Como prefere seguir?")
    expect(p2.context.menu_mode).toBe("reopen")
    expect(p2.buttons.map((b: any) => b.id)).toEqual([4, 1, 2, 0])
    // saudação continua 1x; nenhuma bolha nova começa com "Olá"
    expect(greetings().length).toBe(1)
    const olas = db.chat_messages.filter((m) => m.role === "assistant" && /^Olá/.test(m.text))
    expect(olas.length).toBe(1)
    // reopen repetido (menu já ativo) não duplica nada
    await reopenThreeOptions(base)
    expect(db.chat_prompts.filter((p) => p.status === "active").length).toBe(1)
    expect(greetings().length).toBe(1)
  })

  it("nova thread (thread_epoch+1) → saudação de novo, 1x na época nova", async () => {
    const { bootstrapThreeOptionsPrompt } = await import("@/lib/journey/acknowledgement")
    await bootstrapThreeOptionsPrompt(base)
    // simula o reset 24h: supersede + arquiva a época 0 e abre a época 1
    for (const p of db.chat_prompts) { p.status = "superseded"; p.archived_at = "x" }
    for (const m of db.chat_messages) m.archived_at = "x"
    db.negotiation_sessions[0].thread_epoch = 1
    await bootstrapThreeOptionsPrompt(base)
    await bootstrapThreeOptionsPrompt(base)
    const g = greetings()
    expect(g.length).toBe(2)
    expect(g[1].thread_epoch).toBe(1)
    expect(active()!.thread_epoch).toBe(1)
  })
})

describe("already_active atualiza copy IN-PLACE (N-D5-7)", () => {
  beforeEach(() => seed())

  it("prompt ativo com saudação antiga como pergunta e rótulos velhos → mesmo id, question/buttons atuais", async () => {
    const { bootstrapThreeOptionsPrompt, threeOptionsButtons } = await import("@/lib/journey/acknowledgement")
    db.chat_prompts = [{
      id: "p-old", company_id: CO, session_id: SID, kind: "debt_three_options", status: "active",
      question: "Oi, Fabio! Tudo bem? Encontramos R$ 250,00 em aberto 🙂",
      buttons: [
        { id: 4, label: "Quero pagar — R$ 250,00", order: 0 },
        { id: 1, label: "Quero negociar", order: 1 },
        { id: 2, label: "Consultar dívida", order: 2 },
        { id: 0, label: "Não reconheço esta dívida", order: 3 },
      ],
      context: { debt_ids: [DEBT], primary_debt_id: DEBT }, created_at: "2026-09-25T12:00:00Z",
    }]
    const r = await bootstrapThreeOptionsPrompt(base)
    expect(r.ok).toBe(true)
    if (r.ok && !r.created) {
      expect(r.reason).toBe("already_active")
      expect(r.prompt?.id).toBe("p-old")
    } else {
      throw new Error("esperava already_active")
    }
    const row = db.chat_prompts[0]
    expect(row.id).toBe("p-old")
    expect(row.status).toBe("active")
    // copy atual: sem "Tudo bem?"/emoji/valor na pergunta (menu inicial = sem pergunta)
    expect(row.question).toBe("")
    expect(row.buttons).toEqual(threeOptionsButtons(250, false))
    expect(row.context.menu_mode).toBe("initial")
    // e a saudação da thread foi garantida (1x)
    expect(greetings().length).toBe(1)
  })

  it("prompt ativo já atualizado → nenhuma escrita (idempotente)", async () => {
    const { bootstrapThreeOptionsPrompt } = await import("@/lib/journey/acknowledgement")
    await bootstrapThreeOptionsPrompt(base)
    const before = JSON.stringify(db.chat_prompts[0])
    await bootstrapThreeOptionsPrompt(base)
    expect(JSON.stringify(db.chat_prompts[0])).toBe(before)
  })

  it("menu-volta do 'não reconheço' (só [98]) NÃO é reescrito", async () => {
    const { bootstrapThreeOptionsPrompt, backToOptionsButtons } = await import("@/lib/journey/acknowledgement")
    db.chat_prompts = [{
      id: "p-back", company_id: CO, session_id: SID, kind: "debt_three_options", status: "active",
      question: "Se preferir, você pode voltar às opções.", buttons: backToOptionsButtons(),
      context: { debt_ids: [DEBT], primary_debt_id: DEBT, stage: "not_recognized_back" }, created_at: "2026-09-25T12:00:00Z",
    }]
    await bootstrapThreeOptionsPrompt(base)
    expect(db.chat_prompts[0].question).toBe("Se preferir, você pode voltar às opções.")
    expect(db.chat_prompts[0].buttons.map((b: any) => b.id)).toEqual([98])
  })
})

describe("invoice_count (N5)", () => {
  it("sem vmax_invoices e 1 dívida → invoice_count = 1 (não 0)", async () => {
    seed({ invoices: false })
    const { buildAckContext } = await import("@/lib/journey/acknowledgement")
    const ctx = await buildAckContext({ companyId: CO, customerId: CUST, debtIds: [DEBT] })
    expect(ctx.invoiceCount).toBe(1)
    expect(ctx.oldestDueDate).toBe("2026-08-15")
  })

  it("com vmax_invoices → conta as faturas", async () => {
    seed()
    db.vmax_invoices.push({ id_company: CO, doc: "11144477735", fatura: "F2", vencimento: "2026-09-15", saldo: 100 })
    const { buildAckContext } = await import("@/lib/journey/acknowledgement")
    const ctx = await buildAckContext({ companyId: CO, customerId: CUST, debtIds: [DEBT] })
    expect(ctx.invoiceCount).toBe(2)
  })
})
