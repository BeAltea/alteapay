// GET   /api/super-admin/email-templates/[id]  → template + versão corrente
// PUT   /api/super-admin/email-templates/[id]  → edita (cria nova versão)
// PATCH /api/super-admin/email-templates/[id]  → muda status (archive/active/draft)
import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getTemplate, updateTemplate, setStatus } from "@/lib/email/templates/repository"
import type { TemplateInput } from "@/lib/email/templates/types"
import { requireSuperAdmin, noCacheHeaders } from "../_guard"

export const dynamic = "force-dynamic"
export const revalidate = 0

type Ctx = { params: Promise<{ id: string }> }

export async function GET(_request: NextRequest, ctx: Ctx) {
  const guard = await requireSuperAdmin()
  if (!guard.ok) return guard.response
  const { id } = await ctx.params

  const supabase = createServiceClient()
  const data = await getTemplate(supabase, id)
  if (!data) return NextResponse.json({ error: "Template não encontrado" }, { status: 404, headers: noCacheHeaders })
  return NextResponse.json(data, { headers: noCacheHeaders })
}

export async function PUT(request: NextRequest, ctx: Ctx) {
  const guard = await requireSuperAdmin()
  if (!guard.ok) return guard.response
  const { id } = await ctx.params

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
  const result = await updateTemplate(supabase, id, input, guard.userId)
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, validation: result.validation },
      { status: result.validation ? 422 : 400, headers: noCacheHeaders },
    )
  }
  return NextResponse.json({ template: result.template, version: result.version }, { headers: noCacheHeaders })
}

export async function PATCH(request: NextRequest, ctx: Ctx) {
  const guard = await requireSuperAdmin()
  if (!guard.ok) return guard.response
  const { id } = await ctx.params

  let body: { status?: string }
  try {
    body = (await request.json()) as { status?: string }
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400, headers: noCacheHeaders })
  }

  const status = body.status
  if (status !== "draft" && status !== "active" && status !== "archived") {
    return NextResponse.json({ error: "Status inválido" }, { status: 400, headers: noCacheHeaders })
  }

  const supabase = createServiceClient()
  const result = await setStatus(supabase, id, status)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400, headers: noCacheHeaders })
  return NextResponse.json({ ok: true, status }, { headers: noCacheHeaders })
}
