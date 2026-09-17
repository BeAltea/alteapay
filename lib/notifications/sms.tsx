"use server"

import { isMockMode, mockHex } from "@/lib/integrations/mock-mode"

interface SendSMSParams {
  to: string
  body: string
}

async function getTwilioClient() {
  const twilio = (await import("twilio")).default
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
}

export async function sendSMS({ to, body }: SendSMSParams) {
  try {
    console.log("=".repeat(50))
    console.log("[Twilio] Starting SMS send")
    console.log("[Twilio] Original phone:", to)
    console.log("[Twilio] Body preview:", body.substring(0, 100))

    if (!to.startsWith("+")) {
      console.error("[Twilio] ERROR: Phone must start with +")
      return { success: false, error: "Telefone deve estar no formato internacional (+55...)" }
    }

    const phoneDigits = to.replace(/\D/g, "")
    if (phoneDigits.length < 12) {
      console.error("[Twilio] ERROR: Phone too short:", phoneDigits.length)
      return { success: false, error: `Telefone inválido: ${phoneDigits.length} dígitos (mínimo 12 dígitos)` }
    }

    if (isMockMode("twilio")) {
      const messageId = `SMmock${mockHex(`sms:${to}:${body}`, 28)}`
      console.log("[mock:twilio] sendSMS", `to=***${phoneDigits.slice(-4)} messageId=${messageId}`)
      return {
        success: true,
        messageId,
        message: `SMS enviado com sucesso (SID: ${messageId})`,
      }
    }

    console.log("[Twilio] Phone validation passed")
    console.log("[Twilio] Phone digits:", phoneDigits.length)
    console.log("[Twilio] Formatted phone:", to)

    const accountSid = process.env.TWILIO_ACCOUNT_SID
    const authToken = process.env.TWILIO_AUTH_TOKEN
    const fromPhone = process.env.TWILIO_PHONE_NUMBER

    if (!accountSid || !authToken || !fromPhone) {
      console.error("[Twilio] ERROR: Missing credentials")
      return { success: false, error: "Credenciais do Twilio não configuradas" }
    }

    console.log("[Twilio] Calling Twilio REST API...")
    console.log("[Twilio] From:", fromPhone)
    console.log("[Twilio] To:", to)

    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64")

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        From: fromPhone,
        To: to,
        Body: body,
      }),
    })

    const data = await response.json()

    if (!response.ok) {
      console.error("[Twilio] API Error:", data)
      return {
        success: false,
        error: data.message || `Erro Twilio: ${response.status}`,
      }
    }

    console.log("[Twilio Response] SID:", data.sid)
    console.log("[Twilio Response] Status:", data.status)
    console.log("[Twilio Response] To:", data.to)
    console.log("[Twilio Response] From:", data.from)
    console.log("[Twilio] SMS sent successfully!")
    console.log("=".repeat(50))

    return {
      success: true,
      messageId: data.sid,
      message: `SMS enviado com sucesso (SID: ${data.sid})`,
    }
  } catch (error: any) {
    console.error("=".repeat(50))
    console.error("[Twilio] ERROR occurred")
    console.error("[Twilio] Error message:", error.message)
    console.error("[Twilio] Error stack:", error.stack)
    console.error("=".repeat(50))
    return { success: false, error: error.message || "Falha ao enviar SMS" }
  }
}

export async function generateDebtCollectionSMS({
  customerName,
  debtAmount,
  companyName,
  paymentLink,
}: {
  customerName: string
  debtAmount: number
  companyName: string
  paymentLink: string
}): Promise<string> {
  const formattedAmount = debtAmount.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  })

  return `${companyName} - Cobrança Pendente

Olá ${customerName},

Identificamos uma pendência de ${formattedAmount} em seu nome.

Para regularizar sua situação, acesse:
${paymentLink}

Dúvidas? Entre em contato conosco.

Atenciosamente,
${companyName}`
}

export async function sendWhatsApp(to: string, body: string) {
  // Jornada (aditivo): telefone suprimido nunca recebe WhatsApp por NENHUM
  // caminho da plataforma. Falha na checagem não bloqueia o envio legado
  // (try/catch), mas supressão encontrada bloqueia sempre.
  try {
    const { isSuppressed } = await import("@/lib/journey/suppressions")
    const digits = to.replace(/\D/g, "")
    const e164 = digits.startsWith("55") ? `+${digits}` : `+55${digits}`
    const { createServiceClient } = await import("@/lib/supabase/service")
    const supa = createServiceClient()
    const { data: sup } = await supa
      .from("contact_suppressions")
      .select("id, company_id, channel, expires_at")
      .eq("active", true)
      .eq("phone_e164", e164)
      .in("channel", ["whatsapp", "all"])
      .limit(1)
    if (sup && sup.length > 0 && (!sup[0].expires_at || new Date(sup[0].expires_at) > new Date())) {
      console.log(`[WHATSAPP] envio suprimido para ***${digits.slice(-4)} (contact_suppressions)`)
      return { success: false, suppressed: true, error: "suppressed" }
    }
    void isSuppressed // referência estável p/ tree-shaking não remover o módulo
  } catch (gateErr) {
    console.warn("[WHATSAPP] checagem de supressão falhou (segue envio legado):", (gateErr as Error).message)
  }

  try {
    console.log("=".repeat(50))
    console.log("[Twilio WhatsApp] Starting WhatsApp send")
    console.log("[Twilio WhatsApp] Original phone:", to)
    console.log("[Twilio WhatsApp] Body preview:", body.substring(0, 100))

    if (!to.startsWith("+")) {
      console.error("[Twilio WhatsApp] ERROR: Phone must start with +")
      return { success: false, error: "Telefone deve estar no formato internacional (+55...)" }
    }

    const phoneDigits = to.replace(/\D/g, "")
    if (phoneDigits.length < 12) {
      console.error("[Twilio WhatsApp] ERROR: Phone too short:", phoneDigits.length)
      return { success: false, error: `Telefone inválido: ${phoneDigits.length} dígitos (mínimo 12 dígitos)` }
    }

    if (isMockMode("twilio")) {
      const messageId = `SMmock${mockHex(`whatsapp:${to}:${body}`, 28)}`
      console.log("[mock:twilio] sendWhatsApp", `to=***${phoneDigits.slice(-4)} messageId=${messageId}`)
      return {
        success: true,
        messageId,
        message: `WhatsApp enviado com sucesso (SID: ${messageId})`,
      }
    }

    console.log("[Twilio WhatsApp] Phone validation passed")
    console.log("[Twilio WhatsApp] Phone digits:", phoneDigits.length)
    console.log("[Twilio WhatsApp] Formatted phone:", to)

    const accountSid = process.env.TWILIO_ACCOUNT_SID
    const authToken = process.env.TWILIO_AUTH_TOKEN
    const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID

    if (!accountSid || !authToken) {
      console.error("[Twilio WhatsApp] ERROR: Missing credentials")
      return { success: false, error: "Credenciais do Twilio não configuradas" }
    }

    console.log("[Twilio WhatsApp] Calling Twilio REST API...")
    console.log("[Twilio WhatsApp] To:", `whatsapp:${to}`)

    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64")

    const formData = new URLSearchParams({
      To: `whatsapp:${to}`,
      Body: body,
    })

    // Se tem Messaging Service SID, usa ele (recomendado para WhatsApp)
    if (messagingServiceSid) {
      formData.append("MessagingServiceSid", messagingServiceSid)
    } else {
      // Fallback para número direto
      const fromPhone = process.env.TWILIO_PHONE_NUMBER
      if (fromPhone) {
        formData.append("From", `whatsapp:${fromPhone}`)
      }
    }

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formData,
    })

    const data = await response.json()

    if (!response.ok) {
      console.error("[Twilio WhatsApp] API Error:", data)
      return {
        success: false,
        error: data.message || `Erro Twilio: ${response.status}`,
      }
    }

    console.log("[Twilio WhatsApp Response] SID:", data.sid)
    console.log("[Twilio WhatsApp Response] Status:", data.status)
    console.log("[Twilio WhatsApp Response] To:", data.to)
    console.log("[Twilio WhatsApp Response] From:", data.from)
    console.log("[Twilio WhatsApp] Message sent successfully!")
    console.log("=".repeat(50))

    return {
      success: true,
      messageId: data.sid,
      message: `WhatsApp enviado com sucesso (SID: ${data.sid})`,
    }
  } catch (error: any) {
    console.error("=".repeat(50))
    console.error("[Twilio WhatsApp] ERROR occurred")
    console.error("[Twilio WhatsApp] Error message:", error.message)
    console.error("[Twilio WhatsApp] Error stack:", error.stack)
    console.error("=".repeat(50))
    return { success: false, error: error.message || "Falha ao enviar WhatsApp" }
  }
}
