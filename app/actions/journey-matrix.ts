"use server"

// Server actions do painel super-admin de Negociação IA — matriz de condições.
// Escrita SEMPRE via service role no servidor (nunca exposto ao client) e
// guardada por role super_admin (mesmo padrão de create-agreement-super-admin).
import { revalidatePath } from "next/cache"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"

async function assertSuperAdmin(): Promise<void> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("Não autenticado")
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single()
  if (profile?.role !== "super_admin") throw new Error("Sem permissão")
}

export interface MatrixInput {
  id?: string
  company_id: string
  name: string
  priority: number
  active: boolean
  aging_min_days: number
  aging_max_days: number | null
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

const ALLOWED_BILLING = ["PIX", "BOLETO", "CREDIT_CARD"]

function validateMatrix(input: MatrixInput): string | null {
  if (!input.company_id) return "Empresa é obrigatória."
  if (!input.name?.trim()) return "Nome é obrigatório."
  const pct = [
    ["Desconto máximo", input.max_discount_pct],
    ["Desconto no parcelado", input.installment_discount_pct],
    ["Entrada mínima", input.min_entry_pct],
  ] as const
  for (const [label, v] of pct) {
    if (typeof v !== "number" || Number.isNaN(v) || v < 0 || v > 100)
      return `${label} deve estar entre 0 e 100.`
  }
  if (!Number.isInteger(input.max_installments) || input.max_installments < 1)
    return "Máximo de parcelas deve ser inteiro >= 1."
  if (input.aging_min_days < 0) return "Aging mínimo não pode ser negativo."
  if (input.aging_max_days !== null && input.aging_max_days < input.aging_min_days)
    return "Aging máximo deve ser maior ou igual ao mínimo."
  if (input.min_installment_value < 0) return "Valor mínimo da parcela não pode ser negativo."
  if (input.min_debt_value < 0) return "Valor mínimo da dívida não pode ser negativo."
  if (input.proposal_validity_days < 1) return "Validade da proposta deve ser >= 1 dia."
  if (input.retry_after_days !== null && input.retry_after_days < 0)
    return "Dias para nova tentativa não pode ser negativo."
  if (input.max_retries !== null && input.max_retries < 0)
    return "Máximo de tentativas não pode ser negativo."
  if (!Array.isArray(input.allowed_billing_types) || input.allowed_billing_types.length === 0)
    return "Selecione ao menos uma forma de pagamento."
  if (input.allowed_billing_types.some((b) => !ALLOWED_BILLING.includes(b)))
    return "Forma de pagamento inválida."
  return null
}

export async function upsertMatrixRow(
  input: MatrixInput,
): Promise<{ ok: boolean; error?: string; id?: string }> {
  try {
    await assertSuperAdmin()
    const err = validateMatrix(input)
    if (err) return { ok: false, error: err }

    const supabase = createServiceClient()
    const payload = {
      company_id: input.company_id,
      name: input.name.trim(),
      priority: input.priority,
      active: input.active,
      aging_min_days: input.aging_min_days,
      aging_max_days: input.aging_max_days,
      max_discount_pct: input.max_discount_pct,
      installment_discount_pct: input.installment_discount_pct,
      min_entry_pct: input.min_entry_pct,
      max_installments: input.max_installments,
      min_installment_value: input.min_installment_value,
      allowed_billing_types: input.allowed_billing_types,
      proposal_validity_days: input.proposal_validity_days,
      retry_after_days: input.retry_after_days,
      max_retries: input.max_retries,
      min_debt_value: input.min_debt_value,
      updated_at: new Date().toISOString(),
    }
    if (input.id) {
      const { error } = await supabase
        .from("negotiation_condition_matrix")
        .update(payload)
        .eq("id", input.id)
      if (error) return { ok: false, error: error.message }
      revalidatePath("/super-admin/negociacao-ia/matriz")
      return { ok: true, id: input.id }
    }
    const { data, error } = await supabase
      .from("negotiation_condition_matrix")
      .insert(payload)
      .select("id")
      .single()
    if (error) return { ok: false, error: error.message }
    revalidatePath("/super-admin/negociacao-ia/matriz")
    return { ok: true, id: data.id }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export async function setMatrixActive(
  id: string,
  active: boolean,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await assertSuperAdmin()
    const supabase = createServiceClient()
    const { error } = await supabase
      .from("negotiation_condition_matrix")
      .update({ active, updated_at: new Date().toISOString() })
      .eq("id", id)
    if (error) return { ok: false, error: error.message }
    revalidatePath("/super-admin/negociacao-ia/matriz")
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
