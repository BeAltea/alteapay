// R4: validação de botões/IDs (contrato §2). Funções puras.
import { describe, expect, it } from "vitest"
import {
  BTN_HANDOFF,
  BTN_NO,
  BTN_YES,
  assertBooleanButtons,
  findButton,
  sortButtons,
  validateButtons,
} from "@/lib/journey/buttons"

describe("validateButtons", () => {
  it("aceita catálogo com ids únicos e labels", () => {
    const r = validateButtons([
      { id: 1, label: "Sim" },
      { id: 0, label: "Não" },
    ])
    expect(r.ok).toBe(true)
  })

  it("rejeita catálogo vazio", () => {
    expect(validateButtons([])).toEqual({ ok: false, error: "buttons_empty" })
  })

  it("rejeita ids duplicados", () => {
    const r = validateButtons([
      { id: 2, label: "A" },
      { id: 2, label: "B" },
    ])
    expect(r).toEqual({ ok: false, error: "button_id_duplicate" })
  })

  it("rejeita id não-inteiro/negativo", () => {
    expect(validateButtons([{ id: -1, label: "x" }])).toEqual({ ok: false, error: "button_id_invalid" })
    expect(validateButtons([{ id: 1.5, label: "x" }])).toEqual({ ok: false, error: "button_id_invalid" })
  })

  it("rejeita label vazio", () => {
    expect(validateButtons([{ id: 1, label: "  " }])).toEqual({ ok: false, error: "button_label_missing" })
  })

  it("aceita itens de lista (2..N) + reservados 98/99", () => {
    const r = validateButtons([
      { id: 2, label: "Oferta A", value: "off_a" },
      { id: 3, label: "Oferta B", value: "off_b" },
      { id: 98, label: "Voltar" },
      { id: 99, label: "Atendente" },
    ])
    expect(r.ok).toBe(true)
  })
})

describe("assertBooleanButtons", () => {
  it("aceita [1,0] e opcionalmente [99]", () => {
    expect(assertBooleanButtons([{ id: BTN_YES, label: "Sim" }, { id: BTN_NO, label: "Não" }]).ok).toBe(true)
    expect(
      assertBooleanButtons([
        { id: BTN_YES, label: "Sim" },
        { id: BTN_NO, label: "Não" },
        { id: BTN_HANDOFF, label: "Atendente" },
      ]).ok,
    ).toBe(true)
  })

  it("rejeita item de lista num booleano", () => {
    const r = assertBooleanButtons([
      { id: BTN_YES, label: "Sim" },
      { id: BTN_NO, label: "Não" },
      { id: 2, label: "Outro" },
    ])
    expect(r).toEqual({ ok: false, error: "boolean_button_id_invalid" })
  })

  it("rejeita booleano sem 1 e 0", () => {
    expect(assertBooleanButtons([{ id: BTN_YES, label: "Sim" }])).toEqual({
      ok: false,
      error: "boolean_missing_yes_no",
    })
  })
})

describe("sortButtons / findButton", () => {
  it("ordena por id crescente (1/0 → 0,1 ; 98/99 ao final)", () => {
    const sorted = sortButtons([
      { id: 99, label: "Atendente" },
      { id: 1, label: "Sim" },
      { id: 0, label: "Não" },
      { id: 98, label: "Voltar" },
    ])
    expect(sorted.map((b) => b.id)).toEqual([0, 1, 98, 99])
  })

  it("localiza pelo id", () => {
    const buttons = [{ id: 1, label: "Sim" }, { id: 0, label: "Não" }]
    expect(findButton(buttons, 0)?.label).toBe("Não")
    expect(findButton(buttons, 7)).toBeNull()
  })
})
