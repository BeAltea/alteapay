// Convite de negociação por E-MAIL para o hub do link único.
//
// Quando o devedor não tem celular válido mas tem e-mail válido, o MESMO link
// /n/{code} (link opaco do cedente, tenant_chat_config.public_link_code) vai por
// e-mail em vez de WhatsApp. NÃO é o e-mail de cobrança antigo (charge_email):
// este convite leva ao chat de negociação, sem criar cobrança nem boleto.
//
// O envio real passa pela fila SendGrid (lib/notifications/email.sendEmail). Em
// dryRun/mock o corpo é montado mas nada é enfileirado. Nunca loga PII.

import { sendEmail } from "@/lib/notifications/email"

export interface EmailInviteInput {
  to: string
  customerName: string
  brandName: string
  creditorName: string
  /** Link único do cedente já montado (ex.: https://app/n/{code}). */
  link: string
  companyId: string
  customerId: string
  /** dryRun: monta o corpo, valida o e-mail, mas NÃO enfileira. */
  dryRun?: boolean
}

export interface EmailInviteResult {
  ok: boolean
  jobId?: string
  error?: string
  /** true quando validado/pronto mas não enviado (dryRun). */
  previewed?: boolean
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Monta o HTML do convite de negociação (link do chat, sem valores de cobrança).
 * O corpo é neutro de dívida: só apresenta o cedente e o botão para negociar.
 */
export function buildEmailInviteHtml(input: {
  customerName: string
  brandName: string
  creditorName: string
  link: string
}): string {
  const firstName = (input.customerName ?? "").trim().split(/\s+/)[0] || "Olá"
  return `<!DOCTYPE html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Negociação disponível - ${input.creditorName}</title>
  </head>
  <body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;background-color:#f5f5f5;">
    <table role="presentation" style="width:100%;border-collapse:collapse;">
      <tr>
        <td style="padding:20px 0;">
          <table role="presentation" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:8px;box-shadow:0 2px 4px rgba(0,0,0,0.1);">
            <tr>
              <td style="padding:30px 30px 20px;text-align:center;background:linear-gradient(135deg,#1a1a2e 0%,#2d2d4a 100%);border-radius:8px 8px 0 0;">
                <h1 style="margin:0;color:#fff;font-size:24px;font-weight:600;">${input.creditorName}</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:40px 30px;">
                <p style="margin:0 0 20px;color:#1f2937;font-size:16px;line-height:1.6;">${firstName},</p>
                <p style="margin:0 0 20px;color:#4b5563;font-size:16px;line-height:1.6;">
                  Preparamos condições especiais para você regularizar sua situação com a ${input.creditorName}.
                  É rápido, seguro e você negocia direto pelo link abaixo.
                </p>
                <table role="presentation" style="width:100%;margin:30px 0;">
                  <tr>
                    <td align="center">
                      <a href="${input.link}" style="display:inline-block;padding:14px 32px;background:#2d2d4a;color:#fff;text-decoration:none;border-radius:8px;font-size:16px;font-weight:600;">Negociar agora</a>
                    </td>
                  </tr>
                </table>
                <p style="margin:0;color:#9ca3af;font-size:13px;line-height:1.6;">
                  Se o botão não funcionar, copie e cole no navegador: ${input.link}
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 30px;border-top:1px solid #e5e7eb;text-align:center;">
                <p style="margin:0;color:#9ca3af;font-size:12px;">Enviado por ${input.brandName}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`
}

/**
 * Dispara o convite de negociação por e-mail (o MESMO link do chat). Enfileira
 * via SendGrid (lib/notifications/email). Em dryRun não enfileira. NÃO cria
 * cobrança nem e-mail de cobrança.
 */
export async function dispatchEmailInvite(input: EmailInviteInput): Promise<EmailInviteResult> {
  const to = (input.to ?? "").trim()
  if (!EMAIL_RE.test(to)) return { ok: false, error: "email_invalido" }

  const html = buildEmailInviteHtml({
    customerName: input.customerName,
    brandName: input.brandName,
    creditorName: input.creditorName,
    link: input.link,
  })

  if (input.dryRun) return { ok: true, previewed: true }

  const res = await sendEmail({
    to,
    subject: `Negociação disponível - ${input.creditorName}`,
    html,
    metadata: {
      companyId: input.companyId,
      customerId: input.customerId,
      type: "negotiation_invite",
    },
  })
  if (!res.success) return { ok: false, error: res.error ?? "email_send_failed" }
  return { ok: true, jobId: res.jobId }
}
