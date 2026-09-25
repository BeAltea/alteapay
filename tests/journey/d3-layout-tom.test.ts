// D3 — LAYOUT + TOM. Cobre a fronteira do dev D3:
//   (A) HIERARQUIA VISUAL (C11 / R-18): pagar primário, negociar secundário,
//       consultar/não-reconheço terciários — derivada por buttonTier (pura).
//   (B) MOBILE 360 (C12): alvo de toque ≥44px (R-19: min-h-[44px] no estilo base),
//       1º botão acima da dobra (primary = w-full no mobile), SEM largura fixa em px.
//   (C) SEPARAÇÃO anti-clique-errado (R-20): "Não reconheço" isolado do grupo de
//       resolução (isContestation).
//   (D) CONTRASTE AA (R-23): cor de texto adaptativa por luminância (contrast.ts).
//   (E) CARTA DE VOZ §10.2 (T1..T13 + R-46): guardas de regressão de copy — sem
//       alegria forçada, sem "se já pagou desconsidere" (virou o botão "Já paguei",
//       C10), valor SÓ no card/outcome (R-12), AlteaPay identificada como operadora.
//
// Ambiente node do vitest: importamos a lógica PURA (button-tiers.ts, contrast.ts)
// e as funções de copy (.ts), nunca montamos React (o .tsx não é o objeto de teste;
// a decisão vive nos .ts irmãos).

import { describe, expect, it } from "vitest"
import {
  BASE_BTN,
  buttonTier,
  isContestation,
  tierClass,
  ID_PAY,
  ID_NEGOTIATE,
  ID_CONSULT,
  ID_NO,
  ID_BACK,
  ID_HANDOFF,
} from "@/components/journey/button-tiers"
import {
  adaptiveTextColor,
  contrastRatio,
  parseHexColor,
  relativeLuminance,
  type Rgb,
} from "@/lib/journey/contrast"
import {
  threeOptionsSummary,
  debtConsultReply,
  offerChoiceQuestion,
  offerButtonLabel,
  notRecognizedReply,
  type AckContext,
  type CreditorChannel,
} from "@/lib/journey/acknowledgement"
import { payLinkMessageText } from "@/lib/journey/pay"
import { humanHandoffReply, paymentClaimReply } from "@/lib/journey/actions"
import { DEGRADED_MENU_COPY } from "@/lib/journey/wait-machine"
import { NEGOTIATION_PENDING_TEXT } from "@/components/journey/chat-display"
import type { OfferTerms } from "@/lib/negotiation/offers"

// ---------------------------------------------------------------------------
// (A) HIERARQUIA VISUAL (C11 / R-18)
// ---------------------------------------------------------------------------
describe("R-18 — hierarquia visual = decisão (C11)", () => {
  it("menu de 3 opções: PAGAR primário, NEGOCIAR secundário, CONSULTAR/NÃO-RECONHEÇO terciários", () => {
    expect(buttonTier("debt_three_options", ID_PAY)).toBe("primary")
    expect(buttonTier("debt_three_options", ID_NEGOTIATE)).toBe("secondary")
    expect(buttonTier("debt_three_options", ID_CONSULT)).toBe("tertiary")
    expect(buttonTier("debt_three_options", ID_NO)).toBe("tertiary")
  })

  it("exatamente 1 primário e 1 secundário no menu de 3 opções (nenhuma dilução)", () => {
    const ids = [ID_PAY, ID_NEGOTIATE, ID_CONSULT, ID_NO, ID_HANDOFF]
    const tiers = ids.map((id) => buttonTier("debt_three_options", id))
    expect(tiers.filter((t) => t === "primary")).toHaveLength(1) // só PAGAR
    expect(tiers.filter((t) => t === "secondary")).toHaveLength(1) // só NEGOCIAR
    // os demais (consultar/não-reconheço/atendimento) são terciários discretos.
    expect(tiers.filter((t) => t === "tertiary")).toHaveLength(3)
  })

  it("nenhum par de níveis compartilha a MESMA combinação de estilo (R-18)", () => {
    const p = tierClass("primary")
    const s = tierClass("secondary")
    const t = tierClass("tertiary")
    expect(p).not.toBe(s)
    expect(s).not.toBe(t)
    expect(p).not.toBe(t)
    // primary domina (preenchido/maior): text-base + shadow; secondary/tertiary não.
    expect(p).toContain("text-base")
    expect(p).toContain("shadow-sm")
    expect(s).not.toContain("text-base")
    expect(t).not.toContain("text-base")
    // secondary = contorno de marca; tertiary = contorno neutro (peso menor).
    expect(s).toContain("border-[var(--brand-secondary)]")
    expect(t).toContain("border-neutral-300")
  })

  it("VOLTAR(98)/ATENDIMENTO(99) são sempre terciários (não competem com a ação)", () => {
    expect(buttonTier("debt_three_options", ID_BACK)).toBe("tertiary")
    expect(buttonTier("debt_three_options", ID_HANDOFF)).toBe("tertiary")
    expect(buttonTier("offer_choice", ID_BACK)).toBe("tertiary")
  })

  it("escolha de parcelas (offer_choice): as condições de pagamento são primárias", () => {
    // ids 2..97 = condições (à vista/parcelas) — todas são a ação de resolver.
    expect(buttonTier("offer_choice", 2)).toBe("primary")
    expect(buttonTier("offer_choice", 5)).toBe("primary")
    expect(buttonTier("offer_choice", ID_HANDOFF)).toBe("tertiary")
  })
})

// ---------------------------------------------------------------------------
// (B) MOBILE 360 — alvo de toque + 1º botão acima da dobra (C12 / R-19 / R-21)
// ---------------------------------------------------------------------------
describe("R-19/R-21/C12 — alvo de toque ≥44px e mobile 360", () => {
  it("TODO alvo de toque tem min-h-[44px] (R-19), em qualquer tier", () => {
    expect(BASE_BTN).toContain("min-h-[44px]")
    for (const tier of ["primary", "secondary", "tertiary"] as const) {
      expect(tierClass(tier)).toContain("min-h-[44px]")
    }
  })

  it("o PRIMÁRIO ocupa a largura toda no mobile (1º botão visível/acima da dobra) e vira auto no desktop", () => {
    const p = tierClass("primary")
    expect(p).toContain("w-full") // mobile: bloco cheio (fácil de acertar)
    expect(p).toContain("sm:w-auto") // desktop: volta a largura natural
  })

  it("nenhum estilo de botão fixa largura em px (R-22: sem overflow-x em 360)", () => {
    for (const tier of ["primary", "secondary", "tertiary"] as const) {
      // proíbe classes de largura absoluta tipo w-[320px]/min-w-[..px]/max-w-[..px].
      expect(tierClass(tier)).not.toMatch(/\b(?:w|min-w|max-w)-\[\d+px\]/)
    }
  })

  it("foco visível por teclado (a11y): focus-visible ring em todos os tiers", () => {
    for (const tier of ["primary", "secondary", "tertiary"] as const) {
      expect(tierClass(tier)).toContain("focus-visible:ring-2")
    }
  })
})

// ---------------------------------------------------------------------------
// (C) SEPARAÇÃO anti-clique-errado (R-20)
// ---------------------------------------------------------------------------
describe("R-20 — 'Não reconheço' separado do grupo de resolução", () => {
  it("só o 'Não reconheço' (id 0) do menu de 3 opções é contestação", () => {
    expect(isContestation("debt_three_options", ID_NO)).toBe(true)
    expect(isContestation("debt_three_options", ID_PAY)).toBe(false)
    expect(isContestation("debt_three_options", ID_NEGOTIATE)).toBe(false)
    expect(isContestation("debt_three_options", ID_CONSULT)).toBe(false)
  })

  it("particiona o menu: resolução (pagar/negociar/consultar) x contestação (não reconheço)", () => {
    const ids = [ID_PAY, ID_NEGOTIATE, ID_CONSULT, ID_NO]
    const resolution = ids.filter((id) => !isContestation("debt_three_options", id))
    const contestation = ids.filter((id) => isContestation("debt_three_options", id))
    expect(resolution).toEqual([ID_PAY, ID_NEGOTIATE, ID_CONSULT])
    expect(contestation).toEqual([ID_NO]) // isolada → linha própria abaixo do divisor
  })

  it("fora do menu de 3 opções, 'Não' não é tratado como contestação isolada", () => {
    // no reconhecimento legado (Sim/Não) a separação de menu não se aplica.
    expect(isContestation("debt_acknowledgement", ID_NO)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// (D) CONTRASTE AA (R-23)
// ---------------------------------------------------------------------------
describe("R-23 — contraste AA adaptativo por luminância", () => {
  it("fundo claro → texto PRETO; fundo escuro → texto BRANCO", () => {
    expect(adaptiveTextColor("#ffffff")).toBe("#000000") // branco → texto preto
    expect(adaptiveTextColor("#000000")).toBe("#ffffff") // preto → texto branco
    expect(adaptiveTextColor("#ffff00")).toBe("#000000") // amarelo claro → preto
  })

  it("a cor de texto escolhida atinge AA (≥4.5:1) para o secundário default do tenant", () => {
    const bg = parseHexColor("#2563eb")! // brand-secondary default (~azul)
    const fg = parseHexColor(adaptiveTextColor("#2563eb"))!
    expect(contrastRatio(bg, fg)).toBeGreaterThanOrEqual(4.5)
  })

  it("SEMPRE escolhe a de MAIOR contraste (nunca branco fixo sobre um secundário claro)", () => {
    // secundário claro semeado pelo tenant: branco fixo cairia abaixo de AA; a
    // função adaptativa escolhe preto e recupera o contraste.
    const lightBrand = "#e5e7eb"
    const bg = parseHexColor(lightBrand)!
    const chosen = parseHexColor(adaptiveTextColor(lightBrand))!
    const white: Rgb = { r: 255, g: 255, b: 255 }
    expect(adaptiveTextColor(lightBrand)).toBe("#000000")
    expect(contrastRatio(bg, chosen)).toBeGreaterThan(contrastRatio(bg, white))
  })

  it("hex inválido/desconhecido → default seguro '#ffffff' (não quebra)", () => {
    expect(adaptiveTextColor("rgb(0,0,0)")).toBe("#ffffff")
    expect(adaptiveTextColor(null)).toBe("#ffffff")
    expect(adaptiveTextColor("")).toBe("#ffffff")
  })

  it("luminância é monotônica (preto=0, branco=1) — sanidade da fórmula WCAG", () => {
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBeCloseTo(0, 5)
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 5)
  })
})

// ---------------------------------------------------------------------------
// (E) CARTA DE VOZ §10.2 — guarda de regressão dos 13 textos (T1..T13) + R-46
// ---------------------------------------------------------------------------
const ACK: AckContext = {
  firstName: "Fabio",
  creditorName: "VMAX",
  updatedValue: 250,
  invoiceCount: 3,
  oldestDueDate: "2026-08-15",
}
const ACK_NO_NAME: AckContext = { ...ACK, firstName: "" }
const ACK_SINGLE: AckContext = { ...ACK, invoiceCount: 1 }

/** Antipadrões da carta de voz que NENHUM texto do fluxo pode conter (§10.2). */
const VOICE_FORBIDDEN: RegExp[] = [
  /se já pagou/i,
  /pode desconsiderar/i,
  /é só desconsiderar/i,
  /desconsidere/i,
  /Tudo bem\?/i,
  /🙂|😊/,
]

describe("§10.2 — carta de voz: antipadrões banidos em todo o fluxo", () => {
  const cash: OfferTerms = {
    original_value: 250, discount_pct: 30, discount_value: 75, entry_value: 0,
    installments: 1, installment_value: 175, total_value: 175,
    billing_type: "PIX", first_due_date: "2026-08-18",
  }
  const channelNoConfig: CreditorChannel = {
    creditorName: "VMAX", hasConfig: false, channelLabel: null, channelUrl: null,
  }
  const texts: Array<[string, string]> = [
    ["T1 abertura", threeOptionsSummary(ACK)],
    ["T1 abertura sem nome", threeOptionsSummary(ACK_NO_NAME)],
    ["T3 pending (client)", NEGOTIATION_PENDING_TEXT],
    ["T4 consultar", debtConsultReply(ACK)],
    ["T5 escolha parcelas", offerChoiceQuestion()],
    ["T6 rótulo à vista", offerButtonLabel(cash)],
    ["T7 link novo", payLinkMessageText({ link: "https://x/1", valor: 250, vencimentoLink: "2026-08-18", alreadyCharged: false })],
    ["T8 already_charged", payLinkMessageText({ link: "https://x/1", valor: 250, vencimentoLink: null, alreadyCharged: true })],
    ["T10 degradação", DEGRADED_MENU_COPY],
    ["T12 handoff", humanHandoffReply("VMAX")],
    ["T13 já paguei", paymentClaimReply("VMAX")],
    ["R-46 não reconheço", notRecognizedReply(channelNoConfig)],
  ]

  for (const [name, text] of texts) {
    it(`${name}: sem 'se já pagou desconsidere'/alegria forçada/emoji`, () => {
      for (const bad of VOICE_FORBIDDEN) {
        expect(text, `"${text}"`).not.toMatch(bad)
      }
    })
  }
})

describe("T1 / R-24 — abertura (carta de voz)", () => {
  it("identifica o cedente E a AlteaPay como operadora do canal (transparência LGPD)", () => {
    const s = threeOptionsSummary(ACK)
    expect(s).toContain("VMAX")
    expect(s).toContain("AlteaPay")
    expect(s).toMatch(/canal de negociação/i)
    expect(s).toMatch(/prefere seguir/i)
  })
  it("R-12: o VALOR não aparece na fala (mora no card fixo e no rótulo do botão)", () => {
    const s = threeOptionsSummary(ACK)
    expect(s).not.toContain("R$")
    expect(s).not.toContain("250")
  })
  it("com nome → 'Olá, {nome}.'; sem nome → 'Olá.' (nunca 'Olá, .'/'null'/'Oi!')", () => {
    expect(threeOptionsSummary(ACK).startsWith("Olá, Fabio.")).toBe(true)
    const noName = threeOptionsSummary(ACK_NO_NAME)
    expect(noName.startsWith("Olá.")).toBe(true)
    expect(noName).not.toContain("Olá, .")
    expect(noName).not.toContain("null")
    expect(noName).not.toMatch(/^Oi/)
  })
})

describe("T4 / R-27 — debtConsultReply (consultar)", () => {
  it("vencimento + serviço do cedente + caminho de volta; plural condicional", () => {
    const multi = debtConsultReply(ACK) // invoiceCount 3
    expect(multi).toMatch(/vencimento original em/i)
    expect(multi).toMatch(/reúne 3 faturas/i) // N>1 → cita as faturas
    expect(multi).toMatch(/serviço da VMAX/i)
    expect(multi).toMatch(/escolher abaixo/i) // sempre oferece caminho
    const single = debtConsultReply(ACK_SINGLE) // invoiceCount 1
    expect(single).not.toMatch(/faturas/i) // N=1 → não cita quantidade
  })
  it("R-12: sem valor na fala", () => {
    expect(debtConsultReply(ACK)).not.toContain("R$")
  })
})

describe("T6 / R-45 — offerButtonLabel (âncora de economia)", () => {
  it("à vista COM desconto: âncora de economia em REAIS + '(recomendado)'", () => {
    const withDisc: OfferTerms = {
      original_value: 250, discount_pct: 30, discount_value: 75, entry_value: 0,
      installments: 1, installment_value: 175, total_value: 175,
      billing_type: "PIX", first_due_date: "2026-08-18",
    }
    const label = offerButtonLabel(withDisc)
    expect(label).toMatch(/À vista R\$\s?175,00/)
    expect(label).toMatch(/você economiza R\$\s?75,00/)
    expect(label).toContain("(recomendado)")
    expect(label).not.toContain("desconto") // âncora é a economia, não a palavra "desconto"
  })
  it("à vista SEM desconto: recomenda mas NÃO insinua economia inexistente", () => {
    const noDisc: OfferTerms = {
      original_value: 250, discount_pct: 0, discount_value: 0, entry_value: 0,
      installments: 1, installment_value: 250, total_value: 250,
      billing_type: "PIX", first_due_date: "2026-08-18",
    }
    const label = offerButtonLabel(noDisc)
    expect(label).toMatch(/À vista R\$\s?250,00/)
    expect(label).toContain("(recomendado)")
    expect(label).not.toMatch(/economiza/i)
  })
  it("parcelado (N>1): 'Nx de R$ … (total R$ …)', sem 'recomendado'", () => {
    const inst: OfferTerms = {
      original_value: 250, discount_pct: 0, discount_value: 0, entry_value: 0,
      installments: 3, installment_value: 78.33, total_value: 235,
      billing_type: "BOLETO", first_due_date: "2026-08-18",
    }
    const label = offerButtonLabel(inst)
    expect(label).toMatch(/3x de R\$\s?78,33/)
    expect(label).toMatch(/total R\$\s?235,00/)
    expect(label).not.toContain("(recomendado)")
  })
})

describe("T7 / R-29 — link entregue (ponto de maior conversão)", () => {
  it("valor + vencimento + reforço de segurança; sem 'Pronto!'", () => {
    const t = payLinkMessageText({ link: "https://asaas/x", valor: 250, vencimentoLink: "2026-08-18", alreadyCharged: false })
    expect(t).toMatch(/R\$\s?250,00/)
    expect(t).toContain("18/08/2026")
    expect(t).toContain("O link é pessoal e seguro")
    expect(t).not.toMatch(/^Pronto!/)
    expect(t).toContain("https://asaas/x")
  })
})

describe("T8 / R-30 — already_charged", () => {
  it("reforça 'não é preciso gerar outro'; enxuto", () => {
    const t = payLinkMessageText({ link: "https://asaas/i", valor: 250, vencimentoLink: null, alreadyCharged: true })
    expect(t).toMatch(/cobrança ativa de R\$\s?250,00/)
    expect(t).toMatch(/não é preciso gerar outro/i)
  })
})

describe("T10 / R-31 — degradação (15s)", () => {
  it("positiva, oferece 3 caminhos, sem expor falha interna nem tom vendedor", () => {
    expect(DEGRADED_MENU_COPY).toContain("Você ainda pode resolver")
    expect(DEGRADED_MENU_COPY).toMatch(/pague o valor à vista/i)
    expect(DEGRADED_MENU_COPY).toMatch(/tente as opções de novo/i)
    expect(DEGRADED_MENU_COPY).toMatch(/atendimento/i)
    expect(DEGRADED_MENU_COPY).not.toMatch(/não te impede de resolver hoje/i)
    expect(DEGRADED_MENU_COPY).not.toMatch(/n8n|http|erro|falha/i)
  })
})

describe("T12 / R-33 — handoff", () => {
  it("nomeia o canal (WhatsApp AlteaPay) sem prometer prazo ('em breve') nem número em claro", () => {
    const t = humanHandoffReply("VMAX")
    expect(t).toMatch(/WhatsApp da AlteaPay/i)
    expect(t).toContain("VMAX")
    expect(t).not.toMatch(/em breve/i)
    // sem número de telefone em claro (fallback seguro).
    expect(t).not.toMatch(/\+?\d[\d\s().-]{7,}\d/)
  })
})

describe("T13 / R-34 — já paguei (não declara pago — D6)", () => {
  it("registra p/ conferência da equipe, orienta comprovante, sem 'Obrigado por avisar'", () => {
    const t = paymentClaimReply("VMAX")
    expect(t).toMatch(/nossa equipe vai conferir/i)
    expect(t).toMatch(/comprovante/i)
    expect(t).not.toMatch(/obrigado por avisar/i)
    // D6/M15: NUNCA declara pago/quitado/confirmado.
    expect(t).not.toMatch(/pagamento (confirmado|recebido)|quitad[oa]|est[aá] pago/i)
  })
})

describe("R-46 — não reconheço (fallback seguro + voz)", () => {
  it("cita o cedente, AlteaPay como operadora, não promete pagamento; sem muleta", () => {
    const t = notRecognizedReply({ creditorName: "VMAX", hasConfig: false, channelLabel: null, channelUrl: null })
    expect(t).toContain("VMAX")
    expect(t).toContain("A AlteaPay opera o canal de negociação")
    expect(t).toMatch(/não vamos gerar nenhum pagamento/i)
    expect(t).not.toContain("null")
    expect(t).not.toMatch(/obrigado por avisar/i)
  })
})

describe("T2 = T3 (R-26) — uma só frase para o clique 'Negociar'", () => {
  it("a bolha optimistic do client é exatamente a confirmação do servidor (sem duplicar)", () => {
    // T3 (client): mesmíssima string que o servidor persiste (T2, button/route.ts).
    expect(NEGOTIATION_PENDING_TEXT).toBe(
      "Certo. Vou buscar as condições de pagamento disponíveis para você.",
    )
    expect(NEGOTIATION_PENDING_TEXT).not.toMatch(/Perfeito\./)
    expect(NEGOTIATION_PENDING_TEXT).not.toMatch(/seu caso/)
  })
})
