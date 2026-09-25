// QA round 2 — QAB1-H2 (MÉDIO): 2º clique com prompt OBSOLETO enquanto o vencedor
// ainda processa nunca é mudo. O servidor devolve 409 { prompt_stale,
// active_prompt:null } (o prompt seguinte ainda não existe) ou 200 { duplicate:
// true } sem `prompt`; o client mostra "Já estou processando a sua escolha." e
// mantém o poll até o próximo prompt/outcome — nunca reabilita o mesmo menu.
// Rota real + regra pura (click-feedback.ts) + leitura do fonte de chat.tsx.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

process.env.CHAT_JOURNEY_ENABLED = "true"
process.env.NEGOTIATION_JWT_SECRET = "test-secret-qa2-stale"

const CO = "eeeeeeee-0000-0000-0000-000000qa2st1"
const SID = "sess-qa2-stale"
const CUST = "cust-qa2-stale"
const DEBT = "debt-qa2-stale"

let db: FakeDb
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/asaas", () => ({ getAsaasPaymentsForCustomer: async () => [] }))
vi.mock("@/lib/notifications/email", () => ({ sendEmail: async () => ({ ok: true }) }))
vi.mock("@/lib/journey/events", () => ({
  recordEvent: async () => ({ ok: true, duplicate: false }),
  getTimeline: async () => [],
}))
vi.mock("@/lib/journey/closing", () => ({
  buildAcceptSummary: async () => ({ ok: true, summary: { termsHash: "h", terms: {}, validUntil: null } }),
  confirmAccept: async () => ({ ok: false, error: "never_called" }),
}))
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
function seed() {
  db = {
    tenant_chat_config: [{
      company_id: CO, payment_origin: "platform", allow_payment_without_acknowledgement: true,
      acknowledgement_enabled: true, show_handoff_button: false, on_debt_not_recognized: "continue",
      official_channel_label: null, official_channel_url: null, branding: { brand_name: "VMAX" }, creditor_notification_emails: [],
    }],
    companies: [{ id: CO, name: "VMAX LTDA" }],
    customers: [{ id: CUST, company_id: CO, name: "Fabio Mendes", document: "11144477735" }],
    debts: [{ id: DEBT, company_id: CO, customer_id: CUST, status: "pending", amount: 250, due_date: "2026-08-15" }],
    vmax_invoices: [{ id_company: CO, doc: "11144477735", fatura: "F1", vencimento: "2026-08-15", saldo: 250 }],
    negotiation_sessions: [{ id: SID, company_id: CO, customer_id: CUST, debt_id: DEBT, agreement_id: null, debt_acknowledged_at: null, thread_epoch: 0 }],
    negotiation_offers: [], negotiation_condition_matrix: [MATRIX], negotiation_acceptances: [], negotiation_cases: [],
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
/** O vencedor (outra aba) respondeu o menu com `buttonId` há instantes e AINDA não
 *  criou o prompt seguinte (janela Detalhes 2,4–5,6 s / Pagar 11–16 s). */
function winnerStillProcessing(prompt: Record<string, any>, buttonId: number) {
  prompt.status = "answered"
  prompt.answered_button_id = buttonId
  prompt.answered_at = new Date().toISOString()
}

describe("QAB1-H2 servidor — 409 sem active_prompt / duplicate sem prompt na janela do vencedor", () => {
  beforeEach(seed)

  it("Negociar num menu já respondido por DETALHES (vencedor ainda processa) → 409 prompt_stale com active_prompt:null → feedback 'processing'", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    const { staleClickFeedback } = await import("@/lib/journey/click-feedback")
    const p1 = await bootstrap()
    winnerStillProcessing(p1, 2)
    const res = await POST(req(await signed(), { prompt_id: p1.id, button_id: 1 }))
    const b = await res.json()
    expect(res.status).toBe(409)
    expect(b.code).toBe("prompt_stale")
    expect(b.active_prompt).toBeNull()
    expect(staleClickFeedback(b)).toBe("processing")
    // nenhum efeito novo: 0 eco, 0 prompt novo
    expect(db.chat_messages.filter((m) => m.role === "customer").length).toBe(0)
    expect(db.chat_prompts.length).toBe(1)
  })

  it("Negociar no menu obsoleto quando o vencedor JÁ criou outro prompt (parcelas) → 409 com active_prompt → feedback 'rehydrate'", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    const { staleClickFeedback } = await import("@/lib/journey/click-feedback")
    const p1 = await bootstrap()
    // vencedor = Negociar de verdade (cria o offer_choice); depois o 2º clique chega
    await POST(req(await signed(), { prompt_id: p1.id, button_id: 1 }))
    const b = await (await POST(req(await signed(), { prompt_id: p1.id, button_id: 2 }))).json()
    expect(b.code).toBe("prompt_stale")
    expect(b.active_prompt?.kind).toBe("offer_choice")
    expect(staleClickFeedback(b)).toBe("rehydrate")
  })

  it("MESMO botão duplicado enquanto o vencedor processa → 200 duplicate com prompt:null → feedback 'processing'", async () => {
    const { POST } = await import("@/app/api/chat/button/route")
    const { staleClickFeedback } = await import("@/lib/journey/click-feedback")
    const p1 = await bootstrap()
    winnerStillProcessing(p1, 2)
    const b = await (await POST(req(await signed(), { prompt_id: p1.id, button_id: 2 }))).json()
    expect(b).toMatchObject({ ok: true, duplicate: true })
    expect(b.prompt).toBeNull()
    expect(staleClickFeedback(b)).toBe("processing")
  })
})

describe("QAB1-H2 regras puras (click-feedback.ts)", () => {
  it("toRenderablePrompt: só id/kind string + ≥ 1 botão {id:number,label:string}", async () => {
    const { toRenderablePrompt } = await import("@/lib/journey/click-feedback")
    expect(toRenderablePrompt(null)).toBeNull()
    expect(toRenderablePrompt({ id: "p", kind: "k", buttons: [] })).toBeNull()
    expect(toRenderablePrompt({ id: "p", kind: "k", buttons: [{ id: "x", label: "y" }] })).toBeNull()
    expect(toRenderablePrompt({ id: "p", kind: "k", buttons: [{ id: 1, label: "Negociar" }] })).toEqual({ id: "p", kind: "k", question: "", buttons: [{ id: 1, label: "Negociar" }] })
  })

  it("staleClickFeedback: prompt renderizável em active_prompt OU prompt → rehydrate; senão processing (nunca mudo)", async () => {
    const { staleClickFeedback, PROCESSING_CHOICE_NOTICE } = await import("@/lib/journey/click-feedback")
    const p = { id: "p2", kind: "debt_three_options", question: "Como prefere seguir?", buttons: [{ id: 4, label: "Pagar R$ 250,00" }] }
    expect(staleClickFeedback({ active_prompt: p })).toBe("rehydrate")
    expect(staleClickFeedback({ prompt: p })).toBe("rehydrate")
    expect(staleClickFeedback({ active_prompt: null })).toBe("processing")
    expect(staleClickFeedback({ prompt: null, duplicate: true } as any)).toBe("processing")
    expect(staleClickFeedback(null)).toBe("processing")
    expect(staleClickFeedback({ active_prompt: { id: "x", kind: "k", buttons: [] } })).toBe("processing")
    expect(PROCESSING_CHOICE_NOTICE).toBe("Já estou processando a sua escolha.")
    expect(PROCESSING_CHOICE_NOTICE).not.toMatch(/n8n|erro|http|prompt/i)
  })
})

describe("QAB1-H2 client (chat.tsx) — wire-up (leitura do fonte)", () => {
  const src = readFileSync(join(__dirname, "..", "..", "components", "journey", "chat.tsx"), "utf8")
  const click = src.slice(src.indexOf("async function clickButton("), src.indexOf("function startPayLongWait()"))

  it("409 sem prompt → aviso de processamento, bloco de botões consumido (setActivePrompt(null)), poll e ok:true (nunca o mesmo menu reabilitado)", () => {
    const branch = click.slice(click.indexOf('if (res.status === 409 && (data?.code === "prompt_stale"'))
    const processing = branch.slice(branch.indexOf('if (staleClickFeedback(data) === "processing") {'), branch.indexOf("setPromptNotice(PROMPT_STALE_NOTICE)"))
    expect(processing).toContain("setActivePrompt(null)")
    expect(processing).toContain("setProcessingNotice(PROCESSING_CHOICE_NOTICE)")
    expect(processing).toContain("await pollMessages()")
    expect(processing).toContain("return { ok: true }")
    // com prompt no corpo continua o caminho A1 (aviso + re-hidratação)
    expect(branch).toContain("setPromptNotice(PROMPT_STALE_NOTICE)")
    expect(branch).toContain("const stalePrompt = asActivePrompt(data?.active_prompt)")
  })

  it("duplicate sem prompt (não-Pagar) → mesmo aviso + poll", () => {
    const dup = click.slice(click.indexOf("if (res.ok && data?.duplicate === true) {"), click.indexOf('if (isPay && data && data.action === "pay") {'))
    expect(dup).toContain('else if (staleClickFeedback(data) === "processing") {')
    expect(dup).toContain("setProcessingNotice(PROCESSING_CHOICE_NOTICE)")
  })

  it("o aviso renderiza FORA do bloco condicionado ao prompt ativo e some quando o próximo prompt/outcome chega pelo poll", () => {
    const noticeIdx = src.indexOf("{processingNotice && !ended ? (")
    const promptBlockIdx = src.indexOf("{activePrompt && !ended ? (\n        // R8")
    expect(noticeIdx).toBeGreaterThan(0)
    expect(promptBlockIdx).toBeGreaterThan(noticeIdx)
    const poll = src.slice(src.indexOf("async function pollMessages("), src.indexOf("function reconcilePayWait("))
    expect(poll).toContain("if (ap) setProcessingNotice(null)")
    expect(poll).toContain("OUTCOME_STAGES.has(m.stage)")
    expect(poll).toContain("setProcessingNotice(null)")
    // um clique novo limpa o aviso anterior
    expect(click).toContain("setProcessingNotice(null)")
  })
})
