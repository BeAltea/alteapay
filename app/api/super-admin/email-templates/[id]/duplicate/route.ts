// POST /api/super-admin/email-templates/[id]/duplicate → clona como novo draft
import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { duplicateTemplate } from "@/lib/email/templates/repository"
import { requireSuperAdmin, noCacheHeaders } from "../../_guard"

export const dynamic = "force-dynamic"
export const revalidate = 0

type Ctx = { params: Promise<{ id: string }> }

export async function POST(_request: NextRequest, ctx: Ctx) {
  const guard = await requireSuperAdmin()
  if (!guard.ok) return guard.response
  const { id } = await ctx.params

  const supabase = createServiceClient()
  const result = await duplicateTemplate(supabase, id, guard.userId)
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400, headers: noCacheHeaders })
  }
  return NextResponse.json(
    { template: result.template, version: result.version },
    { status: 201, headers: noCacheHeaders },
  )
}
