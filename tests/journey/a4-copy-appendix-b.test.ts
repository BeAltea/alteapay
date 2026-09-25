// A4 — COPY (G5): as 26 strings S1–S26 de 01-descoberta-D5.md §6 casam o texto-alvo
// do Apêndice B (PROMPT_TIMES_FECHAMENTO_NEGOCIACAO_2026-09-25.md), string a string.
//
// Funções puras são chamadas com contextos representativos; as strings que vivem
// em JSX (chat.tsx, layouts, public-auth-form.tsx) e as inline da rota são
// conferidas na FONTE (mesmo padrão de a1-no-store.test.ts), já que o vitest deste
// repo roda em node e não monta React. Rótulos com valor usam \s? entre "R$" e o
// número (o Intl emite um espaço não-separável).
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  acknowledgementQuestion,
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
  REOPEN_MENU_QUESTION,
  settledMessage,
  threeOptionsButtons,
  threeOptionsSummary,
  type AckContext,
} from "@/lib/journey/acknowledgement"
import { payLinkMessageText as payLinkFromPay, postPaymentLinkButtons } from "@/lib/journey/pay"
import { payLinkMessageText } from "@/lib/journey/pay-poll"
import { paymentClaimReply } from "@/lib/journey/actions"
import { recapText, type RecapState } from "@/lib/journey/recap"
import { NEGOTIATION_PENDING_TEXT, NEGOTIATION_SEARCHING_TEXT, waitStepCopy } from "@/lib/journey/wait-machine"
import { NEGOTIATION_PENDING_TEXT as PENDING_FROM_CLIENT } from "@/components/journey/chat-display"
import type { OfferTerms } from "@/lib/negotiation/offers"

const ROOT = join(__dirname, "..", "..")
const src = (rel: string) => readFileSync(join(ROOT, rel), "utf8")

const ACK: AckContext = { firstName: "Fabio", creditorName: "VMAX", updatedValue: 250, invoiceCount: 3, oldestDueDate: "2026-08-15" }
const ACK_ONE: AckContext = { ...ACK, invoiceCount: 1 }
const ACK_NO_NAME: AckContext = { ...ACK, firstName: "" }
const PENDING = "Certo. Estas são as condições disponíveis para você:"

describe("S1–S4 — rótulos do menu de 3 opções (Apêndice B)", () => {
  it("Pagar R$ 250,00 (sem travessão) · Negociar · Detalhes da dívida · Não reconheço", () => {
    const labels = threeOptionsButtons(250, false).map((b) => b.label)
    expect(labels[0]).toMatch(/^Pagar R\$\s?250,00$/)
    expect(labels.slice(1)).toEqual(["Negociar", "Detalhes da dívida", "Não reconheço"])
    for (const l of labels) expect(l).not.toContain("—")
  })
  it("com handoff: o 5º é 'Falar com atendimento'", () => {
    expect(threeOptionsButtons(250, true).map((b) => b.label)[4]).toBe("Falar com atendimento")
  })
})

describe("S5 — saudação inicial", () => {
  it("Olá, {primeiro_nome}. Este é o canal oficial de negociação da {credor}, operado pela AlteaPay. Como você prefere seguir?", () => {
    expect(threeOptionsSummary(ACK)).toBe(
      "Olá, Fabio. Este é o canal oficial de negociação da VMAX, operado pela AlteaPay. Como você prefere seguir?",
    )
  })
  it("sem nome: 'Olá. Este é o canal oficial…' (nunca 'Olá, .')", () => {
    expect(threeOptionsSummary(ACK_NO_NAME)).toBe(
      "Olá. Este é o canal oficial de negociação da VMAX, operado pela AlteaPay. Como você prefere seguir?",
    )
  })
})

describe("S6 — saudação de retorno (recap)", () => {
  const states: RecapState[] = ["after_link", "after_negotiate", "after_payment_claim", "after_not_recognized", "after_decision"]
  it("Olá de novo, {primeiro_nome}. Você já viu os detalhes do valor em aberto. Como prefere seguir? — única para todos os estados", () => {
    for (const s of states) {
      expect(recapText(s, "Pagar R$ 250,00", "Fabio")).toBe(
        "Olá de novo, Fabio. Você já viu os detalhes do valor em aberto. Como prefere seguir?",
      )
    }
  })
  it("sem nome → 'Olá de novo.' (nunca 'Olá de novo, .')", () => {
    expect(recapText("after_decision", null)).toBe("Olá de novo. Você já viu os detalhes do valor em aberto. Como prefere seguir?")
    expect(recapText("after_decision", null, "  ")).not.toContain("Olá de novo, ")
  })
})

describe("S7/S8/S22 — 'Negociar - antes': uma frase, uma constante", () => {
  it("NEGOTIATION_PENDING_TEXT = 'Certo. Estas são as condições disponíveis para você:' (servidor e client, a MESMA constante)", () => {
    expect(NEGOTIATION_PENDING_TEXT).toBe(PENDING)
    expect(PENDING_FROM_CLIENT).toBe(NEGOTIATION_PENDING_TEXT)
  })
  it("S8: a pergunta do prompt de parcelas é a mesma frase", () => {
    expect(offerChoiceQuestion()).toBe(PENDING)
  })
  it("T2 (button/route.ts) usa as constantes — sem literal inline, sem 'Perfeito!' (S22)", () => {
    const route = src("app/api/chat/button/route.ts")
    expect(route).toContain('import { NEGOTIATION_PENDING_TEXT, NEGOTIATION_SEARCHING_TEXT } from "@/lib/journey/wait-machine"')
    // menu de 3 opções: as parcelas seguem → S7 (com dois-pontos)
    expect(route).toContain("const reply = NEGOTIATION_PENDING_TEXT")
    // legado "Sim, reconheço": só kickoff em background, nada vem depois → frase completa (B3-F2)
    expect(route).toContain("const recognizedReply = NEGOTIATION_SEARCHING_TEXT")
    expect(route).not.toContain("const recognizedReply = NEGOTIATION_PENDING_TEXT")
    expect(route).not.toContain('"Certo. Vou buscar as condições')
    expect(route).not.toContain('"Certo. Estas são as condições')
    // a string legada era atribuída ("= \"Perfeito!…\"" / linha começando em "\"Perfeito!"); comentários não contam
    expect(route).not.toMatch(/=\s*"Perfeito!|\n\s*"Perfeito!/)
    expect(src("lib/journey/acknowledgement.ts")).not.toMatch(/=\s*"Perfeito!|\n\s*"Perfeito!/)
  })
  it("B3-F2: S7 termina em dois-pontos SÓ onde as parcelas seguem; sem parcelas a frase é completa (NEGOTIATION_SEARCHING_TEXT)", () => {
    expect(NEGOTIATION_PENDING_TEXT.endsWith(":")).toBe(true)
    expect(NEGOTIATION_SEARCHING_TEXT).toBe("Certo. Vou buscar as condições de pagamento disponíveis para você.")
    expect(NEGOTIATION_SEARCHING_TEXT.endsWith(".")).toBe(true)
    expect(NEGOTIATION_SEARCHING_TEXT).not.toMatch(/Estas são|:$/)
    // fonte única (N-D5-8): o alias NEGOTIATE_ACK_TEXT saiu; handleDebtNegotiate escolhe
    // a frase pelo desfecho (com parcelas → S7 gravada como precedingWrite; sem → completa).
    const ack = src("lib/journey/acknowledgement.ts")
    expect(ack).not.toContain("NEGOTIATE_ACK_TEXT")
    expect(ack).toContain("const reply = offersPresented ? NEGOTIATION_PENDING_TEXT : NEGOTIATION_SEARCHING_TEXT")
    // comportamento: a2-legacy-negotiate (sem faixa → SEARCHING; com parcelas → S7) e e2e-lab-reconhecimento.
  })
})

describe("S9 — rótulo da oferta à vista (sem travessão)", () => {
  const cash: OfferTerms = {
    original_value: 250, discount_pct: 30, discount_value: 75, entry_value: 0,
    installments: 1, installment_value: 175, total_value: 175, billing_type: "PIX", first_due_date: "2026-08-18",
  }
  it("À vista R$ 175,00, economia de R$ 75,00 (recomendado)", () => {
    expect(offerButtonLabel(cash)).toMatch(/^À vista R\$\s?175,00, economia de R\$\s?75,00 \(recomendado\)$/)
  })
  it("sem desconto: 'À vista R$ 250,00 (recomendado)'; parcelado: 'Nx de R$ … (total R$ …)'", () => {
    expect(offerButtonLabel({ ...cash, discount_pct: 0, discount_value: 0, installment_value: 250, total_value: 250 }))
      .toMatch(/^À vista R\$\s?250,00 \(recomendado\)$/)
    expect(offerButtonLabel({ ...cash, installments: 3, installment_value: 78.33, total_value: 235 }))
      .toMatch(/^3x de R\$\s?78,33 \(total R\$\s?235,00\)$/)
  })
})

describe("S10/S24 — Detalhes da dívida", () => {
  it("bolha + pergunta do menu = 'Vencimento original {venc} · {n} fatura(s) · {descrição}. Como prefere seguir?'", () => {
    const onScreen = `${debtConsultReply(ACK)} ${REOPEN_MENU_QUESTION}`
    // B3-F4: "2026-08-15" (coluna date) é 15/08/2026 em QUALQUER fuso do runtime (componentes, sem Date)
    expect(onScreen).toBe("Vencimento original 15/08/2026 · 3 faturas · serviço da VMAX. Como prefere seguir?")
    expect(debtConsultReply(ACK_ONE)).toBe("Vencimento original 15/08/2026 · 1 fatura · serviço da VMAX.")
  })
  it("segmentos ausentes são omitidos (nunca '—'/vazio); sem valor na fala", () => {
    expect(debtConsultReply({ ...ACK, invoiceCount: 0 })).toBe("Vencimento original 15/08/2026 · serviço da VMAX.")
    expect(debtConsultReply({ ...ACK, oldestDueDate: null })).toBe("3 faturas · serviço da VMAX.")
    expect(debtConsultReply({ ...ACK, oldestDueDate: "não é data" })).toBe("3 faturas · serviço da VMAX.")
    expect(debtConsultReply(ACK)).not.toContain("R$")
  })
  it("B3-F6: sem vencimento E sem nº de faturas a bolha é uma frase completa, nunca o fragmento 'serviço da VMAX.'", () => {
    const bare = debtConsultReply({ ...ACK, oldestDueDate: null, invoiceCount: 0 })
    expect(bare).toBe("Este valor refere-se a um serviço da VMAX.")
    expect(bare).not.toContain("—")
    expect(bare).not.toContain("R$")
    // na tela: bolha + pergunta do menu reemitido (uma pergunta só, decisão §4.1)
    expect(`${bare} ${REOPEN_MENU_QUESTION}`).toBe("Este valor refere-se a um serviço da VMAX. Como prefere seguir?")
    expect(debtInfoMessage({ ...ACK, oldestDueDate: null, invoiceCount: 0 })).toBe(bare)
  })
  it("debtInfoMessage (legado) usa a mesma linha compacta", () => {
    expect(debtInfoMessage(ACK)).toBe(debtConsultReply(ACK))
  })
})

describe("S11 — Não reconheço", () => {
  it("com canal: 'Registramos que você não reconhece esta cobrança. Para entender a origem e contestar, fale com a {credor}: {canal_oficial}.'", () => {
    expect(notRecognizedReply({ creditorName: "VMAX", hasConfig: true, channelLabel: "SAC VMAX 0800-123", channelUrl: "https://vmax.example/sac" })).toBe(
      "Registramos que você não reconhece esta cobrança. Para entender a origem e contestar, fale com a VMAX: SAC VMAX 0800-123 (https://vmax.example/sac).",
    )
  })
  it("sem canal (VMAX hoje): fallback 'pelo canal informado na sua fatura ou no site oficial da {credor}'", () => {
    expect(notRecognizedReply({ creditorName: "VMAX", hasConfig: false, channelLabel: null, channelUrl: null })).toBe(
      "Registramos que você não reconhece esta cobrança. Para entender a origem e contestar, fale com a VMAX pelo canal informado na sua fatura ou no site oficial da VMAX.",
    )
  })
  it("N-D5-8: a rota chama a função única (nenhuma cópia inline da frase)", () => {
    const route = src("app/api/chat/button/route.ts")
    expect(route).not.toContain("`Registramos que você não reconhece")
    expect(route.match(/notRecognizedReply\(/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
  })
})

describe("S12 — volta às opções", () => {
  it("rótulo 'Voltar às opções'; pergunta do prompt de volta vazia (o rótulo basta)", () => {
    expect(backToOptionsButtons().map((b) => b.label)).toEqual(["Voltar às opções"])
    const route = src("app/api/chat/button/route.ts")
    expect(route).not.toContain("Se preferir, você pode voltar às opções.")
    expect(route).toMatch(/question: "",\s*\n\s*buttons: backToOptionsButtons\(\)/)
    expect(postPaymentLinkButtons().map((b) => b.label)).toEqual(["Voltar às opções", "Falar com atendimento"])
  })
})

describe("S13/S16/S17 — Pagar (client, chat.tsx)", () => {
  const chat = src("components/journey/chat.tsx")
  it("S13 antes: 'Certo. Estou gerando seu link de pagamento.'", () => {
    expect(chat).toContain('"Certo. Estou gerando seu link de pagamento."')
    expect(chat).not.toContain("Só um instante")
  })
  it("S16 erro: 'Não consegui gerar o link agora.' + [Tentar de novo] [Falar com atendimento]", () => {
    expect(chat).toContain('"Não consegui gerar o link agora."')
    expect(chat).toContain('"Não consegui gerar o link agora. Nenhuma cobrança foi criada."')
    // rótulos como TEXTO JSX (linha própria) — os comentários do arquivo não contam
    expect(chat).toMatch(/\n\s+Tentar de novo\n/)
    expect(chat).not.toMatch(/\n\s+Tentar novamente\n/)
    expect(chat).toMatch(/\n\s+Falar com atendimento\n/)
  })
  it("S17 processing: 'Estou gerando seu link de pagamento. Assim que estiver pronto, ele aparece aqui.'", () => {
    expect(chat).toContain("Estou gerando seu link de pagamento. Assim que estiver pronto, ele aparece aqui.")
    expect(chat).not.toContain("pode aguardar um instante")
  })
  it("o painel-fallback usa payLinkMessageText (N-D5-8) — nenhuma copy do link duplicada no client", () => {
    expect(chat).toContain("payLinkMessageText({")
    expect(chat).not.toContain("Aqui está o seu link")
    expect(chat).not.toContain("Use o mesmo link abaixo")
  })
})

describe("S14/S15 — link de pagamento (fonte única: pay-poll.ts, re-exportada por pay.ts)", () => {
  it("pay.ts re-exporta a MESMA função", () => {
    expect(payLinkFromPay).toBe(payLinkMessageText)
  })
  it("S14: 'Aqui está seu link para pagar {valor}, válido até {vencimento_link}.' + URL em linha própria", () => {
    const t = payLinkMessageText({ link: "https://x/1", valor: 250, vencimentoLink: "2026-08-18", alreadyCharged: false })
    expect(t).toMatch(/^Aqui está seu link para pagar R\$\s?250,00, válido até 18\/08\/2026\.\nhttps:\/\/x\/1$/)
  })
  it("S15: 'Você já tem uma cobrança ativa de {valor}. Use o link abaixo; não é preciso gerar outro.'", () => {
    const t = payLinkMessageText({ link: "https://x/1", valor: 250, vencimentoLink: null, alreadyCharged: true })
    expect(t).toMatch(/^Você já tem uma cobrança ativa de R\$\s?250,00\. Use o link abaixo; não é preciso gerar outro\.\nhttps:\/\/x\/1$/)
  })
  it("sem link (painel do client) e sem valor: frases fechadas, sem vazio/travessão", () => {
    expect(payLinkMessageText({ link: null, valor: null, vencimentoLink: null, alreadyCharged: false })).toBe("Aqui está seu link de pagamento.")
    expect(payLinkMessageText({ link: null, valor: null, vencimentoLink: null, alreadyCharged: true })).toBe(
      "Você já tem uma cobrança ativa. Use o link abaixo; não é preciso gerar outro.",
    )
  })
})

describe("S18 — Já paguei", () => {
  it("texto fixo (B3-F5): 'Obrigado por avisar. Vamos conferir o pagamento. Se quiser adiantar, fale com o atendimento.'", () => {
    // O tenant não tem campo de contato de atendimento (official_channel_* é o canal do
    // CREDOR, da contestação), então o segmento ": {contato}" do Apêndice B fica fora —
    // sem parâmetro morto e sem promessa; termina em "fale com o atendimento." (nunca ": .").
    const t = paymentClaimReply("VMAX")
    expect(t).toBe("Obrigado por avisar. Vamos conferir o pagamento. Se quiser adiantar, fale com o atendimento.")
    expect(t).not.toMatch(/: \.$|\{contato\}/)
    expect(paymentClaimReply()).toBe(t)
    expect(src("lib/journey/actions.ts")).toMatch(/export function paymentClaimReply\(_creditorName\?: string\): string/)
  })
  it("não declara pago (D6/M15)", () => {
    expect(paymentClaimReply("VMAX")).not.toMatch(/pagamento (confirmado|recebido)|quitad[oa]|est[aá] pago/i)
  })
  it("a âncora do recap reconhece a copy nova E a geração anterior (bolhas já gravadas)", () => {
    const recap = src("lib/journey/recap.ts")
    expect(recap).toContain("/vamos conferir o pagamento|registramos que você já pagou/i")
  })
})

describe("S19 — espera", () => {
  it("d2 sem texto próprio (S7 é a única frase de espera); d3 = 'Está demorando mais que o normal. Se preferir, você pode resolver agora:'", () => {
    expect(waitStepCopy("d2_narrated")).toBe("")
    expect(waitStepCopy("d3_slow")).toBe("Está demorando mais que o normal. Se preferir, você pode resolver agora:")
  })
})

describe("S20/S21 — quitação", () => {
  it("S20: ação de contato = 'Falar com atendimento'", () => {
    expect(debtSettledContactAction().label).toBe("Falar com atendimento")
  })
  it("S21: 'Olá, {nome}. Não há valor em aberto em seu nome com a {credor}: o pagamento de {valor} consta como recebido{ em {data}}. Se precisar de algo, fale com o atendimento.'", () => {
    const base = { firstName: "Fabio", creditorName: "VMAX", totalPaid: 250, oldestDueDate: "2026-08-15", paidAt: null }
    expect(settledMessage(base)).toMatch(
      /^Olá, Fabio\. Não há valor em aberto em seu nome com a VMAX: o pagamento de R\$\s?250,00 consta como recebido\. Se precisar de algo, fale com o atendimento\.$/,
    )
    // B3-F4: dia civil em America/Sao_Paulo (runtime UTC na Netlify): 12h UTC = 09h BRT → 20/09;
    // 01:30 UTC de 21/09 = 22:30 BRT de 20/09 → 20/09 (não o dia seguinte); data civil pura → componentes.
    expect(settledMessage({ ...base, paidAt: "2026-09-20T12:00:00Z" })).toContain("consta como recebido em 20/09/2026. Se precisar")
    expect(settledMessage({ ...base, paidAt: "2026-09-21T01:30:00Z" })).toContain("consta como recebido em 20/09/2026. Se precisar")
    expect(settledMessage({ ...base, paidAt: "2026-09-20" })).toContain("consta como recebido em 20/09/2026. Se precisar")
    expect(settledMessage({ ...base, paidAt: "inválida" })).toContain("consta como recebido. Se precisar")
    expect(settledMessage({ ...base, firstName: "" }).startsWith("Olá. Não há valor")).toBe(true)
    expect(settledMessage(base)).not.toMatch(/PAGA|Obrigado!|!/)
  })
})

describe("S23/S24 — caminhos legados (debt_acknowledgement / debt_consult)", () => {
  it("S23: 'Olá, {nome}. Este é o canal oficial de negociação da {credor}, operado pela AlteaPay. Você reconhece esta cobrança em seu nome?'", () => {
    expect(acknowledgementQuestion(ACK)).toBe(
      "Olá, Fabio. Este é o canal oficial de negociação da VMAX, operado pela AlteaPay. Você reconhece esta cobrança em seu nome?",
    )
  })
  it("S24: saudação Consultar/Negociar com a mesma abertura; rótulos alinhados a S2–S4", () => {
    expect(consultNegotiateQuestion(ACK)).toBe(
      "Olá, Fabio. Este é o canal oficial de negociação da VMAX, operado pela AlteaPay. O que você deseja fazer?",
    )
    expect(consultNegotiateButtons(false).map((b) => b.label)).toEqual(["Detalhes da dívida", "Negociar"])
    expect(postConsultButtons(false).map((b) => b.label)).toEqual(["Negociar", "Não reconheço"])
  })
})

describe("S25/S26 — casca (layouts) e porta", () => {
  it("S25: cabeçalho pós-login 'AlteaPay · canal oficial de negociação da {credor}' nos dois layouts da jornada", () => {
    for (const rel of ["app/(journey)/n/[code]/layout.tsx", "app/(journey)/c/[token]/layout.tsx"]) {
      const s = src(rel)
      expect(s).toContain("subtitle: `AlteaPay · canal oficial de negociação da ${branding.brandName}`")
      expect(s).not.toContain("parceira oficial de cobrança")
    }
  })
  it("S25 na entrada viva /t/[tenantSlug]/negociar (B3-F3): mesmo subtítulo, sem 'parceira oficial de cobrança'", () => {
    const s = src("app/t/[tenantSlug]/negociar/layout.tsx")
    expect(s).toContain("AlteaPay · canal oficial de negociação da {branding.brandName}")
    expect(s).not.toContain("parceira oficial")
  })
  it("S26: o submit das duas portas é 'Continuar' (não colide com 'Detalhes da dívida')", () => {
    for (const rel of ["components/journey/public-auth-form.tsx", "components/journey/generic-auth-form.tsx"]) {
      const s = src(rel)
      expect(s, rel).toContain('{submitting ? "Confirmando..." : "Continuar"}')
      expect(s, rel).not.toContain(': "Consultar"')
    }
  })
})
