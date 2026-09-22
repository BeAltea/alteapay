// POST /api/super-admin/email-templates/test-send
// Envia um e-mail de TESTE do template (renderizado com dados fictícios,
// sanitizado). Assunto prefixado com "[TESTE]". SendGrid está em SANDBOX
// (mail_settings.sandbox_mode) → NÃO envia de verdade; valida o payload/render.
import { NextRequest, NextResponse } from "next/server"
import { validateTemplateInput } from "@/lib/email/templates/validate"
import { buildPreviewHtml } from "@/lib/email/templates/preview"
import { renderVariables, PREVIEW_SAMPLE } from "@/lib/email/templates/variables"
import { toPlainText } from "@/lib/email/templates/sanitize"
import type { TemplateInput } from "@/lib/email/templates/types"
import { requireSuperAdmin, noCacheHeaders } from "../_guard"

export const dynamic = "force-dynamic"
export const revalidate = 0

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function POST(request: NextRequest) {
  const guard = await requireSuperAdmin()
  if (!guard.ok) return guard.response

  let body: Partial<TemplateInput> & { testEmail?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400, headers: noCacheHeaders })
  }

  const testEmail = (body.testEmail ?? "").trim()
  if (!EMAIL_RE.test(testEmail)) {
    return NextResponse.json({ error: "E-mail de teste inválido" }, { status: 400, headers: noCacheHeaders })
  }

  const input: TemplateInput = {
    name: body.name || "teste",
    scope: body.scope === "company" ? "company" : "global",
    companyId: body.companyId ?? null,
    purpose: body.purpose === "negotiation" ? "negotiation" : "communication",
    allowDebtFields: body.allowDebtFields === true,
    subject: body.subject ?? "",
    preheader: body.preheader ?? "",
    html: body.html ?? "",
    textFallback: body.textFallback ?? "",
  }

  // Valida (allowlist + sanitização) — não envia teste de template inválido.
  const validation = validateTemplateInput(input)
  if (!validation.ok || !validation.sanitized) {
    return NextResponse.json({ error: "Template inválido", validation }, { status: 422, headers: noCacheHeaders })
  }

  const subject = `[TESTE] ${renderVariables(validation.sanitized.subject, PREVIEW_SAMPLE)}`
  const html = buildPreviewHtml({
    subject: validation.sanitized.subject,
    preheader: validation.sanitized.preheader,
    html: validation.sanitized.html,
  })
  const text = toPlainText(html)

  const apiKey = process.env.SENDGRID_API_KEY
  const fromEmail = process.env.SENDGRID_FROM_EMAIL || process.env.SENDGRID_SENDER_EMAIL || "noreply@alteapay.com"
  const fromName = process.env.SENDGRID_FROM_NAME || process.env.SENDGRID_SENDER_NAME || "AlteaPay"

  if (!apiKey) {
    return NextResponse.json(
      { error: "SENDGRID_API_KEY não configurada" },
      { status: 500, headers: noCacheHeaders },
    )
  }

  // sandbox_mode: o SendGrid valida o payload mas NÃO entrega. Segurança extra
  // além de o ambiente já estar em sandbox.
  const requestBody = {
    personalizations: [{ to: [{ email: testEmail }] }],
    from: { email: fromEmail, name: fromName },
    subject,
    content: [
      { type: "text/plain", value: text },
      { type: "text/html", value: html },
    ],
    mail_settings: { sandbox_mode: { enable: true } },
  }

  try {
    const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    })
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      const message = errorData.errors?.[0]?.message || `Erro HTTP ${response.status}`
      return NextResponse.json({ error: message }, { status: 502, headers: noCacheHeaders })
    }
    return NextResponse.json(
      { ok: true, sandbox: true, message: "Teste validado (SendGrid sandbox — nenhum e-mail entregue)." },
      { headers: noCacheHeaders },
    )
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Falha ao enviar teste" },
      { status: 500, headers: noCacheHeaders },
    )
  }
}
