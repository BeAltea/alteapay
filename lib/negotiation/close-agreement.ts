// Fechamento de acordo do chatbot — domínio compartilhado entre
// POST /api/agents/close-agreement (server-to-server, x-agent-token) e a ação
// agreement.close do webhook n8n (HMAC). Os termos SEMPRE derivam das regras
// do servidor (buckets de aging em charge-rules) — nunca do LLM/fluxo.

import { chargeQueue } from "@/lib/queue/queues"
import { createServiceClient } from "@/lib/supabase/service"
import { cashDiscountPctForAging } from "./charge-rules"
import { agingDays } from "./config"

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function formatBRL(value: number): string {
  return `R$ ${value.toFixed(2).replace(".", ",")}`
}

export interface AgreementTerms {
  installments: number
  agreedAmount: number
  installmentAmount: number
  summary: string
}

/**
 * Deriva os termos do offer_id:
 * - 'avista' -> pagamento único com desconto do bucket de aging
 * - 'parc_N' -> N parcelas de currentAmount / N (sem desconto)
 */
export function deriveTerms(offerId: string, currentAmount: number, aging: number): AgreementTerms | null {
  if (offerId === "avista") {
    const discountPct = cashDiscountPctForAging(aging)
    const agreedAmount = Math.round(currentAmount * (1 - discountPct / 100) * 100) / 100
    return {
      installments: 1,
      agreedAmount,
      installmentAmount: agreedAmount,
      summary: `pagamento à vista de ${formatBRL(agreedAmount)} (${discountPct}% de desconto)`,
    }
  }

  const match = offerId.match(/^parc_(\d+)$/)
  if (match) {
    const installments = Number.parseInt(match[1], 10)
    if (installments >= 1 && installments <= 60) {
      const agreedAmount = currentAmount
      const installmentAmount = Math.round((agreedAmount / installments) * 100) / 100
      return {
        installments,
        agreedAmount,
        installmentAmount,
        summary: `${installments}x de ${formatBRL(installmentAmount)} (total ${formatBRL(agreedAmount)})`,
      }
    }
  }

  return null
}

export interface CloseAgreementInput {
  company_id: string
  debt_id: string
  offer_id: string
  /** Identificação da origem para auditoria (ex.: "negotiation-agent thread X", "n8n flow"). */
  origin: string
  channel?: string
}

export type CloseAgreementResult =
  | { ok: true; agreement_id: string; message: string; terms: AgreementTerms }
  | { ok: false; status: number; error: string }

export async function closeAgreement(input: CloseAgreementInput): Promise<CloseAgreementResult> {
  const { company_id, debt_id, offer_id, origin, channel } = input

  if (!UUID_REGEX.test(debt_id)) {
    return { ok: false, status: 400, error: "debt_id deve ser um UUID válido" }
  }

  const supabase = createServiceClient()

  const { data: debt, error: debtError } = await supabase
    .from("debts")
    .select("*")
    .eq("id", debt_id)
    .eq("company_id", company_id)
    .maybeSingle()

  if (debtError) throw debtError
  if (!debt) return { ok: false, status: 404, error: "Dívida não encontrada para esta empresa" }
  if (debt.status === "paid") return { ok: false, status: 409, error: "Dívida já está paga" }

  const currentAmount = Number(debt.current_amount ?? debt.amount) || 0
  if (currentAmount <= 0) return { ok: false, status: 422, error: "Dívida sem valor em aberto" }

  const terms = deriveTerms(offer_id, currentAmount, debt.due_date ? agingDays(debt.due_date) : 0)
  if (!terms) {
    return { ok: false, status: 400, error: `offer_id inválido: ${offer_id} (use 'avista' ou 'parc_N')` }
  }

  const { data: customer, error: customerError } = await supabase
    .from("customers")
    .select("id, name, document, email, phone")
    .eq("id", debt.customer_id)
    .maybeSingle()

  if (customerError) throw customerError
  if (!customer) return { ok: false, status: 404, error: "Cliente da dívida não encontrado" }

  // Primeiro vencimento: 7 dias a partir de hoje (YYYY-MM-DD)
  const firstDueDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]

  // user_id omitido de propósito: nullable e não há usuário autenticado aqui.
  const agreementData: Record<string, any> = {
    debt_id: debt.id,
    customer_id: customer.id,
    company_id,
    original_amount: currentAmount,
    agreed_amount: terms.agreedAmount,
    discount_amount: Math.round((currentAmount - terms.agreedAmount) * 100) / 100,
    discount_percentage:
      currentAmount > 0 ? ((currentAmount - terms.agreedAmount) / currentAmount) * 100 : 0,
    installments: terms.installments,
    installment_amount: terms.installmentAmount,
    due_date: firstDueDate,
    status: "active",
    attendant_name: "negotiation-agent",
    terms: channel ? `${origin} (canal: ${channel})` : origin,
    payment_status: "pending",
  }

  const { data: agreement, error: agreementError } = await supabase
    .from("agreements")
    .insert(agreementData)
    .select()
    .single()

  if (agreementError) throw agreementError

  // O CHECK real de debts.status é pending|paid|cancelled|in_negotiation;
  // "in_agreement" violava a constraint (bug D1 do diagnóstico FASE0_CHATBOT.md).
  const { data: debtUpdated, error: debtUpdateError } = await supabase
    .from("debts")
    .update({ status: "in_negotiation", updated_at: new Date().toISOString() })
    .eq("id", debt.id)
    .select("id")

  if (debtUpdateError || !debtUpdated?.length) {
    console.warn("[CLOSE-AGREEMENT] Failed to update debt status:", debtUpdateError?.message ?? "0 rows")
  }

  const cpfCnpj = (customer.document || "").replace(/[^\d]/g, "")
  const customerPhone = (customer.phone || "").replace(/[^\d]/g, "")
  const chargeDescription =
    terms.installments === 1
      ? `Acordo ${agreement.id} - pagamento à vista`
      : `Acordo ${agreement.id} - parcela 1/${terms.installments}`

  try {
    await chargeQueue.add(`agent-agreement-${agreement.id}`, {
      customer: {
        name: customer.name || "Cliente",
        cpfCnpj,
        email: customer.email || undefined,
        mobilePhone: customerPhone || undefined,
      },
      payment: {
        billingType: "UNDEFINED",
        value: terms.installments === 1 ? terms.agreedAmount : terms.installmentAmount,
        dueDate: firstDueDate,
        description: chargeDescription,
        externalReference: agreement.id,
      },
      metadata: {
        companyId: company_id,
        source: origin,
      },
    })
  } catch (queueError: any) {
    // O acordo já está registrado; falha no enqueue não pode perdê-lo.
    console.warn("[CLOSE-AGREEMENT] Failed to enqueue ASAAS charge:", queueError?.message)
  }

  return {
    ok: true,
    agreement_id: agreement.id,
    message: `Acordo registrado. Pagamento: ${terms.summary}`,
    terms,
  }
}
