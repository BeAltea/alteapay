"use server"

import { createClient } from "@/lib/supabase/server"
import { sendEmail, generateDebtCollectionEmail } from "@/lib/notifications/email"
import { sendSMS, generateDebtCollectionSMS } from "@/lib/notifications/sms"

export interface SendNotificationParams {
  debtId: string
  type: "email" | "sms" | "whatsapp"
}

export interface SendNotificationResult {
  success: boolean
  message: string
  error?: string
}

/**
 * Send collection notification to customer
 * Called from Admin Dashboard "Enviar Cobrança Manual" button
 */
export async function sendCollectionNotification({
  debtId,
  type,
}: SendNotificationParams): Promise<SendNotificationResult> {
  try {
    const supabase = await createClient()

    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return {
        success: false,
        message: "Usuário não autenticado",
      }
    }

    const { data: vmaxRecord, error: vmaxError } = await supabase.from("VMAX").select("*").eq("id", debtId).single()

    if (vmaxError || !vmaxRecord) {
      console.error("[v0] VMAX record not found:", vmaxError)
      return {
        success: false,
        message: "Registro de dívida não encontrado",
        error: vmaxError?.message,
      }
    }

    console.log("[v0] VMAX record found:", {
      id: vmaxRecord.id,
      cliente: vmaxRecord.Cliente,
      empresa: vmaxRecord.Empresa,
      vencido: vmaxRecord.Vencido,
      email: vmaxRecord.Email,
      telefone: vmaxRecord["Telefone 1"] || vmaxRecord["Telefone 2"],
    })

    const customerName = vmaxRecord.Cliente || "Cliente"
    const companyName = vmaxRecord.Empresa || "Empresa"
    const debtAmount = vmaxRecord.Vencido || "0"
    const customerEmail = vmaxRecord.Email
    const customerPhone = vmaxRecord["Telefone 1"] || vmaxRecord["Telefone 2"]

    if (type === "email") {
      if (!customerEmail) {
        return {
          success: false,
          message: `Cliente ${customerName} não possui e-mail cadastrado na VMAX. Adicione o e-mail primeiro.`,
        }
      }
    }

    if (type === "sms" || type === "whatsapp") {
      if (!customerPhone) {
        return {
          success: false,
          message: `Cliente ${customerName} não possui telefone cadastrado na VMAX. Adicione o telefone primeiro.`,
        }
      }
    }

    const parsedAmount =
      typeof debtAmount === "string"
        ? Number.parseFloat(debtAmount.replace(/[R$\s.]/g, "").replace(",", "."))
        : debtAmount

    let result: { success: boolean; messageId?: string; error?: string }
    let messageContent = ""

    if (type === "email") {
      const html = await generateDebtCollectionEmail({
        customerName,
        debtAmount: parsedAmount,
        dueDate: vmaxRecord.Vecto
          ? new Date(vmaxRecord.Vecto).toLocaleDateString("pt-BR")
          : "Vencida",
        companyName,
        paymentLink: `${(process.env.NEXT_PUBLIC_APP_URL || "https://alteapay.com").replace(/\/+$/, "")}/user-dashboard/debts/${debtId}`,
      })

      messageContent = `Email de cobrança enviado para ${customerEmail}`

      result = await sendEmail({
        to: customerEmail,
        subject: `Cobrança Pendente - ${companyName}`,
        html,
      })
    } else if (type === "sms" || type === "whatsapp") {
      const body = await generateDebtCollectionSMS({
        customerName,
        debtAmount: parsedAmount,
        companyName,
        paymentLink: `${(process.env.NEXT_PUBLIC_APP_URL || "https://alteapay.com").replace(/\/+$/, "")}/user-dashboard`,
      })

      messageContent = body

      result = await sendSMS({
        to: customerPhone,
        body,
      })
    } else {
      return {
        success: false,
        message: "Tipo de notificação inválido",
      }
    }

    if (result.success) {
      try {
        const { error: insertError } = await supabase.from("collection_actions").insert({
          company_id: vmaxRecord.id_company,
          customer_id: null, // VMAX doesn't have customer UUIDs, only names
          debt_id: debtId,
          action_type: type,
          status: "sent",
          message: messageContent,
          sent_by: user.id,
          metadata: {
            customer_name: customerName,
            contact: type === "email" ? customerEmail : customerPhone,
            amount: parsedAmount,
            message_id: result.messageId,
          },
        })

        if (insertError) {
          console.warn("[v0] Failed to log collection action:", insertError.message)
        } else {
          console.log("[v0] Collection action logged successfully")
        }
      } catch (insertError) {
        console.warn("[v0] Failed to log collection action (schema may need refresh):", insertError)
      }

      console.log("[v0] Notification sent successfully:", {
        type,
        customer: customerName,
        contact: type === "email" ? customerEmail : customerPhone,
        messageId: result.messageId,
      })
    }

    return {
      success: result.success,
      message: result.success
        ? `Cobrança enviada com sucesso via ${type.toUpperCase()} para ${customerName}`
        : `Erro ao enviar: ${result.error}`,
      error: result.error,
    }
  } catch (error) {
    console.error("[v0] Send notification error:", error)
    return {
      success: false,
      message: "Erro ao enviar notificação",
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}
