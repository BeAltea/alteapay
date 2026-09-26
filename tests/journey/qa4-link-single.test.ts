// QA round 4 — R-10/R-20 (ALTO) e QAA1-R4-01 (ALTO): UM link, UM painel
// Abrir/Copiar e UMA fileira pós-link por cobrança, em qualquer caminho; o
// painel deriva EXCLUSIVAMENTE da bolha persistida e a vivacidade vem do servidor
// (`live:false` / `dead_payment_links`). Cancelamento vindo de outra aba desliga
// Abrir/Copiar e zera o estado local no próximo poll; "Voltar às opções" limpa
// painel/fileira mortos.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { ChatMsg, MsgAction } from "@/components/journey/chat-display"
import {
  isHrefDead,
  LINK_BUBBLE_GRACE_MS,
  normalizePaymentHref,
  resolveLinkView,
  type LocalLinkResult,
} from "@/lib/journey/link-view"

const HREF = "https://www.asaas.com/i/abc123"
const HREF_OTHER = "https://www.asaas.com/b/pdf/abc123" // mesmo acordo, outra URL (boleto)

const link = (href: string, extra: Partial<MsgAction> = {}): MsgAction => ({
  type: "open_payment_link", label: "Abrir link de pagamento", href, ...extra,
})
const bubble = (id: string, href: string, extra: Partial<MsgAction> = {}): ChatMsg => ({
  id, from: "assistant", text: `Aqui está seu link para pagar R$ 250,00.\n${href}`, action: link(href, extra), stage: "payment_link",
})
const menu: ChatMsg = { id: "q1", from: "assistant", text: "Como prefere seguir?", promptId: "p-menu" }
const local = (href: string | null, linkMessageId: string | null = null): LocalLinkResult => ({ status: "link", link: href, linkMessageId })
const NONE: ReadonlySet<string> = new Set()

/** conta painéis e fileiras que a tela renderiza a partir da view (o que o chat.tsx faz). */
function screen(view: ReturnType<typeof resolveLinkView>) {
  const panels = (view.panelMessageId ? 1 : 0) + (view.fallback?.mode === "panel" ? 1 : 0)
  const rows = view.postLinkRow === "none" ? 0 : 1
  return { panels, rows }
}

describe("R-10/R-20 — um painel por cobrança nos 3 caminhos", () => {
  it("(a) Pagar nesta aba: corpo e bolha com o MESMO href → 1 painel (o da bolha), 1 fileira (servidor)", () => {
    const v = resolveLinkView({ payResult: local(HREF, "m1"), messages: [bubble("m1", HREF)], deadHrefs: NONE, activePromptKind: "post_payment_link" })
    expect(v.panelMessageId).toBe("m1")
    expect(v.fallback).toBeNull()
    expect(screen(v)).toEqual({ panels: 1, rows: 1 })
    expect(v.postLinkRow).toBe("server")
  })

  it("(b) aceite de parcela: href do corpo ≠ href da bolha, link_message_id igual → reconcilia por id (nunca 2 painéis)", () => {
    const v = resolveLinkView({ payResult: local(HREF_OTHER, "m1"), messages: [bubble("m1", HREF)], deadHrefs: NONE, activePromptKind: "post_payment_link", graceExpired: true })
    expect(screen(v)).toEqual({ panels: 1, rows: 1 })
    expect(v.fallback).toBeNull()
  })

  it("(b') href diferente e SEM id, mas uma bolha de link viva na tela → a bolha vence (nunca painel local ao lado)", () => {
    const v = resolveLinkView({ payResult: local(HREF_OTHER), messages: [bubble("m1", HREF)], deadHrefs: NONE, activePromptKind: "post_payment_link", graceExpired: true })
    expect(screen(v)).toEqual({ panels: 1, rows: 1 })
  })

  it("(c) cobrança criada em outra aba/dispositivo: sem resultado local, só a bolha do poll → 1 painel", () => {
    const v = resolveLinkView({ payResult: null, messages: [menu, bubble("m9", HREF)], deadHrefs: NONE, activePromptKind: "post_payment_link" })
    expect(v.panelMessageId).toBe("m9")
    expect(screen(v)).toEqual({ panels: 1, rows: 1 })
  })

  it("href com query utm/barra final/host maiúsculo reconcilia com a bolha", () => {
    expect(normalizePaymentHref("https://WWW.Asaas.com/i/abc123/?utm_source=x#top")).toBe(normalizePaymentHref(HREF))
    const v = resolveLinkView({ payResult: local("https://WWW.asaas.com/i/abc123/?utm_campaign=y"), messages: [bubble("m1", HREF)], deadHrefs: NONE, activePromptKind: "post_payment_link", graceExpired: true })
    expect(screen(v).panels).toBe(1)
  })

  it("resultado local ainda sem bolha: slot 'gerando' (sem link, sem botões); só após a carência o painel local aparece", () => {
    const early = resolveLinkView({ payResult: local(HREF, "m1"), messages: [menu], deadHrefs: NONE, activePromptKind: "post_payment_link" })
    expect(early.fallback).toEqual({ mode: "generating" })
    expect(screen(early)).toEqual({ panels: 0, rows: 1 })
    expect(early.hasLiveLink).toBe(false)
    const late = resolveLinkView({ payResult: local(HREF, "m1"), messages: [menu], deadHrefs: NONE, activePromptKind: null, graceExpired: true })
    expect(late.fallback).toEqual({ mode: "panel", href: HREF })
    expect(late.postLinkRow).toBe("local") // sem prompt do servidor → a rede de segurança local
    expect(screen(late)).toEqual({ panels: 1, rows: 1 })
    expect(LINK_BUBBLE_GRACE_MS).toBeGreaterThanOrEqual(3000)
  })

  it("nunca 2 fileiras: com o prompt pós-link do servidor a fileira local não existe, mesmo com o painel local", () => {
    const v = resolveLinkView({ payResult: local(HREF), messages: [menu], deadHrefs: NONE, activePromptKind: "post_payment_link", graceExpired: true })
    expect(v.postLinkRow).toBe("server")
    expect(screen(v).rows).toBe(1)
  })

  it("só a ÚLTIMA bolha viva ganha o painel (cobrança recriada)", () => {
    const v = resolveLinkView({ payResult: null, messages: [bubble("m1", HREF), bubble("m2", "https://www.asaas.com/i/new")], deadHrefs: new Set([HREF]), activePromptKind: null })
    expect(v.panelMessageId).toBe("m2")
  })
})

describe("QAA1-R4-01 — cancelamento vindo de outra aba desliga Abrir/Copiar no próximo poll", () => {
  it("href da bolha em dead_payment_links → 0 painéis; resultado local com o mesmo href → clearLocal", () => {
    const dead = new Set([HREF])
    const v = resolveLinkView({ payResult: local(HREF, "m1"), messages: [bubble("m1", HREF)], deadHrefs: dead, activePromptKind: "post_payment_link", graceExpired: true })
    expect(v.panelMessageId).toBeNull()
    expect(v.fallback).toBeNull()
    expect(v.clearLocal).toBe(true)
    expect(v.hasLiveLink).toBe(false)
    expect(screen(v).panels).toBe(0)
  })

  it("cobrança criada na outra aba e cancelada (sem resultado local): bolha só texto", () => {
    const v = resolveLinkView({ payResult: null, messages: [bubble("m1", HREF)], deadHrefs: new Set([HREF]), activePromptKind: "debt_three_options" })
    expect(screen(v)).toEqual({ panels: 0, rows: 0 })
  })

  it("painel LOCAL (carência expirada) com href morto nunca aparece — nem por variação de formato do href", () => {
    const dead = new Set(["https://WWW.asaas.com/i/abc123/"])
    expect(isHrefDead(HREF, dead)).toBe(true)
    const v = resolveLinkView({ payResult: local(HREF), messages: [menu], deadHrefs: dead, activePromptKind: null, graceExpired: true })
    expect(v.fallback).toBeNull()
    expect(v.clearLocal).toBe(true)
    expect(screen(v)).toEqual({ panels: 0, rows: 0 })
  })

  it("live:false do servidor (retomada) também desliga", () => {
    const v = resolveLinkView({ payResult: null, messages: [bubble("m1", HREF, { live: false })], deadHrefs: NONE, activePromptKind: null })
    expect(v.panelMessageId).toBeNull()
  })

  it("Voltar às opções: sem resultado local e sem prompt pós-link → 0 painéis/fileiras pós-link órfãos", () => {
    const v = resolveLinkView({ payResult: null, messages: [bubble("m1", HREF)], deadHrefs: new Set([HREF]), activePromptKind: "debt_three_options" })
    expect(v.postLinkRow).toBe("none")
    expect(screen(v).panels).toBe(0)
  })
})

describe("chat.tsx — wire-up (leitura do fonte)", () => {
  const src = readFileSync(join(__dirname, "..", "..", "components/journey/chat.tsx"), "utf8")

  it("o painel vem de resolveLinkView; o painel local só existe como fallback 'panel' (nunca ao lado da bolha)", () => {
    expect(src).toContain("const linkView = resolveLinkView({")
    expect(src).toContain("const latestPaymentLinkId = linkView.panelMessageId")
    expect(src).not.toContain("hasPersistedLink")
    expect(src).toContain('linkView.fallback?.mode === "panel"')
    expect(src).toContain('linkView.postLinkRow === "local"')
  })

  it("o poll zera o estado local quando o href do resultado local entra em dead_payment_links", () => {
    expect(src).toMatch(/isHrefDead\(localPay\.link, deadHrefs\)\) \{\s*clearLinkLocalState\(\)/)
  })

  it("Voltar limpa sempre: reopenOptions e o [98] (back_to_options) chamam clearLinkLocalState", () => {
    expect(src).toMatch(/async function reopenOptions\(\) \{[\s\S]{0,200}clearLinkLocalState\(\)/)
    expect(src).toContain('if (data?.action === "back_to_options") clearLinkLocalState()')
  })

  it("o prompt pós-link do corpo do Pagar entra na hora (a única fileira) e o id da bolha é guardado", () => {
    expect(src).toContain("if (!applyActionBody(data)) setActivePrompt(null)")
    expect(src).toContain("linkMessageId: m.id")
    expect(src).toContain('typeof data.link_message_id === "string"')
  })
})
