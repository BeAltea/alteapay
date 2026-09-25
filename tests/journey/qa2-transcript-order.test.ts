// QA round 2 — QAA2-01 (MÉDIO): ordem da transcrição. A bolha OTIMISTA do
// Negociar ("Certo. Estas são as condições…") nascia no clique e ficava ACIMA do
// eco "Negociar" persistido (que chega pelo poll) sempre que a confirmação T2 não
// era persistida de novo (dedup de conteúdo de 15 min no servidor: 2ª apresentação
// e retomada). Agora, ao chegar o eco do clique, a otimista é recolocada logo
// depois dele — a ordem do banco (eco → confirmação → parcelas). Regra pura em
// chat-display.ts + pipeline de render + leitura do fonte de chat.tsx.
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  dedupAssistantByContent,
  NEGOTIATION_PENDING_TEXT,
  placeAfterCustomerEcho,
  resolvePromptForRender,
  type ChatMsg,
} from "@/components/journey/chat-display"

const a = (id: string, text: string, extra: Partial<ChatMsg> = {}): ChatMsg => ({ id, from: "assistant", text, action: null, promptId: null, ...extra })
const c = (id: string, text: string, buttonId: number, createdAt: string): ChatMsg => ({ id, from: "customer", text, action: null, promptId: "p1", buttonId, createdAt })

describe("QAA2-01 regra pura — placeAfterCustomerEcho", () => {
  it("o eco entra e a otimista vai para logo depois dele (o resto da ordem fica)", () => {
    const greeting = a("g", "Olá, Fabio. Como você prefere seguir?", { stage: "greeting", createdAt: "2026-09-25T20:30:00Z" })
    const opt = a("optimistic-neg-1", NEGOTIATION_PENDING_TEXT)
    const echo = c("e1", "Negociar", 1, "2026-09-25T20:31:03.045Z")
    const out = placeAfterCustomerEcho([greeting, opt], "optimistic-neg-1", echo)
    expect(out.map((m) => m.id)).toEqual(["g", "e1", "optimistic-neg-1"])
  })

  it("otimista ausente (já removida) ou id null → só o eco é anexado", () => {
    const echo = c("e1", "Negociar", 1, "2026-09-25T20:31:03.045Z")
    expect(placeAfterCustomerEcho([a("g", "x")], "optimistic-neg-9", echo).map((m) => m.id)).toEqual(["g", "e1"])
    expect(placeAfterCustomerEcho([a("g", "x")], null, echo).map((m) => m.id)).toEqual(["g", "e1"])
  })
})

describe("QAA2-01 pipeline — a pergunta do offer_choice nunca aparece acima do eco 'Negociar'", () => {
  const offerPrompt = { id: "oc-2", kind: "offer_choice", question: NEGOTIATION_PENDING_TEXT, buttons: [{ id: 2, label: "À vista R$ 237,50" }, { id: 98, label: "Voltar às opções" }] }

  it("1ª apresentação: eco → otimista; a T2 persistida chega depois e o dedup fica com ela (ordem: eco, T2)", () => {
    let list: ChatMsg[] = [a("g", "Olá, Fabio.", { stage: "greeting" }), a("optimistic-neg-1", NEGOTIATION_PENDING_TEXT)]
    list = placeAfterCustomerEcho(list, "optimistic-neg-1", c("e1", "Negociar", 1, "2026-09-25T20:30:13.1Z"))
    list = [...list, a("t2", NEGOTIATION_PENDING_TEXT, { createdAt: "2026-09-25T20:30:13.9Z" })]
    const visible = dedupAssistantByContent(list)
    expect(visible.map((m) => m.id)).toEqual(["g", "e1", "t2"])
    expect(visible.findIndex((m) => m.id === "e1")).toBeLessThan(visible.findIndex((m) => m.text === NEGOTIATION_PENDING_TEXT))
  })

  it("2ª apresentação (T2 deduplicada no servidor, só a otimista): eco ANTES da confirmação; a pergunta do prompt não repete a frase", () => {
    const history: ChatMsg[] = [
      c("e1", "Negociar", 1, "2026-09-25T20:30:13Z"),
      a("t2", NEGOTIATION_PENDING_TEXT, { createdAt: "2026-09-25T20:30:14Z" }),
      c("e-back", "Voltar às opções", 98, "2026-09-25T20:30:40Z"),
      a("menu-q", "Como prefere seguir?", { promptId: "p2", createdAt: "2026-09-25T20:30:41Z" }),
    ]
    // clique: otimista no fim; depois o eco chega pelo poll → recolocação
    let list: ChatMsg[] = [...history, a("optimistic-neg-2", NEGOTIATION_PENDING_TEXT)]
    list = placeAfterCustomerEcho(list, "optimistic-neg-2", c("e2", "Negociar", 1, "2026-09-25T20:31:03.045Z"))
    const visible = dedupAssistantByContent(list.filter((m) => m.promptId !== "oc-2"))
    const iEcho = visible.findIndex((m) => m.id === "e2")
    const iOpt = visible.findIndex((m) => m.id === "optimistic-neg-2")
    expect(iEcho).toBeGreaterThan(-1)
    expect(iOpt).toBe(iEcho + 1)
    // a frase da otimista é a última bolha visível → o bloco de parcelas vem sem repetir a pergunta (B3-F1)
    expect(resolvePromptForRender(offerPrompt, visible, null)?.question).toBe("")
    // e a T2 antiga (1ª apresentação) colapsou na otimista (só a última ocorrência)
    expect(visible.filter((m) => m.text === NEGOTIATION_PENDING_TEXT).length).toBe(1)
  })

  it("retomada (mobile): recap + menu, clique → otimista; eco pelo poll → eco antes da confirmação", () => {
    const list0: ChatMsg[] = [a("menu-q", "Como prefere seguir?", { promptId: "p7", createdAt: "2026-09-25T20:39:00Z" }), a("optimistic-neg-3", NEGOTIATION_PENDING_TEXT)]
    const out = placeAfterCustomerEcho(list0, "optimistic-neg-3", c("e3", "Negociar", 1, "2026-09-25T20:39:10.168Z"))
    expect(out.map((m) => m.id)).toEqual(["menu-q", "e3", "optimistic-neg-3"])
  })
})

describe("QAA2-01 client (chat.tsx) — wire-up (leitura do fonte)", () => {
  const src = readFileSync(join(__dirname, "..", "..", "components", "journey", "chat.tsx"), "utf8")

  it("o clique em Negociar registra a otimista à espera do eco; o eco (customer + button_id) a recoloca via placeAfterCustomerEcho", () => {
    const click = src.slice(src.indexOf("async function clickButton("), src.indexOf("function startPayLongWait()"))
    expect(click).toContain("optimisticAwaitingEchoRef.current = optimisticId")
    const poll = src.slice(src.indexOf("async function pollMessages("), src.indexOf("function reconcilePayWait("))
    expect(poll).toContain('const echoReorderId = !isAssistant && typeof m.button_id === "number" ? optimisticAwaitingEchoRef.current : null')
    expect(poll).toContain("placeAfterCustomerEcho(base, echoReorderId, incoming)")
    // a otimista removida por erro/queda deixa de esperar o eco
    expect(src).toContain("if (optimisticAwaitingEchoRef.current === id) optimisticAwaitingEchoRef.current = null")
  })
})
