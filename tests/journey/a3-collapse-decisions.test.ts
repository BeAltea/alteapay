// A3 (§2.4) — COLAPSO DE DECISIONS CONSECUTIVAS IGUAIS (regra pura em
// chat-display.ts): cliques repetidos no mesmo botão sem um outcome entre eles
// viram UM (fica a última ocorrência); um outcome entre eles separa; botões
// diferentes nunca colapsam; só decisions da geração corrente contam.
import { describe, expect, it } from "vitest"
import { CURRENT_GENERATION } from "@/lib/journey/display-class"
import { collapseConsecutiveDecisions, type ChatMsg } from "@/components/journey/chat-display"

function cust(id: string, text: string, buttonId: number | null = 2, generation: number | null = CURRENT_GENERATION): ChatMsg {
  return { id, from: "customer", text, action: null, promptId: null, buttonId, engine: null, generation }
}
function asst(id: string, text: string, extra: Partial<ChatMsg> = {}): ChatMsg {
  return { id, from: "assistant", text, action: null, promptId: null, engine: null, buttonId: null, ...extra }
}
const ids = (list: ChatMsg[]) => list.map((m) => m.id)

describe("collapseConsecutiveDecisions (A3 / §2.4)", () => {
  it("dois cliques iguais seguidos viram um — fica a ÚLTIMA ocorrência, na posição dela", () => {
    const list = [cust("c1", "Consultar dívida"), cust("c2", "Consultar dívida")]
    expect(ids(collapseConsecutiveDecisions(list, null, "idle"))).toEqual(["c2"])
  })

  it("guidance entre os cliques NÃO separa (a pilha 'Consultar › resposta › Consultar' colapsa)", () => {
    const list = [
      cust("c1", "Consultar dívida"),
      asst("g1", "Vencimento original: 15/08/2026."),
      cust("c2", "Consultar dívida"),
      asst("g2", "Vencimento original: 15/08/2026."),
    ]
    expect(ids(collapseConsecutiveDecisions(list, null, "idle"))).toEqual(["g1", "c2", "g2"])
  })

  it("um OUTCOME entre os cliques separa: cada clique que produziu resultado é memória legítima", () => {
    const link = asst("o1", "Aqui está seu link\nhttps://pay.example.test/c/1")
    const detail = asst("d1", "Este valor tem vencimento…", { stage: "detail" })
    expect(ids(collapseConsecutiveDecisions([cust("c1", "Quero pagar", 4), link, cust("c2", "Quero pagar", 4)], null, "idle"))).toEqual([
      "c1",
      "o1",
      "c2",
    ])
    expect(ids(collapseConsecutiveDecisions([cust("c1", "Consultar dívida"), detail, cust("c2", "Consultar dívida")], null, "idle"))).toEqual([
      "c1",
      "d1",
      "c2",
    ])
  })

  it("botão diferente entre dois iguais → nenhum colapsa (não são consecutivos)", () => {
    const list = [cust("c1", "Consultar dívida", 2), cust("c2", "Negociar", 1), cust("c3", "Consultar dívida", 2)]
    expect(ids(collapseConsecutiveDecisions(list, null, "idle"))).toEqual(["c1", "c2", "c3"])
  })

  it("mesmo button_id com rótulo diferente NÃO colapsa (id 2 = Detalhes no menu, parcela no offer_choice)", () => {
    const list = [cust("c1", "Consultar dívida", 2), cust("c2", "À vista R$ 237,50", 2)]
    expect(ids(collapseConsecutiveDecisions(list, null, "idle"))).toEqual(["c1", "c2"])
  })

  it("rótulo igual a menos de caixa/espaços colapsa; button_id ausente nos dois também", () => {
    expect(ids(collapseConsecutiveDecisions([cust("c1", "Consultar  Dívida"), cust("c2", "consultar dívida ")], null, "idle"))).toEqual(["c2"])
    expect(ids(collapseConsecutiveDecisions([cust("c1", "texto livre", null), cust("c2", "texto livre", null)], null, "idle"))).toEqual(["c2"])
  })

  it("três iguais seguidos → um; quatro com outcome no meio → dois", () => {
    expect(ids(collapseConsecutiveDecisions([cust("a", "x"), cust("b", "x"), cust("c", "x")], null, "idle"))).toEqual(["c"])
    const link = asst("o", "https://pay.example.test/c/2")
    expect(ids(collapseConsecutiveDecisions([cust("a", "x"), cust("b", "x"), link, cust("c", "x"), cust("d", "x")], null, "idle"))).toEqual([
      "b",
      "o",
      "d",
    ])
  })

  it("decisions de geração anterior (superseded) não entram na regra", () => {
    const list = [cust("old1", "Consultar Dívida", 2, 1), cust("old2", "Consultar Dívida", 2, 1), cust("new", "Consultar Dívida", 2)]
    // com a geração corrente: as antigas são superseded (não decision) → nada a colapsar entre elas e a nova
    expect(ids(collapseConsecutiveDecisions(list, null, "idle", CURRENT_GENERATION))).toEqual(["old1", "old2", "new"])
    // sem a regra de geração (histórico expandido): as três são consecutivas iguais → uma
    expect(ids(collapseConsecutiveDecisions(list, null, "idle", null))).toEqual(["new"])
  })

  it("lista sem decisions / vazia → devolvida intacta (mesma referência)", () => {
    const list = [asst("g1", "a"), asst("g2", "b")]
    expect(collapseConsecutiveDecisions(list, null, "idle")).toBe(list)
    expect(collapseConsecutiveDecisions([], null, "idle")).toEqual([])
  })
})
