// QA round 3 — QAB3-01 (ALTO): o indicador de foco por teclado dos botões da
// jornada é um anel NEUTRO ESCURO com offset (≥ 3:1 contra a página, contra o
// primário da marca VMAX #EAB308 e contra o default #2563eb) — nunca a cor da
// marca (`ring-[var(--brand-secondary)]` dava 1,92:1 com a VMAX).
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { BASE_BTN, FOCUS_RING, FOCUS_RING_HEX, tierClass } from "@/components/journey/button-tiers"
import { contrastRatio, parseHexColor } from "@/lib/journey/contrast"

const root = join(__dirname, "..", "..")
const src = (rel: string) => readFileSync(join(root, rel), "utf8")
/** Linha `className=` de cada <button>/<a> (o 1º className depois da abertura). */
function interactiveClassLines(source: string): string[] {
  const out: string[] = []
  for (const m of source.matchAll(/<(button|a)(\s|$)/gm)) {
    const rest = source.slice(m.index!, m.index! + 900)
    const line = /className=[^\n]*/.exec(rest)?.[0]
    if (line) out.push(line)
  }
  return out
}
const ratio = (a: string, b: string) => contrastRatio(parseHexColor(a)!, parseHexColor(b)!)

describe("QAB3-01 — anel de foco ≥ 3:1, independente da marca", () => {
  it("contraste do anel (#171717) contra a marca VMAX (#EAB308), o default (#2563eb), branco e a página", () => {
    for (const bg of ["#EAB308", "#2563eb", "#ffffff", "#fafafa"]) {
      expect(ratio(FOCUS_RING_HEX, bg), `anel × ${bg}`).toBeGreaterThanOrEqual(3)
    }
    // o anel antigo (cor da marca) reprovava contra o branco — é o bug medido
    expect(ratio("#EAB308", "#ffffff")).toBeLessThan(3)
  })

  it("FOCUS_RING é neutral-900 com offset; BASE_BTN e todos os tiers o usam; nenhum tier usa a cor da marca no anel", () => {
    expect(FOCUS_RING).toContain("focus-visible:ring-neutral-900")
    expect(FOCUS_RING).toContain("focus-visible:ring-offset-2")
    expect(BASE_BTN).toContain(FOCUS_RING)
    for (const t of ["primary", "secondary", "tertiary"] as const) {
      expect(tierClass(t)).toContain("focus-visible:ring-neutral-900")
      expect(tierClass(t)).not.toMatch(/ring-\[var\(--brand/)
    }
  })

  it("nenhum componente da jornada usa a cor da marca como anel/borda de foco", () => {
    const dir = join(root, "components/journey")
    const files = readdirSync(dir).filter((f) => f.endsWith(".tsx"))
    for (const f of files) {
      const s = src(`components/journey/${f}`)
      expect(s, f).not.toMatch(/(focus|focus-visible):ring-\[var\(--brand/)
      expect(s, f).not.toMatch(/focus:border-\[var\(--brand/)
    }
  })

  it("chat.tsx: todo <button>/<a> com className carrega o FOCUS_RING (menu vem de tierClass)", () => {
    const chat = src("components/journey/chat.tsx")
    const tags = interactiveClassLines(chat)
    expect(tags.length).toBeGreaterThan(15)
    for (const t of tags) expect(t).toMatch(/FOCUS_RING|focus-visible:ring-neutral-900|tierClass/)
  })

  it("portas e telas de ação: botões e links com anel neutro", () => {
    for (const rel of [
      "components/journey/auth-form.tsx",
      "components/journey/generic-auth-form.tsx",
      "components/journey/public-auth-form.tsx",
      "components/journey/choice-screen.tsx",
      "components/journey/action-confirm.tsx",
      "components/journey/optout.tsx",
    ]) {
      const s = src(rel)
      const tags = interactiveClassLines(s)
      expect(tags.length, rel).toBeGreaterThan(0)
      for (const t of tags) expect(t, rel).toContain("focus-visible:ring-neutral-900")
    }
  })
})
