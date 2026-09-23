"use server"

import { isMockMode, mockHex } from "@/lib/integrations/mock-mode"

interface SendGridEmailParams {
  to: string | string[]
  subject: string
  html: string
  text?: string
  replyTo?: string
  /** Headers SMTP custom (ex.: List-Unsubscribe / List-Unsubscribe-Post). */
  headers?: Record<string, string>
}

interface SendGridResponse {
  success: boolean
  messageId?: string
  error?: string
}

interface IndividualSendResult {
  email: string
  success: boolean
  error?: string
}

interface BulkSendResponse {
  success: boolean
  totalSent: number
  totalFailed: number
  results: IndividualSendResult[]
  error?: string
}

function getConfig() {
  return {
    apiKey: process.env.SENDGRID_API_KEY,
    fromEmail: process.env.SENDGRID_FROM_EMAIL || process.env.SENDGRID_SENDER_EMAIL || "noreply@alteapay.com",
    fromName: process.env.SENDGRID_FROM_NAME || process.env.SENDGRID_SENDER_NAME || "AlteaPay",
    replyTo: process.env.SENDGRID_REPLY_TO,
  }
}

export async function validateSendGridConfig(): Promise<{ valid: boolean; error?: string }> {
  const config = getConfig()

  if (!config.apiKey) {
    return { valid: false, error: "SENDGRID_API_KEY não configurada" }
  }

  if (!config.fromEmail) {
    return { valid: false, error: "SENDGRID_FROM_EMAIL não configurado" }
  }

  return { valid: true }
}

export async function sendEmailViaSendGrid({
  to,
  subject,
  html,
  text,
  replyTo,
  headers,
}: SendGridEmailParams): Promise<SendGridResponse> {
  try {
    console.log("=".repeat(50))
    console.log("[SendGrid] Starting email send")
    console.log("[SendGrid] To:", Array.isArray(to) ? to.length + " recipients" : to)
    console.log("[SendGrid] Subject:", subject)

    if (isMockMode("sendgrid")) {
      const mockRecipients = Array.isArray(to) ? to : [to]
      const messageId = `mock-sg-${mockHex(`${mockRecipients.join(",")}:${subject}`)}`
      console.log("[mock:sendgrid] send", `recipients=${mockRecipients.length} messageId=${messageId}`)
      return { success: true, messageId }
    }

    const config = getConfig()

    if (!config.apiKey) {
      console.error("[SendGrid] ERROR: SENDGRID_API_KEY not configured")
      return { success: false, error: "SENDGRID_API_KEY não configurada" }
    }

    const recipients = Array.isArray(to) ? to : [to]

    // Validate emails
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    const invalidEmails = recipients.filter((email) => !emailRegex.test(email))
    if (invalidEmails.length > 0) {
      console.error("[SendGrid] ERROR: Invalid email formats:", invalidEmails)
      return { success: false, error: `Emails inválidos: ${invalidEmails.join(", ")}` }
    }

    console.log("[SendGrid] Calling SendGrid API...")

    // Prepare personalizations for bulk sending
    const personalizations = recipients.map((email) => ({
      to: [{ email }],
    }))

    // Build the request body
    const requestBody: Record<string, unknown> = {
      personalizations,
      from: {
        email: config.fromEmail,
        name: config.fromName,
      },
      subject,
      content: [
        ...(text ? [{ type: "text/plain", value: text }] : []),
        { type: "text/html", value: html },
      ],
      // Click/open tracking DESLIGADO: o domínio de rastreio da conta
      // (url6522.alteapay.com) não resolve no DNS e reescreve TODO link para um
      // redirecionador morto — quebrava o botão "Negociar agora". Sem tracking, o
      // link real (https://alteapay.com/n/...) vai intacto. Reativar só depois de
      // configurar o link branding/CNAME no SendGrid.
      tracking_settings: {
        click_tracking: { enable: false, enable_text: false },
        open_tracking: { enable: false },
      },
    }

    // Add reply_to if configured
    const effectiveReplyTo = replyTo || config.replyTo
    if (effectiveReplyTo) {
      requestBody.reply_to = { email: effectiveReplyTo }
    }

    // Headers SMTP custom (List-Unsubscribe etc.) — paridade com o worker da fila.
    if (headers && Object.keys(headers).length > 0) {
      requestBody.headers = headers
    }

    const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      console.error("[SendGrid] ERROR from API:", response.status, errorData)
      console.error("=".repeat(50))

      const errorMessage = errorData.errors?.[0]?.message || `Erro HTTP ${response.status}`
      return { success: false, error: errorMessage }
    }

    // SendGrid returns 202 Accepted for successful sends
    const messageId = response.headers.get("x-message-id") || `sg-${Date.now()}`

    console.log("[SendGrid Response] Message ID:", messageId)
    console.log("[SendGrid] Email(s) sent successfully!")
    console.log("=".repeat(50))

    return {
      success: true,
      messageId,
    }
  } catch (error: unknown) {
    console.error("=".repeat(50))
    console.error("[SendGrid] EXCEPTION occurred")
    console.error("[SendGrid] Error message:", error instanceof Error ? error.message : String(error))
    console.error("=".repeat(50))
    return { success: false, error: error instanceof Error ? error.message : "Falha ao enviar email" }
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
}

export async function sendBulkEmailViaSendGrid({
  recipients,
  subject,
  html,
}: {
  recipients: string[]
  subject: string
  html: string
}): Promise<SendGridResponse> {
  console.log("[SendGrid] Sending bulk email to", recipients.length, "recipients")

  // SendGrid allows up to 1000 recipients per request
  // For larger lists, we need to batch
  const batchSize = 1000
  const batches: string[][] = []

  for (let i = 0; i < recipients.length; i += batchSize) {
    batches.push(recipients.slice(i, i + batchSize))
  }

  console.log("[SendGrid] Split into", batches.length, "batches")

  let totalSent = 0
  const errors: string[] = []

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]
    console.log(`[SendGrid] Sending batch ${i + 1}/${batches.length} (${batch.length} recipients)`)

    const result = await sendEmailViaSendGrid({
      to: batch,
      subject,
      html,
      text: stripHtml(html),
    })

    if (result.success) {
      totalSent += batch.length
    } else {
      errors.push(`Batch ${i + 1}: ${result.error}`)
    }
  }

  if (errors.length > 0) {
    return {
      success: false,
      error: `Enviados: ${totalSent}/${recipients.length}. Erros: ${errors.join("; ")}`,
    }
  }

  return {
    success: true,
    messageId: `bulk-${Date.now()}`,
  }
}

/**
 * Send emails individually with tracking for each recipient
 * This allows us to track which specific emails succeeded or failed
 */
export async function sendIndividualEmailsWithTracking({
  recipients,
  subject,
  html,
}: {
  recipients: { email: string; id: string }[]
  subject: string
  html: string
}): Promise<BulkSendResponse> {
  console.log("[SendGrid] Sending individual emails to", recipients.length, "recipients with tracking")

  if (isMockMode("sendgrid")) {
    console.log("[mock:sendgrid] sendIndividual", `recipients=${recipients.length}`)
    return {
      success: true,
      totalSent: recipients.length,
      totalFailed: 0,
      results: recipients.map((r) => ({ email: r.email, success: true })),
    }
  }

  const config = getConfig()

  if (!config.apiKey) {
    return {
      success: false,
      totalSent: 0,
      totalFailed: recipients.length,
      results: recipients.map(r => ({ email: r.email, success: false, error: "SENDGRID_API_KEY não configurada" })),
      error: "SENDGRID_API_KEY não configurada",
    }
  }

  const results: IndividualSendResult[] = []
  let totalSent = 0
  let totalFailed = 0
  const textContent = stripHtml(html)

  for (const recipient of recipients) {
    try {
      // Build the request body for individual email
      const requestBody: Record<string, unknown> = {
        personalizations: [{ to: [{ email: recipient.email }] }],
        from: {
          email: config.fromEmail,
          name: config.fromName,
        },
        subject,
        content: [
          { type: "text/plain", value: textContent },
          { type: "text/html", value: html },
        ],
      }

      // Add reply_to if configured
      if (config.replyTo) {
        requestBody.reply_to = { email: config.replyTo }
      }

      const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        const errorMessage = errorData.errors?.[0]?.message || `Erro HTTP ${response.status}`
        console.error(`[SendGrid] Failed to send to ${recipient.email}:`, errorMessage)
        results.push({ email: recipient.email, success: false, error: errorMessage })
        totalFailed++
      } else {
        console.log(`[SendGrid] Successfully sent to ${recipient.email}`)
        results.push({ email: recipient.email, success: true })
        totalSent++
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Erro desconhecido"
      console.error(`[SendGrid] Exception sending to ${recipient.email}:`, errorMessage)
      results.push({ email: recipient.email, success: false, error: errorMessage })
      totalFailed++
    }
  }

  console.log(`[SendGrid] Completed: ${totalSent} sent, ${totalFailed} failed`)

  return {
    success: totalFailed === 0,
    totalSent,
    totalFailed,
    results,
  }
}
