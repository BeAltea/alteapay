// QA round 4 — R-15/R-23 (S6): o relógio de inatividade conta só INPUT REAL
// (mousemove sem deslocamento / evento sintético por re-render não conta; poll
// sem mudança não re-renderiza). R-17/R-28 (S8): transcrição por TURNO — a
// resposta nunca acima do seu eco; na vista expandida nenhum eco órfão; o log
// abre no ponto do corte e "Recolher conversa" fica sempre visível.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { IDLE_ACTIVITY_EVENTS, isRealActivity, MIN_MOVE_PX } from "@/lib/journey/idle-input"
import {
  collapseConsecutiveDecisions,
  dedupAssistantByContent,
  pairTurns,
  placeEchoBeforeReply,
  type ChatMsg,
} from "@/components/journey/chat-display"

const root = join(__dirname, "..", "..")
const chat = readFileSync(join(root, "components/journey/chat.tsx"), "utf8")

describe("R-15/R-23 — isRealActivity", () => {
  it("mousemove/pointermove no MESMO ponto (conteúdo mudou sob o ponteiro parado) não conta", () => {
    let pos = isRealActivity({ type: "mousemove", isTrusted: true, clientX: 300, clientY: 200 }, null).pos
    for (let i = 0; i < 19; i++) {
      const v = isRealActivity({ type: "mousemove", isTrusted: true, clientX: 300, clientY: 200 }, pos)
      expect(v.real).toBe(false)
      pos = v.pos
    }
    expect(isRealActivity({ type: "pointermove", isTrusted: true, clientX: 301, clientY: 200 }, pos).real).toBe(MIN_MOVE_PX <= 1)
  })

  it("deslocamento real (≥ 2 px) conta e avança a posição; evento sintético (isTrusted:false) nunca conta", () => {
    const a = isRealActivity({ type: "mousemove", isTrusted: true, clientX: 303, clientY: 200 }, { x: 300, y: 200 })
    expect(a.real).toBe(true)
    expect(a.pos).toEqual({ x: 303, y: 200 })
    expect(isRealActivity({ type: "mousemove", isTrusted: false, clientX: 900, clientY: 900 }, { x: 0, y: 0 }).real).toBe(false)
    expect(isRealActivity({ type: "click", isTrusted: false }, null).real).toBe(false)
  })

  it("tecla, toque, clique, roda contam; 'scroll' (auto-scroll do log) não", () => {
    for (const type of ["keydown", "touchstart", "pointerdown", "mousedown", "click", "wheel"]) {
      expect(isRealActivity({ type, isTrusted: true }, null).real, type).toBe(true)
    }
    expect(isRealActivity({ type: "scroll", isTrusted: true }, null).real).toBe(false)
    expect(IDLE_ACTIVITY_EVENTS).not.toContain("scroll")
  })

  it("chat.tsx: usa isRealActivity; cartão e links mortos só re-renderizam quando o conteúdo muda", () => {
    expect(chat).toContain("const verdict = isRealActivity(")
    expect(chat).toContain("if (!verdict.real) return")
    expect(chat).toContain("if (next !== pinnedDebtJsonRef.current) {")
    expect(chat).toContain("if (!sameSet(incomingDead, deadHrefsRef.current)) {")
    expect(chat).not.toMatch(/"mousemove", "mousedown", "keydown", "touchstart", "scroll", "click"/)
  })
})

const echo = (id: string, label: string, buttonId: number, promptId: string, createdAt?: string): ChatMsg => ({
  id, from: "customer", text: label, buttonId, promptId, createdAt: createdAt ?? null,
})
const out = (id: string, text: string, stage: string, promptId: string | null): ChatMsg => ({
  id, from: "assistant", text, stage, promptId,
})
const q = (id: string, text: string, promptId: string): ChatMsg => ({ id, from: "assistant", text, promptId })

describe("R-17/R-28 — pairTurns / placeEchoBeforeReply", () => {
  it("resposta gravada ANTES do eco (corrida de inserts) volta para logo depois dele", () => {
    const list = [out("r1", "Registramos que você não reconhece…", "not_recognized", "p1"), echo("e1", "Não reconheço", 0, "p1")]
    expect(pairTurns(list).map((m) => m.id)).toEqual(["e1", "r1"])
  })

  it("eco chegando pelo poll depois do resultado aplicado do corpo do POST entra ANTES dele", () => {
    const base = [q("g", "Olá…", "p0"), out("r2", "Vencimento original…", "detail", "p1")]
    expect(placeEchoBeforeReply(base, echo("e2", "Detalhes da dívida", 2, "p1")).map((m) => m.id)).toEqual(["g", "e2", "r2"])
    // sem resposta presente → no fim
    expect(placeEchoBeforeReply([q("g", "Olá…", "p0")], echo("e3", "Negociar", 1, "p1")).map((m) => m.id)).toEqual(["g", "e3"])
  })

  it("vista expandida: ecos consecutivos sem resposta colapsam (nunca eco órfão); outcomes iguais de turnos diferentes ficam", () => {
    // sequência do QA (#104-#115): Voltar › Detalhes › Voltar › Pagar …
    const list: ChatMsg[] = [
      echo("e1", "Voltar às opções", 98, "pA"),
      echo("e2", "Detalhes da dívida", 2, "pB"),
      out("r2", "Vencimento original 15/08/2026.", "detail", "pB"),
      echo("e3", "Voltar às opções", 98, "pC"),
      echo("e4", "Detalhes da dívida", 2, "pD"),
      out("r4", "Vencimento original 15/08/2026.", "detail", "pD"),
    ]
    const shown = pairTurns(list, { dropOrphanEchoes: true })
    expect(shown.map((m) => m.id)).toEqual(["e2", "r2", "e4", "r4"])
    for (let i = 0; i + 1 < shown.length; i++) {
      expect(shown[i].from === "customer" && shown[i + 1].from === "customer").toBe(false)
    }
    // os DOIS outcomes (turnos diferentes) continuam — só colapsam na pilha idêntica consecutiva
    expect(dedupAssistantByContent(list).filter((m) => m.stage === "detail").length).toBe(2)
    // sem a vista expandida nada é removido (só reordenado)
    expect(pairTurns(list).length).toBe(list.length)
  })

  it("pares eco+resposta idênticos consecutivos continuam colapsando num par (A3), sem eco órfão", () => {
    const list: ChatMsg[] = [
      echo("e1", "Detalhes da dívida", 2, "p1"),
      out("r1", "Vencimento original 15/08/2026.", "detail", "p1"),
      echo("e2", "Detalhes da dívida", 2, "p2"),
      out("r2", "Vencimento original 15/08/2026.", "detail", "p2"),
    ]
    const collapsed = collapseConsecutiveDecisions(list, null, "idle", null)
    expect(pairTurns(collapsed, { dropOrphanEchoes: true }).map((m) => m.id)).toEqual(["e2", "r2"])
  })

  it("chat.tsx: pairTurns na pipeline; expandir abre no ponto do corte; 'Recolher conversa' sticky dentro do log", () => {
    expect(chat).toContain("pairTurns(dedupAssistantByContent(collapsedDecisions), { dropOrphanEchoes: historyExpanded })")
    expect(chat).toContain("expandAnchorRef.current = capped.visible[0]?.id ?? null")
    expect(chat).toContain('log.querySelector(`[data-mid="${CSS.escape(id)}"]`)')
    expect(chat).toMatch(/className="sticky bottom-0[^"]*"[\s\S]{0,400}Recolher conversa/)
    expect(chat).toContain("placeEchoBeforeReply(base, incoming)")
  })
})
