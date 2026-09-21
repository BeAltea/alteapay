// R4: reconhecimento da dívida — grava nas 4 tabelas (append-only), a view
// devolve a última resposta, "Não" não bloqueia navegação mas bloqueia
// payment.create (guard), e a flag allow_payment_without_acknowledgement libera.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

const CO = "eeeeeeee-0000-0000-0000-000000000011"
const SID = "sess-ack"
const CUST = "cust-ack"
const DEBT = "debt-ack"

let db: FakeDb
const events: Array<{ type: string }> = []
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/journey/events", () => ({
  recordEvent: async (i: { type: string }) => {
    events.push({ type: i.type })
    return { ok: true, duplicate: false }
  },
}))

/** Recalcula a "view" debt_acknowledgement_latest a partir do append-log. */
function refreshView() {
  const rows = db.debt_acknowledgements ?? []
  const latestByKey = new Map<string, any>()
  for (const r of rows) {
    const key = `${r.session_id}|${r.debt_id}`
    const cur = latestByKey.get(key)
    if (!cur || r.created_at >= cur.created_at) latestByKey.set(key, r)
  }
  db.debt_acknowledgement_latest = [...latestByKey.values()]
}

function reset(cfg: Record<string, unknown> = {}) {
  events.length = 0
  db = {
    tenant_chat_config: [{ company_id: CO, on_debt_not_recognized: "continue", acknowledgement_enabled: true, allow_payment_without_acknowledgement: false, ...cfg }],
    chat_prompts: [],
    chat_messages: [],
    debt_acknowledgements: [],
    debt_acknowledgement_latest: [],
    negotiation_sessions: [{ id: SID, company_id: CO, debt_acknowledged_at: null }],
  }
}

async function seedAckPrompt() {
  const { createPrompt } = await import("@/lib/journey/prompts")
  const r = await createPrompt({
    companyId: CO, sessionId: SID, kind: "debt_acknowledgement", question: "Reconhece?",
    buttons: [{ id: 1, label: "Sim, reconheço" }, { id: 0, label: "Não reconheço" }],
  })
  if (!r.ok) throw new Error("seed prompt failed")
  return r.prompt.id
}

describe("recordAcknowledgement", () => {
  beforeEach(() => reset())

  it("Sim (1): grava debt_acknowledgements + prompt answered + msg + event + espelho", async () => {
    const promptId = await seedAckPrompt()
    const { recordAcknowledgement } = await import("@/lib/journey/acknowledgement")
    const r = await recordAcknowledgement({
      companyId: CO, sessionId: SID, customerId: CUST, debtId: DEBT, promptId, buttonId: 1,
      ip: "1.2.3.4", userAgent: "t",
    })
    expect(r.ok && r.acknowledged).toBe(true)
    const ack = db.debt_acknowledgements[0]
    expect(ack.acknowledged).toBe(true)
    expect(ack.button_id).toBe(1)
    expect(ack.ip_hash).toBeTruthy()
    expect(ack.ip_hash).not.toBe("1.2.3.4") // hash, não claro
    expect(db.chat_prompts.find((p) => p.id === promptId)?.status).toBe("answered")
    expect(db.chat_messages.some((m) => m.prompt_id === promptId && m.button_id === 1)).toBe(true)
    expect(events.some((e) => e.type === "debt.acknowledged")).toBe(true)
    expect(db.negotiation_sessions[0].debt_acknowledged_at).toBeTruthy()
  })

  it("Não (0): registra, emite debt.not_recognized e devolve onNotRecognized=continue", async () => {
    const promptId = await seedAckPrompt()
    const { recordAcknowledgement } = await import("@/lib/journey/acknowledgement")
    const r = await recordAcknowledgement({
      companyId: CO, sessionId: SID, customerId: CUST, debtId: DEBT, promptId, buttonId: 0,
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.acknowledged).toBe(false)
      expect(r.onNotRecognized).toBe("continue")
    }
    expect(db.debt_acknowledgements[0].button_id).toBe(0)
    expect(events.some((e) => e.type === "debt.not_recognized")).toBe(true)
    // "Não" NÃO grava o espelho (não reconheceu)
    expect(db.negotiation_sessions[0].debt_acknowledged_at).toBeNull()
  })

  it("append-only: 2ª resposta não sobrescreve; a view pega a mais recente", async () => {
    const p1 = await seedAckPrompt()
    const { recordAcknowledgement } = await import("@/lib/journey/acknowledgement")
    await recordAcknowledgement({ companyId: CO, sessionId: SID, customerId: CUST, debtId: DEBT, promptId: p1, buttonId: 0 })
    // segunda pergunta (nova) + resposta "Sim"
    const p2 = await seedAckPrompt()
    // garante ordenação temporal
    db.debt_acknowledgements[0].created_at = "2026-09-21T10:00:00.000Z"
    await recordAcknowledgement({ companyId: CO, sessionId: SID, customerId: CUST, debtId: DEBT, promptId: p2, buttonId: 1 })
    db.debt_acknowledgements[1].created_at = "2026-09-21T10:05:00.000Z"
    expect(db.debt_acknowledgements.length).toBe(2) // append-only
    refreshView()
    const latest = db.debt_acknowledgement_latest.find((v) => v.session_id === SID && v.debt_id === DEBT)
    expect(latest.acknowledged).toBe(true) // a mais recente é "Sim"
  })

  it("[99] handoff: não grava debt_acknowledgements; onNotRecognized=human", async () => {
    const { createPrompt } = await import("@/lib/journey/prompts")
    const p = await createPrompt({
      companyId: CO, sessionId: SID, kind: "debt_acknowledgement", question: "Reconhece?",
      buttons: [{ id: 1, label: "Sim" }, { id: 0, label: "Não" }, { id: 99, label: "Atendente" }],
    })
    if (!p.ok) throw new Error("seed failed")
    const { recordAcknowledgement } = await import("@/lib/journey/acknowledgement")
    const r = await recordAcknowledgement({ companyId: CO, sessionId: SID, customerId: CUST, debtId: DEBT, promptId: p.prompt.id, buttonId: 99 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.onNotRecognized).toBe("human")
    expect(db.debt_acknowledgements.length).toBe(0)
  })
})

describe("assertAcknowledgedForPayment", () => {
  it("sem reconhecimento (ou 'Não') → bloqueia (debt_not_acknowledged)", async () => {
    reset()
    const { assertAcknowledgedForPayment } = await import("@/lib/journey/acknowledgement")
    const r = await assertAcknowledgedForPayment({ companyId: CO, sessionId: SID, debtId: DEBT })
    expect(r).toEqual({ ok: false, code: "debt_not_acknowledged" })
  })

  it("reconhecido (Sim) → libera", async () => {
    reset()
    db.debt_acknowledgement_latest = [{ session_id: SID, debt_id: DEBT, acknowledged: true, button_id: 1, created_at: new Date().toISOString() }]
    const { assertAcknowledgedForPayment } = await import("@/lib/journey/acknowledgement")
    const r = await assertAcknowledgedForPayment({ companyId: CO, sessionId: SID, debtId: DEBT })
    expect(r.ok).toBe(true)
  })

  it("flag allow_payment_without_acknowledgement=true → libera mesmo sem reconhecer", async () => {
    reset({ allow_payment_without_acknowledgement: true })
    const { assertAcknowledgedForPayment } = await import("@/lib/journey/acknowledgement")
    const r = await assertAcknowledgedForPayment({ companyId: CO, sessionId: SID, debtId: DEBT })
    expect(r.ok).toBe(true)
  })
})
