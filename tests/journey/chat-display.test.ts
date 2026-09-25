// C1-client: lógica PURA de exibição do chat do devedor (components/journey/
// chat-display.ts). Cobre "manter só a última resposta" (dedup por conteúdo) e o
// reconhecimento do botão Negociar pelo rótulo (indicador optimistic).
import { describe, expect, it } from "vitest"
import {
  dedupAssistantByContent,
  isNegotiateLabel,
  lastAssistantVisibleText,
  NEGOTIATION_PENDING_TEXT,
  resolvePromptForRender,
  type ChatMsg,
} from "@/components/journey/chat-display"

function assistant(id: string, text: string, action: ChatMsg["action"] = null): ChatMsg {
  return { id, from: "assistant", text, action, promptId: null }
}
function customer(id: string, text: string): ChatMsg {
  return { id, from: "customer", text, action: null, promptId: null }
}

describe("dedupAssistantByContent", () => {
  it("mantém SÓ A ÚLTIMA de bolhas assistant idênticas (dados da dívida 3x)", () => {
    const list: ChatMsg[] = [
      assistant("a1", "Aqui estão os dados da sua dívida..."),
      assistant("a2", "Aqui estão os dados da sua dívida..."),
      assistant("a3", "Aqui estão os dados da sua dívida..."),
    ]
    const out = dedupAssistantByContent(list)
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe("a3") // a última ocorrência
  })

  it("colapsa a saudação re-bootstrapada mantendo a posição da última", () => {
    const list: ChatMsg[] = [
      assistant("g1", "Olá, Fabio! O que deseja fazer?"),
      assistant("d1", "Aqui estão os dados da sua dívida..."),
      assistant("g2", "Olá, Fabio! O que deseja fazer?"),
    ]
    const out = dedupAssistantByContent(list)
    expect(out.map((m) => m.id)).toEqual(["d1", "g2"])
  })

  it("normaliza por trim (espaços em volta não impedem o colapso)", () => {
    const list: ChatMsg[] = [
      assistant("a1", "Mesma resposta"),
      assistant("a2", "  Mesma resposta  "),
    ]
    const out = dedupAssistantByContent(list)
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe("a2")
  })

  it("NUNCA colapsa bolhas do cliente (cada clique é um evento real)", () => {
    const list: ChatMsg[] = [
      customer("c1", "Negociar Dívida"),
      customer("c2", "Negociar Dívida"),
    ]
    const out = dedupAssistantByContent(list)
    expect(out.map((m) => m.id)).toEqual(["c1", "c2"])
  })

  it("preserva bolhas assistant com AÇÃO anexada (link externo não entra no dedup)", () => {
    const action = { type: "external_link", label: "Falar com atendente", href: "https://x.test/contato" }
    const list: ChatMsg[] = [
      assistant("a1", "Para quitação, fale conosco.", action),
      assistant("a2", "Para quitação, fale conosco.", action),
    ]
    const out = dedupAssistantByContent(list)
    expect(out.map((m) => m.id)).toEqual(["a1", "a2"])
  })

  it("colapsa a versão SEM ação e mantém a COM ação (não são a mesma chave)", () => {
    const action = { type: "external_link", label: "Contato", href: "https://x.test/c" }
    const list: ChatMsg[] = [
      assistant("plain1", "Texto"),
      assistant("plain2", "Texto"),
      assistant("act1", "Texto", action),
    ]
    const out = dedupAssistantByContent(list)
    // colapsa plain1 (fica plain2, a última sem ação) e mantém act1 sempre
    expect(out.map((m) => m.id)).toEqual(["plain2", "act1"])
  })

  it("preserva a ordem relativa e as bolhas do cliente intercaladas", () => {
    const list: ChatMsg[] = [
      assistant("g1", "Olá! O que deseja fazer?"),
      customer("c1", "Consultar Dívida"),
      assistant("d1", "Aqui estão os dados..."),
      customer("c2", "Consultar Dívida"),
      assistant("d2", "Aqui estão os dados..."),
      assistant("g2", "Olá! O que deseja fazer?"),
    ]
    const out = dedupAssistantByContent(list)
    // d1 colapsa em d2; g1 colapsa em g2; clientes preservados
    expect(out.map((m) => m.id)).toEqual(["c1", "c2", "d2", "g2"])
  })

  it("lista sem duplicatas é devolvida intacta", () => {
    const list: ChatMsg[] = [
      assistant("a1", "Um"),
      customer("c1", "clique"),
      assistant("a2", "Dois"),
    ]
    expect(dedupAssistantByContent(list)).toEqual(list)
  })

  it("lista vazia → vazia", () => {
    expect(dedupAssistantByContent([])).toEqual([])
  })

  it("colapsa também a bolha optimistic 'preparando' se repetida (defensivo)", () => {
    const list: ChatMsg[] = [
      assistant("o1", NEGOTIATION_PENDING_TEXT),
      assistant("o2", NEGOTIATION_PENDING_TEXT),
    ]
    const out = dedupAssistantByContent(list)
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe("o2")
  })
})

describe("isNegotiateLabel", () => {
  it("reconhece 'Negociar' e 'Negociar Dívida' (case-insensitive)", () => {
    expect(isNegotiateLabel("Negociar")).toBe(true)
    expect(isNegotiateLabel("Negociar Dívida")).toBe(true)
    expect(isNegotiateLabel("NEGOCIAR DÍVIDA")).toBe(true)
    expect(isNegotiateLabel("negociar")).toBe(true)
  })

  it("NÃO reconhece Consultar / Não reconheço / Atendente / vazio", () => {
    expect(isNegotiateLabel("Consultar Dívida")).toBe(false)
    expect(isNegotiateLabel("Não reconheço a dívida")).toBe(false)
    expect(isNegotiateLabel("Falar com atendente")).toBe(false)
    expect(isNegotiateLabel("")).toBe(false)
  })
})

// A4 (correção r1 / B3-F1) — composição na TELA: log + bloco do prompt. A pergunta
// do prompt ativo aparece UMA vez: se já é a última bolha visível do assistente
// (T2 = S7 persistida antes do prompt de parcelas, cuja pergunta S8 = S7) ou já
// fecha a saudação de retorno (A3), o bloco vem só com os botões.
describe("resolvePromptForRender / lastAssistantVisibleText — S7 uma vez na tela (B3-F1)", () => {
  const offerChoice = {
    id: "p-offer",
    kind: "offer_choice",
    question: NEGOTIATION_PENDING_TEXT,
    buttons: [
      { id: 1, label: "À vista R$ 175,00, economia de R$ 75,00 (recomendado)", order: 0 },
      { id: 2, label: "3x de R$ 78,33 (total R$ 235,00)", order: 1 },
      { id: 0, label: "Voltar às opções", order: 2 },
    ],
  }
  // o log do Negociar após o dedup: eco do clique + T2 (S7) como última bolha
  const negotiateLog: ChatMsg[] = [
    assistant("g1", "Olá, Ana. Este é o canal oficial de negociação da VMAX, operado pela AlteaPay. Como você prefere seguir?"),
    customer("c1", "Negociar"),
    assistant("t2", NEGOTIATION_PENDING_TEXT),
  ]

  it("offer_choice com question === NEGOTIATION_PENDING_TEXT e última bolha igual → question vazia (botões intactos)", () => {
    const out = resolvePromptForRender(offerChoice, negotiateLog, null)
    expect(out).not.toBeNull()
    expect(out!.question).toBe("")
    expect(out!.id).toBe("p-offer")
    expect(out!.buttons).toBe(offerChoice.buttons)
    // o log continua com T2 (a frase mora numa bolha só, acima das parcelas)
    expect(negotiateLog.filter((m) => m.text === NEGOTIATION_PENDING_TEXT)).toHaveLength(1)
  })

  it("pergunta DIFERENTE da última bolha → prompt intacto (mesma referência)", () => {
    const back = { ...offerChoice, id: "p-back", kind: "debt_three_options", question: "Como prefere seguir?" }
    const out = resolvePromptForRender(back, negotiateLog, null)
    expect(out).toBe(back)
    expect(out!.question).toBe("Como prefere seguir?")
  })

  it("normaliza espaços e caixa entre a bolha e a pergunta (T2 gravada com espaços à volta)", () => {
    const log: ChatMsg[] = [customer("c1", "Negociar"), assistant("t2", `  ${NEGOTIATION_PENDING_TEXT.toUpperCase()}  `)]
    expect(resolvePromptForRender(offerChoice, log, null)!.question).toBe("")
  })

  it("só a bolha que ENCOSTA no bloco conta: log terminando no cliente → pergunta mantida", () => {
    const log: ChatMsg[] = [assistant("t2", NEGOTIATION_PENDING_TEXT), customer("c2", "Voltar às opções")]
    expect(lastAssistantVisibleText(log)).toBeNull()
    expect(resolvePromptForRender(offerChoice, log, null)!.question).toBe(NEGOTIATION_PENDING_TEXT)
  })

  it("retomada: T2 recolhida atrás de 'Ver conversa completa' (log = último outcome) → pergunta mantida (S7 uma vez, no bloco)", () => {
    const log: ChatMsg[] = [
      assistant("m46", "Aqui está seu link para pagar R$ 250,00, válido até 27/09/2026.", {
        type: "open_payment_link",
        label: "Abrir link de pagamento",
        href: "https://x.test/i/abc",
      }),
    ]
    const recap = "Olá de novo, Ana. Você já viu os detalhes do valor em aberto. Como prefere seguir?"
    expect(resolvePromptForRender(offerChoice, log, recap)!.question).toBe(NEGOTIATION_PENDING_TEXT)
  })

  it("saudação de retorno continua como 2ª fonte (A3): recap termina com a pergunta do menu → vazia", () => {
    const menu = { ...offerChoice, id: "p-menu", kind: "debt_three_options", question: "Como prefere seguir?" }
    const recap = "Olá de novo, Ana. Você já viu os detalhes do valor em aberto. Como prefere seguir?"
    const log: ChatMsg[] = [assistant("d1", "Vencimento original 15/08/2026 · 1 fatura · serviço da VMAX.")]
    expect(resolvePromptForRender(menu, log, recap)!.question).toBe("")
    // sem recap e sem bolha igual → intacto
    expect(resolvePromptForRender(menu, log, null)).toBe(menu)
  })

  it("log vazio / prompt nulo / pergunta vazia (menu inicial da A1) → sem efeito", () => {
    expect(lastAssistantVisibleText([])).toBeNull()
    expect(resolvePromptForRender(null, negotiateLog, null)).toBeNull()
    const initial = { ...offerChoice, id: "p-initial", kind: "debt_three_options", question: "" }
    expect(resolvePromptForRender(initial, negotiateLog, null)).toBe(initial)
    expect(resolvePromptForRender(offerChoice, [], null)).toBe(offerChoice)
  })
})
