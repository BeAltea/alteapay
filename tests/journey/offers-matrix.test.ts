import { describe, expect, it } from "vitest"
import { pickMatrixRow, type MatrixRow } from "@/lib/negotiation/matrix"
import { generateOfferTerms, validateProposedTerms } from "@/lib/negotiation/offers"
import { maskPayload } from "@/lib/journey/events"

const row = (over: Partial<MatrixRow> = {}): MatrixRow => ({
  id: "m1", company_id: "c1", name: "faixa", priority: 10, active: true,
  valid_from: null, valid_to: null,
  aging_min_days: 90, aging_max_days: 180, aging_basis: "oldest_due",
  max_discount_pct: 15, installment_discount_pct: 7.5, min_entry_pct: 20,
  max_installments: 3, min_installment_value: 30,
  allowed_billing_types: ["PIX", "BOLETO", "CREDIT_CARD"],
  proposal_validity_days: 7, retry_after_days: 10, max_retries: 2, min_debt_value: 20,
  ...over,
})

describe("pickMatrixRow", () => {
  const rows = [
    row({ id: "a", aging_min_days: 0, aging_max_days: 89, max_discount_pct: 5 }),
    row({ id: "b", aging_min_days: 90, aging_max_days: 180 }),
    row({ id: "c", aging_min_days: 366, aging_max_days: null, max_discount_pct: 35 }),
  ]
  const at = new Date("2026-09-16")

  it("seleciona a faixa que contém o aging", () => {
    expect(pickMatrixRow(rows, 45, 100, at)?.id).toBe("a")
    expect(pickMatrixRow(rows, 90, 100, at)?.id).toBe("b")
    expect(pickMatrixRow(rows, 180, 100, at)?.id).toBe("b")
    expect(pickMatrixRow(rows, 400, 100, at)?.id).toBe("c")
  })

  it("aging fora de toda faixa retorna null", () => {
    expect(pickMatrixRow(rows, 250, 100, at)).toBeNull()
  })

  it("respeita min_debt_value, active e vigência", () => {
    expect(pickMatrixRow(rows, 100, 10, at)).toBeNull() // abaixo do mínimo
    expect(pickMatrixRow([row({ active: false })], 100, 100, at)).toBeNull()
    expect(pickMatrixRow([row({ valid_to: "2026-01-01" })], 100, 100, at)).toBeNull()
    expect(pickMatrixRow([row({ valid_from: "2027-01-01" })], 100, 100, at)).toBeNull()
  })

  it("maior priority vence quando faixas sobrepõem", () => {
    const r = pickMatrixRow(
      [row({ id: "low", priority: 1 }), row({ id: "high", priority: 99 })],
      100, 100, at,
    )
    expect(r?.id).toBe("high")
  })
})

describe("generateOfferTerms", () => {
  it("gera à vista com desconto máximo e parcelados com desconto reduzido", () => {
    const offers = generateOfferTerms(1000, row(), "2026-09-23")
    expect(offers[0]).toMatchObject({
      installments: 1, discount_pct: 15, total_value: 850, billing_type: "PIX",
    })
    const parc = offers.filter((o) => o.installments > 1)
    expect(parc.map((o) => o.installments)).toEqual([2, 3])
    for (const o of parc) {
      expect(o.discount_pct).toBeCloseTo(7.5, 1)
      expect(o.billing_type).toBe("BOLETO") // PIX não parcela
      expect(o.entry_value).toBe(o.installment_value) // parcelas iguais: entrada = 1ª
      expect(o.installment_value * o.installments).toBeCloseTo(o.total_value, 2)
    }
  })

  it("centavos: parcelas iguais fecham o total exato (desconto absorve o ajuste)", () => {
    const offers = generateOfferTerms(100.01, row({ min_installment_value: 1 }), "2026-09-23")
    for (const o of offers.filter((x) => x.installments > 1)) {
      expect(Math.round(o.installment_value * o.installments * 100) / 100).toBe(o.total_value)
      expect(Math.round((o.original_value - o.discount_value) * 100) / 100).toBe(o.total_value)
    }
  })

  it("suprime parcelamentos com parcela abaixo do mínimo", () => {
    const offers = generateOfferTerms(60, row(), "2026-09-23") // 3x ficaria ~14,80 < 30
    expect(offers.filter((o) => o.installments === 3)).toHaveLength(0)
  })

  it("sem billing de parcelamento permitido gera só à vista", () => {
    const offers = generateOfferTerms(1000, row({ allowed_billing_types: ["PIX"] }), "2026-09-23")
    expect(offers).toHaveLength(1)
    expect(offers[0].installments).toBe(1)
  })
})

describe("validateProposedTerms", () => {
  const base = generateOfferTerms(1000, row(), "2026-09-23")[0]

  it("aceita oferta gerada pelo sistema", () => {
    expect(validateProposedTerms(base, row())).toEqual({ ok: true })
  })

  it.each([
    [{ ...base, discount_pct: 40, discount_value: 400, total_value: 600, installment_value: 600 }, "DISCOUNT_ABOVE_MAX"],
    [{ ...base, billing_type: "CREDIT_CARD" as const }, undefined], // permitido
    [{ ...base, installments: 2, billing_type: "PIX" as const, discount_pct: 7.5, discount_value: 75, total_value: 925, entry_value: 462.5, installment_value: 462.5 }, "PIX_CANNOT_INSTALL"],
    [{ ...base, installments: 5, billing_type: "BOLETO" as const, discount_pct: 7.5, discount_value: 75, total_value: 925, entry_value: 185, installment_value: 185 }, "INSTALLMENTS_ABOVE_MAX"],
    [{ ...base, total_value: 700 }, "TOTAL_MISMATCH"],
  ])("caso %#", (terms, expectedError) => {
    const r = validateProposedTerms(terms, row())
    if (expectedError === undefined) expect(r.ok).toBe(true)
    else {
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toBe(expectedError)
    }
  })

  it("1ª parcela abaixo da entrada mínima e parcela abaixo do mínimo", () => {
    // 6 parcelas iguais de 1000: 1ª = 16,6% < 20% → ENTRY_BELOW_MIN (com max_installments alto)
    const r6 = row({ max_installments: 6, min_installment_value: 1 })
    const seis = generateOfferTerms(1000, r6, "2026-09-23").find((o) => o.installments === 6)
    expect(seis).toBeUndefined() // gerador já suprime por entrada mínima
    const manual = { ...generateOfferTerms(1000, r6, "2026-09-23")[0], installments: 6, billing_type: "BOLETO" as const, discount_pct: 7.5, discount_value: 75, total_value: 925, entry_value: 154.17, installment_value: 154.17 }
    expect(validateProposedTerms(manual, r6)).toMatchObject({ ok: false, error: "ENTRY_BELOW_MIN" })
    const low = row({ min_installment_value: 500 })
    const parc2 = { ...generateOfferTerms(1000, row(), "2026-09-23").find((o) => o.installments === 2)! }
    expect(validateProposedTerms(parc2, low)).toMatchObject({ ok: false, error: "INSTALLMENT_BELOW_MIN" })
  })
})

describe("maskPayload", () => {
  it("mascara CPF/CNPJ e e-mail em strings do payload", () => {
    const m = maskPayload({ note: "doc 12345678901 email fulano.tal@gmail.com", n: 7 })
    expect(m.note).not.toContain("12345678901")
    expect(m.note).toContain("***01")
    expect(m.note).toContain("fu***@gmail")
    expect(m.n).toBe(7)
  })
})
