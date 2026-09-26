// QA round 3 — QAB3-02 (ALTO): a retomada NUNCA eleva um link MORTO como o
// "último resultado" (mostrava "Aqui está seu link para pagar R$ …" sem link, sem
// "Abrir" e sem dizer que a cobrança fora cancelada). Eleva o link VIVO anterior
// ou, na falta, mostra a bolha neutra "Sua cobrança anterior foi cancelada." sem
// botão. E o resultado eleito na 1ª pintura fica pinado: um poll posterior não
// troca o texto sob os olhos do devedor.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  RESUME_DEAD_LINK_NOTICE,
  splitResumeHistory,
  type ChatMsg,
} from "@/components/journey/chat-display"

const CUTOFF = "2026-09-24T12:00:00.000Z"
const at = (min: number) => new Date(Date.parse("2026-09-24T10:00:00.000Z") + min * 60_000).toISOString()
const link = (href: string, live?: boolean) => ({
  type: "open_payment_link" as const, label: "Abrir link de pagamento", href, ...(live === false ? { live: false } : {}),
})
function asst(id: string, text: string, min: number, extra: Partial<ChatMsg> = {}): ChatMsg {
  return { id, from: "assistant", text, action: null, promptId: null, createdAt: at(min), ...extra }
}
function cust(id: string, text: string, min: number): ChatMsg {
  return { id, from: "customer", text, action: null, promptId: null, buttonId: 1, createdAt: at(min) }
}
const split = (list: ChatMsg[], extra: { deadHrefs?: Set<string> | null; pinnedOutcomeId?: string | null } = {}) =>
  splitResumeHistory(list, { cutoffAt: CUTOFF, expanded: false, activePromptId: null, waitState: null, currentGeneration: null, ...extra })

const liveLink = asst("m-live", "Aqui está seu link para pagar R$ 250,00.\nhttps://asaas/i/live", 10, { stage: "payment_link", action: link("https://asaas/i/live") })
const deadLink = asst("m-dead", "Aqui está seu link para pagar R$ 250,00.\nhttps://asaas/i/dead", 20, { stage: "payment_link", action: link("https://asaas/i/dead", false) })

describe("QAB3-02 — splitResumeHistory nunca eleva link morto", () => {
  it("último outcome = link com live:false e sem outro outcome → nada elevado + notice neutra", () => {
    const r = split([cust("c1", "Pagar R$ 250,00", 19), deadLink])
    expect(r.lastOutcomeId).toBeNull()
    expect(r.notice).toBe(RESUME_DEAD_LINK_NOTICE)
    expect(r.notice).toBe("Sua cobrança anterior foi cancelada.")
    expect(r.visible.map((m) => m.id)).not.toContain("m-dead")
  })

  it("link morto por href terminal do poll (deadHrefs) também é pulado", () => {
    const alsoDead = asst("m-dead2", "Aqui está seu link.\nhttps://asaas/i/x", 20, { stage: "payment_link", action: link("https://asaas/i/x") })
    const r = split([alsoDead], { deadHrefs: new Set(["https://asaas/i/x"]) })
    expect(r.lastOutcomeId).toBeNull()
    expect(r.notice).toBe(RESUME_DEAD_LINK_NOTICE)
  })

  it("há um link VIVO anterior → é ele o elevado (sem notice)", () => {
    const r = split([liveLink, cust("c1", "Pagar", 19), deadLink])
    expect(r.lastOutcomeId).toBe("m-live")
    expect(r.notice).toBeNull()
    expect(r.visible.map((m) => m.id)).toEqual(["m-live"])
  })

  it("outcome NÃO-link mais antigo que o Pagar cancelado não é elevado (não é o resultado da última escolha)", () => {
    const claim = asst("m-claim", "Obrigado por avisar. Vamos conferir o pagamento.", 5, { stage: "payment_claim" })
    const r = split([claim, deadLink])
    expect(r.lastOutcomeId).toBeNull()
    expect(r.notice).toBe(RESUME_DEAD_LINK_NOTICE)
  })

  it("último outcome vivo → comportamento de antes (elevado, sem notice)", () => {
    const r = split([deadLink, asst("m-link2", "Aqui está seu link.\nhttps://asaas/i/2", 30, { stage: "payment_link", action: link("https://asaas/i/2") })])
    expect(r.lastOutcomeId).toBe("m-link2")
    expect(r.notice).toBeNull()
  })

  it("estabilidade: o pino da 1ª pintura continua eleito enquanto elegível, mesmo com outcome mais novo na lista", () => {
    const claim = asst("m-claim", "Obrigado por avisar.", 40, { stage: "payment_claim" })
    const first = split([liveLink, cust("c1", "Já paguei", 39)])
    expect(first.lastOutcomeId).toBe("m-live")
    // um poll traz uma linha antiga que faltava (janela de 200) — o destaque não troca
    const second = split([liveLink, cust("c1", "Já paguei", 39), claim], { pinnedOutcomeId: first.lastOutcomeId })
    expect(second.lastOutcomeId).toBe("m-live")
  })

  it("pino deixa de ser elegível (a cobrança foi cancelada) → re-elege; sem vivo → notice", () => {
    const r = split([liveLink], { pinnedOutcomeId: "m-live", deadHrefs: new Set(["https://asaas/i/live"]) })
    expect(r.lastOutcomeId).toBeNull()
    expect(r.notice).toBe(RESUME_DEAD_LINK_NOTICE)
  })

  it("expanded / sem cutoff → sem notice", () => {
    const r = splitResumeHistory([deadLink], { cutoffAt: CUTOFF, expanded: true, activePromptId: null, waitState: null })
    expect(r.notice).toBeNull()
  })

  it("chat.tsx: notice renderizada sem botão; pino guardado em ref e repassado; deadHrefs repassado", () => {
    const chat = readFileSync(join(__dirname, "..", "..", "components/journey/chat.tsx"), "utf8")
    expect(chat).toContain("pinnedOutcomeId: resumeOutcomePinRef.current")
    expect(chat).toContain("deadHrefs: deadLinkHrefs")
    const i = chat.indexOf("{resume.notice ? (")
    expect(i).toBeGreaterThan(-1)
    const block = chat.slice(i, chat.indexOf(") : null}", i))
    expect(block).toContain("RESUME_DEAD_LINK_NOTICE")
    expect(block).not.toMatch(/<button|<a\b/)
  })
})
