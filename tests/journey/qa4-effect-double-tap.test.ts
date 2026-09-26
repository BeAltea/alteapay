// QA round 4 — R-11/R-21 (ALTO, QAB1-R2-01): toques múltiplos em "Já paguei"
// geram 1 claim; nenhum controle de efeito (Não reconheço, Pagar, Já paguei)
// grava efeito com o 2º/3º toque de um toque múltiplo iniciado noutro controle.
// Servidor: guard generalizado (double-tap.ts) no /button e no /reopen, com o
// eco [96] do "Já paguei". Client: bloco de ações inerte após qualquer toque e
// quando nasce/se desloca (tap-guard.ts), controle no lugar desabilitado.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"
import {
  BTN_PAYMENT_CLAIM,
  DOUBLE_TAP_WINDOW_MS,
  EFFECT_BUTTON_IDS,
  isEffectDoubleTap,
} from "@/lib/journey/double-tap"
import {
  ACTIONS_ARM_MS,
  extendInertUntil,
  isInert,
  shouldRearm,
  TAP_INERT_MS,
} from "@/lib/journey/tap-guard"
import { WAIT_EXITS_ARM_MS } from "@/lib/journey/wait-machine"

process.env.CHAT_JOURNEY_ENABLED = "true"
process.env.NEGOTIATION_JWT_SECRET = "test-secret-qa4-effect"

const CO = "eeeeeeee-0000-0000-0000-0000000qa4e1"
const SID = "sess-qa4-effect"
const CUST = "cust-qa4-effect"
const DEBT = "debt-qa4-effect"

let db: FakeDb
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
vi.mock("@/lib/negotiation/engine", () => ({
  engineName: () => "disabled",
  emitNegotiationStart: async () => ({ ok: true, delivered: false, reason: "engine_unavailable" }),
}))

function seed() {
  events.length = 0
  db = {
    tenant_chat_config: [{
      company_id: CO, payment_origin: "platform", allow_payment_without_acknowledgement: false,
      acknowledgement_enabled: true, show_handoff_button: false, on_debt_not_recognized: "dispute",
      official_channel_label: null, official_channel_url: null, branding: { brand_name: "VMAX" },
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
async function bootstrap() {
  const { bootstrapThreeOptionsPrompt } = await import("@/lib/journey/acknowledgement")
  await bootstrapThreeOptionsPrompt({ companyId: CO, sessionId: SID, customerId: CUST, debtIds: [DEBT], primaryDebtId: DEBT })
  return db.chat_prompts.find((p) => p.status === "active")!
}
/** Envelhece os ecos (o próximo clique é NOVO, ≥ 2 s depois). */
function ageClicks(ms = 3000) {
  for (const m of db.chat_messages as Array<{ role?: string; created_at?: string }>) {
    if (m.role === "customer" && m.created_at) m.created_at = new Date(Date.parse(m.created_at) - ms).toISOString()
  }
}
const negativeAcks = () => (db.debt_acknowledgements ?? []).filter((a) => a.acknowledged === false)
const claimCases = () => (db.negotiation_cases ?? []).filter((c) => c.type === "payment_claim")
const claimBubbles = () => db.chat_messages.filter((m) => m.role === "assistant" && m.offers_snapshot?.stage === "payment_claim")

describe("regra pura isEffectDoubleTap (servidor)", () => {
  const now = Date.parse("2026-09-26T10:00:02.000Z")
  const at = (ms: number) => new Date(now - ms).toISOString()

  it("controles de efeito: Não reconheço [0], Pagar [4], Já paguei [96]; o handoff [99] tem guard próprio", () => {
    expect([...EFFECT_BUTTON_IDS].sort((a, b) => a - b)).toEqual([0, 4, BTN_PAYMENT_CLAIM])
    expect(BTN_PAYMENT_CLAIM).toBe(96)
    expect(DOUBLE_TAP_WINDOW_MS).toBe(2000)
  })

  it("matriz (anterior, atual, delta) → ignora / aceita", () => {
    // Já paguei → Não reconheço a 150 ms: é o 2º toque (QAB1-R2-01)
    expect(isEffectDoubleTap({ at: at(150), buttonId: 96 }, 0, now)).toBe(true)
    // Voltar → Pagar do menu novo a 400 ms
    expect(isEffectDoubleTap({ at: at(400), buttonId: 98 }, 4, now)).toBe(true)
    // Detalhes → Já paguei a 1,9 s
    expect(isEffectDoubleTap({ at: at(1900), buttonId: 2 }, 96, now)).toBe(true)
    // isolado ≥ 2 s depois: grava
    expect(isEffectDoubleTap({ at: at(2000), buttonId: 96 }, 0, now)).toBe(false)
    expect(isEffectDoubleTap({ at: at(5000), buttonId: 98 }, 4, now)).toBe(false)
    // mesmo controle repetido: caminho próprio (duplicate/claim reusado), não este guard
    expect(isEffectDoubleTap({ at: at(100), buttonId: 0 }, 0, now)).toBe(false)
    // controle sem efeito (Detalhes [2], Negociar [1]) nunca é ignorado por este guard
    expect(isEffectDoubleTap({ at: at(100), buttonId: 96 }, 2, now)).toBe(false)
    expect(isEffectDoubleTap({ at: at(100), buttonId: 96 }, 1, now)).toBe(false)
    // sem clique anterior / relógio do banco à frente (clique concorrente) → conta como agora
    expect(isEffectDoubleTap({ at: null, buttonId: null }, 0, now)).toBe(false)
    expect(isEffectDoubleTap({ at: new Date(now + 80).toISOString(), buttonId: 96 }, 0, now)).toBe(true)
  })
})

describe("R-21 — rotas: triplo toque em 'Já paguei' nunca vira contestação", () => {
  beforeEach(seed)

  it("Já paguei → (2º toque) Não reconheço < 2 s: 200 ignored, 0 ack negativo, 0 disputa, prompt no corpo; auditoria com o controle de origem", async () => {
    const { POST: REOPEN } = await import("@/app/api/chat/reopen/route")
    const { POST: BUTTON } = await import("@/app/api/chat/button/route")
    const menu = await bootstrap()
    const jwt = await signed()
    const claim = await (await REOPEN(req(jwt, { action: "payment_claim" }))).json()
    expect(claim.claim_registered).toBe(true)
    const res = await BUTTON(req(jwt, { prompt_id: menu.id, button_id: 0 }))
    const b = await res.json()
    expect(res.status).toBe(200)
    expect(b.ok).toBe(true)
    expect(b.ignored).toBe("double_tap")
    expect(b.prompt?.kind).toBe("debt_three_options") // o menu volta na hora (D36)
    expect(negativeAcks().length).toBe(0)
    expect(events.some((e) => e.type === "debt.not_recognized")).toBe(false)
    expect((db.negotiation_cases ?? []).filter((c) => c.type !== "payment_claim").length).toBe(0)
    const ignored = events.find((e) => e.type === "chat.click_ignored" && e.payload?.button_id === 0)
    expect(ignored?.payload?.previous_button_id).toBe(96)
    expect(ignored?.payload?.reason).toBe("double_tap")
  })

  it("3 toques em 'Já paguei' (< 2 s): 1 caso, 1 eco [96], 1 'Obrigado por avisar…'; os demais devolvem o mesmo estado", async () => {
    const { POST: REOPEN } = await import("@/app/api/chat/reopen/route")
    const jwt = await signed()
    await bootstrap()
    const b1 = await (await REOPEN(req(jwt, { action: "payment_claim" }))).json()
    const b2 = await (await REOPEN(req(jwt, { action: "payment_claim" }))).json()
    const b3 = await (await REOPEN(req(jwt, { action: "payment_claim" }))).json()
    expect(b1.claim_registered).toBe(true)
    expect(b2.duplicate).toBe(true)
    expect(b3.duplicate).toBe(true)
    expect(claimCases().length).toBe(1)
    expect(claimBubbles().length).toBe(1)
    expect(db.chat_messages.filter((m) => m.role === "customer" && m.button_id === 96).length).toBe(1)
    expect(events.filter((e) => e.type === "payment_claim.registered").length).toBe(1)
    for (const b of [b2, b3]) expect(b.prompt?.kind).toBe("debt_three_options")
  })

  it("'Não reconheço' legítimo (≥ 2 s depois de outro clique) grava e segue como hoje", async () => {
    const { POST: REOPEN } = await import("@/app/api/chat/reopen/route")
    const { POST: BUTTON } = await import("@/app/api/chat/button/route")
    const menu = await bootstrap()
    const jwt = await signed()
    await REOPEN(req(jwt, { action: "payment_claim" }))
    ageClicks()
    const b = await (await BUTTON(req(jwt, { prompt_id: menu.id, button_id: 0 }))).json()
    expect(b.ignored).toBeUndefined()
    expect(b.action).toBe("not_recognized")
    expect(negativeAcks().length).toBe(1)
    expect(b.prompt?.buttons?.map((x: { id: number }) => x.id)).toEqual([98])
  })

  it("Pagar do menu que acabou de nascer sob o dedo (Detalhes → Pagar < 2 s): ignorado, 0 acordo; o menu volta no corpo", async () => {
    const { POST: BUTTON } = await import("@/app/api/chat/button/route")
    const menu = await bootstrap()
    const jwt = await signed()
    await BUTTON(req(jwt, { prompt_id: menu.id, button_id: 2 }))
    const reopened = db.chat_prompts.find((p) => p.status === "active")!
    const b = await (await BUTTON(req(jwt, { prompt_id: reopened.id, button_id: 4 }))).json()
    expect(b.ignored).toBe("double_tap")
    expect(db.agreements.length).toBe(0)
    expect(b.prompt?.id).toBe(reopened.id)
    expect(reopened.status).toBe("active") // nada respondido
  })

  it("o eco do 'Já paguei' é gravado com button_id 96 ANTES do resultado e volta no corpo com o resultado e o menu", async () => {
    const { POST: REOPEN } = await import("@/app/api/chat/reopen/route")
    await bootstrap()
    const b = await (await REOPEN(req(await signed(), { action: "payment_claim" }))).json()
    expect(b.echo?.button_id).toBe(96)
    expect(b.echo?.text).toBe("Já paguei este valor")
    expect(b.outcome?.stage).toBe("payment_claim")
    expect(b.outcome?.text).toMatch(/^Obrigado por avisar/)
    const echoRow = db.chat_messages.find((m) => m.id === b.echo.id)!
    const outRow = db.chat_messages.find((m) => m.id === b.outcome.id)!
    expect(Date.parse(echoRow.created_at)).toBeLessThanOrEqual(Date.parse(outRow.created_at))
    expect(db.chat_messages.indexOf(echoRow)).toBeLessThan(db.chat_messages.indexOf(outRow))
    // nunca declara pago
    expect(b.outcome.text.toLowerCase()).not.toMatch(/pagamento (confirmado|recebido)|quitad/)
  })
})

describe("client — bloco de ações inerte (tap-guard)", () => {
  it("janelas: toque ≥ 700 ms; bloco que nasce/se desloca = arming das saídas (2,5 s ≥ janela do servidor)", () => {
    expect(TAP_INERT_MS).toBeGreaterThanOrEqual(700)
    expect(ACTIONS_ARM_MS).toBe(WAIT_EXITS_ARM_MS)
    expect(ACTIONS_ARM_MS).toBeGreaterThanOrEqual(DOUBLE_TAP_WINDOW_MS)
  })

  it("extendInertUntil nunca encurta; isInert respeita o voo", () => {
    expect(extendInertUntil(5000, 1000, 900)).toBe(5000)
    expect(extendInertUntil(0, 1000, 900)).toBe(1900)
    expect(isInert(1900, 1800)).toBe(true)
    expect(isInert(1900, 1900)).toBe(false)
    expect(isInert(0, 1900, true)).toBe(true)
  })

  it("shouldRearm: prompt novo, bloco que aparece, deslocamento > 4 px (coordenada da página); rolagem não conta", () => {
    expect(shouldRearm(null, { promptId: "p1", top: 500 })).toBe(true)
    expect(shouldRearm({ promptId: "p1", top: 500 }, { promptId: "p2", top: 500 })).toBe(true)
    expect(shouldRearm({ promptId: "p1", top: 500 }, { promptId: "p1", top: 560 })).toBe(true) // o log cresceu
    expect(shouldRearm({ promptId: "p1", top: 500 }, { promptId: "p1", top: 503 })).toBe(false)
    expect(shouldRearm({ promptId: "p1", top: 500 }, { promptId: null, top: null })).toBe(false)
  })

  it("chat.tsx/PromptButtons: toque arma o bloco; Já paguei fica NO LUGAR desabilitado", () => {
    const root = join(__dirname, "..", "..")
    const chat = readFileSync(join(root, "components/journey/chat.tsx"), "utf8")
    const pb = readFileSync(join(root, "components/journey/prompt-buttons.tsx"), "utf8")
    // (Correção B8: inércia ancorada no último toque; toque inerte avisa — ver qa4-b8-inert-ignored)
    expect(chat).toMatch(/resetIdle\(\)\s*\/\/[^\n]*\n[^\n]*\n\s*armOnTap\(\)/)
    expect(chat).toMatch(/async function requestPaymentClaim\(\) \{\s*if \(claimInFlightRef\.current\) return/)
    expect(chat).toContain("inert={actionsInert || claimInFlight}")
    expect(chat).not.toContain("!claimSent")
    expect(chat).toContain("if (shouldRearm(actionBlockPosRef.current, next)) rearmFromLastTap()")
    expect(pb).toContain("aria-disabled={answered || pending !== null || inert || undefined}")
  })
})
