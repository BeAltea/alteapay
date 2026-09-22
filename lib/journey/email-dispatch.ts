// Convite de negociação por E-MAIL para o hub do link único.
//
// Quando o devedor não tem celular válido mas tem e-mail válido, o MESMO link
// /n/{code} (link opaco do cedente, tenant_chat_config.public_link_code) vai por
// e-mail em vez de WhatsApp. NÃO é o e-mail de cobrança antigo (charge_email):
// este convite leva ao chat de negociação, sem criar cobrança nem boleto.
//
// O envio real passa pela fila SendGrid (lib/notifications/email.sendEmail). Em
// dryRun/mock o corpo é montado mas nada é enfileirado. Nunca loga PII.
//
// Descadastro / direito de oposição (LGPD art. 18): o rodapé do convite traz um
// link visível de opt-out (o PRÓPRIO /n/{code}, onde, pós-login, o titular se
// opõe a novos contatos — não há rota de opt-out dedicada, então reusamos o
// link do hub). Além do link visível, enviamos o header `List-Unsubscribe`
// (+ `List-Unsubscribe-Post: List-Unsubscribe=One-Click`), que melhora a
// reputação do sender e atende o direito de oposição para clientes que o honram.
//
// O encanamento de headers custom já existe de ponta a ponta: `sendEmail`
// (lib/notifications/email) aceita `headers?` → enfileira no job → o worker
// SendGrid (lib/queue/workers/email.worker) inclui `headers` no `requestBody` do
// `mail/send`. Passamos os headers de descadastro abaixo.

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
                <p style="margin:0 0 8px;color:#9ca3af;font-size:12px;">Enviado por ${input.brandName}</p>
                <p style="margin:0;color:#9ca3af;font-size:12px;line-height:1.5;">
                  Não quer mais receber estas mensagens? <a href="${input.link}" style="color:#6b7280;text-decoration:underline;">Clique aqui</a> e, após entrar, informe que deseja parar de receber contatos.
                </p>
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

  // Header List-Unsubscribe (RFC 2369) + List-Unsubscribe-Post One-Click (RFC
  // 8058). O alvo de opt-out é o próprio link do hub (/n/{code}); não há rota
  // dedicada. Repassados a sendEmail → fila → worker → SendGrid (mail/send).
  const unsubHeaders: Record<string, string> = {
    "List-Unsubscribe": `<${input.link}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  }

  const res = await sendEmail({
    to,
    subject: `Negociação disponível - ${input.creditorName}`,
    html,
    headers: unsubHeaders,
    metadata: {
      companyId: input.companyId,
      customerId: input.customerId,
      type: "negotiation_invite",
    },
  })
  if (!res.success) return { ok: false, error: res.error ?? "email_send_failed" }
  return { ok: true, jobId: res.jobId }
}

// ---------------------------------------------------------------------------
// F4: envio de um convite JÁ RENDERIZADO a partir do template padrão do cedente
// (resolve-default.renderTemplate). Diferente de dispatchEmailInvite (que monta
// o corpo fixo embutido), aqui o subject/html/text vêm prontos e sanitizados —
// esta função só valida o destinatário e enfileira via SendGrid, mantendo o
// mesmo header de descadastro (List-Unsubscribe → o próprio link do hub). NUNCA
// recebe/loga PII: o corpo já foi renderizado só com a allowlist de variáveis.
// ---------------------------------------------------------------------------

export interface RenderedEmailInput {
  to: string
  subject: string
  html: string
  text?: string
  /** link do hub (/n/{code}) para o header List-Unsubscribe. */
  link: string
  companyId: string
  customerId: string
  dryRun?: boolean
}

/** Dispara um e-mail de negociação já renderizado (template do cedente/global). */
export async function dispatchRenderedEmail(input: RenderedEmailInput): Promise<EmailInviteResult> {
  const to = (input.to ?? "").trim()
  if (!EMAIL_RE.test(to)) return { ok: false, error: "email_invalido" }
  if (!input.subject.trim() || !input.html.trim()) return { ok: false, error: "template_vazio" }

  if (input.dryRun) return { ok: true, previewed: true }

  const unsubHeaders: Record<string, string> = {
    "List-Unsubscribe": `<${input.link}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  }

  const res = await sendEmail({
    to,
    subject: input.subject,
    html: input.html,
    ...(input.text && input.text.trim() ? { text: input.text } : {}),
    headers: unsubHeaders,
    metadata: {
      companyId: input.companyId,
      customerId: input.customerId,
      type: "negotiation_invite",
    },
  })
  if (!res.success) return { ok: false, error: res.error ?? "email_send_failed" }
  return { ok: true, jobId: res.jobId }
}
