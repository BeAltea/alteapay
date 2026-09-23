// Fix: sessão reaberta do fluxo ASSISTIDO (engine disabled) precisa trazer o
// CONTEXTO completo, não só o último clique. O servidor persiste em chat_messages:
//   1) a PERGUNTA+resumo do reconhecimento (role='assistant', ligada ao prompt),
//      gravada na criação do prompt (bootstrapAcknowledgementPrompt);
//   2) o CLIQUE do cliente (role='customer'), via answerPrompt dentro de
//      recordAcknowledgement;
//   3) a RESPOSTA do assistente (role='assistant'), via persistAssistantMessage.
// Este teste simula o GET /api/chat/messages numa reabertura (mesma query: por
// session_id, ordenado por created_at) e confere que os 3 vêm na ordem certa.
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

  it("a pergunta+resumo é persistida como chat_messages(assistant, prompt_id) na criação do prompt", async () => {
    const { bootstrapAcknowledgementPrompt } = await import("@/lib/journey/acknowledgement")
    const r = await bootstrapAcknowledgementPrompt({ companyId: CO, sessionId: SID, customerId: CUST, debtIds: [DEBT], primaryDebtId: DEBT })
    expect(r.ok && r.created).toBe(true)
    const promptId = r.ok && r.created ? r.prompt.id : ""

    const qMsg = db.chat_messages.find((m) => m.role === "assistant" && m.prompt_id === promptId)
    expect(qMsg).toBeTruthy()
    expect(qMsg?.text).toContain("Você reconhece esta cobrança em seu nome?")
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

  it("contexto completo: [pergunta+resumo] → [clique] → [resposta do assistente] em ordem", async () => {
    const { bootstrapAcknowledgementPrompt, recordAcknowledgement, persistAssistantMessage } = await import("@/lib/journey/acknowledgement")

    // 1) prompt criado → pergunta persistida
    const boot = await bootstrapAcknowledgementPrompt({ companyId: CO, sessionId: SID, customerId: CUST, debtIds: [DEBT], primaryDebtId: DEBT })
    const promptId = boot.ok && boot.created ? boot.prompt.id : ""

    // 2) clique "Sim" → grava a mensagem do cliente (via answerPrompt)
    const ack = await recordAcknowledgement({ companyId: CO, sessionId: SID, customerId: CUST, debtId: DEBT, promptId, buttonId: 1 })
    expect(ack.ok && ack.acknowledged).toBe(true)
    refreshView()

    // 3) resposta do assistente (o que a rota /api/chat/button persiste no ramo "Sim")
    await persistAssistantMessage({ companyId: CO, sessionId: SID, text: "Perfeito! Então vamos trabalhar juntos para sanar o seu débito." })

    // garante ordenação temporal determinística (o fake usa new Date() por linha)
    const msgs = sessionMessages()
    msgs[0].created_at = "2026-09-23T10:00:00.000Z"
    msgs[1].created_at = "2026-09-23T10:00:01.000Z"
    msgs[2].created_at = "2026-09-23T10:00:02.000Z"

    const ordered = sessionMessages()
    expect(ordered.length).toBe(3)
    // pergunta + resumo (assistant, ligada ao prompt)
    expect(ordered[0].role).toBe("assistant")
    expect(ordered[0].prompt_id).toBe(promptId)
    expect(ordered[0].text).toContain("Você reconhece esta cobrança em seu nome?")
    // clique do cliente
    expect(ordered[1].role).toBe("customer")
    expect(ordered[1].text).toBe("Sim, reconheço")
    expect(ordered[1].button_id).toBe(1)
    // resposta do assistente
    expect(ordered[2].role).toBe("assistant")
    expect(ordered[2].text).toContain("vamos trabalhar juntos")
  })
})
