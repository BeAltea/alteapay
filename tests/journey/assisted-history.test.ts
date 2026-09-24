// Fix: sessão reaberta do fluxo ASSISTIDO (engine disabled) precisa trazer o
// CONTEXTO completo, não só o último clique. Fluxo Consultar/Negociar: o servidor
// persiste em chat_messages:
//   1) a PERGUNTA (saudação + convite Consultar/Negociar, role='assistant',
//      ligada ao prompt debt_consult), gravada na criação do prompt;
//   2) o CLIQUE do cliente (role='customer'), via answerPrompt;
//   3) os DADOS da dívida + a RESPOSTA do assistente (role='assistant'), via
//      handleDebtNegotiate/persistAssistantMessage.
// Este teste simula o GET /api/chat/messages numa reabertura (mesma query: por
// session_id, ordenado por created_at) e confere que vêm na ordem certa.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

process.env.CHAT_JOURNEY_ENABLED = "true"

const CO = "bbbbbbbb-0000-0000-0000-0000000000bb"
const SID = "sess-hist"
const CUST = "cust-hist"
const DEBT = "debt-hist"

let db: FakeDb
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/journey/events", () => ({ recordEvent: async () => ({ ok: true, duplicate: false }) }))

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

function seed() {
  db = {
    tenant_chat_config: [{ company_id: CO, branding: { brand_name: "VMAX" }, acknowledgement_enabled: true, show_handoff_button: false, on_debt_not_recognized: "continue" }],
    companies: [{ id: CO, name: "VMAX LTDA" }],
    customers: [{ id: CUST, company_id: CO, name: "Fabio Mendes", document: "11144477735" }],
    debts: [{ id: DEBT, company_id: CO, customer_id: CUST, status: "pending", amount: 250, due_date: "2020-02-01" }],
    vmax_invoices: [{ id_company: CO, doc: "11144477735", vencimento: "2020-01-10" }],
    negotiation_sessions: [{ id: SID, company_id: CO, customer_id: CUST, debt_id: DEBT, debt_acknowledged_at: null }],
    chat_prompts: [],
    chat_messages: [],
    debt_acknowledgements: [],
    debt_acknowledgement_latest: [],
  }
}

/** Espelha a query de GET /api/chat/messages (por session, ordenada). */
function sessionMessages() {
  return [...(db.chat_messages ?? [])]
    .filter((m) => m.session_id === SID && m.company_id === CO)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))
}

describe("histórico do fluxo assistido (sessão reaberta)", () => {
  beforeEach(seed)

  it("o prompt inicial é debt_consult (Consultar/Negociar) e sua pergunta é persistida (assistant, prompt_id)", async () => {
    const { bootstrapAcknowledgementPrompt } = await import("@/lib/journey/acknowledgement")
    const r = await bootstrapAcknowledgementPrompt({ companyId: CO, sessionId: SID, customerId: CUST, debtIds: [DEBT], primaryDebtId: DEBT })
    expect(r.ok && r.created).toBe(true)
    const promptId = r.ok && r.created ? r.prompt.id : ""

    // prompt inicial = debt_consult com os DOIS botões Consultar/Negociar
    const prompt = db.chat_prompts.find((p) => p.id === promptId)
    expect(prompt?.kind).toBe("debt_consult")
    expect(prompt?.buttons.map((b: { id: number }) => b.id).sort()).toEqual([2, 3])

    const qMsg = db.chat_messages.find((m) => m.role === "assistant" && m.prompt_id === promptId)
    expect(qMsg).toBeTruthy()
    expect(qMsg?.text).toContain("O que você deseja fazer?")
    expect(qMsg?.engine).toBe("platform")
  })

  it("não duplica a pergunta se o bootstrap rodar de novo (idempotente por prompt_id)", async () => {
    const { bootstrapAcknowledgementPrompt, persistAssistantMessage } = await import("@/lib/journey/acknowledgement")
    const r = await bootstrapAcknowledgementPrompt({ companyId: CO, sessionId: SID, customerId: CUST, debtIds: [DEBT], primaryDebtId: DEBT })
    const promptId = r.ok && r.created ? r.prompt.id : ""
    // segunda chamada de persistência com o mesmo prompt_id → no-op
    await persistAssistantMessage({ companyId: CO, sessionId: SID, text: "qualquer coisa", promptId })
    const qMsgs = db.chat_messages.filter((m) => m.role === "assistant" && m.prompt_id === promptId)
    expect(qMsgs.length).toBe(1)
  })

  it("Consultar [2] mostra os dados da dívida e reabre o menu (Negociar [3] + Não reconheço [0])", async () => {
    const { bootstrapAcknowledgementPrompt, handleDebtConsult } = await import("@/lib/journey/acknowledgement")
    const { answerPrompt, getActivePrompt } = await import("@/lib/journey/prompts")

    const boot = await bootstrapAcknowledgementPrompt({ companyId: CO, sessionId: SID, customerId: CUST, debtIds: [DEBT], primaryDebtId: DEBT })
    const promptId = boot.ok && boot.created ? boot.prompt.id : ""

    const answered = await answerPrompt({ sessionId: SID, companyId: CO, promptId, buttonId: 2 })
    expect(answered.ok).toBe(true)
    const out = await handleDebtConsult({ companyId: CO, sessionId: SID, customerId: CUST, debtId: DEBT, debtIds: [DEBT], primaryDebtId: DEBT })
    expect(out.ok).toBe(true)

    // dados da dívida publicados como mensagem
    expect(db.chat_messages.some((m) => m.role === "assistant" && /dados da sua pendência/.test(m.text))).toBe(true)
    // NÃO reconheceu ainda (Consultar não registra reconhecimento)
    expect(db.debt_acknowledgements.length).toBe(0)
    // menu pós-consulta ativo: Negociar [3] + Não reconheço [0]
    const post = await getActivePrompt(SID)
    expect(post?.kind).toBe("debt_consult")
    expect(post?.buttons.map((b: { id: number }) => b.id).sort()).toEqual([0, 3])
  })

  it("BUG re-entrada: com reconhecimento anterior mas SEM prompt ativo, o menu Consultar/Negociar REABRE (não fica travado)", async () => {
    const { bootstrapAcknowledgementPrompt, handleDebtNegotiate } = await import("@/lib/journey/acknowledgement")
    const { answerPrompt } = await import("@/lib/journey/prompts")

    // 1ª visita: bootstrap → Negociar → reconhece (prompt fica answered, sem ativo)
    const boot = await bootstrapAcknowledgementPrompt({ companyId: CO, sessionId: SID, customerId: CUST, debtIds: [DEBT], primaryDebtId: DEBT })
    const promptId = boot.ok && boot.created ? boot.prompt.id : ""
    await answerPrompt({ sessionId: SID, companyId: CO, promptId, buttonId: 3 })
    await handleDebtNegotiate({ companyId: CO, sessionId: SID, customerId: CUST, debtId: DEBT, debtIds: [DEBT], promptId, buttonId: 3 })
    refreshView()
    expect(db.debt_acknowledgement_latest.some((v) => v.acknowledged === true)).toBe(true)
    // nenhum prompt ativo agora (o inicial foi respondido)
    expect(db.chat_prompts.filter((p) => p.status === "active").length).toBe(0)

    // RE-ENTRADA: bootstrap roda de novo. ANTES do fix devolvia already_answered e
    // NÃO recriava prompt (menu morto). AGORA reabre um debt_consult novo.
    const reentry = await bootstrapAcknowledgementPrompt({ companyId: CO, sessionId: SID, customerId: CUST, debtIds: [DEBT], primaryDebtId: DEBT })
    expect(reentry.ok && reentry.created).toBe(true)
    const active = db.chat_prompts.filter((p) => p.status === "active")
    expect(active.length).toBe(1)
    expect(active[0].kind).toBe("debt_consult")
    expect(active[0].buttons.map((b: { id: number }) => b.id).sort()).toEqual([2, 3])
  })

  it("idempotência da re-entrada: com um prompt debt_consult JÁ ativo, o bootstrap NÃO cria outro", async () => {
    const { bootstrapAcknowledgementPrompt } = await import("@/lib/journey/acknowledgement")
    const first = await bootstrapAcknowledgementPrompt({ companyId: CO, sessionId: SID, customerId: CUST, debtIds: [DEBT], primaryDebtId: DEBT })
    const firstId = first.ok && first.created ? first.prompt.id : ""
    const second = await bootstrapAcknowledgementPrompt({ companyId: CO, sessionId: SID, customerId: CUST, debtIds: [DEBT], primaryDebtId: DEBT })
    // devolve o MESMO prompt ativo, sem criar um segundo
    expect(second.ok && second.created ? second.prompt.id : "").toBe(firstId)
    expect(db.chat_prompts.filter((p) => p.status === "active").length).toBe(1)
  })

  it("contexto completo: [pergunta] → [clique Negociar] → [dados da dívida] → [resposta] em ordem", async () => {
    const { bootstrapAcknowledgementPrompt, handleDebtNegotiate } = await import("@/lib/journey/acknowledgement")
    const { answerPrompt } = await import("@/lib/journey/prompts")

    // 1) prompt inicial debt_consult criado → pergunta persistida
    const boot = await bootstrapAcknowledgementPrompt({ companyId: CO, sessionId: SID, customerId: CUST, debtIds: [DEBT], primaryDebtId: DEBT })
    const promptId = boot.ok && boot.created ? boot.prompt.id : ""

    // 2) clique "Negociar Dívida" [3] → grava a mensagem do cliente (via answerPrompt),
    //    igual ao que a rota faz antes de handleDebtNegotiate.
    const answered = await answerPrompt({ sessionId: SID, companyId: CO, promptId, buttonId: 3 })
    expect(answered.ok).toBe(true)

    // 3) handleDebtNegotiate: dados da dívida + reconhecimento + reply (n8n cai no
    //    assistido no ambiente de teste → reply persistido).
    const neg = await handleDebtNegotiate({ companyId: CO, sessionId: SID, customerId: CUST, debtId: DEBT, debtIds: [DEBT], promptId, buttonId: 3 })
    expect(neg.ok).toBe(true)
    refreshView()
    // reconhecimento gravado (append-log) via Negociar
    expect(db.debt_acknowledgements.some((a) => a.acknowledged === true)).toBe(true)

    // garante ordenação temporal determinística (o fake usa new Date() por linha)
    const msgs = sessionMessages()
    msgs.forEach((m, i) => { m.created_at = `2026-09-23T10:00:0${i}.000Z` })

    const ordered = sessionMessages()
    expect(ordered.length).toBe(4)
    // pergunta (assistant, ligada ao prompt)
    expect(ordered[0].role).toBe("assistant")
    expect(ordered[0].prompt_id).toBe(promptId)
    expect(ordered[0].text).toContain("O que você deseja fazer?")
    // clique do cliente
    expect(ordered[1].role).toBe("customer")
    expect(ordered[1].text).toBe("Negociar Dívida")
    expect(ordered[1].button_id).toBe(3)
    // dados da dívida (assistant)
    expect(ordered[2].role).toBe("assistant")
    expect(ordered[2].text).toContain("dados da sua pendência")
    // resposta do assistente
    expect(ordered[3].role).toBe("assistant")
    expect(ordered[3].text).toContain("vamos trabalhar juntos")
  })
})
