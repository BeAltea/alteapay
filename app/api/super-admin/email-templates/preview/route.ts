// POST /api/super-admin/email-templates/preview
// Recebe o conteúdo do editor (mesmo NÃO salvo) e devolve o HTML de PREVIEW já
// renderizado com DADOS FICTÍCIOS e SANITIZADO. O client injeta este HTML num
// `iframe sandbox` (sem allow-scripts). Também roda a validação de variáveis para
// avisar sobre bloqueios antes de salvar.
import { NextRequest, NextResponse } from "next/server"
import { buildPreviewHtml } from "@/lib/email/templates/preview"
import { validateVariables, validatePurposeRequirements } from "@/lib/email/templates/variables"
import type { TemplatePurpose } from "@/lib/email/templates/variables"
import { requireSuperAdmin, noCacheHeaders } from "../_guard"

export const dynamic = "force-dynamic"
export const revalidate = 0

export async function POST(request: NextRequest) {
  const guard = await requireSuperAdmin()
  if (!guard.ok) return guard.response

  let body: { subject?: string; preheader?: string; html?: string; textFallback?: string; purpose?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400, headers: noCacheHeaders })
  }

  const subject = body.subject ?? ""
  const preheader = body.preheader ?? ""
  const html = body.html ?? ""
  const textFallback = body.textFallback ?? ""
  const purpose: TemplatePurpose = body.purpose === "negotiation" ? "negotiation" : "communication"

  const varResult = validateVariables({ subject, preheader, html, textFallback })
  const purposeResult = validatePurposeRequirements(purpose, { subject, preheader, html, textFallback })
  const warnings = [...varResult.errors, ...purposeResult.errors]

  const previewHtml = buildPreviewHtml({ subject, preheader, html })

  return NextResponse.json(
    { previewHtml, variablesUsed: varResult.used, warnings, canSave: warnings.length === 0 },
    { headers: noCacheHeaders },
  )
}
