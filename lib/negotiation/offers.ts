// Geração e validação de ofertas a partir da matriz (D8: servidor decide).
// Funções puras (testáveis) + persistência em negotiation_offers.
// Invariantes ASAAS: PIX não parcela; parcelamento = N parcelas IGUAIS
// (installmentCount/installmentValue). A "entrada mínima" da matriz é
// satisfeita pela 1ª parcela (total/N >= min_entry_pct exige N <= 1/pct;
// com max_installments 3 e entrada 20%, sempre vale). entry_value = 1ª parcela.

import { createServiceClient } from "@/lib/supabase/service"
import type { MatrixRow } from "./matrix"

export type BillingType = "PIX" | "BOLETO" | "CREDIT_CARD"

export interface OfferTerms {
  original_value: number
  discount_pct: number
  discount_value: number
  entry_value: number
  installments: number
  installment_value: number
  total_value: number
  billing_type: BillingType
  first_due_date: string // YYYY-MM-DD
}

const round2 = (n: number) => Math.round(n * 100) / 100

export function generateOfferTerms(
  originalValue: number,
  row: MatrixRow,
  firstDueDate: string,
): OfferTerms[] {
  const offers: OfferTerms[] = []
  const allowed = row.allowed_billing_types as BillingType[]

  // 1) À vista, com o desconto máximo da faixa
  const cashDiscount = round2(originalValue * (row.max_discount_pct / 100))
  const cashTotal = round2(originalValue - cashDiscount)
  const cashBilling: BillingType = allowed.includes("PIX")
    ? "PIX"
    : allowed.includes("BOLETO") ? "BOLETO" : "CREDIT_CARD"
  offers.push({
    original_value: round2(originalValue),
    discount_pct: row.max_discount_pct,
    discount_value: cashDiscount,
    entry_value: 0,
    installments: 1,
    installment_value: cashTotal,
    total_value: cashTotal,
    billing_type: cashBilling,
    first_due_date: firstDueDate,
  })

  // 2) Parcelado: 2..max_installments (PIX fora), desconto reduzido,
  //    N parcelas IGUAIS (modelo installmentCount do ASAAS)
  const installBilling = (["BOLETO", "CREDIT_CARD"] as BillingType[]).filter((b) => allowed.includes(b))
  if (installBilling.length > 0) {
    for (let n = 2; n <= row.max_installments; n++) {
      const discountTarget = round2(originalValue * (row.installment_discount_pct / 100))
      const iv = round2((originalValue - discountTarget) / n)
      if (iv < row.min_installment_value) continue
      const total = round2(iv * n)
      const discount = round2(originalValue - total)
      // 1ª parcela deve cumprir a entrada mínima da matriz
      if (iv + 0.01 < round2(total * (row.min_entry_pct / 100))) continue
      offers.push({
        original_value: round2(originalValue),
        discount_pct: round2((discount / originalValue) * 100),
        discount_value: discount,
        entry_value: iv, // = 1ª parcela (parcelas iguais)
        installments: n,
        installment_value: iv,
        total_value: total,
        billing_type: installBilling[0],
        first_due_date: firstDueDate,
      })
    }
  }
  return offers
}

export type TermsValidationError =
  | "DISCOUNT_ABOVE_MAX"
  | "ENTRY_BELOW_MIN"
  | "INSTALLMENTS_ABOVE_MAX"
  | "INSTALLMENT_BELOW_MIN"
  | "BILLING_TYPE_NOT_ALLOWED"
  | "PIX_CANNOT_INSTALL"
  | "TOTAL_MISMATCH"

export function validateProposedTerms(
  terms: OfferTerms,
  row: MatrixRow,
): { ok: true } | { ok: false; error: TermsValidationError } {
  const maxPct = terms.installments > 1 ? row.installment_discount_pct : row.max_discount_pct
  if (terms.discount_pct > maxPct + 0.05) return { ok: false, error: "DISCOUNT_ABOVE_MAX" }
  if (!row.allowed_billing_types.includes(terms.billing_type))
    return { ok: false, error: "BILLING_TYPE_NOT_ALLOWED" }
  if (terms.installments > 1 && terms.billing_type === "PIX")
    return { ok: false, error: "PIX_CANNOT_INSTALL" }
  if (terms.installments > row.max_installments)
    return { ok: false, error: "INSTALLMENTS_ABOVE_MAX" }
  if (terms.installments > 1) {
    // entrada = 1ª parcela (parcelas iguais)
    const minEntry = round2(terms.total_value * (row.min_entry_pct / 100))
    if (terms.installment_value + 0.01 < minEntry) return { ok: false, error: "ENTRY_BELOW_MIN" }
    if (terms.installment_value + 0.001 < row.min_installment_value)
      return { ok: false, error: "INSTALLMENT_BELOW_MIN" }
  }
  const expectedTotal = round2(terms.original_value - terms.discount_value)
  if (Math.abs(expectedTotal - terms.total_value) > 0.01)
    return { ok: false, error: "TOTAL_MISMATCH" }
  if (terms.installments > 1) {
    // parcelas IGUAIS: total = parcela × N (tolerância de 1 centavo)
    if (Math.abs(round2(terms.installment_value * terms.installments) - terms.total_value) > 0.011)
      return { ok: false, error: "TOTAL_MISMATCH" }
  }
  return { ok: true }
}

export type OfferSource = "system" | "ai" | "customer" | "admin"
export type OfferStatus = "presented" | "accepted" | "rejected" | "expired" | "invalid" | "superseded"

export async function persistOffer(input: {
  companyId: string
  sessionId: string
  customerId: string
  debtId: string
  matrixId: string | null
  source: OfferSource
  status: OfferStatus
  terms: OfferTerms
  validUntil: string | null
  validationError?: string | null
}): Promise<string> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from("negotiation_offers")
    .insert({
      company_id: input.companyId,
      session_id: input.sessionId,
      customer_id: input.customerId,
      debt_id: input.debtId,
      matrix_id: input.matrixId,
      source: input.source,
      status: input.status,
      terms: input.terms,
      valid_until: input.validUntil,
      validation_error: input.validationError ?? null,
    })
    .select("id")
    .single()
  if (error) throw new Error(`persistOffer: ${error.message}`)
  return data.id
}
