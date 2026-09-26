// QA round 4 — R-12 (S4) + decisão do PO (08 §3): "Não reconheço" × login/
// retomada concorrente. O bootstrap do login nunca publica o menu PAGÁVEL para
// quem está contestando (último clique = [0]) e, com um clique em voo (prompt
// recém-respondido sem sucessor), espera e reusa o sucessor em vez de criar um
// menu que a outra aba vai superseder (409). Saudação de retorno VARIANTE POR
// ESTADO: abriu Detalhes / não abriu / não reconheceu (+ menu-volta [98]).
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"
import { returnGreetingFor } from "@/lib/journey/recap"

process.env.CHAT_JOURNEY_ENABLED = "true"
process.env.NEGOTIATION_JWT_SECRET = "test-secret-qa4-nr"

const CO = "eeeeeeee-0000-0000-0000-0000000qa4n1"
const SID = "sess-qa4-nr"
const CUST = "cust-qa4-nr"
const DEBT = "debt-qa4-nr"

let db: FakeDb
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/asaas", () => ({ getAsaasPaymentsForCustomer: async () => [] }))
vi.mock("@/lib/notifications/email", () => ({ sendEmail: async () => ({ ok: true }) }))
vi.mock("@/lib/journey/events", () => ({
  recordEvent: async () => ({ ok: true, duplicate: false }),
  getTimeline: async () => [],
}))
vi.mock("@/lib/negotiation/engine", () => ({
  engineName: () => "disabled",
  emitNegotiationStart: async () => ({ ok: true, delivered: false, reason: "engine_unavailable" }),
}))

function seed(channel: { label: string | null; url: string | null } = { label: null, url: null }) {
  db = {
    tenant_chat_config: [{
      company_id: CO, payment_origin: "platform", allow_payment_without_acknowledgement: false,
      acknowledgement_enabled: true, show_handoff_button: false, on_debt_not_recognized: "continue",
      official_channel_label: channel.label, official_channel_url: channel.url, branding: { brand_name: "VMAX" },
      creditor_notification_emails: [],
    }],
    companies: [{ id: CO, name: "VMAX LTDA" }],
    customers: [{ id: CUST, company_id: CO, name: "Fabio Mendes", document: "11144477735" }],
    debts: [{ id: DEBT, company_id: CO, customer_id: CUST, status: "pending", amount: 250, due_date: "2026-08-15" }],
    vmax_invoices: [{ id_company: CO, doc: "11144477735", fatura: "F1", vencimento: "2026-08-15", saldo: 250 }],
    negotiation_sessions: [{ id: SID, company_id: CO, customer_id: CUST, debt_id: DEBT, agreement_id: null, debt_ids: [DEBT], primary_debt_id: DEBT }],
    negotiation_offers: [], negotiation_condition_matrix: [], negotiation_acceptances: [], negotiation_cases: [],
    contact_suppressions: [], chat_prompts: [], chat_messages: [], debt_acknowledgements: [], debt_acknowledgement_latest: [], agreements: [],
  }
}
function req(cookieValue: string | null, body: Record<string, unknown>) {
  return {
    cookies: { get: (name: string) => (cookieValue && name === "alteapay_chat_session" ? { value: cookieValue } : undefined) },
    headers: { get: () => null },
    json: async () => body,
  } as any
}
async function signed() {
  const { signChatJwt } = await import("@/lib/negotiation/crypto")
  return signChatJwt({ sid: SID, cid: CO }, 3600)
}
async function login() {
  const { bootstrapThreeOptionsPrompt } = await import("@/lib/journey/acknowledgement")
  return bootstrapThreeOptionsPrompt({ companyId: CO, sessionId: SID, customerId: CUST, debtIds: [DEBT], primaryDebtId: DEBT })
}
const actives = () => db.chat_prompts.filter((p) => p.status === "active")
const payableActives = () => actives().filter((p) => (p.buttons ?? []).some((b: { id: number }) => b.id === 4))

describe("R-12 — login concorrente ao 'Não reconheço'", () => {
  beforeEach(() => seed())

  it("contestação registrada (último clique [0]) e sem prompt ativo → o login publica o menu-volta [98], nunca o pagável", async () => {
    const { answerPrompt } = await import("@/lib/journey/prompts")
    await login()
    const menu = actives()[0]
    await answerPrompt({ sessionId: SID, companyId: CO, promptId: menu.id, buttonId: 0 })
    // o clique terminou há mais que a carência (o handler caiu antes do menu-volta)
    menu.answered_at = new Date(Date.now() - 5000).toISOString()
    const out = await login()
    expect(out.ok).toBe(true)
    expect(actives().length).toBe(1)
    expect(payableActives().length).toBe(0)
    expect(actives()[0].buttons.map((b: { id: number }) => b.id)).toEqual([98])
    expect(actives()[0].context.stage).toBe("not_recognized_back")
  })

  it("clique em voo (prompt recém-respondido, sucessor a caminho): o login espera e REUSA o sucessor — 1 prompt ativo, 0 pagáveis, sem 409", async () => {
    const { answerPrompt, createPrompt } = await import("@/lib/journey/prompts")
    const { backToOptionsButtons } = await import("@/lib/journey/acknowledgement")
    await login()
    const menu = actives()[0]
    await answerPrompt({ sessionId: SID, companyId: CO, promptId: menu.id, buttonId: 0 })
    // o handler do "Não reconheço" publica o menu-volta 300 ms depois
    setTimeout(() => {
      void createPrompt({
        companyId: CO, sessionId: SID, kind: "debt_three_options", question: "",
        buttons: backToOptionsButtons(), context: { stage: "not_recognized_back" }, createdBy: "platform",
      })
    }, 300)
    const out = await login()
    expect(out.ok && !out.created && out.reason).toBe("already_active")
    expect(actives().length).toBe(1)
    expect(payableActives().length).toBe(0)
    expect(db.chat_prompts.filter((p) => p.status === "superseded").length).toBe(0) // ninguém foi superseded
  })

  it("sem clique em voo nem contestação: o login segue criando o menu pagável (fluxo intocado)", async () => {
    await login()
    expect(payableActives().length).toBe(1)
  })

  it("o handler do Não reconheço reusa um menu-volta já publicado pelo login (sem supersede → a outra aba não recebe 409)", () => {
    const route = readFileSync(join(__dirname, "..", "..", "app/api/chat/button/route.ts"), "utf8")
    expect(route).toContain('(current.context as { stage?: unknown } | null)?.stage === "not_recognized_back"')
    expect(route).toContain("if (!alreadyBack) {")
  })
})

describe("PO 08 §3 — saudação de retorno variante por estado", () => {
  it("texto puro das 3 variantes (sem travessão, sem emoji, sem valor)", () => {
    expect(returnGreetingFor("detail_seen", "Fabio")).toBe(
      "Olá de novo, Fabio. Você já viu os detalhes do valor em aberto. Como prefere seguir?",
    )
    expect(returnGreetingFor("no_detail", "Fabio")).toBe("Olá de novo, Fabio. Como prefere seguir?")
    expect(returnGreetingFor("no_detail", null)).toBe("Olá de novo. Como prefere seguir?")
    expect(
      returnGreetingFor("not_recognized", "Fabio", { creditorName: "VMAX", hasConfig: true, channelLabel: "SAC VMAX 0800 000 0000", channelUrl: null }),
    ).toBe("Olá de novo, Fabio. Você nos informou que não reconhece esta cobrança. Para contestar, fale com a VMAX: SAC VMAX 0800 000 0000.")
    const fallback = returnGreetingFor("not_recognized", "Fabio", { creditorName: "VMAX", hasConfig: false, channelLabel: null, channelUrl: null })
    expect(fallback).toBe(
      "Olá de novo, Fabio. Você nos informou que não reconhece esta cobrança. Para contestar, fale com a VMAX pelo canal informado na sua fatura ou no site oficial da VMAX.",
    )
    for (const t of [fallback, returnGreetingFor("no_detail", "Ana")]) {
      expect(t).not.toMatch(/—|–|R\$|null|undefined/)
    }
  })

  it("buildRecap: abriu Detalhes → 'já viu os detalhes'; não abriu → curta; último clique Não reconheço → contestação + canal", async () => {
    const { buildRecap } = await import("@/lib/journey/recap")
    seed({ label: "SAC VMAX", url: "https://vmax.example/contato" })
    const t = (s: number) => new Date(Date.parse("2026-09-26T10:00:00Z") + s * 1000).toISOString()
    db.chat_messages = [
      { id: "e1", session_id: SID, company_id: CO, role: "customer", text: "Detalhes da dívida", button_id: 2, created_at: t(1) },
      { id: "a1", session_id: SID, company_id: CO, role: "assistant", text: "Vencimento original…", offers_snapshot: { stage: "detail" }, created_at: t(2) },
    ]
    expect((await buildRecap(SID, CO))!.text).toBe("Olá de novo, Fabio. Você já viu os detalhes do valor em aberto. Como prefere seguir?")

    db.chat_messages = [
      { id: "e1", session_id: SID, company_id: CO, role: "customer", text: "Pagar R$ 250,00", button_id: 4, created_at: t(1) },
    ]
    expect((await buildRecap(SID, CO))!.text).toBe("Olá de novo, Fabio. Como prefere seguir?")

    db.chat_messages = [
      { id: "e1", session_id: SID, company_id: CO, role: "customer", text: "Detalhes da dívida", button_id: 2, created_at: t(1) },
      { id: "a1", session_id: SID, company_id: CO, role: "assistant", text: "Vencimento original…", offers_snapshot: { stage: "detail" }, created_at: t(2) },
      { id: "e2", session_id: SID, company_id: CO, role: "customer", text: "Não reconheço", button_id: 0, created_at: t(3) },
    ]
    const nr = (await buildRecap(SID, CO))!
    expect(nr.state).toBe("after_not_recognized")
    expect(nr.text).toBe(
      "Olá de novo, Fabio. Você nos informou que não reconhece esta cobrança. Para contestar, fale com a VMAX: SAC VMAX (https://vmax.example/contato).",
    )
    expect(nr.text).not.toContain("Você já viu os detalhes")

    // Voltar às opções [98] depois da contestação → menu pagável de novo → variante normal
    db.chat_messages.push({ id: "e3", session_id: SID, company_id: CO, role: "customer", text: "Voltar às opções", button_id: 98, created_at: t(4) })
    expect((await buildRecap(SID, CO))!.state).not.toBe("after_not_recognized")
  })
})
