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

/**
 * F-5 — descrição da cobrança no ASAAS (fatura/boleto que o devedor abre). Nomeia
 * o CREDOR (quem desconfia desiste quando a fatura não diz de quem é a dívida) e
 * um id curto do acordo (8 primeiros caracteres do uuid; o suporte acha o acordo
 * por ele ou pelo id da cobrança). Formato:
 *   à vista:   "VMAX — acordo 2f516142, pagamento à vista"
 *   parcelado: "VMAX — acordo 2f516142"
 *              (o ASAAS prefixa cada parcela: "Parcela 2 de 3. VMAX — acordo 2f516142";
 *               por isso nenhum "parcela 1/N" aqui — F8-03)
 *   sem nome:  "Acordo 2f516142, pagamento à vista" / "Acordo 2f516142"
 * O nome nunca leva "plano"/"assinatura": o webhook usa essas palavras para
 * reconhecer cobrança de assinatura da plataforma (credor com esse nome sai sem
 * nome). Espaços colapsados e nome cortado em 60 caracteres.
 */
export function chargeDescription(input: {
  creditorName?: string | null
  agreementId: string
  installments: number
}): string {
  const shortId = String(input.agreementId).slice(0, 8)
  const name = (input.creditorName ?? "").replace(/\s+/g, " ").trim().slice(0, 60).trim()
  const folded = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
  const usable = name.length > 0 && !folded.includes("plano") && !folded.includes("assinatura")
  const base = usable ? `${name} — acordo ${shortId}` : `Acordo ${shortId}`
  return input.installments === 1 ? `${base}, pagamento à vista` : base
}

/**
 * Nome do credor com a mesma precedência da jornada (buildAckContext /
 * resolveCreditorName): tenant_chat_config.branding.brand_name › companies.name.
 * Nunca lança (null = descrição sem nome); sempre filtrado por company_id.
 */
async function loadCreditorName(
  supabase: ReturnType<typeof createServiceClient>,
  companyId: string,
): Promise<string | null> {
  try {
    const [{ data: cfg }, { data: company }] = await Promise.all([
      supabase.from("tenant_chat_config").select("branding").eq("company_id", companyId).maybeSingle(),
      supabase.from("companies").select("name").eq("id", companyId).maybeSingle(),
    ])
    const branding = ((cfg as { branding?: unknown } | null)?.branding ?? {}) as Record<string, unknown>
    const brand = typeof branding.brand_name === "string" ? branding.brand_name.trim() : ""
    const companyName = typeof (company as { name?: unknown } | null)?.name === "string"
      ? String((company as { name: string }).name).trim()
      : ""
    return brand || companyName || null
  } catch {
    return null
  }
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
  /** Latência (14-latencia-pagar): dívida (lida com company_id) e cliente JÁ
   *  lidos pelo chamador nesta request. Usados só se a dívida é desta empresa e
   *  o cliente é o da dívida; senão lê como antes. */
  preloaded?: { debt: Record<string, any> | null; customer: Record<string, any> | null }
}

/** Resultado da criação da cobrança no fechamento (inline) ou do enfileiramento. */
export type CloseChargeStatus = "created" | "failed" | "not_started" | "queued"

export type CloseAgreementResult =
  | {
      ok: true; agreement_id: string; message: string; terms: AgreementTerms; charge_status?: CloseChargeStatus
      /** linha do acordo gravada pelo write-back inline (colunas de PaymentDetails). */
      charge_row?: Record<string, unknown> | null
    }
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
  const pre = input.preloaded
  const usePre =
    !!pre && !!pre.debt && pre.debt.id === debt_id && pre.debt.company_id === company_id &&
    !!input.customer_id_hint && !!pre.customer && pre.customer.id === input.customer_id_hint
  const [{ data: debt, error: debtError }, hinted] = usePre
    ? [{ data: pre!.debt, error: null }, { data: pre!.customer, error: null }]
    : await Promise.all([
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

  const cpfCnpj = (customer.document || "").replace(/[^\d]/g, "")
  const customerPhone = (customer.phone || "").replace(/[^\d]/g, "")
  const chargeCustomer = {
    name: customer.name || "Cliente",
    cpfCnpj,
    email: customer.email || undefined,
    mobilePhone: customerPhone || undefined,
  }
  const chargeMode = (process.env.CHARGE_MODE || "queue").toLowerCase()

  // Latência (10-latencia.md): no inline com customer ASAAS JÁ conhecido, o
  // reforço de supressão de notificações (PUT /customers — não é cobrança) começa
  // JÁ, em paralelo com a gravação do acordo e do espelho; a cobrança (POST
  // /payments) só sai depois que ele termina, como antes.
  const knownAsaasCustomerId = input.charge?.knownAsaasCustomerId || null
  let customerUpdate: Promise<unknown> | null = null
  if (chargeMode === "inline" && knownAsaasCustomerId) {
    customerUpdate = import("@/lib/asaas").then(({ updateAsaasCustomer }) =>
      updateAsaasCustomer(knownAsaasCustomerId, {
        name: chargeCustomer.name,
        email: chargeCustomer.email,
        mobilePhone: chargeCustomer.mobilePhone,
      }),
    )
    customerUpdate.catch(() => {}) // aguardado (e o erro tratado) no charge-inline
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
  // F-5: nome do credor para a descrição da cobrança, lido UMA vez aqui, em
  // paralelo com o status da dívida e o espelho (nada a mais no caminho crítico).
  let mirrorError: unknown = null
  const [{ data: debtUpdated, error: debtUpdateError }, , creditorName] = await Promise.all([
    supabase
      .from("debts")
      .update({ status: "in_negotiation", updated_at: new Date().toISOString() })
      .eq("id", debt.id)
      .select("id"),
    input.beforeCharge
      ? input.beforeCharge(agreement.id).catch((err: unknown) => { mirrorError = err })
      : Promise.resolve(),
    loadCreditorName(supabase, company_id),
  ])

  if (debtUpdateError || !debtUpdated?.length) {
    console.warn("[CLOSE-AGREEMENT] Failed to update debt status:", debtUpdateError?.message ?? "0 rows")
  }

  const description = chargeDescription({
    creditorName,
    agreementId: agreement.id,
    installments: terms.installments,
  })

  // Payload da cobrança — idêntico nos dois modos (fila e inline).
  const chargeJobData = {
    customer: chargeCustomer,
    payment: {
      billingType: (input.journey ? input.journey.terms.billing_type : "UNDEFINED") as
        | "BOLETO"
        | "CREDIT_CARD"
        | "PIX"
        | "UNDEFINED",
      value: terms.installments === 1 ? terms.agreedAmount : terms.installmentAmount,
      dueDate: firstDueDate,
      description,
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
  const result = (charge_status: CloseChargeStatus, charge_row: Record<string, unknown> | null = null) => ({
    ok: true as const,
    agreement_id: agreement.id,
    message: `Acordo registrado. Pagamento: ${terms.summary}`,
    terms,
    charge_status,
    charge_row,
  })

  if (mirrorError) {
    console.warn("[CLOSE-AGREEMENT] beforeCharge falhou; cobrança NÃO criada:", (mirrorError as Error)?.message)
    return result("not_started")
  }

  if (chargeMode === "inline") {
    try {
      const { createAsaasChargeInline } = await import("@/lib/journey/charge-inline")
      const inline = await createAsaasChargeInline(chargeJobData, {
        ...(input.charge ?? {}),
        freshAgreement: true,
        customerUpdate,
      })
      if (!inline.ok) {
        console.warn("[CLOSE-AGREEMENT] Inline ASAAS charge failed:", inline.error)
        return result(inline.notStarted ? "not_started" : "failed")
      }
      return result("created", inline.row ?? null)
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
