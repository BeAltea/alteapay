// A4 — LAYOUT/CONTRASTE (N-D5-2, N-D5-4, N-D5-5):
//   - todo texto sobre --brand-secondary usa a cor ADAPTATIVA (--brand-secondary-fg),
//     nunca text-white fixo (eco do cliente, botões de marca, modais, porta);
//   - o secondary de button-tiers usa texto neutro escuro (marca clara → 1,92:1);
//   - o primary é maior de verdade (text-base + py-3; BASE sem text-sm);
//   - alvos ≥ 44px em "Já paguei", "Sair", "Quem somos", "Ver conversa completa"
//     e em todos os botões h-9 dos painéis (que viraram min-h-[44px]).
// Os PARES de cor realmente usados são medidos com lib/journey/contrast.ts (WCAG).
// A paleta neutral do Tailwind é aproximada em hex (v4 usa oklch; a diferença é
// desprezível para a régua AA).
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { adaptiveTextColor, contrastRatio, parseHexColor } from "@/lib/journey/contrast"
import { BASE_BTN, tierClass } from "@/components/journey/button-tiers"

const ROOT = join(__dirname, "..", "..")
const src = (rel: string) => readFileSync(join(ROOT, rel), "utf8")
const ratio = (fg: string, bg: string) => contrastRatio(parseHexColor(fg)!, parseHexColor(bg)!)

const VMAX_SECONDARY = "#EAB308" // medido em produção (D5 §3): rgb(234,179,8)
const DEFAULT_SECONDARY = "#2563EB" // NEUTRAL_SECONDARY dos layouts (porta)
const WHITE = "#ffffff"
const NEUTRAL = { 50: "#fafafa", 100: "#f5f5f5", 600: "#525252", 700: "#404040", 800: "#262626", 900: "#171717" }

describe("contraste ≥ 4.5:1 (AA) nos pares usados pela jornada", () => {
  it("texto adaptativo sobre o secundário da VMAX (#EAB308): preto, ≥ 4.5:1 (branco fixo daria < 4.5)", () => {
    expect(adaptiveTextColor(VMAX_SECONDARY)).toBe("#000000")
    expect(ratio(adaptiveTextColor(VMAX_SECONDARY), VMAX_SECONDARY)).toBeGreaterThanOrEqual(4.5)
    expect(ratio(WHITE, VMAX_SECONDARY)).toBeLessThan(4.5) // o bug N-D5-2 (1,92:1)
  })
  it("texto adaptativo sobre o secundário default (#2563EB): ≥ 4.5:1", () => {
    expect(ratio(adaptiveTextColor(DEFAULT_SECONDARY), DEFAULT_SECONDARY)).toBeGreaterThanOrEqual(4.5)
  })
  it("botão secondary: texto neutral-900 sobre branco ≥ 4.5:1 (texto na cor da marca daria < 3:1 na VMAX)", () => {
    expect(ratio(NEUTRAL[900], WHITE)).toBeGreaterThanOrEqual(4.5)
    expect(ratio(VMAX_SECONDARY, WHITE)).toBeLessThan(3)
  })
  it("tertiary/afordâncias: neutral-600 sobre branco e sobre neutral-50 ≥ 4.5:1", () => {
    expect(ratio(NEUTRAL[600], WHITE)).toBeGreaterThanOrEqual(4.5)
    expect(ratio(NEUTRAL[600], NEUTRAL[50])).toBeGreaterThanOrEqual(4.5)
    expect(ratio(NEUTRAL[700], WHITE)).toBeGreaterThanOrEqual(4.5)
  })
  it("links auto-linkados nas bolhas do assistente: neutral-800 sobre neutral-100 ≥ 4.5:1", () => {
    expect(ratio(NEUTRAL[800], NEUTRAL[100])).toBeGreaterThanOrEqual(4.5)
  })
})

describe("N-D5-2 — nenhum text-white sobre --brand-secondary (fonte)", () => {
  it("chat.tsx: zero 'text-white'; UM único preenchimento de marca (BRAND_FILL_STYLE) com a cor adaptativa", () => {
    const chat = src("components/journey/chat.tsx")
    expect(chat).not.toContain("text-white")
    const fills = chat.match(/backgroundColor: "var\(--brand-secondary\)"/g) ?? []
    expect(fills.length).toBe(1)
    expect(chat).toMatch(/const BRAND_FILL_STYLE = \{\s*backgroundColor: "var\(--brand-secondary\)",\s*color: "var\(--brand-secondary-fg, #ffffff\)",/)
    // todo uso de marca passa pela constante (eco do cliente, links, botões, modais)
    expect((chat.match(/BRAND_FILL_STYLE/g) ?? []).length).toBeGreaterThanOrEqual(8)
    // o link auto-linkado não usa mais a cor da marca sobre fundo claro
    expect(chat).not.toContain('style={{ color: "var(--brand-secondary)" }}')
  })
  it("prompt-buttons.tsx e public-auth-form.tsx: marca sempre com --brand-secondary-fg; zero text-white", () => {
    for (const rel of ["components/journey/prompt-buttons.tsx", "components/journey/public-auth-form.tsx"]) {
      const s = src(rel)
      expect(s, rel).not.toContain("text-white")
      const fills = s.match(/backgroundColor: "var\(--brand-secondary\)"[^}]*\}/g) ?? []
      expect(fills.length, rel).toBeGreaterThanOrEqual(1)
      for (const f of fills) expect(f, `${rel}: ${f}`).toContain("--brand-secondary-fg")
    }
  })
  it("os layouts continuam definindo --brand-secondary-fg via adaptiveTextColor", () => {
    for (const rel of ["app/(journey)/n/[code]/layout.tsx", "app/(journey)/c/[token]/layout.tsx"]) {
      expect(src(rel)).toContain('"--brand-secondary-fg": adaptiveTextColor(view.secondary)')
    }
  })
})

describe("N-D5-4 — hierarquia: primary maior de verdade; secondary com texto neutro", () => {
  it("BASE não fixa tamanho de fonte; primary text-base+py-3; secondary/tertiary text-sm", () => {
    expect(BASE_BTN).not.toContain("text-sm")
    expect(BASE_BTN).not.toContain("text-base")
    const p = tierClass("primary")
    expect(p).toContain("text-base")
    expect(p).toContain("py-3")
    expect(p).not.toContain("text-sm")
    for (const t of ["secondary", "tertiary"] as const) {
      expect(tierClass(t)).toContain("text-sm")
      expect(tierClass(t)).not.toContain("text-base")
    }
  })
  it("secondary: contorno de marca + texto neutral-900 (nunca text-[var(--brand-secondary)])", () => {
    const s = tierClass("secondary")
    expect(s).toContain("border-[var(--brand-secondary)]")
    expect(s).toContain("text-neutral-900")
    expect(s).not.toContain("text-[var(--brand-secondary)]")
  })
  it("todos os tiers mantêm min-h-[44px] (R-19)", () => {
    for (const t of ["primary", "secondary", "tertiary"] as const) expect(tierClass(t)).toContain("min-h-[44px]")
  })
})

/** className do elemento cujo texto/rotulo `label` aparece logo depois (janela curta). */
function classBefore(source: string, label: string, window = 700): string {
  const idx = source.indexOf(label)
  expect(idx, `rótulo "${label}" não encontrado`).toBeGreaterThan(-1)
  const slice = source.slice(Math.max(0, idx - window), idx)
  const m = slice.match(/className="([^"]*)"(?![\s\S]*className=")/)
  expect(m, `className antes de "${label}"`).toBeTruthy()
  return m![1]
}

describe("N-D5-5 — alvos de toque ≥ 44px", () => {
  it("chat.tsx: 'Já paguei este valor' (afordância sob o menu), 'Sair' e 'Ver conversa completa' têm min-h-[44px]", () => {
    const chat = src("components/journey/chat.tsx")
    // 'Já paguei' aparece 2x (painel do link e afordância sob o menu) — ambas ≥ 44px
    const positions = [...chat.matchAll(/Já paguei este valor/g)].map((m) => m.index!)
    expect(positions.length).toBeGreaterThanOrEqual(2)
    for (const pos of positions) {
      const slice = chat.slice(Math.max(0, pos - 700), pos)
      const cls = slice.match(/className="([^"]*)"(?![\s\S]*className=")/)![1]
      expect(cls, `Já paguei @${pos}`).toContain("min-h-[44px]")
    }
    expect(classBefore(chat, "\n          Sair\n")).toContain("min-h-[44px]")
    expect(classBefore(chat, "\n              Ver conversa completa\n")).toContain("min-h-[44px]")
    // nenhum botão de painel ficou em h-9 (36px)
    expect(chat).not.toMatch(/className="h-9 /)
  })
  it("porta: 'Quem somos…' (disclosure) ≥ 44px e submit h-11", () => {
    const form = src("components/journey/public-auth-form.tsx")
    expect(classBefore(form, "{ENTRY_SEAL_WHO_LABEL}")).toContain("min-h-[44px]")
    expect(classBefore(form, '{submitting ? "Confirmando..." : "Continuar"}')).toContain("h-11")
  })
})
