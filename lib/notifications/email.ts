"use server"

import { emailQueue } from "@/lib/queue"
import { sendEmailViaSendGrid } from "@/lib/notifications/sendgrid"

/**
 * Fallback SEM Redis: quando EMAIL_SEND_MODE=inline (ou REDIS_DISABLED=1), o e-mail
 * é enviado DIRETO via SendGrid, sem tocar a fila/Upstash nem depender dos workers
 * Fargate. Essencial para lotes pequenos com a infra de fila desligada.
 */
function isEmailInline(): boolean {
  return process.env.EMAIL_SEND_MODE === "inline" || process.env.REDIS_DISABLED === "1"
}

interface SendEmailParams {
  to: string | string[]
  subject: string
  html?: string
  body?: string
  text?: string
  replyTo?: string
  /**
   * Headers SMTP customizados repassados ao SendGrid (mail/send) pelo worker.
   * Ex.: List-Unsubscribe / List-Unsubscribe-Post (RFC 2369/8058). Opcional —
   * chamadas existentes seguem funcionando sem passar nada.
   */
  headers?: Record<string, string>
  metadata?: {
    chargeId?: string
    customerId?: string
    companyId?: string
    type?: string
  }
}

interface SendEmailResult {
  success: boolean
  messageId?: string
  jobId?: string
  error?: string
  message?: string
}

/**
 * Queue an email to be sent via SendGrid (processed by Fargate workers)
 * This function returns immediately after queueing - actual sending happens async
 */
export async function sendEmail({
  to,
  subject,
  html,
  body,
  text,
  replyTo,
  headers,
  metadata,
}: SendEmailParams): Promise<SendEmailResult> {
  try {
    const recipients = Array.isArray(to) ? to : [to]

    // Validate emails
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    const invalidEmails = recipients.filter((email) => !emailRegex.test(email))

    if (invalidEmails.length > 0) {
      console.error("[EMAIL QUEUE] Invalid email formats:", invalidEmails)
      return { success: false, error: `Emails inválidos: ${invalidEmails.join(", ")}` }
    }

    const htmlContent = html || body || ""
    const textContent = text || stripHtml(htmlContent)

    // Fallback inline (sem Redis/workers): envia direto via SendGrid.
    if (isEmailInline()) {
      const r = await sendEmailViaSendGrid({
        to: recipients,
        subject,
        html: htmlContent,
        text: textContent,
        replyTo,
        ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
      })
      if (r.success) {
        return { success: true, messageId: r.messageId, message: "Email enviado (inline via SendGrid)" }
      }
      return { success: false, error: r.error || "Falha ao enviar email (inline)" }
    }

    console.log(`[EMAIL QUEUE] Queueing email to ${recipients.length} recipient(s): ${subject}`)

    // Add job to queue
    const job = await emailQueue.add(
      `email-${Date.now()}`,
      {
        to: recipients,
        subject,
        html: htmlContent,
        text: textContent,
        replyTo,
        ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
        metadata: {
          ...metadata,
          queuedAt: new Date().toISOString(),
        },
      },
      { priority: metadata?.type === "urgent" ? 1 : 2 }
    )

    console.log(`[EMAIL QUEUE] Job ${job.id} queued successfully`)

    return {
      success: true,
      jobId: job.id,
      message: `Email queued successfully (Job ID: ${job.id})`,
    }
  } catch (error: any) {
    console.error("[EMAIL QUEUE] Failed to queue email:", error.message)
    return { success: false, error: error.message || "Falha ao enfileirar email" }
  }
}

/**
 * Queue multiple emails in bulk (much faster for large batches)
 */
export async function sendBulkEmails(
  emails: Array<{
    to: string
    subject: string
    html: string
    metadata?: Record<string, any>
  }>
): Promise<{ success: boolean; queued: number; failed: number; error?: string }> {
  try {
    // Fallback inline (sem Redis/workers): envia cada e-mail direto via SendGrid,
    // sequencialmente. Adequado a lotes pequenos (teste, piloto de 25).
    if (isEmailInline()) {
      let queued = 0
      let failed = 0
      for (const email of emails) {
        const r = await sendEmailViaSendGrid({
          to: email.to,
          subject: email.subject,
          html: email.html,
          text: stripHtml(email.html),
        })
        if (r.success) queued++
        else failed++
      }
      return { success: failed === 0, queued, failed }
    }

    console.log(`[EMAIL QUEUE] Bulk queueing ${emails.length} emails...`)

    const jobs = emails.map((email, index) => ({
      name: `bulk-email-${Date.now()}-${index}`,
      data: {
        to: email.to,
        subject: email.subject,
        html: email.html,
        text: stripHtml(email.html),
        metadata: {
          ...email.metadata,
          bulkIndex: index,
          queuedAt: new Date().toISOString(),
        },
      },
    }))

    await emailQueue.addBulk(jobs)

    console.log(`[EMAIL QUEUE] ${emails.length} emails queued successfully`)

    return { success: true, queued: emails.length, failed: 0 }
  } catch (error: any) {
    console.error("[EMAIL QUEUE] Bulk queue failed:", error.message)
    return { success: false, queued: 0, failed: emails.length, error: error.message }
  }
}

/**
 * Get queue statistics
 */
export async function getEmailQueueStats(): Promise<{
  waiting: number
  active: number
  completed: number
  failed: number
}> {
  try {
    const counts = await emailQueue.getJobCounts("waiting", "active", "completed", "failed")
    return counts
  } catch (error: any) {
    console.error("[EMAIL QUEUE] Failed to get stats:", error.message)
    return { waiting: 0, active: 0, completed: 0, failed: 0 }
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

/**
 * Generate debt collection email HTML
 */
export async function generateDebtCollectionEmail({
  customerName,
  debtAmount,
  dueDate,
  companyName,
  paymentLink,
}: {
  customerName: string
  debtAmount: number
  dueDate: string
  companyName: string
  paymentLink: string
}): Promise<string> {
  return `
    <!DOCTYPE html>
    <html lang="pt-BR">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Lembrete de Pagamento - ${companyName}</title>
      </head>
      <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
        <table role="presentation" style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="padding: 20px 0;">
              <table role="presentation" style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">

                <!-- Header -->
                <tr>
                  <td style="padding: 30px 30px 20px 30px; text-align: center; background: linear-gradient(135deg, #1a1a2e 0%, #2d2d4a 100%); border-radius: 8px 8px 0 0;">
                    <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600; letter-spacing: -0.5px;">
                      ${companyName}
                    </h1>
                  </td>
                </tr>

                <!-- Body -->
                <tr>
                  <td style="padding: 40px 30px;">
                    <p style="margin: 0 0 20px 0; color: #1f2937; font-size: 16px; line-height: 1.6;">
                      Olá ${customerName},
                    </p>

                    <p style="margin: 0 0 20px 0; color: #4b5563; font-size: 16px; line-height: 1.6;">
                      Este é um lembrete sobre um pagamento pendente relacionado aos serviços da empresa ${companyName}.
                      Estamos entrando em contato para facilitar a regularização da sua situação financeira.
                    </p>

                    <p style="margin: 0 0 20px 0; color: #4b5563; font-size: 16px; line-height: 1.6;">
                      Nosso objetivo é ajudá-lo a manter sua conta em dia e evitar qualquer transtorno.
                      Valorizamos muito seu relacionamento conosco.
                    </p>

                    <!-- Invoice Details Box -->
                    <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; margin: 25px 0;">
                      <tr>
                        <td style="padding: 25px;">
                          <p style="margin: 0 0 15px 0; color: #6b7280; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600;">
                            Detalhes do Pagamento
                          </p>
                          <table role="presentation" style="width: 100%;">
                            <tr>
                              <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb;">
                                <span style="color: #6b7280; font-size: 14px;">Valor a Pagar</span>
                              </td>
                              <td style="padding: 10px 0; text-align: right; border-bottom: 1px solid #e5e7eb;">
                                <span style="color: #1f2937; font-size: 20px; font-weight: 700;">R$ ${debtAmount.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                              </td>
                            </tr>
                            <tr>
                              <td style="padding: 10px 0;">
                                <span style="color: #6b7280; font-size: 14px;">Vencimento</span>
                              </td>
                              <td style="padding: 10px 0; text-align: right;">
                                <span style="color: #1f2937; font-size: 16px; font-weight: 600;">${dueDate}</span>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>

                    <p style="margin: 25px 0 20px 0; color: #4b5563; font-size: 16px; line-height: 1.6;">
                      Para facilitar o processo de pagamento, disponibilizamos uma área exclusiva onde você pode
                      visualizar todos os detalhes e escolher a forma de pagamento mais conveniente para você.
                    </p>

                    <p style="margin: 0 0 25px 0; color: #4b5563; font-size: 16px; line-height: 1.6;">
                      Acesse a área de pagamento clicando no botão abaixo:
                    </p>

                    <!-- CTA Button -->
                    <table role="presentation" style="width: 100%; margin: 30px 0;">
                      <tr>
                        <td style="text-align: center;">
                          <a href="${paymentLink}" style="display: inline-block; padding: 16px 48px; background: linear-gradient(135deg, #d4a843 0%, #b8922e 100%); color: #ffffff; text-decoration: none; border-radius: 8px; font-size: 16px; font-weight: 600; box-shadow: 0 4px 6px rgba(212, 168, 67, 0.3);">
                            Acessar Área de Pagamento
                          </a>
                        </td>
                      </tr>
                    </table>

                    <p style="margin: 30px 0 0 0; color: #6b7280; font-size: 14px; line-height: 1.6;">
                      Se você já realizou o pagamento, por favor desconsidere este email.
                      Caso tenha alguma dúvida ou necessite de assistência, nossa equipe está à disposição
                      para ajudá-lo através do email cobranca@alteapay.com
                    </p>

                    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 30px 0;">

                    <p style="margin: 0; color: #4b5563; font-size: 15px; line-height: 1.5;">
                      Atenciosamente,<br>
                      <strong style="color: #1f2937;">${companyName}</strong>
                    </p>
                  </td>
                </tr>

                <!-- Footer -->
                <tr>
                  <td style="padding: 25px 30px; background-color: #f9fafb; border-radius: 0 0 8px 8px; border-top: 1px solid #e5e7eb;">
                    <p style="margin: 0 0 10px 0; color: #9ca3af; font-size: 12px; text-align: center; line-height: 1.5;">
                      Este é um email transacional enviado automaticamente pelo sistema AlteaPay.<br>
                      Por favor, não responda diretamente a este email.
                    </p>
                    <p style="margin: 0; color: #9ca3af; font-size: 12px; text-align: center; line-height: 1.5;">
                      Para suporte: cobranca@alteapay.com
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
    </html>
  `
}
