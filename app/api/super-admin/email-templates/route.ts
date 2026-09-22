// GET  /api/super-admin/email-templates            → lista (com versão corrente)
// POST /api/super-admin/email-templates            → cria template + versão 1
import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { listTemplates, createTemplate } from "@/lib/email/templates/repository"
import type { TemplateInput } from "@/lib/email/templates/types"
import { requireSuperAdmin, noCacheHeaders } from "./_guard"

export const dynamic = "force-dynamic"
export const revalidate = 0

export async function GET(request: NextRequest) {
  const guard = await requireSuperAdmin()
  if (!guard.ok) return guard.response

  const supabase = createServiceClient()
  const url = new URL(request.url)
  const companyIdParam = url.searchParams.get("companyId")
  const includeArchived = url.searchParams.get("includeArchived") === "true"

  const opts: { companyId?: string | null; includeArchived?: boolean } = { includeArchived }
  if (companyIdParam === "global") opts.companyId = null
  else if (companyIdParam) opts.companyId = companyIdParam

  try {
    const templates = await listTemplates(supabase, opts)
    return NextResponse.json({ templates }, { headers: noCacheHeaders })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Erro ao listar templates" },
      { status: 500, headers: noCacheHeaders },
    )
  }
}

export async function POST(request: NextRequest) {
  const guard = await requireSuperAdmin()
  if (!guard.ok) return guard.response

  let body: Partial<TemplateInput>
  try {
    body = (await request.json()) as Partial<TemplateInput>
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400, headers: noCacheHeaders })
  }

  const input: TemplateInput = {
    name: body.name ?? "",
    scope: body.scope === "company" ? "company" : "global",
    companyId: body.companyId ?? null,
    purpose: body.purpose === "negotiation" ? "negotiation" : "communication",
    allowDebtFields: body.allowDebtFields === true,
    subject: body.subject ?? "",
    preheader: body.preheader ?? "",
    html: body.html ?? "",
    textFallback: body.textFallback ?? "",
  }

  const supabase = createServiceClient()
  const result = await createTemplate(supabase, input, guard.userId)

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, validation: result.validation },
      { status: result.validation ? 422 : 400, headers: noCacheHeaders },
    )
  }
  return NextResponse.json(
    { template: result.template, version: result.version },
    { status: 201, headers: noCacheHeaders },
  )
}
