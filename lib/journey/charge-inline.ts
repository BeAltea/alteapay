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
}

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

  try {
    // ---- Passo 1: acha/cria customer ASAAS (notificationDisabled forçado nas 2 vias)
    const cpfCnpj = (customer.cpfCnpj || "").replace(/[^\d]/g, "")
    let asaasCustomerId: string
    const found = await getAsaasCustomerByCpfCnpj(cpfCnpj)
    if (found?.id) {
      asaasCustomerId = found.id
      await updateAsaasCustomer(asaasCustomerId, {
        name: customer.name,
        email: customer.email,
        mobilePhone: customer.mobilePhone,
      })
    } else {
      const created = await createAsaasCustomer({
        name: customer.name || "Cliente",
        cpfCnpj,
        email: customer.email,
        mobilePhone: customer.mobilePhone,
      })
      asaasCustomerId = created.id
    }

    // ---- Passo 2: cria o pagamento
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
    const asaasPayment = await createAsaasPayment(paymentParams)

    // ---- Passo 3: write-back no agreement (mesmas colunas do worker)
    const { data: updated, error: updateError } = await supabase
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
      })
      .eq("id", agreementId)
      .eq("company_id", metadata.companyId)
      .select("id")

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
