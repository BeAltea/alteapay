import { NextRequest, NextResponse } from "next/server"
import { createAdminClient, createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import {
  getAsaasCustomerByCpfCnpj,
  createAsaasCustomer,
  updateAsaasCustomer,
  getAsaasCustomerNotifications,
  updateAsaasNotification,
  createAsaasPayment,
  resendAsaasPaymentNotification,
  getAsaasPaymentsForCustomer,
} from "@/lib/asaas"
import { findBlockingAgreement, findBlockingPayment } from "@/lib/asaas-idempotency"
import { bulkNegotiationsQueue } from "@/lib/queue/queues"
import { randomUUID } from "crypto"

// Allow up to 120 seconds for small batches (sync mode)
export const maxDuration = 120

interface SendBulkNegotiationsParams {
  companyId: string
  customerIds: string[]
  discountType: "none" | "percentage" | "fixed"
  discountValue: number
  paymentMethods: string[]
  notificationChannels: string[]
}

type NegotiationStep =
  | "validate_data"
  | "create_customer_db"
  | "create_debt_db"
  | "create_asaas_customer"
  | "create_asaas_payment"
  | "create_agreement_db"
  | "update_agreement_db"
  | "update_vmax_status"
  | "completed"

interface ErrorDetails {
  message: string
  step: NegotiationStep
  httpStatus?: number
  asaasErrors?: any[]
  recoverable?: boolean
}

interface NegotiationResult {
  vmaxId: string
  customerName: string
  cpfCnpj: string
  status: "success" | "failed" | "recovered" | "skipped"
  skipReason?: string
  failedAtStep?: NegotiationStep
  error?: ErrorDetails
  asaasCustomerCreated?: boolean
  asaasPaymentCreated?: boolean
  asaasCustomerId?: string
  asaasPaymentId?: string
  paymentUrl?: string
  recoveryNote?: string
  notificationChannel?: "whatsapp" | "email" | "none" // Which channel was used for notification
  phoneValidation?: {
    original: string
    isValid: boolean
    reason?: string
  }
}

// Step labels in Portuguese for display
const STEP_LABELS: Record<NegotiationStep, string> = {
  validate_data: "Validar dados do cliente",
  create_customer_db: "Criar cliente no banco",
  create_debt_db: "Criar dívida no banco",
  create_asaas_customer: "Criar cliente no ASAAS",
  create_asaas_payment: "Criar cobrança no ASAAS",
  create_agreement_db: "Criar acordo no banco",
  update_agreement_db: "Atualizar acordo no banco",
  update_vmax_status: "Atualizar status VMAX",
  completed: "Concluído",
}

// Extract error details from ASAAS or general errors
function extractErrorDetails(error: any, step: NegotiationStep): ErrorDetails {
  const details: ErrorDetails = {
    message: error.message || "Erro desconhecido",
    step,
    recoverable: step === "update_agreement_db" || step === "update_vmax_status",
  }

  // Try to extract HTTP status and ASAAS errors
  if (error.response) {
    details.httpStatus = error.response.status
    if (error.response.data?.errors) {
      details.asaasErrors = error.response.data.errors
      // Use ASAAS error message if available
      const firstError = error.response.data.errors[0]
      if (firstError?.description) {
        details.message = firstError.description
      }
    }
  }

  // Check for ASAAS error format in message
  if (error.message?.includes("ASAAS")) {
    const match = error.message.match(/(\d{3})/)
    if (match) {
      details.httpStatus = parseInt(match[1])
    }
  }

  return details
}

/**
 * Validate Brazilian phone number for SMS/WhatsApp
 * Valid formats:
 * - Mobile: 11 digits (DDD 2 digits + 9 digits starting with 9) e.g., 11987654321
 * - With country code: 13 digits (55 + DDD + number) e.g., 5511987654321
 *
 * Returns: { isValid: boolean, cleaned: string, reason?: string }
 */
function validateBrazilianPhone(phone: string | null | undefined): {
  isValid: boolean
  cleaned: string
  reason?: string
} {
  if (!phone) {
    return { isValid: false, cleaned: "", reason: "Telefone não informado" }
  }

  // Remove all non-digits
  let cleaned = phone.replace(/\D/g, "")

  // Remove country code if present
  if (cleaned.startsWith("55") && cleaned.length >= 12) {
    cleaned = cleaned.substring(2)
  }

  // Check length - must be 10 (landline) or 11 (mobile) digits
  if (cleaned.length < 10 || cleaned.length > 11) {
    return {
      isValid: false,
      cleaned,
      reason: `Telefone com ${cleaned.length} dígitos (esperado 10-11)`
    }
  }

  // Extract DDD (first 2 digits)
  const ddd = parseInt(cleaned.substring(0, 2))

  // Valid DDDs in Brazil: 11-99 (not all are used, but this is a reasonable range)
  if (ddd < 11 || ddd > 99) {
    return { isValid: false, cleaned, reason: `DDD inválido: ${ddd}` }
  }

  // For mobile (11 digits), the 3rd digit must be 9
  if (cleaned.length === 11) {
    const thirdDigit = cleaned.charAt(2)
    if (thirdDigit !== "9") {
      return {
        isValid: false,
        cleaned,
        reason: `Celular deve começar com 9 após DDD (encontrado: ${thirdDigit})`
      }
    }
  }

  // For landline (10 digits), check if it's a valid landline prefix (2-5)
  if (cleaned.length === 10) {
    const thirdDigit = parseInt(cleaned.charAt(2))
    // Landlines start with 2, 3, 4, or 5
    if (thirdDigit < 2 || thirdDigit > 5) {
      return {
        isValid: false,
        cleaned,
        reason: `Fixo deve começar com 2-5 após DDD (encontrado: ${thirdDigit})`
      }
    }
    // Landlines can't receive WhatsApp - flag as invalid for our purposes
    return {
      isValid: false,
      cleaned,
      reason: "Telefone fixo não recebe WhatsApp/SMS"
    }
  }

  return { isValid: true, cleaned }
}

// Process a single negotiation - extracted for parallel execution
async function processSingleNegotiation(
  vmaxId: string,
  params: SendBulkNegotiationsParams,
  userId: string,
  attendantName: string,
  supabase: any
): Promise<NegotiationResult> {
  let currentStep: NegotiationStep = "validate_data"
  let asaasCustomerCreated = false
  let asaasPaymentCreated = false
  let asaasCustomerId: string | null = null
  let asaasPaymentId: string | null = null
  let paymentUrl: string | null = null
  let customerId: string | null = null
  let debtId: string | null = null
  let agreementId: string | null = null

  // Get VMAX record
  const { data: vmax, error: vmaxError } = await supabase
    .from("VMAX")
    .select("*")
    .eq("id", vmaxId)
    .single()

  if (vmaxError || !vmax) {
    return {
      vmaxId,
      customerName: "Desconhecido",
      cpfCnpj: "",
      status: "failed",
      failedAtStep: "validate_data",
      error: {
        message: "Registro VMAX não encontrado",
        step: "validate_data",
      },
    }
  }

  const cpfCnpj = (vmax["CPF/CNPJ"] || "").replace(/\D/g, "")
  const customerName = vmax.Cliente || "Cliente"

  // Validate CPF/CNPJ
  if (!cpfCnpj) {
    return {
      vmaxId,
      customerName,
      cpfCnpj: "",
      status: "failed",
      failedAtStep: "validate_data",
      error: {
        message: "CPF/CNPJ não cadastrado",
        step: "validate_data",
      },
    }
  }

  // Validate CPF (11 digits) or CNPJ (14 digits)
  if (cpfCnpj.length !== 11 && cpfCnpj.length !== 14) {
    return {
      vmaxId,
      customerName,
      cpfCnpj,
      status: "failed",
      failedAtStep: "validate_data",
      error: {
        message: `CPF/CNPJ inválido (${cpfCnpj.length} dígitos, esperado 11 ou 14)`,
        step: "validate_data",
      },
    }
  }

  // Get contact info
  let customerPhone = (vmax["Telefone 1"] || vmax["Telefone 2"] || vmax["Telefone"] || "").replace(/\D/g, "")
  let customerEmail = vmax.Email || ""

  const { data: existingCustomerData } = await supabase
    .from("customers")
    .select("phone, email")
    .eq("document", cpfCnpj)
    .eq("company_id", params.companyId)
    .maybeSingle()

  if (existingCustomerData) {
    if (existingCustomerData.phone) customerPhone = existingCustomerData.phone.replace(/\D/g, "")
    if (existingCustomerData.email) customerEmail = existingCustomerData.email
  }

  // Validate phone for WhatsApp/SMS
  const phoneValidation = validateBrazilianPhone(customerPhone)

  // Determine notification channel:
  // - Valid phone: use WhatsApp (ASAAS sends via WhatsApp)
  // - Invalid phone but has email: use email
  // - Neither: no notification
  let notificationChannel: "whatsapp" | "email" | "none" = "none"
  if (phoneValidation.isValid && params.notificationChannels.includes("whatsapp")) {
    notificationChannel = "whatsapp"
  } else if (customerEmail && params.notificationChannels.includes("whatsapp")) {
    // Fallback to email when phone is invalid
    notificationChannel = "email"
    console.log(`[ASAAS] ${customerName}: Phone invalid (${phoneValidation.reason}), using email fallback`)
  }

  // Phone to send to ASAAS (only if valid)
  const asaasPhone = phoneValidation.isValid ? phoneValidation.cleaned : undefined

  // Parse debt value
  const vencidoStr = String(vmax.Vencido || "0")
  const originalAmount =
    Number(
      vencidoStr
        .replace(/R\$/g, "")
        .replace(/\s/g, "")
        .replace(/\./g, "")
        .replace(",", ".")
    ) || 0

  if (originalAmount <= 0) {
    return {
      vmaxId,
      customerName,
      cpfCnpj,
      status: "failed",
      failedAtStep: "validate_data",
      error: {
        message: "Dívida com valor zero ou inválido",
        step: "validate_data",
      },
    }
  }

  // Calculate discount
  let discountAmount = 0
  if (params.discountType === "percentage" && params.discountValue > 0) {
    discountAmount = (originalAmount * params.discountValue) / 100
  } else if (params.discountType === "fixed" && params.discountValue > 0) {
    discountAmount = Math.min(params.discountValue, originalAmount)
  }

  const agreedAmount = originalAmount - discountAmount
  const discountPercentage = originalAmount > 0 ? (discountAmount / originalAmount) * 100 : 0

  try {
    // === STEP: Create or get customer in DB ===
    currentStep = "create_customer_db"

    const { data: existingCustomers } = await supabase
      .from("customers")
      .select("id")
      .eq("document", cpfCnpj)
      .eq("company_id", params.companyId)
      .limit(1)

    const existingCustomer = existingCustomers?.[0] || null

    if (existingCustomer) {
      customerId = existingCustomer.id
      await supabase
        .from("customers")
        .update({ name: customerName, phone: customerPhone, email: customerEmail })
        .eq("id", existingCustomer.id)
    } else {
      const { data: newCustomer, error: customerError } = await supabase
        .from("customers")
        .insert({
          name: customerName,
          document: cpfCnpj,
          document_type: cpfCnpj.length === 11 ? "CPF" : "CNPJ",
          phone: customerPhone,
          email: customerEmail,
          company_id: params.companyId,
          source_system: "VMAX",
          external_id: vmaxId,
        })
        .select("id")
        .single()

      if (customerError || !newCustomer) {
        throw { message: customerError?.message || "Erro ao criar cliente", step: currentStep }
      }
      customerId = newCustomer.id
    }

    // Guard de idempotência (local): acordo vivo/pago para este cliente bloqueia nova cobrança
    const { data: liveAgreements } = await supabase
      .from("agreements")
      .select("id, asaas_payment_id, payment_status, asaas_status")
      .eq("customer_id", customerId)
      .eq("company_id", params.companyId)
      .not("asaas_payment_id", "is", null)
    const blockingAgreement = findBlockingAgreement(liveAgreements || [])
    if (blockingAgreement) {
      const skipReason = `SKIP_JA_COBRADO_LOCAL: payment ${blockingAgreement.asaas_payment_id} (${blockingAgreement.payment_status ?? ""}/${blockingAgreement.asaas_status ?? ""})`
      console.log(`[sendBulkNegotiations] ${skipReason} - ${customerName}`)
      return {
        vmaxId,
        customerName,
        cpfCnpj,
        status: "skipped",
        skipReason,
      }
    }

    // === STEP: Create or get debt ===
    currentStep = "create_debt_db"

    const { data: existingDebts } = await supabase
      .from("debts")
      .select("id")
      .eq("customer_id", customerId)
      .eq("company_id", params.companyId)
      .order("created_at", { ascending: false })
      .limit(1)

    const existingDebt = existingDebts?.[0] || null

    if (existingDebt) {
      debtId = existingDebt.id
      await supabase
        .from("debts")
        .update({ amount: originalAmount, status: "in_negotiation" })
        .eq("id", existingDebt.id)
    } else {
      const dueDate = new Date()
      dueDate.setDate(dueDate.getDate() + 30)

      const { data: newDebt, error: debtError } = await supabase
        .from("debts")
        .insert({
          customer_id: customerId,
          company_id: params.companyId,
          amount: originalAmount,
          due_date: dueDate.toISOString().split("T")[0],
          description: `Dívida de ${customerName}`,
          status: "in_negotiation",
          source_system: "VMAX",
          external_id: vmaxId,
        })
        .select("id")
        .single()

      if (debtError || !newDebt) {
        throw { message: debtError?.message || "Erro ao criar dívida", step: currentStep }
      }
      debtId = newDebt.id
    }

    // === STEP: ASAAS Customer Integration ===
    currentStep = "create_asaas_customer"

    try {
      // Try to get existing ASAAS customer first
      const existingAsaas = await getAsaasCustomerByCpfCnpj(cpfCnpj)
      if (existingAsaas) {
        asaasCustomerId = existingAsaas.id
        asaasCustomerCreated = true // Already exists
        // Only send phone to ASAAS if it's valid
        await updateAsaasCustomer(asaasCustomerId, {
          mobilePhone: asaasPhone,
          email: customerEmail || undefined,
          notificationDisabled: false,
        })
      } else {
        // Create new ASAAS customer - only send phone if valid
        const newAsaas = await createAsaasCustomer({
          name: customerName,
          cpfCnpj,
          mobilePhone: asaasPhone,
          email: customerEmail || undefined,
          notificationDisabled: false,
        })
        asaasCustomerId = newAsaas.id
        asaasCustomerCreated = true
      }

      // Configure notifications based on phone validity:
      // - Valid phone: enable WhatsApp
      // - Invalid phone: enable email (fallback)
      try {
        const allNotifs = await getAsaasCustomerNotifications(asaasCustomerId)
        const paymentCreatedNotif = allNotifs.find((n: any) => n.event === "PAYMENT_CREATED")
        if (paymentCreatedNotif) {
          const useWhatsApp = notificationChannel === "whatsapp"
          const useEmail = notificationChannel === "email"

          await updateAsaasNotification(paymentCreatedNotif.id, {
            enabled: useWhatsApp || useEmail,
            emailEnabledForCustomer: useEmail,
            smsEnabledForCustomer: false,
            whatsappEnabledForCustomer: useWhatsApp,
          })

          console.log(`[ASAAS] ${customerName}: Notification configured - channel: ${notificationChannel}`)
        }
      } catch (notifErr: any) {
        console.warn(`[ASAAS] Notification config failed for ${customerName}:`, notifErr.message)
      }
    } catch (asaasErr: any) {
      return {
        vmaxId,
        customerName,
        cpfCnpj,
        status: "failed",
        failedAtStep: "create_asaas_customer",
        error: extractErrorDetails(asaasErr, "create_asaas_customer"),
        asaasCustomerCreated: false,
        notificationChannel,
        phoneValidation: {
          original: customerPhone,
          isValid: phoneValidation.isValid,
          reason: phoneValidation.reason,
        },
      }
    }

    // Guard de idempotência (ASAAS, fonte da verdade): qualquer cobrança não-encerrada bloqueia
    const existingPayments = await getAsaasPaymentsForCustomer(asaasCustomerId!)
    const blockingPayment = findBlockingPayment(existingPayments)
    if (blockingPayment) {
      const skipReason = `SKIP_JA_COBRADO_ASAAS: payment ${blockingPayment.id} status ${blockingPayment.status}`
      console.log(`[sendBulkNegotiations] ${skipReason} - ${customerName}`)
      return {
        vmaxId,
        customerName,
        cpfCnpj,
        status: "skipped",
        skipReason,
        asaasCustomerCreated: true,
        asaasCustomerId: asaasCustomerId || undefined,
      }
    }

    // === STEP: Create agreement in DB ===
    currentStep = "create_agreement_db"
    const dueDate = new Date()
    dueDate.setDate(dueDate.getDate() + 30)
    const dueDateStr = dueDate.toISOString().split("T")[0]

    const { data: agreement, error: agreementError } = await supabase
      .from("agreements")
      .insert({
        debt_id: debtId,
        customer_id: customerId,
        user_id: userId,
        company_id: params.companyId,
        original_amount: originalAmount,
        agreed_amount: agreedAmount,
        discount_amount: discountAmount,
        discount_percentage: discountPercentage,
        installments: 1,
        installment_amount: agreedAmount,
        due_date: dueDateStr,
        status: "draft",
        payment_status: "pending",
        attendant_name: attendantName,
        asaas_customer_id: asaasCustomerId,
        terms: JSON.stringify({
          payment_methods: params.paymentMethods,
          notification_channels: params.notificationChannels,
          discount_type: params.discountType,
          discount_value: params.discountValue,
        }),
      })
      .select()
      .single()

    if (agreementError || !agreement) {
      return {
        vmaxId,
        customerName,
        cpfCnpj,
        status: "failed",
        failedAtStep: "create_agreement_db",
        error: extractErrorDetails({ message: agreementError?.message || "Erro ao criar acordo" }, "create_agreement_db"),
        asaasCustomerCreated,
        asaasCustomerId: asaasCustomerId || undefined,
      }
    }
    agreementId = agreement.id

    // === STEP: Create ASAAS payment ===
    currentStep = "create_asaas_payment"

    try {
      let billingType: "BOLETO" | "CREDIT_CARD" | "PIX" | "UNDEFINED" = "UNDEFINED"
      const methodMapping: Record<string, "BOLETO" | "CREDIT_CARD" | "PIX"> = {
        boleto: "BOLETO",
        pix: "PIX",
        credit_card: "CREDIT_CARD",
      }
      if (params.paymentMethods.length === 1 && methodMapping[params.paymentMethods[0]]) {
        billingType = methodMapping[params.paymentMethods[0]]
      }

      const asaasPayment = await createAsaasPayment({
        customer: asaasCustomerId,
        billingType,
        value: agreedAmount,
        dueDate: dueDateStr,
        description: `Acordo de negociação - ${customerName}`,
        externalReference: `agreement_${agreement.id}`,
        postalService: false,
      })

      asaasPaymentId = asaasPayment.id
      asaasPaymentCreated = true
      paymentUrl = asaasPayment.invoiceUrl || null

      // === STEP: Update agreement with ASAAS payment info ===
      currentStep = "update_agreement_db"
      const { error: updateError } = await supabase
        .from("agreements")
        .update({
          asaas_payment_id: asaasPayment.id,
          asaas_payment_url: asaasPayment.invoiceUrl || null,
          asaas_pix_qrcode_url: asaasPayment.pixQrCodeUrl || null,
          asaas_boleto_url: asaasPayment.bankSlipUrl || null,
          status: "active",
        })
        .eq("id", agreement.id)

      if (updateError) {
        // ASAAS succeeded but DB update failed - this is recoverable
        console.error(`[sendBulkNegotiations] DB update failed for agreement ${agreement.id}, will attempt recovery`)

        // Attempt auto-recovery
        const { error: retryError } = await supabase
          .from("agreements")
          .update({
            asaas_payment_id: asaasPayment.id,
            asaas_payment_url: asaasPayment.invoiceUrl || null,
            asaas_pix_qrcode_url: asaasPayment.pixQrCodeUrl || null,
            asaas_boleto_url: asaasPayment.bankSlipUrl || null,
            status: "active",
          })
          .eq("id", agreement.id)

        if (retryError) {
          return {
            vmaxId,
            customerName,
            cpfCnpj,
            status: "failed",
            failedAtStep: "update_agreement_db",
            error: {
              ...extractErrorDetails({ message: updateError.message }, "update_agreement_db"),
              recoverable: true,
            },
            asaasCustomerCreated: true,
            asaasPaymentCreated: true,
            asaasCustomerId: asaasCustomerId || undefined,
            asaasPaymentId: asaasPaymentId || undefined,
            paymentUrl: paymentUrl || undefined,
          }
        }
        // Recovery succeeded, continue
      }
    } catch (asaasPaymentErr: any) {
      // Delete the draft agreement since payment failed
      await supabase.from("agreements").delete().eq("id", agreement.id)
      return {
        vmaxId,
        customerName,
        cpfCnpj,
        status: "failed",
        failedAtStep: "create_asaas_payment",
        error: extractErrorDetails(asaasPaymentErr, "create_asaas_payment"),
        asaasCustomerCreated: true,
        asaasPaymentCreated: false,
        asaasCustomerId: asaasCustomerId || undefined,
      }
    }

    // === STEP: Update VMAX negotiation status ===
    currentStep = "update_vmax_status"
    const { error: vmaxUpdateError } = await supabase
      .from("VMAX")
      .update({ negotiation_status: "sent" })
      .eq("id", vmaxId)

    if (vmaxUpdateError) {
      console.warn(`[sendBulkNegotiations] VMAX update failed for ${vmaxId}, but ASAAS succeeded`)
      // Don't fail the whole operation - ASAAS is the source of truth
    }

    // Record collection action with actual channel used (non-critical)
    if (notificationChannel !== "none") {
      try {
        await supabase.from("collection_actions").insert({
          company_id: params.companyId,
          customer_id: customerId,
          debt_id: debtId,
          action_type: notificationChannel,
          status: "sent",
          sent_by: userId,
          sent_at: new Date().toISOString(),
          message: `Negociação enviada via ${notificationChannel}. Valor: R$ ${agreedAmount.toFixed(2)}`,
          metadata: {
            payment_methods: params.paymentMethods,
            notification_channels: params.notificationChannels,
            actual_channel: notificationChannel,
            phone_valid: phoneValidation.isValid,
            phone_validation_reason: phoneValidation.reason,
            discount_type: params.discountType,
            discount_value: params.discountValue,
            original_amount: originalAmount,
            agreed_amount: agreedAmount,
          },
        })
      } catch (actionErr) {
        console.warn(`[sendBulkNegotiations] Failed to record collection action for ${vmaxId}`)
      }
    }

    // Send notifications in background (don't block the result)
    // Pass the actual notification channel determined by phone validation
    sendNotificationsInBackground(
      params,
      customerName,
      customerEmail,
      customerPhone,
      agreedAmount,
      agreement.id,
      asaasCustomerId,
      supabase,
      notificationChannel
    )

    return {
      vmaxId,
      customerName,
      cpfCnpj,
      status: "success",
      asaasCustomerCreated: true,
      asaasPaymentCreated: true,
      asaasCustomerId: asaasCustomerId || undefined,
      asaasPaymentId: asaasPaymentId || undefined,
      paymentUrl: paymentUrl || undefined,
      notificationChannel,
      phoneValidation: {
        original: customerPhone,
        isValid: phoneValidation.isValid,
        reason: phoneValidation.reason,
      },
    }
  } catch (error: any) {
    return {
      vmaxId,
      customerName,
      cpfCnpj,
      status: "failed",
      failedAtStep: currentStep,
      error: extractErrorDetails(error, currentStep),
      asaasCustomerCreated,
      asaasPaymentCreated,
      asaasCustomerId: asaasCustomerId || undefined,
      asaasPaymentId: asaasPaymentId || undefined,
      notificationChannel,
      phoneValidation: {
        original: customerPhone,
        isValid: phoneValidation.isValid,
        reason: phoneValidation.reason,
      },
    }
  }
}

// Send notifications without blocking the main flow
// NOTIFICATION LOGIC:
// - Valid phone: ASAAS sends WhatsApp/SMS automatically when charge is created
// - Invalid phone: ASAAS sends email (if email exists) when charge is created
// - AlteaPay (Resend): ALWAYS sends its own email notification (regardless of phone validity)
async function sendNotificationsInBackground(
  params: SendBulkNegotiationsParams,
  customerName: string,
  customerEmail: string,
  customerPhone: string,
  agreedAmount: number,
  agreementId: string,
  asaasCustomerId: string | null,
  supabase: any,
  notificationChannel: "whatsapp" | "email" | "none"
) {
  try {
    // Get agreement data
    const { data: agreementData } = await supabase
      .from("agreements")
      .select("asaas_payment_url, asaas_payment_id, due_date")
      .eq("id", agreementId)
      .single()

    const paymentUrl = agreementData?.asaas_payment_url || ""
    const dueDate = agreementData?.due_date
      ? new Date(agreementData.due_date).toLocaleDateString("pt-BR")
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toLocaleDateString("pt-BR")

    // Get company name
    const { data: companyData } = await supabase
      .from("companies")
      .select("name")
      .eq("id", params.companyId)
      .single()
    const companyName = companyData?.name || "Empresa"

    // ASAAS handles WhatsApp/SMS automatically when charge is created
    // We just need to trigger resend if WhatsApp channel was selected
    if (notificationChannel === "whatsapp" && asaasCustomerId && agreementData?.asaas_payment_id) {
      try {
        await resendAsaasPaymentNotification(agreementData.asaas_payment_id)
        console.log(`[Notifications] ${customerName}: WhatsApp/SMS notification triggered via ASAAS`)
      } catch (whatsappErr: any) {
        console.error(`[Notifications] ASAAS WhatsApp failed for ${customerName}:`, whatsappErr.message)
      }
    }

    // AlteaPay ALWAYS sends its own email via Resend (if customer has email)
    // This is separate from ASAAS notifications
    if (customerEmail) {
      try {
        const { sendEmail, generateDebtCollectionEmail } = await import("@/lib/notifications/email")
        const emailHtml = await generateDebtCollectionEmail({
          customerName,
          debtAmount: agreedAmount,
          dueDate,
          companyName,
          paymentLink: paymentUrl,
        })
        await sendEmail({
          to: customerEmail,
          subject: `Proposta de Negociação - ${companyName}`,
          html: emailHtml,
        })
        console.log(`[Notifications] ${customerName}: AlteaPay email sent via Resend`)
      } catch (emailErr: any) {
        console.error(`[Notifications] Resend email failed for ${customerName}:`, emailErr.message)
      }
    } else {
      console.log(`[Notifications] ${customerName}: No email address, skipping AlteaPay email`)
    }
  } catch (err: any) {
    console.error(`[Notifications] Background notifications failed:`, err.message)
  }
}

export async function POST(request: NextRequest) {
  try {
    const params: SendBulkNegotiationsParams = await request.json()

    // Verify user is super admin
    const authSupabase = await createClient()
    const {
      data: { user },
    } = await authSupabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ success: false, error: "Não autenticado", sent: 0, results: [] }, { status: 401 })
    }

    const { data: profile } = await authSupabase
      .from("profiles")
      .select("role, full_name")
      .eq("id", user.id)
      .single()

    if (profile?.role !== "super_admin") {
      return NextResponse.json({ success: false, error: "Sem permissão", sent: 0, results: [] }, { status: 403 })
    }

    // For batches > 5 customers, use queue to avoid Netlify timeout (10-26s limit)
    // Each negotiation can take 3-5 seconds due to multiple ASAAS API calls
    const QUEUE_THRESHOLD = 5
    const useQueue = params.customerIds.length > QUEUE_THRESHOLD

    if (useQueue) {
      // Queue the job and return immediately
      const jobId = randomUUID()

      const job = await bulkNegotiationsQueue.add(
        "bulk-negotiations",
        {
          companyId: params.companyId,
          customerIds: params.customerIds,
          discountType: params.discountType,
          discountValue: params.discountValue,
          paymentMethods: params.paymentMethods,
          notificationChannels: params.notificationChannels,
          userId: user.id,
          attendantName: profile.full_name || "Super Admin",
          createdAt: new Date().toISOString(),
        },
        {
          jobId,
        }
      )

      console.log(`[sendBulkNegotiations] Created queue job ${job.id} for ${params.customerIds.length} negotiations`)

      return NextResponse.json({
        queued: true,
        job_id: job.id,
        total_customers: params.customerIds.length,
        message: `Processamento de ${params.customerIds.length} negociações iniciado em background. Use /status?job_id=${job.id} para acompanhar.`,
      })
    }

    // For small batches, process synchronously (original behavior)
    const supabase = createAdminClient()
    const allResults: NegotiationResult[] = []

    // Process in PARALLEL CHUNKS to avoid timeout
    // ASAAS has stricter rate limits, so use smaller chunks (5 at a time)
    const CHUNK_SIZE = 5
    const totalChunks = Math.ceil(params.customerIds.length / CHUNK_SIZE)

    console.log(`[sendBulkNegotiations] Processing ${params.customerIds.length} negotiations in ${totalChunks} chunks of ${CHUNK_SIZE}`)

    for (let i = 0; i < params.customerIds.length; i += CHUNK_SIZE) {
      const chunk = params.customerIds.slice(i, i + CHUNK_SIZE)
      const chunkNumber = Math.floor(i / CHUNK_SIZE) + 1

      console.log(`[sendBulkNegotiations] Processing chunk ${chunkNumber}/${totalChunks} (${chunk.length} negotiations)`)

      // Process chunk in PARALLEL
      const chunkResults = await Promise.allSettled(
        chunk.map((vmaxId) =>
          processSingleNegotiation(
            vmaxId,
            params,
            user.id,
            profile.full_name || "Super Admin",
            supabase
          )
        )
      )

      // Collect results
      for (let j = 0; j < chunkResults.length; j++) {
        const result = chunkResults[j]
        if (result.status === "fulfilled") {
          allResults.push(result.value)
        } else {
          // Promise rejected (shouldn't happen with our try/catch, but handle it)
          allResults.push({
            vmaxId: chunk[j],
            customerName: "Erro",
            cpfCnpj: "",
            status: "failed",
            error: result.reason?.message || "Erro inesperado",
          })
        }
      }

      const successCount = allResults.filter((r) => r.status === "success").length
      const failedCount = allResults.filter((r) => r.status === "failed").length
      console.log(`[sendBulkNegotiations] Chunk ${chunkNumber} done. Total so far: ${successCount} success, ${failedCount} failed`)
    }

    const sentCount = allResults.filter((r) => r.status === "success").length
    const failedCount = allResults.filter((r) => r.status === "failed").length
    const errors = allResults.filter((r) => r.status === "failed").map((r) => `${r.customerName}: ${r.error}`)

    console.log(`[sendBulkNegotiations] FINAL: ${sentCount} sent, ${failedCount} failed out of ${params.customerIds.length}`)

    revalidatePath("/super-admin/negotiations")
    revalidatePath("/super-admin/companies")

    // Group errors by type for summary
    const errorSummary: Record<string, number> = {}
    for (const result of allResults) {
      if (result.status === "failed" && result.error) {
        const errorMessage = result.error.message || "Erro desconhecido"
        const errorType = errorMessage.split(":")[0] || errorMessage
        errorSummary[errorType] = (errorSummary[errorType] || 0) + 1
      }
    }

    return NextResponse.json({
      queued: false,
      success: sentCount > 0,
      sent: sentCount,
      failed: failedCount,
      total: params.customerIds.length,
      results: allResults,
      errors: errors.length > 0 ? errors : undefined,
      errorSummary: Object.keys(errorSummary).length > 0 ? errorSummary : undefined,
      stepLabels: STEP_LABELS, // Include labels for client display
    })
  } catch (error: any) {
    console.error("Error in sendBulkNegotiations API:", error)
    return NextResponse.json(
      {
        success: false,
        error: error.message || "Erro desconhecido",
        sent: 0,
        results: [],
      },
      { status: 500 }
    )
  }
}
