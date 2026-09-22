// POST /api/super-admin/email-templates/[id]/default → define como padrão do cedente
// Body: { companyId, purpose }. 1 padrão por (cedente, propósito).
import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getTemplate, setDefault } from "@/lib/email/templates/repository"
import { requireSuperAdmin, noCacheHeaders } from "../../_guard"

export const dynamic = "force-dynamic"
export const revalidate = 0

type Ctx = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, ctx: Ctx) {
  const guard = await requireSuperAdmin()
  if (!guard.ok) return guard.response
  const { id } = await ctx.params

  let body: { companyId?: string; purpose?: string }
  try {
    body = (await request.json()) as { companyId?: string; purpose?: string }
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400, headers: noCacheHeaders })
  }
  if (!body.companyId) {
    return NextResponse.json({ error: "companyId é obrigatório" }, { status: 400, headers: noCacheHeaders })
  }

  const supabase = createServiceClient()
  const template = await getTemplate(supabase, id)
  if (!template) return NextResponse.json({ error: "Template não encontrado" }, { status: 404, headers: noCacheHeaders })

  // O padrão é o propósito DO template (não confia no body para o propósito).
  const purpose = template.template.purpose

  // Um template global pode ser padrão de qualquer cedente; um de cedente só do
  // próprio cedente.
  if (template.template.companyId && template.template.companyId !== body.companyId) {
    return NextResponse.json(
      { error: "Este template pertence a outro cedente e não pode ser padrão deste." },
      { status: 400, headers: noCacheHeaders },
    )
  }
  if (template.template.status !== "active") {
    return NextResponse.json(
      { error: "Só um template ativo pode ser definido como padrão." },
      { status: 400, headers: noCacheHeaders },
    )
  }

  const result = await setDefault(supabase, body.companyId, id, purpose, guard.userId)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400, headers: noCacheHeaders })
  return NextResponse.json({ ok: true, companyId: body.companyId, purpose }, { headers: noCacheHeaders })
}
