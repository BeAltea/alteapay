// Criação de cobrança ASAAS INLINE (na própria request), gated por CHARGE_MODE.
//
// Contexto: no modo `queue` (default), closeAgreement enfileira a cobrança em
// chargeQueue e o worker Fargate a cria no ASAAS + escreve as URLs no agreement.
// Quando o worker está DESLIGADO (Upstash no teto), a cobrança nunca é criada.
// Este módulo replica a lógica do worker (charge.worker.ts:152-285) SÍNCRONA,
// usando as funções canônicas de lib/asaas (que já forçam notificationDisabled:
// true — política "ASAAS não comunica o devedor").
//
// IMPORTANTE: este arquivo NÃO pode importar lib/queue/* (evita puxar Redis no
// caminho inline). Só depende de lib/asaas + client de service do Supabase.
//
// Idempotência: se o agreement já tem asaas_payment_id (respeitando o guard de
// lib/asaas-idempotency), NÃO cria outra cobrança — devolve a existente.
//
// PII: NÃO logar nome/cpf/email/telefone do devedor.

import {
  createAsaasCustomer,
  createAsaasPayment,
  getAsaasCustomerByCpfCnpj,
  updateAsaasCustomer,
  type CreatePaymentParams,
} from "@/lib/asaas"
import { isBlockingAgreement } from "@/lib/asaas-idempotency"
import { createAdminClient } from "@/lib/supabase/admin"
import { timed } from "./server-timing"

/** Payload idêntico ao enfileirado em close-agreement.ts (jobData da chargeQueue). */
export interface InlineChargeJobData {
  customer: {
    name: string
    cpfCnpj: string
    email?: string
    mobilePhone?: string
  }
  payment: {
    billingType: CreatePaymentParams["billingType"]
    value: number
    dueDate: string
    description?: string
    externalReference?: string
    installmentCount?: number
    installmentValue?: number
  }
  metadata: {
    companyId: string
    source: string
    agreementId: string
  }
}

export interface InlineChargeResult {
  ok: boolean
  invoiceUrl: string | null
  paymentId: string | null
  error?: string
  /** QA rodada 5 (Q2-01): true quando NENHUMA chamada de criação de cobrança foi
   *  enviada ao ASAAS (prazo `notAfter` estourado antes do POST /payments). O
   *  chamador pode cancelar o acordo com segurança: não há cobrança órfã. */
  notStarted?: boolean
}

/** QA rodada 5 (Q2-01) — opções do caminho inline (todas opcionais). */
export interface InlineChargeOpts {
  /** Epoch ms: se já passou quando a cobrança estiver para ser enviada ao ASAAS,
   *  NÃO envia (devolve notStarted). Garante que a criação nunca começa tão
   *  tarde que a função seria morta entre criar e espelhar (teto da plataforma). */
  notAfter?: number | null
  /** Customer ASAAS já conhecido (agreements.asaas_customer_id do mesmo cliente):
   *  pula a busca por CPF/CNPJ (1 chamada ASAAS a menos). O update de supressão
   *  de notificações continua (cliente legado pode ter notificação ligada). */
  knownAsaasCustomerId?: string | null
}

const deadlinePassed = (notAfter: number | null | undefined) =>
  typeof notAfter === "number" && Date.now() > notAfter

/**
 * Cria a cobrança ASAAS na própria request e faz o write-back no agreement.
 *
 * Passos (espelham o worker):
 *  1. Acha/cria o customer ASAAS por cpfCnpj (create já força notificationDisabled;
 *     se já existir, update para reforçar a supressão em clientes antigos).
 *  2. Cria o pagamento (billingType/value/dueDate/description/externalReference,
 *     + installments quando parcelado).
 *  3. Atualiza `agreements` (por metadata.agreementId) com ids e URLs do ASAAS.
 *
 * Idempotente: se o agreement já carrega uma cobrança viva (asaas_payment_id +
 * status bloqueante), devolve a existente SEM criar outra.
 */
export async function createAsaasChargeInline(
  jobData: InlineChargeJobData,
  opts: InlineChargeOpts = {},
): Promise<InlineChargeResult> {
  const { customer, payment, metadata } = jobData
  const agreementId = metadata.agreementId
  const supabase = createAdminClient()

  // ---- Idempotência: agreement já tem cobrança viva? devolve a existente.
  const { data: existing, error: existingError } = await supabase
    .from("agreements")
    .select("id, asaas_payment_id, asaas_invoice_url, asaas_payment_url, payment_status, asaas_status, status")
    .eq("id", agreementId)
    .eq("company_id", metadata.companyId)
    .maybeSingle()

  if (existingError) {
    console.warn(`[CHARGE-INLINE] Failed to read agreement ${agreementId}:`, existingError.message)
  }

  if (existing && isBlockingAgreement(existing)) {
    return {
      ok: true,
      paymentId: existing.asaas_payment_id ?? null,
      invoiceUrl: existing.asaas_invoice_url ?? existing.asaas_payment_url ?? null,
    }
  }

  // Prazo já estourado antes de qualquer chamada ao ASAAS: não começa.
  if (deadlinePassed(opts.notAfter)) {
    return { ok: false, paymentId: null, invoiceUrl: null, error: "charge_deadline", notStarted: true }
  }

  try {
    // ---- Passo 1: acha/cria customer ASAAS (notificationDisabled forçado nas 2 vias).
    // QA rodada 5: customer já conhecido pelos acordos do cliente → pula a busca.
    const cpfCnpj = (customer.cpfCnpj || "").replace(/[^\d]/g, "")
    let asaasCustomerId: string
    const known = opts.knownAsaasCustomerId || null
    const found = known ? { id: known } : await timed("asaas_customer_lookup", () => getAsaasCustomerByCpfCnpj(cpfCnpj))
    if (found?.id) {
      asaasCustomerId = found.id
      await timed("asaas_customer_update", () => updateAsaasCustomer(asaasCustomerId, {
        name: customer.name,
        email: customer.email,
        mobilePhone: customer.mobilePhone,
      }))
    } else {
      const created = await timed("asaas_customer_create", () => createAsaasCustomer({
        name: customer.name || "Cliente",
        cpfCnpj,
        email: customer.email,
        mobilePhone: customer.mobilePhone,
      }))
      asaasCustomerId = created.id
    }

    // ---- Passo 2: cria o pagamento — SÓ se ainda dentro do prazo (nada foi
    // enviado ao ASAAS que crie cobrança até aqui; customer não é cobrança).
    if (deadlinePassed(opts.notAfter)) {
      return { ok: false, paymentId: null, invoiceUrl: null, error: "charge_deadline", notStarted: true }
    }
    const paymentParams: CreatePaymentParams = {
      customer: asaasCustomerId,
      billingType: payment.billingType,
      value: payment.value,
      dueDate: payment.dueDate,
      description: payment.description,
      externalReference: payment.externalReference,
    }
    if (payment.installmentCount && payment.installmentCount > 1) {
      paymentParams.installmentCount = payment.installmentCount
      paymentParams.installmentValue = payment.installmentValue
    }
    const asaasPayment = await timed("asaas_payment", () => createAsaasPayment(paymentParams))

    // ---- Passo 3: write-back no agreement (mesmas colunas do worker)
    const { data: updated, error: updateError } = await timed("charge_writeback", async () => await supabase
      .from("agreements")
      .update({
        asaas_customer_id: asaasCustomerId,
        asaas_payment_id: asaasPayment.id,
        asaas_status: asaasPayment.status ?? "PENDING",
        asaas_billing_type: asaasPayment.billingType ?? payment.billingType,
        asaas_payment_url: asaasPayment.invoiceUrl ?? null,
        asaas_invoice_url: asaasPayment.invoiceUrl ?? null,
        asaas_boleto_url: asaasPayment.bankSlipUrl ?? null,
        asaas_pix_qrcode_url: asaasPayment.pixQrCodeUrl ?? null,
        due_date: asaasPayment.dueDate ?? payment.dueDate,
        // QA rodada 6 (Q4r2-03): id do PARCELAMENTO (coluna existente) — o webhook
        // das parcelas 2..N casa por ele com este acordo.
        ...(asaasPayment.installment ? { asaas_subscription_id: asaasPayment.installment } : {}),
      })
      .eq("id", agreementId)
      .eq("company_id", metadata.companyId)
      .select("id"))

    if (updateError || !updated?.length) {
      console.warn(
        `[CHARGE-INLINE] Agreement write-back skipped (${agreementId}):`,
        updateError?.message ?? "0 rows",
      )
    }

    return {
      ok: true,
      paymentId: asaasPayment.id,
      invoiceUrl: asaasPayment.invoiceUrl ?? null,
    }
  } catch (error: any) {
    console.error(`[CHARGE-INLINE] Failed to create charge for agreement ${agreementId}:`, error?.message)
    return { ok: false, paymentId: null, invoiceUrl: null, error: error?.message ?? "unknown error" }
  }
}
