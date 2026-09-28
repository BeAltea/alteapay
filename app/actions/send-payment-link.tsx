"use server"

import { createAdminClient } from "@/lib/supabase/server"
import {
  getAsaasCustomerByCpfCnpj,
  createAsaasCustomer,
  updateAsaasCustomer,
  getAsaasCustomerNotifications,
  updateAsaasNotification,
  createAsaasPayment,
} from "@/lib/asaas"

export async function sendPaymentLink(
  agreementId: string,
  channel: "email" | "sms" | "whatsapp",
  contactInfo: {
    email?: string
    phone?: string
    customerName?: string
  }
) {
  try {
    const supabase = createAdminClient()

    const { data: agreement, error: agreementError } = await supabase
      .from("agreements")
      .select("*")
      .eq("id", agreementId)
      .single()

    if (agreementError || !agreement) {
      return { success: false, error: "Acordo nao encontrado" }
    }

    let asaasCustomerId = agreement.asaas_customer_id

    // If agreement doesn't have asaas_customer_id, create/find the customer now
    if (!asaasCustomerId) {
      // Get the customer document from DB
      const { data: customer } = await supabase
        .from("customers")
        .select("document, name, email, phone")
        .eq("id", agreement.customer_id)
        .single()

      if (!customer?.document) {
        return { success: false, error: "Cliente sem CPF/CNPJ cadastrado." }
      }

      const cpfCnpj = customer.document.replace(/[^\d]/g, "")

      try {
        // Try to find existing customer in Asaas
        const existingAsaas = await getAsaasCustomerByCpfCnpj(cpfCnpj)
        if (existingAsaas) {
          asaasCustomerId = existingAsaas.id
        } else {
          // Create new customer in Asaas with phone only (NO email)
          // IMPORTANT: Do NOT send email - AlteaPay handles email via SendGrid/Resend
          const newAsaas = await createAsaasCustomer({
            name: customer.name || contactInfo.customerName || "Cliente",
            cpfCnpj,
            // email: DO NOT SEND - AlteaPay handles email
            mobilePhone: customer.phone || contactInfo.phone?.replace(/[^\d]/g, "") || undefined,
            notificationDisabled: false,
          })
          asaasCustomerId = newAsaas.id
        }

        // Save asaas_customer_id to agreement so next time it works directly
        await supabase
          .from("agreements")
          .update({ asaas_customer_id: asaasCustomerId })
          .eq("id", agreementId)
      } catch (asaasErr: any) {
        console.error("[v0] Failed to create Asaas customer. Error:", asaasErr.message)
        return { success: false, error: `Erro ao criar cliente no Asaas: ${asaasErr.message}` }
      }
    }

    // 1. Update contact info - phone only (NO email to ASAAS)
    const updateData: { notificationDisabled: boolean; mobilePhone?: string } = { notificationDisabled: false }
    if (contactInfo.phone) {
      updateData.mobilePhone = contactInfo.phone.replace(/[^\d]/g, "")
    }
    await updateAsaasCustomer(asaasCustomerId, updateData)

    // 2. Configure notifications - WhatsApp only, email/SMS disabled (AlteaPay handles those)
    const allNotifications = await getAsaasCustomerNotifications(asaasCustomerId)

    for (const notif of allNotifications) {
      if (notif.event === "PAYMENT_CREATED") {
        await updateAsaasNotification(notif.id, {
          enabled: channel === "whatsapp", // Only enable if WhatsApp
          emailEnabledForCustomer: false, // NEVER - AlteaPay handles email
          smsEnabledForCustomer: false, // NEVER - AlteaPay handles SMS via Twilio
          whatsappEnabledForCustomer: channel === "whatsapp",
        })
      } else {
        await updateAsaasNotification(notif.id, {
          enabled: false,
          emailEnabledForCustomer: false,
          smsEnabledForCustomer: false,
          whatsappEnabledForCustomer: false,
        })
      }
    }

    // 3. Create payment
    const customerName = contactInfo.customerName || "Cliente"
    const installmentAmount = agreement.installment_amount || agreement.agreed_amount
    const installments = agreement.installments || 1

    // Determine billingType from agreement terms (may contain payment_methods selection)
    let billingType: "BOLETO" | "CREDIT_CARD" | "PIX" | "UNDEFINED" = "UNDEFINED"
    try {
      const termsData = typeof agreement.terms === "string" ? JSON.parse(agreement.terms) : agreement.terms
      if (termsData?.payment_methods && Array.isArray(termsData.payment_methods)) {
        const methodMapping: Record<string, "BOLETO" | "CREDIT_CARD" | "PIX"> = {
          boleto: "BOLETO",
          pix: "PIX",
          credit_card: "CREDIT_CARD",
        }
        if (termsData.payment_methods.length === 1 && methodMapping[termsData.payment_methods[0]]) {
          billingType = methodMapping[termsData.payment_methods[0]]
        }
      }
    } catch {
      // terms is not JSON, keep UNDEFINED
    }

    const paymentParams: any = {
      customer: asaasCustomerId,
      billingType,
      value: installments > 1 ? installmentAmount : agreement.agreed_amount,
      dueDate: agreement.due_date,
      // Parcelado: o ASAAS prefixa "Parcela N de M." em cada parcela; sem sufixo fixo "1/N".
      description: `Acordo de negociacao - ${customerName}`,
      externalReference: `agreement_${agreementId}`,
      postalService: false,
    }

    if (installments > 1) {
      paymentParams.installmentCount = installments
      paymentParams.installmentValue = installmentAmount
    }

    const asaasPayment = await createAsaasPayment(paymentParams)

    // 4. Update agreement
    // IMPORTANT: Also save the due_date from ASAAS response to ensure it's persisted
    // The dueDate sent to ASAAS (from agreement.due_date or paymentParams.dueDate)
    // may differ from what was stored, so save the actual ASAAS response value
    await supabase
      .from("agreements")
      .update({
        asaas_payment_id: asaasPayment.id,
        asaas_payment_url: asaasPayment.invoiceUrl || null,
        asaas_pix_qrcode_url: asaasPayment.pixQrCodeUrl || null,
        asaas_boleto_url: asaasPayment.bankSlipUrl || null,
        due_date: asaasPayment.dueDate || agreement.due_date || null,
        status: "active",
      })
      .eq("id", agreementId)

    // 5. Keep notifications enabled - ASAAS will send based on customer contact info

    // Send SMS directly via Twilio when SMS channel is selected (as additional notification)
    if (channel === "sms" && contactInfo.phone) {
      try {
        const { sendSMS, generateDebtCollectionSMS } = await import("@/lib/notifications/sms")

        let formattedPhone = contactInfo.phone.replace(/\D/g, "")
        if (formattedPhone.length >= 10 && !formattedPhone.startsWith("55")) {
          formattedPhone = "55" + formattedPhone
        }
        formattedPhone = "+" + formattedPhone

        // Get company name
        const { data: companyData } = await supabase
          .from("companies")
          .select("name")
          .eq("id", agreement.company_id)
          .single()

        const smsBody = await generateDebtCollectionSMS({
          customerName,
          debtAmount: agreement.agreed_amount,
          companyName: companyData?.name || "Empresa",
          paymentLink: asaasPayment.invoiceUrl || "",
        })

        const smsResult = await sendSMS({ to: formattedPhone, body: smsBody })
        if (!smsResult.success) {
          console.log(`[sendPaymentLink] SMS Twilio falhou: ${smsResult.error}`)
        } else {
          console.log(`[sendPaymentLink] SMS Twilio enviado com sucesso`)
        }
      } catch (smsErr: any) {
        console.error(`[sendPaymentLink] Erro ao enviar SMS Twilio:`, smsErr.message)
      }
    }

    const channelLabel = channel === "email" ? "e-mail" : channel === "whatsapp" ? "WhatsApp" : "SMS"

    return {
      success: true,
      data: {
        channel,
        paymentUrl: asaasPayment.invoiceUrl,
        message: `Cobranca criada e notificacao enviada via ${channelLabel}.`,
      },
    }
  } catch (error: any) {
    console.error("Error in sendPaymentLink:", error)
    return { success: false, error: error.message || "Erro ao enviar proposta" }
  }
}
