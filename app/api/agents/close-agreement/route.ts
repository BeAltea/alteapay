import { NextResponse, type NextRequest } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { chargeQueue } from "@/lib/queue/queues"
import { cashDiscountPctForAging } from "@/lib/negotiation/charge-rules"
import { agingDays } from "@/lib/negotiation/config"

export const dynamic = "force-dynamic"

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface CloseAgreementBody {
  company_id: string
  thread_id: string
  debt_id: string
  offer_id: string
  channel?: string
}

function formatBRL(value: number): string {
  return `R$ ${value.toFixed(2).replace(".", ",")}`
}

/**
 * Derive agreement terms from offer_id:
 * - 'avista'  -> single payment com desconto do bucket de aging (espelho do
 *                rules engine do agente — antes era 5% fixo, o que gravava um
 *                valor DIFERENTE do que o agente ofereceu para dívidas 90d+)
 * - 'parc_N'  -> N installments of currentAmount / N (no discount)
 */
function deriveTerms(offerId: string, currentAmount: number, agingDays: number) {
  if (offerId === "avista") {
    const discountPct = cashDiscountPctForAging(agingDays)
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

export async function POST(request: NextRequest) {
  try {
    // --- Auth: shared token between negotiation agent and this app ---
    const expectedToken = process.env.AGENT_APP_TOKEN
    if (!expectedToken) {
      return NextResponse.json(
        { success: false, error: "AGENT_APP_TOKEN não configurado" },
        { status: 503 },
      )
    }

    const providedToken = request.headers.get("x-agent-token")
    if (!providedToken || providedToken !== expectedToken) {
      return NextResponse.json({ success: false, error: "Não autorizado" }, { status: 401 })
    }

    // --- Parse and validate body ---
    let body: Partial<CloseAgreementBody>
    try {
      body = (await request.json()) ?? {}
    } catch {
      return NextResponse.json({ success: false, error: "JSON inválido" }, { status: 400 })
    }

    const { company_id, thread_id, debt_id, offer_id, channel } = body

    if (
      typeof company_id !== "string" || !company_id ||
      typeof thread_id !== "string" || !thread_id ||
      typeof debt_id !== "string" || !debt_id ||
      typeof offer_id !== "string" || !offer_id
    ) {
      return NextResponse.json(
        { success: false, error: "Campos obrigatórios: company_id, thread_id, debt_id, offer_id" },
        { status: 400 },
      )
    }

    if (!UUID_REGEX.test(debt_id)) {
      return NextResponse.json(
        { success: false, error: "debt_id deve ser um UUID válido" },
        { status: 400 },
      )
    }

    const supabase = createServiceClient()

    // --- Load and validate the debt ---
    const { data: debt, error: debtError } = await supabase
      .from("debts")
      .select("*")
      .eq("id", debt_id)
      .eq("company_id", company_id)
      .maybeSingle()

    if (debtError) throw debtError
    if (!debt) {
      return NextResponse.json(
        { success: false, error: "Dívida não encontrada para esta empresa" },
        { status: 404 },
      )
    }

    if (debt.status === "paid") {
      return NextResponse.json(
        { success: false, error: "Dívida já está paga" },
        { status: 409 },
      )
    }

    const currentAmount = Number(debt.current_amount ?? debt.amount) || 0
    if (currentAmount <= 0) {
      return NextResponse.json(
        { success: false, error: "Dívida sem valor em aberto" },
        { status: 422 },
      )
    }

    // --- Derive terms from offer_id ---
    const terms = deriveTerms(offer_id, currentAmount, debt.due_date ? agingDays(debt.due_date) : 0)
    if (!terms) {
      return NextResponse.json(
        { success: false, error: `offer_id inválido: ${offer_id} (use 'avista' ou 'parc_N')` },
        { status: 400 },
      )
    }

    // --- Load customer (needed for the ASAAS charge payload) ---
    const { data: customer, error: customerError } = await supabase
      .from("customers")
      .select("id, name, document, email, phone")
      .eq("id", debt.customer_id)
      .maybeSingle()

    if (customerError) throw customerError
    if (!customer) {
      return NextResponse.json(
        { success: false, error: "Cliente da dívida não encontrado" },
        { status: 404 },
      )
    }

    // First due date: 7 days from now (YYYY-MM-DD)
    const firstDueDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0]

    // --- Insert agreement (mirrors app/actions/create-agreement-with-asaas.ts) ---
    // user_id is intentionally omitted: it is nullable (scripts/997_fix_agreements_user_id.sql)
    // and there is no authenticated user in the agent flow.
    const originText = `negotiation-agent thread ${thread_id}`
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
      terms: channel ? `${originText} (canal: ${channel})` : originText,
      payment_status: "pending",
    }

    const { data: agreement, error: agreementError } = await supabase
      .from("agreements")
      .insert(agreementData)
      .select()
      .single()

    if (agreementError) throw agreementError

    // --- Update debt status ---
    // O CHECK real de debts.status é pending|paid|cancelled|in_negotiation;
    // "in_agreement" violava a constraint e falhava silenciosamente em toda
    // negociação fechada (bug D1 do diagnóstico FASE0_CHATBOT.md).
    const { data: debtUpdated, error: debtUpdateError } = await supabase
      .from("debts")
      .update({ status: "in_negotiation", updated_at: new Date().toISOString() })
      .eq("id", debt.id)
      .select("id")

    if (debtUpdateError || !debtUpdated?.length) {
      console.warn(
        "[CLOSE-AGREEMENT] Failed to update debt status:",
        debtUpdateError?.message ?? "0 rows",
      )
    }

    // --- Enqueue ASAAS charge (processed async by charge worker; ASAAS_MODE=mock safe) ---
    // Payload matches ChargeJobData in lib/queue/workers/charge.worker.ts
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
          source: `negotiation-agent thread ${thread_id}`,
        },
      })
    } catch (queueError: any) {
      // Agreement is already registered; charge enqueue failure should not lose it.
      console.warn("[CLOSE-AGREEMENT] Failed to enqueue ASAAS charge:", queueError?.message)
    }

    return NextResponse.json(
      {
        success: true,
        agreement_id: agreement.id,
        message: `Acordo registrado. Pagamento: ${terms.summary}`,
      },
      { status: 200 },
    )
  } catch (error: any) {
    console.error("[CLOSE-AGREEMENT] Error:", error)
    return NextResponse.json(
      { success: false, error: error?.message || "Erro desconhecido ao registrar acordo" },
      { status: 500 },
    )
  }
}
