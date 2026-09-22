// GET  /api/super-admin/email-templates/[id]/versions        → histórico (versão/quem/quando)
// POST /api/super-admin/email-templates/[id]/versions/restore não; restore vai via body {versionId}
import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { listVersions, restoreVersion } from "@/lib/email/templates/repository"
import { requireSuperAdmin, noCacheHeaders } from "../../_guard"

export const dynamic = "force-dynamic"
export const revalidate = 0

type Ctx = { params: Promise<{ id: string }> }

export async function GET(_request: NextRequest, ctx: Ctx) {
  const guard = await requireSuperAdmin()
  if (!guard.ok) return guard.response
  const { id } = await ctx.params

  const supabase = createServiceClient()
  const versions = await listVersions(supabase, id)
  return NextResponse.json({ versions }, { headers: noCacheHeaders })
}

/** Restaura uma versão antiga (cria uma nova versão a partir dela). */
export async function POST(request: NextRequest, ctx: Ctx) {
  const guard = await requireSuperAdmin()
  if (!guard.ok) return guard.response
  const { id } = await ctx.params

  let body: { versionId?: string }
  try {
    body = (await request.json()) as { versionId?: string }
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400, headers: noCacheHeaders })
  }
  if (!body.versionId) {
    return NextResponse.json({ error: "versionId é obrigatório" }, { status: 400, headers: noCacheHeaders })
  }

  const supabase = createServiceClient()
  const result = await restoreVersion(supabase, id, body.versionId, guard.userId)
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, validation: result.validation },
      { status: result.validation ? 422 : 400, headers: noCacheHeaders },
    )
  }
  return NextResponse.json({ template: result.template, version: result.version }, { headers: noCacheHeaders })
}
