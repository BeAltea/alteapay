// Fechamento de acordo do chatbot — domínio compartilhado entre
// POST /api/agents/close-agreement (server-to-server, x-agent-token) e a ação
// agreement.close do webhook n8n (HMAC). Os termos SEMPRE derivam das regras
// do servidor (buckets de aging em charge-rules) — nunca do LLM/fluxo.

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

export interface JourneyClose {
  session_id: string
  offer_row_id: string // negotiation_offers.id
  terms: {
    total_value: number
    installments: number
    installment_value: number
    billing_type: "PIX" | "BOLETO" | "CREDIT_CARD"
    first_due_date: string
  }
  valid_until: string | null
}

export interface CloseAgreementInput {
  company_id: string
  debt_id: string
  offer_id: string
  /** Identificação da origem para auditoria (ex.: "negotiation-agent thread X", "n8n flow"). */
  origin: string
  channel?: string
  /** Jornada (D8): termos JÁ validados pela matriz substituem deriveTerms. */
  journey?: JourneyClose
  /**
   * QA rodada 5 (Q2-01) — espelho ANTES da cobrança: chamado logo após o insert
   * do acordo e ANTES de qualquer chamada ao ASAAS. A jornada grava aqui a prova
   * do aceite (offer → agreement) e o vínculo sessão → acordo, para que uma
   * função morta no meio da criação nunca deixe cobrança sem espelho local.
   * Se lançar, a cobrança NÃO é criada (o acordo fica sem cobrança e é devolvido
   * com charge_status 'not_started').
   */
  beforeCharge?: (agreementId: string) => Promise<void>
  /** QA rodada 5 (Q2-01) — opções do caminho inline (prazo e customer conhecido). */
  charge?: { notAfter?: number | null; knownAsaasCustomerId?: string | null }
  /** QA rodada 5: customer_id já conhecido (sessão) — lido em paralelo com a
   *  dívida; conferido contra debts.customer_id (divergência → releitura). */
  customer_id_hint?: string
}

/** Resultado da criação da cobrança no fechamento (inline) ou do enfileiramento. */
export type CloseChargeStatus = "created" | "failed" | "not_started" | "queued"

export type CloseAgreementResult =
  | { ok: true; agreement_id: string; message: string; terms: AgreementTerms; charge_status?: CloseChargeStatus }
  | { ok: false; status: number; error: string }

export async function closeAgreement(input: CloseAgreementInput): Promise<CloseAgreementResult> {
  const { company_id, debt_id, offer_id, origin, channel } = input

  if (!UUID_REGEX.test(debt_id)) {
    return { ok: false, status: 400, error: "debt_id deve ser um UUID válido" }
  }

  const supabase = createServiceClient()

  const loadCustomer = (id: string) =>
    supabase.from("customers").select("id, name, document, email, phone").eq("id", id).maybeSingle()
  // QA rodada 5: dívida e cliente em paralelo quando a sessão já sabe o cliente.
  const [{ data: debt, error: debtError }, hinted] = await Promise.all([
    supabase.from("debts").select("*").eq("id", debt_id).eq("company_id", company_id).maybeSingle(),
    input.customer_id_hint ? loadCustomer(input.customer_id_hint) : Promise.resolve(null),
  ])

  if (debtError) throw debtError
  if (!debt) return { ok: false, status: 404, error: "Dívida não encontrada para esta empresa" }
  if (debt.status === "paid") return { ok: false, status: 409, error: "Dívida já está paga" }

  const currentAmount = Number(debt.amount) || 0
  if (currentAmount <= 0) return { ok: false, status: 422, error: "Dívida sem valor em aberto" }

  const terms = input.journey
    ? {
        agreedAmount: input.journey.terms.total_value,
        installments: input.journey.terms.installments,
        installmentAmount: input.journey.terms.installment_value,
        summary:
          input.journey.terms.installments === 1
            ? `pagamento à vista de R$ ${input.journey.terms.total_value.toFixed(2)}`
            : `${input.journey.terms.installments}x de R$ ${input.journey.terms.installment_value.toFixed(2)}`,
      }
    : deriveTerms(offer_id, currentAmount, debt.due_date ? agingDays(debt.due_date) : 0)
  if (!terms) {
    return { ok: false, status: 400, error: `offer_id inválido: ${offer_id} (use 'avista' ou 'parc_N')` }
  }

  const { data: customer, error: customerError } =
    hinted && input.customer_id_hint === debt.customer_id ? hinted : await loadCustomer(debt.customer_id)

  if (customerError) throw customerError
  if (!customer) return { ok: false, status: 404, error: "Cliente da dívida não encontrado" }

  // Primeiro vencimento: da oferta (jornada) ou 7 dias a partir de hoje
  const firstDueDate =
    input.journey?.terms.first_due_date ??
    new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]

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
    attendant_name: input.journey ? "chat-journey" : "negotiation-agent",
    terms: channel ? `${origin} (canal: ${channel})` : origin,
    payment_status: "pending",
  }
  if (input.journey) {
    agreementData.origin = "chat_journey"
    agreementData.negotiation_session_id = input.journey.session_id
    agreementData.offer_id = input.journey.offer_row_id
    agreementData.proposal_valid_until = input.journey.valid_until
  }

  const { data: agreement, error: agreementError } = await supabase
    .from("agreements")
    .insert(agreementData)
    .select()
    .single()

  if (agreementError) throw agreementError

  // O CHECK real de debts.status é pending|paid|cancelled|in_negotiation;
  // "in_agreement" violava a constraint (bug D1 do diagnóstico FASE0_CHATBOT.md).
  // QA rodada 5 (Q2-01): status da dívida e espelho da jornada (beforeCharge) em
  // paralelo — os dois ANTES da cobrança. Falha no espelho = não cobra.
  let mirrorError: unknown = null
  const [{ data: debtUpdated, error: debtUpdateError }] = await Promise.all([
    supabase
      .from("debts")
      .update({ status: "in_negotiation", updated_at: new Date().toISOString() })
      .eq("id", debt.id)
      .select("id"),
    input.beforeCharge
      ? input.beforeCharge(agreement.id).catch((err: unknown) => { mirrorError = err })
      : Promise.resolve(),
  ])

  if (debtUpdateError || !debtUpdated?.length) {
    console.warn("[CLOSE-AGREEMENT] Failed to update debt status:", debtUpdateError?.message ?? "0 rows")
  }

  const cpfCnpj = (customer.document || "").replace(/[^\d]/g, "")
  const customerPhone = (customer.phone || "").replace(/[^\d]/g, "")
  const chargeDescription =
    terms.installments === 1
      ? `Acordo ${agreement.id} - pagamento à vista`
      : `Acordo ${agreement.id} - parcela 1/${terms.installments}`

  // Payload da cobrança — idêntico nos dois modos (fila e inline).
  const chargeJobData = {
    customer: {
      name: customer.name || "Cliente",
      cpfCnpj,
      email: customer.email || undefined,
      mobilePhone: customerPhone || undefined,
    },
    payment: {
      billingType: (input.journey ? input.journey.terms.billing_type : "UNDEFINED") as
        | "BOLETO"
        | "CREDIT_CARD"
        | "PIX"
        | "UNDEFINED",
      value: terms.installments === 1 ? terms.agreedAmount : terms.installmentAmount,
      dueDate: firstDueDate,
      description: chargeDescription,
      externalReference: input.journey
        ? `journey_${input.journey.session_id}_${input.journey.offer_row_id}`
        : agreement.id,
      ...(terms.installments > 1
        ? { installmentCount: terms.installments, installmentValue: terms.installmentAmount }
        : {}),
    },
    metadata: {
      companyId: company_id,
      source: origin,
      agreementId: agreement.id,
    },
  }

  // CHARGE_MODE decide onde a cobrança é criada:
  //  - 'queue' (DEFAULT): enfileira em chargeQueue; o worker Fargate cria no ASAAS.
  //  - 'inline': cria a cobrança na PRÓPRIA request (import dinâmico de
  //    charge-inline p/ nunca puxar lib/queue/Redis no caminho inline).
  // Em ambos os modos, falha na cobrança NÃO pode perder o acordo já registrado.
  const result = (charge_status: CloseChargeStatus) => ({
    ok: true as const,
    agreement_id: agreement.id,
    message: `Acordo registrado. Pagamento: ${terms.summary}`,
    terms,
    charge_status,
  })

  if (mirrorError) {
    console.warn("[CLOSE-AGREEMENT] beforeCharge falhou; cobrança NÃO criada:", (mirrorError as Error)?.message)
    return result("not_started")
  }

  const chargeMode = (process.env.CHARGE_MODE || "queue").toLowerCase()
  if (chargeMode === "inline") {
    try {
      const { createAsaasChargeInline } = await import("@/lib/journey/charge-inline")
      const inline = await createAsaasChargeInline(chargeJobData, input.charge ?? {})
      if (!inline.ok) {
        console.warn("[CLOSE-AGREEMENT] Inline ASAAS charge failed:", inline.error)
        return result(inline.notStarted ? "not_started" : "failed")
      }
      return result("created")
    } catch (inlineError: any) {
      console.warn("[CLOSE-AGREEMENT] Inline ASAAS charge threw:", inlineError?.message)
      return result("failed")
    }
  }
  try {
    const { chargeQueue } = await import("@/lib/queue/queues")
    await chargeQueue.add(`agent-agreement-${agreement.id}`, chargeJobData)
  } catch (queueError: any) {
    // O acordo já está registrado; falha no enqueue não pode perdê-lo.
    console.warn("[CLOSE-AGREEMENT] Failed to enqueue ASAAS charge:", queueError?.message)
  }
  return result("queued")
}
