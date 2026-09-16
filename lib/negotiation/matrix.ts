// Matriz de condições de negociação (D8/D11): o SERVIDOR decide desconto,
// entrada, parcelas e validade. Resolução pura (testável) + acesso a dados.

import { createServiceClient } from "@/lib/supabase/service"

export interface MatrixRow {
  id: string
  company_id: string
  name: string
  priority: number
  active: boolean
  valid_from: string | null
  valid_to: string | null
  aging_min_days: number
  aging_max_days: number | null
  aging_basis: "oldest_due" | "weighted"
  max_discount_pct: number
  installment_discount_pct: number
  min_entry_pct: number
  max_installments: number
  min_installment_value: number
  allowed_billing_types: string[]
  proposal_validity_days: number
  retry_after_days: number | null
  max_retries: number | null
  min_debt_value: number
}

/** Resolução pura: linha ativa, vigente, cuja faixa contém o aging; maior priority vence. */
export function pickMatrixRow(
  rows: MatrixRow[],
  agingDays: number,
  debtValue: number,
  at: Date,
): MatrixRow | null {
  const candidates = rows
    .filter((r) => r.active)
    .filter((r) => !r.valid_from || new Date(r.valid_from) <= at)
    .filter((r) => !r.valid_to || new Date(r.valid_to) >= at)
    .filter((r) => agingDays >= r.aging_min_days)
    .filter((r) => r.aging_max_days === null || agingDays <= r.aging_max_days)
    .filter((r) => debtValue >= (r.min_debt_value ?? 0))
  if (candidates.length === 0) return null
  candidates.sort((a, b) => b.priority - a.priority || a.aging_min_days - b.aging_min_days)
  return candidates[0]
}

export async function resolveMatrixRow(input: {
  companyId: string
  agingDays: number
  debtValue: number
  at?: Date
}): Promise<MatrixRow | null> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from("negotiation_condition_matrix")
    .select("*")
    .eq("company_id", input.companyId)
    .eq("active", true)
  if (error) throw new Error(`resolveMatrixRow: ${error.message}`)
  return pickMatrixRow((data ?? []) as MatrixRow[], input.agingDays, input.debtValue, input.at ?? new Date())
}
