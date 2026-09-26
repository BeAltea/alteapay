// QA round 4 — Correção B8.
// A-1/M-1: `200 { ignored:'double_tap', prompt }` com o MESMO prompt ativo não
//   congela o menu: o clique volta ao bloco como NÃO respondido (reabilita), o
//   prompt não entra em consumedPromptIds (o poll pode repô-lo) e um aviso curto
//   e neutro explica o toque — inclusive no Pagar (sai do "gerando" com aviso).
// A-2: a inércia de nascimento/deslocamento conta do ÚLTIMO TOQUE (lastTapAt +
//   ACTIONS_ARM_MS), nunca do render; inerte = opacity + cursor de espera (sem
//   reflow) e o toque na janela ganha aviso aria-live (nunca clique mudo).
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { IGNORED_CLICK_RESULT, shouldConsumeClickedPrompt } from "@/lib/journey/click-feedback"
import {
  ACTIONS_ARM_MS,
  DOUBLE_TAP_NOTICE,
  INERT_CLASS,
  INERT_TAP_NOTICE,
  rearmUntilFromLastTap,
  shouldRearm,
  TAP_INERT_MS,
} from "@/lib/journey/tap-guard"

const root = join(__dirname, "..", "..")
const chat = readFileSync(join(root, "components/journey/chat.tsx"), "utf8")
const pb = readFileSync(join(root, "components/journey/prompt-buttons.tsx"), "utf8")

describe("A-1/M-1 — ignored não congela o menu", () => {
  it("o prompt clicado NÃO é consumido quando o servidor ignora o toque; 200 efetivo e 409 continuam consumindo", () => {
    expect(shouldConsumeClickedPrompt(true, 200, { ignored: "double_tap" })).toBe(false)
    expect(shouldConsumeClickedPrompt(true, 200, {})).toBe(true)
    expect(shouldConsumeClickedPrompt(false, 409, {})).toBe(true)
    expect(shouldConsumeClickedPrompt(false, 500, {})).toBe(false)
  })

  it("o bloco recebe ok:false (não marca 'respondido', reabilita) sem o aviso de erro vermelho", () => {
    expect(IGNORED_CLICK_RESULT).toEqual({ ok: false, code: "ignored" })
    // clickNotice("ignored") → null (o aviso neutro é do pai; .tsx lido como fonte)
    expect(pb).toContain('if (code === "ignored") return null')
    // o PromptButtons só marca answered com ok:true
    expect(pb).toMatch(/if \(res\.ok\) \{\s*setAnswered\(true\)/)
  })

  it("chat.tsx: ignored → aplica o prompt do corpo, aviso neutro no bloco, devolve IGNORED_CLICK_RESULT; Pagar sai do 'gerando'", () => {
    const branch = chat.slice(chat.indexOf('if (res.ok && data?.ignored === "double_tap") {'))
    const body = branch.slice(0, branch.indexOf("return IGNORED_CLICK_RESULT") + 30)
    expect(body).toContain("if (isPay) resetWaitToIdle()")
    expect(body).toContain("applyActionBody(data)")
    expect(body).toContain("setPromptNotice(DOUBLE_TAP_NOTICE)")
    expect(body).not.toContain("return { ok: true }")
    expect(chat).toContain("if (shouldConsumeClickedPrompt(res.ok, res.status, data)) consumedPromptIds.current.add(promptId)")
    expect(DOUBLE_TAP_NOTICE).toBe("Toque registrado uma vez. Escolha de novo, se quiser.")
  })
})

describe("A-2 — inércia ancorada no último toque, com sinal e aviso", () => {
  it("menu que nasce/se move ≥ ACTIONS_ARM_MS depois do último toque (ou sem toque) já nasce clicável", () => {
    const now = 100_000
    expect(rearmUntilFromLastTap(null, now)).toBeNull() // login: nenhum toque → clicável
    expect(rearmUntilFromLastTap(now - ACTIONS_ARM_MS, now)).toBeNull()
    expect(rearmUntilFromLastTap(now - 5000, now)).toBeNull() // Voltar há 5 s → Pagar responde
    // 2º/3º toque de um toque múltiplo (menu nasce 300 ms depois do 1º): protegido até toque + 2,5 s
    expect(rearmUntilFromLastTap(now - 300, now)).toBe(now - 300 + ACTIONS_ARM_MS)
    // o deslocamento continua detectado; quem decide a janela é o último toque
    expect(shouldRearm({ promptId: "p1", top: 500 }, { promptId: "p1", top: 560 })).toBe(true)
    expect(TAP_INERT_MS).toBeLessThan(ACTIONS_ARM_MS)
  })

  it("chat.tsx: toque registra lastTapAt; nascimento/deslocamento e fim do claim usam rearmFromLastTap (nunca now + ARM)", () => {
    expect(chat).toContain("lastTapAtRef.current = now")
    expect(chat).toContain("const until = rearmUntilFromLastTap(lastTapAtRef.current, Date.now())")
    expect(chat).toContain("if (shouldRearm(actionBlockPosRef.current, next)) rearmFromLastTap()")
    expect(chat).not.toContain("armActions(ACTIONS_ARM_MS)")
  })

  it("inerte = opacity + cursor de espera, sem pointer-events-none (o toque chega e avisa); aviso aria-live", () => {
    expect(INERT_CLASS).toBe("opacity-60 cursor-wait")
    expect(INERT_CLASS).not.toMatch(/\b(h-|w-|p-|m-|hidden|invisible)/) // sem reflow
    expect(pb).toContain("className={inert ? `${tierClass(tier)} ${INERT_CLASS}` : tierClass(tier)}")
    expect(pb).not.toContain("pointer-events-none")
    expect(pb).toMatch(/if \(inert\) \{\s*setNotice\(INERT_TAP_NOTICE\)/)
    expect(pb).toMatch(/role="status" aria-live="polite">\s*\{notice\}/)
    expect(chat).toMatch(/if \(isActionsInertNow\(\)\) \{\s*setPromptNotice\(INERT_TAP_NOTICE\)/)
    expect(chat).not.toMatch(/actionsInert[^\n]*pointer-events-none/)
    expect(INERT_TAP_NOTICE).toBe("Um instante. Toque de novo para escolher.")
  })
})
