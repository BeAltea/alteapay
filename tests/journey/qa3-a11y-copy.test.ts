// QA round 3 — QAB3-04 (foco inicial no card), QAB3-05 (quem fala, sr-only +
// aria-busy no pendente), QAB3-07 (handoff sem promessa), QAB3-08 (link de
// privacidade ≥ 24 px) e QAB3-10 (a "em nome da", c "vencimento", d "Link copiado.").
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { SR_SPEAKER_ASSISTANT, SR_SPEAKER_CUSTOMER, srSpeakerPrefix } from "@/components/journey/chat-display"
import { humanHandoffReply } from "@/lib/journey/actions"

const src = (rel: string) => readFileSync(join(__dirname, "..", "..", rel), "utf8")
const chat = src("components/journey/chat.tsx")
const LAYOUTS = ["app/(journey)/c/[token]/layout.tsx", "app/(journey)/n/[code]/layout.tsx", "app/t/[tenantSlug]/negociar/layout.tsx"]

describe("QAB3-05 — prefixo sr-only por bolha", () => {
  it("srSpeakerPrefix: 'Você: ' para o cliente, 'AlteaPay: ' para o assistente", () => {
    expect(SR_SPEAKER_CUSTOMER).toBe("Você: ")
    expect(SR_SPEAKER_ASSISTANT).toBe("AlteaPay: ")
    expect(srSpeakerPrefix("customer")).toBe("Você: ")
    expect(srSpeakerPrefix("assistant")).toBe("AlteaPay: ")
  })
  it("chat.tsx: cada bolha do log abre com <span className=\"sr-only\">{srSpeakerPrefix(...)}</span>", () => {
    expect(chat).toContain('<span className="sr-only">{srSpeakerPrefix(m.from)}</span>')
    expect(chat).toContain('<span className="sr-only">{srSpeakerPrefix("assistant")}</span>')
  })
  it("prompt-buttons: pendente mantém o nome acessível (aria-label) e marca aria-busy", () => {
    const pb = src("components/journey/prompt-buttons.tsx")
    expect(pb).toContain("aria-busy={pending === b.id || undefined}")
    expect(pb).toContain("aria-label={pending === b.id ? b.label : undefined}")
  })
})

describe("QAB3-04 — foco inicial no início do conteúdo (card)", () => {
  it("DebtCard: section focável (tabIndex=-1) recebendo o ref", () => {
    const card = src("components/journey/debt-card.tsx")
    expect(card).toMatch(/ref=\{focusRef\}\s*\n\s*tabIndex=\{-1\}/)
  })
  it("chat.tsx: foca o card (fallback no log) com preventScroll; saudação de retorno não é live region", () => {
    expect(chat).toContain("<DebtCard debt={pinnedDebt} focusRef={cardFocusRef} />")
    expect(chat).toContain("const el = cardFocusRef.current ?? summaryFocusRef.current")
    const i = chat.indexOf("const el = cardFocusRef.current")
    expect(chat.slice(i, i + 800)).toContain("preventScroll: true")
    const r = chat.indexOf("{recap && !ended ? (")
    expect(chat.slice(r, r + 300)).not.toMatch(/aria-live|role="status"/)
  })
})

describe("QAB3-07 — handoff sem promessa", () => {
  it("registra o pedido; sem canal, sem 'vai falar com você', sem prazo", () => {
    const t = humanHandoffReply("VMAX")
    expect(t).toContain("Registramos o seu pedido de atendimento.")
    expect(t).not.toMatch(/WhatsApp|vai falar com você|em breve|entraremos em contato|hoje|horas?/i)
    expect(t).toContain("VMAX")
  })
})

describe("QAB3-08 / QAB3-10 — copy miúda e alvos", () => {
  it("rodapés: 'em nome da {marca}' e link de privacidade com min-h-[24px]", () => {
    for (const rel of LAYOUTS) {
      const s = src(rel)
      expect(s, rel).toMatch(/em nome da \$?\{/)
      expect(s, rel).not.toMatch(/em nome de \$?\{/)
      const links = [...s.matchAll(/className="([^"]*)"\s*>\s*\n\s*Política de privacidade/g)]
      expect(links.length, rel).toBe(2)
      for (const l of links) expect(l[1], rel).toContain("min-h-[24px]")
    }
  })
  it("card diz 'vencimento' por extenso; 'Link copiado.' sem exclamação", () => {
    const card = src("components/journey/debt-card.tsx")
    expect(card).toContain("vencimento {due}")
    expect(card).not.toContain("venc. {due}")
    expect(chat).toContain('"Link copiado."')
    expect(chat).not.toContain("Link copiado!")
  })
})
