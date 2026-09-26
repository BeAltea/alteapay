// QA round 4 — R-19 (S10): anel de foco ≥ 3:1 também no checkbox LGPD e nos
// links do rodapé (3 formulários + 3 layouts), com rede de segurança escopada em
// [data-journey]. R-18/R-27 (S9, parte sem infra nova): `engine_owner` do corpo
// ∈ {banco, "pending"} (nunca "platform" presumido) e JANELA DO MOTOR — o n8n só
// substitui as parcelas do assistido até N8N_TAKEOVER_WINDOW_MS (15 s).
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { FOCUS_RING_HEX } from "@/components/journey/button-tiers"
import { contrastRatio, parseHexColor } from "@/lib/journey/contrast"
import { isWithinTakeoverWindow, n8nTakeoverWindowMs } from "@/lib/journey/chat-send"

const root = join(__dirname, "..", "..")
const src = (rel: string) => readFileSync(join(root, rel), "utf8")
const ratio = (a: string, b: string) => contrastRatio(parseHexColor(a)!, parseHexColor(b)!)

describe("R-19 — anel de foco ≥ 3:1 no checkbox LGPD e nos links do rodapé", () => {
  it("os 3 formulários aplicam FOCUS_RING ao checkbox", () => {
    for (const f of ["generic-auth-form.tsx", "public-auth-form.tsx", "auth-form.tsx"]) {
      const s = src(`components/journey/${f}`)
      expect(s, f).toContain('import { FOCUS_RING } from "./button-tiers"')
      expect(s, f).toMatch(/type="checkbox"[\s\S]{0,400}className=\{`\$\{FOCUS_RING\} mt-0\.5 h-4 w-4/)
    }
  })

  it("os 3 layouts da jornada: links do rodapé com FOCUS_RING e wrapper [data-journey]", () => {
    for (const rel of ["app/(journey)/c/[token]/layout.tsx", "app/(journey)/n/[code]/layout.tsx", "app/t/[tenantSlug]/negociar/layout.tsx"]) {
      const s = src(rel)
      expect(s.match(/\$\{FOCUS_RING\} inline-flex min-h-\[24px\]/g)?.length, rel).toBe(2)
      expect(s, rel).toContain('data-journey=""')
    }
  })

  it("globals.css: rede de segurança só em [data-journey] (anel #171717 + halo branco), na camada base", () => {
    const css = src("app/globals.css")
    expect(css).toMatch(/@layer base \{\s*\/\*[^*]*\*\/\s*\[data-journey\] :focus-visible \{\s*outline: 2px solid #171717;/)
    expect(css).toContain("box-shadow: 0 0 0 4px #ffffff;")
    // o anel escuro passa 3:1 sobre branco, página, VMAX e default; o halo branco sobre a marca escura
    for (const bg of ["#ffffff", "#fafafa", "#EAB308", "#2563eb"]) expect(ratio(FOCUS_RING_HEX, bg)).toBeGreaterThanOrEqual(3)
    expect(ratio("#ffffff", "#171717")).toBeGreaterThanOrEqual(3)
  })
})

describe("R-18/R-27 — engine_owner coerente e janela do motor", () => {
  it("kickoff ainda sem desfecho devolve owner 'pending' (nunca 'platform' presumido)", () => {
    const ack = src("lib/journey/acknowledgement.ts")
    expect(ack).toContain('| { status: "pending"; owner: "pending" }')
    expect(ack).toContain('resolve({ status: "pending", owner: "pending" })')
  })

  it("janela do motor: 15 s por padrão, configurável; sem data → dentro (compat)", () => {
    const prev = process.env.N8N_TAKEOVER_WINDOW_MS
    delete process.env.N8N_TAKEOVER_WINDOW_MS
    expect(n8nTakeoverWindowMs()).toBe(15_000)
    const now = Date.parse("2026-09-26T10:00:30.000Z")
    expect(isWithinTakeoverWindow("2026-09-26T10:00:20.000Z", now)).toBe(true) // 10 s
    expect(isWithinTakeoverWindow("2026-09-26T10:00:10.000Z", now)).toBe(false) // 20 s
    expect(isWithinTakeoverWindow(null, now)).toBe(true)
    process.env.N8N_TAKEOVER_WINDOW_MS = "30000"
    expect(isWithinTakeoverWindow("2026-09-26T10:00:10.000Z", now)).toBe(true)
    if (prev === undefined) delete process.env.N8N_TAKEOVER_WINDOW_MS
    else process.env.N8N_TAKEOVER_WINDOW_MS = prev
  })

  it("chat.send fora da janela → 422 prompt_outside_window e as parcelas do assistido ficam", () => {
    const s = src("lib/journey/chat-send.ts")
    expect(s).toContain('active!.kind === "offer_choice" && !isWithinTakeoverWindow(active!.created_at, Date.now())')
    expect(s).toContain('code: "prompt_outside_window"')
  })
})
