// C1-client: lógica PURA de exibição do chat do devedor (components/journey/
// chat-display.ts). Cobre "manter só a última resposta" (dedup por conteúdo) e o
// reconhecimento do botão Negociar pelo rótulo (indicador optimistic).
import { describe, expect, it } from "vitest"
import {
  dedupAssistantByContent,
  isNegotiateLabel,
  NEGOTIATION_PENDING_TEXT,
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
