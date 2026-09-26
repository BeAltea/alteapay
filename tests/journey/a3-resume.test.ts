// A3 (§2.2 / §2.4 / G4 / G7) — RETOMADA. Roda o MESMO pipeline do client
// (chat.tsx) sobre a fixture sintética da sessão de teste (3 gerações na mesma
// época, cliques repetidos, bolhas antigas com valor, link vivo) e prova:
// retomada = {saudação de retorno, último outcome, menu} + N ocultas; "Ver
// conversa completa" presente; valor só no card e no outcome; uma só pergunta.
// Também exercita a ROTA real GET /api/chat/messages (anotação de geração no
// servidor + recap com primeiro nome) contra o fake supabase.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"
import { RESUME_ACTIVE_PROMPT, RESUME_MESSAGES, RESUME_PROMPTS } from "./fixtures/a3-session-resume"
import { CURRENT_GENERATION, annotateMessageGenerations } from "@/lib/journey/display-class"
import {
  capHistory,
  classOf,
  collapseConsecutiveDecisions,
  currentGenerationOf,
  dedupAssistantByContent,
  prunePresentation,
  splitResumeHistory,
  stripDuplicateQuestion,
  type ChatMsg,
} from "@/components/journey/chat-display"
import { returnGreeting } from "@/lib/journey/recap"
import type { WaitState } from "@/lib/journey/wait-machine"

process.env.CHAT_JOURNEY_ENABLED = "true"
process.env.NEGOTIATION_JWT_SECRET = "test-secret-a3-resume"

let db: FakeDb
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/journey/events", () => ({
  recordEvent: async () => ({ ok: true, duplicate: false }),
  getTimeline: async () => [],
}))

// ---------------------------------------------------------------------------
// Espelho do GET /api/chat/messages (action/stage do offers_snapshot + geração)
// e do pollMessages do client (ChatMsg com generation/createdAt).
// ---------------------------------------------------------------------------
function serverRows() {
  const mapped = RESUME_MESSAGES.map((m) => {
    const snap = m.offers_snapshot
    const action = snap && snap.message_action ? snap.message_action : null
    const stage = snap && typeof snap.stage === "string" ? snap.stage : null
    return {
      id: m.id,
      role: m.role,
      text: m.text,
      button_id: m.button_id,
      prompt_id: m.prompt_id,
      engine: m.engine,
      created_at: m.created_at,
      ...(action ? { action } : {}),
      ...(stage ? { stage } : {}),
    }
  })
  return annotateMessageGenerations(mapped, RESUME_PROMPTS)
}

function toChatMsgs(rows: ReturnType<typeof serverRows>): ChatMsg[] {
  return rows.map((m) => {
    const a = (m as { action?: { type: string; label: string; href: string } }).action
    return {
      id: m.id,
      from: m.role === "customer" ? "customer" : "assistant",
      text: m.text,
      action: a ? { type: a.type, label: a.label, href: a.href } : null,
      promptId: m.prompt_id ?? null,
      engine: m.engine ?? null,
      buttonId: m.button_id ?? null,
      stage: (m as { stage?: string | null }).stage ?? null,
      generation: m.generation,
      createdAt: m.created_at,
    }
  })
}

interface RenderOpts {
  messages?: ChatMsg[]
  activePrompt?: typeof RESUME_ACTIVE_PROMPT | null
  cutoffAt?: string | null
  expanded?: boolean
  recapText?: string | null
  waitState?: WaitState
}

/** O pipeline de apresentação de chat.tsx, na mesma ordem. */
function render(opts: RenderOpts = {}) {
  const messages = opts.messages ?? toChatMsgs(serverRows())
  const activePrompt = opts.activePrompt === undefined ? RESUME_ACTIVE_PROMPT : opts.activePrompt
  const expanded = opts.expanded ?? false
  const waitState = opts.waitState ?? "idle"
  const activePromptId = activePrompt?.id ?? null
  const currentGeneration = expanded ? null : currentGenerationOf(messages, activePrompt?.kind ?? null)
  const visibleMessages = messages.filter((m) => !(activePrompt && m.promptId && m.promptId === activePrompt.id))
  const pruned = prunePresentation(visibleMessages, activePromptId, waitState, currentGeneration)
  const collapsed = collapseConsecutiveDecisions(pruned, activePromptId, waitState, currentGeneration)
  const deduped = dedupAssistantByContent(collapsed)
  const resume = splitResumeHistory(deduped, {
    cutoffAt: opts.cutoffAt === undefined ? RESUME_ACTIVE_PROMPT.created_at : opts.cutoffAt,
    expanded,
    activePromptId,
    waitState,
    currentGeneration,
  })
  const capped = capHistory(resume.visible, activePromptId, waitState, { expanded, currentGeneration })
  const hiddenCount = resume.collapsed.length + capped.collapsed.length
  const recap = opts.recapText === undefined ? returnGreeting("Ana") : opts.recapText
  const promptForRender = activePrompt && recap ? stripDuplicateQuestion(activePrompt, recap) : activePrompt
  return { visible: capped.visible, hiddenCount, promptForRender, resume, recap, currentGeneration, deduped, activePromptId, waitState }
}

const VALUE = /R\$\s?250,00/

describe("RETOMADA (A3 / §2.2) — pipeline do client sobre a sessão de teste", () => {
  it("retomada = {saudação de retorno, último outcome (link), menu} + N ocultas", () => {
    const r = render()
    // saudação de retorno (Apêndice B) — a única saudação da tela
    expect(r.recap).toBe("Olá de novo, Ana. Você já viu os detalhes do valor em aberto. Como prefere seguir?")
    // no log: EXATAMENTE o último outcome (o link vivo), nada mais
    expect(r.visible.map((m) => m.id)).toEqual(["m46"])
    expect(r.visible[0].stage).toBe("payment_link")
    expect(r.visible[0].action?.type).toBe("open_payment_link")
    // menu corrente presente (o bloco de botões vem do active_prompt)
    expect(r.promptForRender).toBeTruthy()
    expect(r.promptForRender!.buttons.some((b) => b.id === 4)).toBe(true)
    // algo ficou recolhido → "Ver conversa completa" presente
    expect(r.hiddenCount).toBeGreaterThan(0)
    expect(r.resume.lastOutcomeId).toBe("m46")
  })

  it("a saudação original (stage=greeting) NÃO aparece na retomada — uma só saudação na tela", () => {
    const r = render()
    expect(r.visible.some((m) => m.stage === "greeting")).toBe(false)
    expect(r.resume.collapsed.some((m) => m.id === "m27")).toBe(true) // está recolhida, não perdida
  })

  it("valor só no card e no outcome: nenhuma bolha visível com R$ fora de outcome (1 ocorrência no log)", () => {
    const r = render()
    const withValue = r.visible.filter((m) => VALUE.test(m.text))
    expect(withValue).toHaveLength(1)
    expect(withValue.every((m) => classOf(m, r.activePromptId, r.waitState, r.currentGeneration) === "outcome")).toBe(true)
  })

  it("gerações anteriores (Sim/Não, Consultar/Negociar, motor entre elas) são superseded — nem na tela nem no recolhido", () => {
    const r = render()
    const legacyIds = ["m01", "m02", "m03", "m04", "m05", "m06", "m07", "m08", "m09", "m10", "m11", "m12", "m13"]
    const everywhere = new Set([...r.visible, ...r.resume.collapsed].map((m) => m.id))
    for (const id of legacyIds) expect(everywhere.has(id)).toBe(false)
    expect(r.currentGeneration).toBe(CURRENT_GENERATION)
  })

  it("decisions consecutivas iguais colapsaram (Pagar › Pagar sem outcome entre eles → uma)", () => {
    const r = render()
    const ids = r.deduped.map((m) => m.id)
    expect(ids).not.toContain("m44")
    expect(ids).toContain("m45")
    // QA round 1 (F-QAA3-1 / QAA1-06): Detalhes › detalhe › Detalhes › MESMO detalhe
    // é o MESMO par clique→resposta repetido → fica o último par (m31 + m32), nunca
    // um eco órfão sem resposta (antes: o dedup apagava m29 e m28 ficava "mudo").
    expect(ids).not.toContain("m28")
    expect(ids).not.toContain("m29")
    expect(ids).toContain("m31")
    expect(ids).toContain("m32")
  })

  it("uma só pergunta na tela: menu em modo reopen ('Como prefere seguir?') sob a saudação de retorno vem sem pergunta", () => {
    const reopen = { ...RESUME_ACTIVE_PROMPT, id: "p18r", question: "Como prefere seguir?" }
    const r = render({ activePrompt: reopen })
    expect(r.promptForRender!.question).toBe("")
    // pergunta diferente (menu-volta do não reconheço) permanece
    const back = { ...RESUME_ACTIVE_PROMPT, id: "p18b", question: "Se preferir, você pode voltar às opções." }
    expect(render({ activePrompt: back }).promptForRender!.question).toBe("Se preferir, você pode voltar às opções.")
    // sem retomada (recap null) nada é alterado
    expect(render({ activePrompt: reopen, recapText: null }).promptForRender!.question).toBe("Como prefere seguir?")
  })

  it("'Ver conversa completa' (expanded): o histórico volta, inclusive as gerações anteriores; nada recolhido", () => {
    const r = render({ expanded: true })
    const ids = r.visible.map((m) => m.id)
    expect(ids).toContain("m01") // Sim, reconheço (G0) volta como decision
    expect(ids).toContain("m27") // saudação original
    expect(ids).toContain("m46")
    expect(r.hiddenCount).toBe(0)
    expect(r.currentGeneration).toBeNull()
  })

  it("1º login (sem recap/corte): saudação única + o que a poda por classe deixa; gerações anteriores continuam fora", () => {
    const r = render({ cutoffAt: null, recapText: null })
    const ids = r.visible.map((m) => m.id)
    expect(ids).toContain("m27")
    expect(ids).not.toContain("m01")
    expect(ids).toContain("m46")
  })

  it("conversa NOVA após a retomada aparece: bolhas depois do corte e bolhas locais (sem createdAt) ficam visíveis", () => {
    const base = toChatMsgs(serverRows())
    const after: ChatMsg = {
      id: "new-1",
      from: "assistant",
      text: DETAIL_AFTER,
      action: null,
      promptId: "p18",
      stage: "detail",
      generation: CURRENT_GENERATION,
      createdAt: "2026-09-05T08:00:30Z",
    }
    const local: ChatMsg = { id: "optimistic-1", from: "assistant", text: "Certo. Vou buscar as condições…", action: null, promptId: null }
    // o clique respondeu p18 e o servidor reabriu o menu (p19); o corte da
    // retomada continua sendo o created_at de p18 (fixado no 1º poll).
    const reopened = { ...RESUME_ACTIVE_PROMPT, id: "p19", question: "Como prefere seguir?", created_at: "2026-09-05T08:00:31Z" }
    const r = render({ messages: [...base, after, local], activePrompt: reopened })
    const ids = r.visible.map((m) => m.id)
    expect(ids).toEqual(["m46", "new-1", "optimistic-1"])
  })

  it("último outcome: um desfecho (não reconheço / já paguei) também é preservado; 'detail' não conta", () => {
    const base = toChatMsgs(serverRows())
    // corta ANTES do link m46: o último outcome não-detalhe é o não-reconheço (m35)
    const r = render({ messages: base.filter((m) => !["m40", "m46"].includes(m.id)) })
    expect(r.resume.lastOutcomeId).toBe("m35")
    expect(r.visible.map((m) => m.id)).toEqual(["m35"])
  })

  it("sem prompt ativo na retomada (corte = server_time): tudo recolhido, salvo o último outcome", () => {
    const r = render({ activePrompt: null, cutoffAt: "2026-09-05T08:00:00Z" })
    expect(r.visible.map((m) => m.id)).toEqual(["m46"])
    expect(r.hiddenCount).toBeGreaterThan(0)
  })
})

const DETAIL_AFTER = "Este valor tem vencimento original em 15/08/2026 e refere-se a um serviço da VMAX. (nova)"

// ---------------------------------------------------------------------------
// ROTA real: GET /api/chat/messages anota prompt_kind/generation e o recap traz
// a saudação de retorno com o primeiro nome (customers.name).
// ---------------------------------------------------------------------------
const CO = "eeeeeeee-0000-0000-0000-00000000a3r1"
const SID = "sess-a3-resume"
const CUST = "cust-a3-resume"
const DEBT = "debt-a3-resume"

function seed() {
  db = {
    tenant_chat_config: [{ company_id: CO, acknowledgement_enabled: true, show_handoff_button: false, branding: { brand_name: "VMAX" } }],
    companies: [{ id: CO, name: "VMAX LTDA" }],
    customers: [{ id: CUST, company_id: CO, name: "Ana Souza", document: "11144477735" }],
    debts: [{ id: DEBT, company_id: CO, customer_id: CUST, status: "pending", amount: 250, due_date: "2026-08-15" }],
    vmax_invoices: [],
    negotiation_sessions: [{
      id: SID, company_id: CO, customer_id: CUST, debt_id: DEBT, primary_debt_id: DEBT, debt_ids: [DEBT],
      thread_epoch: 0, wait_state: null, wait_started_at: null,
    }],
    chat_prompts: [
      { id: "p-ack", session_id: SID, company_id: CO, kind: "debt_acknowledgement", status: "answered", question: "?", buttons: [], created_at: "2026-09-01T10:00:00Z" },
      { id: "p-three", session_id: SID, company_id: CO, kind: "debt_three_options", status: "active", question: "", buttons: [{ id: 4, label: "Pagar R$ 250,00", order: 0 }], created_at: "2026-09-05T08:00:00Z" },
    ],
    chat_messages: [
      { id: "c1", session_id: SID, company_id: CO, role: "customer", text: "Sim, reconheço", button_id: 1, prompt_id: "p-ack", created_at: "2026-09-01T10:00:10Z" },
      { id: "n1", session_id: SID, company_id: CO, role: "assistant", text: "Muito obrigado pela confirmação!", engine: "n8n", created_at: "2026-09-01T10:01:00Z" },
      { id: "g1", session_id: SID, company_id: CO, role: "assistant", text: "Olá, Ana. Encontramos um valor em aberto…", offers_snapshot: { stage: "greeting" }, created_at: "2026-09-05T08:00:01Z" },
    ],
    debt_acknowledgements: [],
    debt_acknowledgement_latest: [],
    agreements: [],
  }
}

function makeReq(cookie: string, since?: string) {
  const url = since ? `https://x.test/api/chat/messages?since=${encodeURIComponent(since)}` : "https://x.test/api/chat/messages"
  return {
    cookies: { get: (n: string) => (n === "alteapay_chat_session" ? { value: cookie } : undefined) },
    nextUrl: new URL(url),
  } as any
}

describe("GET /api/chat/messages — anotação de geração no servidor + recap de retorno (A3)", () => {
  beforeEach(seed)

  it("cada mensagem sai com prompt_kind e generation (join em memória com chat_prompts)", async () => {
    const { GET } = await import("@/app/api/chat/messages/route")
    const { signChatJwt } = await import("@/lib/negotiation/crypto")
    const cookie = signChatJwt({ sid: SID, cid: CO }, 3600)
    const body = await (await GET(makeReq(cookie))).json()
    const byId = Object.fromEntries(body.messages.map((m: any) => [m.id, m]))
    expect(byId.c1.prompt_kind).toBe("debt_acknowledgement")
    expect(byId.c1.generation).toBe(0)
    expect(byId.n1.prompt_kind).toBe("debt_acknowledgement") // janela entre prompts → o prompt que a abriu
    expect(byId.n1.generation).toBe(0)
    expect(byId.g1.prompt_kind).toBe("debt_three_options")
    expect(byId.g1.generation).toBe(CURRENT_GENERATION)
    expect(byId.g1.stage).toBe("greeting")
    // o menu corrente continua sendo o active_prompt (com created_at para o corte da retomada)
    expect(body.active_prompt.id).toBe("p-three")
    expect(typeof body.active_prompt.created_at).toBe("string")
  })

  it("recap (só sem `since`) = saudação de retorno com o primeiro nome do cliente", async () => {
    const { GET } = await import("@/app/api/chat/messages/route")
    const { signChatJwt } = await import("@/lib/negotiation/crypto")
    const cookie = signChatJwt({ sid: SID, cid: CO }, 3600)
    const body = await (await GET(makeReq(cookie))).json()
    expect(body.recap).toBeTruthy()
    expect(body.recap.text).toBe("Olá de novo, Ana. Você já viu os detalhes do valor em aberto. Como prefere seguir?")
    expect(body.recap.firstName).toBe("Ana")
    expect(body.recap.lastDecisionLabel).toBe("Sim, reconheço")
    const inc = await (await GET(makeReq(cookie, "2026-09-01T00:00:00Z"))).json()
    expect(inc.recap).toBeNull()
  })

  it("buildRecap: sem nome do cliente cai no genérico; firstName do chamador tem precedência", async () => {
    const { buildRecap } = await import("@/lib/journey/recap")
    db.customers = []
    const r1 = await buildRecap(SID, CO)
    expect(r1!.text).toBe("Olá de novo. Você já viu os detalhes do valor em aberto. Como prefere seguir?")
    expect(r1!.firstName).toBeNull()
    const r2 = await buildRecap(SID, CO, { firstName: "Bia" })
    expect(r2!.text).toMatch(/^Olá de novo, Bia\./)
    expect(returnGreeting("  ")).toBe("Olá de novo. Você já viu os detalhes do valor em aberto. Como prefere seguir?")
  })

  it("debtInfoMessage (guidance legada) não traz mais o valor — o valor mora no card e nos outcomes", async () => {
    const { debtInfoMessage } = await import("@/lib/journey/acknowledgement")
    const text = debtInfoMessage({ firstName: "Ana", creditorName: "VMAX", updatedValue: 250, invoiceCount: 1, oldestDueDate: "2026-08-15" })
    expect(text).not.toMatch(/R\$/)
    // A4/S24 (plural condicional): "1 fatura" / "2 faturas".
    expect(text).toMatch(/1 fatura\b/)
    // formatDatePt (pré-existente, fora desta trilha) formata a data no fuso local:
    // em UTC-3 "2026-08-15" sai como 14/08 — o teste aceita os dois (a data em si é da A4).
    expect(text).toMatch(/1[45]\/08\/2026/)
    expect(debtInfoMessage({ firstName: "", creditorName: "VMAX", updatedValue: 250, invoiceCount: 0, oldestDueDate: "2026-08-15" })).not.toMatch(/fatura/)
  })
})
