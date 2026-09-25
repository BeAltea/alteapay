// A4 — VARREDURA da carta de voz (D45 / Apêndice B) sobre o CONJUNTO de strings
// da jornada: zero travessão, zero emoji, zero "Tudo bem?", zero "se já pagou
// desconsidere", zero muleta ("Perfeito!/Pronto!/Obrigado!"), zero nome de sistema
// na fala ao devedor. Duas camadas:
//   (a) SAÍDA das funções de copy com contextos representatives (o que o devedor lê);
//   (b) FONTE dos arquivos da jornada (JSX/rota/libs), com comentários removidos —
//       identificadores nunca têm travessão/emoji, então qualquer ocorrência
//       restante é string exibível.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  acknowledgementQuestion,
  acknowledgementButtons,
  backToOptionsButtons,
  consultNegotiateButtons,
  consultNegotiateQuestion,
  debtConsultReply,
  debtInfoMessage,
  debtSettledContactAction,
  notRecognizedReply,
  offerButtonLabel,
  offerChoiceQuestion,
  postConsultButtons,
  postConsultQuestion,
  REOPEN_MENU_QUESTION,
  settledMessage,
  threeOptionsButtons,
  threeOptionsSummary,
  type AckContext,
} from "@/lib/journey/acknowledgement"
import { payLinkMessageText, postPaymentLinkButtons, paymentLinkAction } from "@/lib/journey/pay"
import { humanHandoffReply, paymentClaimReply } from "@/lib/journey/actions"
import { recapText } from "@/lib/journey/recap"
import { DEGRADED_MENU_COPY, NEGOTIATION_PENDING_TEXT, NEGOTIATION_SEARCHING_TEXT, waitStepCopy } from "@/lib/journey/wait-machine"
import { isNegotiateLabel } from "@/components/journey/chat-display"
import { ENTRY_SEAL_WHO_LABEL, entrySealText, entrySealWhoText } from "@/lib/journey/entry-seal"
import type { OfferTerms } from "@/lib/negotiation/offers"

const ROOT = join(__dirname, "..", "..")

/** Antipadrões D45 — NENHUMA string exibível pode conter. */
const FORBIDDEN: Array<[string, RegExp]> = [
  ["travessão", /—/],
  ["emoji", /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u],
  ["'Tudo bem?'", /tudo bem\?/i],
  ["'se já pagou desconsidere'", /desconsider/i],
  ["muleta 'Perfeito!'", /Perfeito!/],
  ["muleta 'Pronto!'", /Pronto!/],
  ["muleta 'Obrigado!'", /Obrigado!/],
  ["nome de sistema", /\bn8n\b|\bASAAS\b|supabase|netlify|\bHTTP\b|stack|status code/i],
]

const ACK: AckContext = { firstName: "Fabio", creditorName: "VMAX", updatedValue: 250, invoiceCount: 3, oldestDueDate: "2026-08-15" }
const cash: OfferTerms = {
  original_value: 250, discount_pct: 30, discount_value: 75, entry_value: 0,
  installments: 1, installment_value: 175, total_value: 175, billing_type: "PIX", first_due_date: "2026-08-18",
}

/** Tudo que o devedor pode ler, gerado pelo código atual. */
function journeyStrings(): Array<[string, string]> {
  const out: Array<[string, string]> = [
    ["S5 saudação", threeOptionsSummary(ACK)],
    ["S5 saudação sem nome", threeOptionsSummary({ ...ACK, firstName: "" })],
    ["S6 retorno", recapText("after_link", "Pagar R$ 250,00", "Fabio")],
    ["S6 retorno sem nome", recapText("after_decision", null)],
    ["S7 negociar-antes", NEGOTIATION_PENDING_TEXT],
    ["S7 negociar-antes sem parcelas (B3-F2)", NEGOTIATION_SEARCHING_TEXT],
    ["S8 pergunta parcelas", offerChoiceQuestion()],
    ["S9 à vista", offerButtonLabel(cash)],
    ["S9 parcelado", offerButtonLabel({ ...cash, installments: 3, installment_value: 78.33, total_value: 235 })],
    ["S10 detalhes", debtConsultReply(ACK)],
    ["S10 detalhes sem data", debtConsultReply({ ...ACK, oldestDueDate: null, invoiceCount: 0 })],
    ["menu reemitido", REOPEN_MENU_QUESTION],
    ["S11 não reconheço (sem canal)", notRecognizedReply({ creditorName: "VMAX", hasConfig: false, channelLabel: null, channelUrl: null })],
    ["S11 não reconheço (com canal)", notRecognizedReply({ creditorName: "VMAX", hasConfig: true, channelLabel: "SAC 0800", channelUrl: null })],
    ["S14 link", payLinkMessageText({ link: "https://x/1", valor: 250, vencimentoLink: "2026-08-18", alreadyCharged: false })],
    ["S15 já existia", payLinkMessageText({ link: "https://x/1", valor: 250, vencimentoLink: null, alreadyCharged: true })],
    ["ação do link", paymentLinkAction("https://x/1").label],
    ["S18 já paguei", paymentClaimReply("VMAX")],
    ["S19 d3", waitStepCopy("d3_slow")],
    ["degradação", DEGRADED_MENU_COPY],
    ["handoff", humanHandoffReply("VMAX")],
    ["S20 ação quitação", debtSettledContactAction().label],
    ["S21 quitação", settledMessage({ firstName: "Fabio", creditorName: "VMAX", totalPaid: 250, oldestDueDate: "2026-08-15", paidAt: "2026-09-20" })],
    ["S23 reconhecimento", acknowledgementQuestion(ACK)],
    ["S24 consultar/negociar", consultNegotiateQuestion(ACK)],
    ["S24 dados", debtInfoMessage(ACK)],
    ["pós-consulta", postConsultQuestion()],
    ["porta selo", entrySealText("VMAX")],
    ["porta quem somos", ENTRY_SEAL_WHO_LABEL],
    ["porta quem somos (texto)", entrySealWhoText("VMAX")],
  ]
  const buttonSets: Array<[string, { label: string }[]]> = [
    ["S1–S4 menu", threeOptionsButtons(250, true)],
    ["S12 volta", backToOptionsButtons()],
    ["pós-link", postPaymentLinkButtons()],
    ["legado reconhecimento", acknowledgementButtons(true)],
    ["legado consultar/negociar", consultNegotiateButtons(true)],
    ["legado pós-consulta", postConsultButtons(true)],
  ]
  for (const [name, buttons] of buttonSets) for (const b of buttons) out.push([`${name}: ${b.label}`, b.label])
  return out
}

describe("(a) saída das funções de copy — antipadrões D45 banidos", () => {
  for (const [name, text] of journeyStrings()) {
    it(`${name}: sem travessão/emoji/'Tudo bem?'/'desconsidere'/muleta/nome de sistema`, () => {
      expect(text.trim().length).toBeGreaterThan(0)
      for (const [what, re] of FORBIDDEN) expect(text, `${what} em "${text}"`).not.toMatch(re)
    })
  }

  it("R-12: o VALOR só aparece no rótulo PAGAR, nas ofertas e nos outcomes (link/quitação) — nunca em saudação/detalhes/contestação", () => {
    const noValue = [
      threeOptionsSummary(ACK), recapText("after_link", null, "Fabio"), debtConsultReply(ACK), debtInfoMessage(ACK),
      notRecognizedReply({ creditorName: "VMAX", hasConfig: false, channelLabel: null, channelUrl: null }),
      acknowledgementQuestion(ACK), consultNegotiateQuestion(ACK), paymentClaimReply("VMAX"), NEGOTIATION_PENDING_TEXT,
      NEGOTIATION_SEARCHING_TEXT,
    ]
    for (const t of noValue) expect(t).not.toMatch(/R\$|250/)
  })

  it("nenhuma string exibível cita a AlteaPay como dona da dívida nem ameaça (D36)", () => {
    for (const [, text] of journeyStrings()) {
      expect(text).not.toMatch(/negativa|protesto|judicial|SPC|Serasa|cart[óo]rio/i)
      expect(text).not.toMatch(/dívida (da|com a) AlteaPay/i)
    }
  })
})

/** Remove comentários de bloco (inclusive os de JSX) e de linha (preservando "://"). */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/gm, "$1")
}

const SCOPE_FILES = [
  "lib/journey/acknowledgement.ts",
  "lib/journey/pay.ts",
  "lib/journey/pay-poll.ts",
  "lib/journey/actions.ts",
  "lib/journey/wait-machine.ts",
  "lib/journey/recap.ts",
  "lib/journey/entry-seal.ts",
  "app/api/chat/button/route.ts",
  "components/journey/chat.tsx",
  "components/journey/chat-display.ts",
  "components/journey/prompt-buttons.tsx",
  "components/journey/debt-card.tsx",
  "components/journey/button-tiers.ts",
  "components/journey/public-auth-form.tsx",
  // A4 r2 (B3-F3): entrada viva /t/[tenantSlug]/negociar (porta + casca)
  "components/journey/generic-auth-form.tsx",
  "app/t/[tenantSlug]/negociar/layout.tsx",
  "app/(journey)/n/[code]/layout.tsx",
  "app/(journey)/c/[token]/layout.tsx",
]

describe("(b) fonte dos arquivos da jornada (sem comentários) — zero travessão/emoji/muleta", () => {
  for (const rel of SCOPE_FILES) {
    it(rel, () => {
      const code = stripComments(readFileSync(join(ROOT, rel), "utf8"))
      const lines = code.split("\n")
      const hits: string[] = []
      lines.forEach((l, i) => {
        if (/—/.test(l)) hits.push(`${i + 1}: travessão: ${l.trim()}`)
        if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(l)) hits.push(`${i + 1}: emoji: ${l.trim()}`)
        if (/tudo bem\?|desconsider|Perfeito!|Pronto!|Obrigado!/i.test(l)) hits.push(`${i + 1}: muleta/antipadrão: ${l.trim()}`)
        // rótulos antigos (case-sensitive: o matcher legado de atalhos em chat.tsx é minúsculo)
        if (/Quero pagar|Quero negociar|Consultar dívida|Não reconheço esta dívida|Na verdade, quero|parceira oficial/.test(l)) {
          hits.push(`${i + 1}: rótulo antigo: ${l.trim()}`)
        }
      })
      expect(hits, hits.join("\n")).toEqual([])
    })
  }
})

describe("isNegotiateLabel — reconhece 'Negociar' (S2) e nunca os demais rótulos", () => {
  it("canônico e legado → true", () => {
    expect(isNegotiateLabel("Negociar")).toBe(true)
    expect(isNegotiateLabel("Negociar Dívida")).toBe(true)
    expect(isNegotiateLabel("negociar")).toBe(true)
  })
  it("os outros rótulos do Apêndice B → false", () => {
    for (const l of ["Pagar R$ 250,00", "Detalhes da dívida", "Não reconheço", "Já paguei este valor", "Voltar às opções", "Falar com atendimento", "Continuar", ""]) {
      expect(isNegotiateLabel(l), l).toBe(false)
    }
  })
})
