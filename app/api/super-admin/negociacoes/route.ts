// Lista paginada server-side das negociações (T5). Lê a projeção
// negotiation_state (T1) e satélites em lote. super_admin OBRIGATÓRIO; documento
// SEMPRE mascarado (na camada de query); company_id vem dos filtros mas o acesso
// cross-tenant só é liberado ao super_admin (verificação server-side).

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { parseFilters } from "@/components/super-admin/negotiations/filters"
import {
  queryNegotiations,
  resolveFilteredCustomerIds,
} from "@/components/super-admin/negotiations/query"
import { buildStageCounts, countersReconcile } from "@/components/super-admin/negotiations/stages"

export const dynamic = "force-dynamic"
export const revalidate = 0

const noCache = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  Pragma: "no-cache",
}

async function requireSuperAdmin() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false as const, status: 401, error: "Nao autenticado" }
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single()
  if (profile?.role !== "super_admin") return { ok: false as const, status: 403, error: "Sem permissao" }
  return { ok: true as const }
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requireSuperAdmin()
    if (!auth.ok) {
      return NextResponse.json({ error: auth.error }, { status: auth.status, headers: noCache })
    }

    const filters = parseFilters(request.nextUrl.searchParams)

    // Modo "resolver ids do total filtrado" (seleção "todos os N filtrados").
    if (request.nextUrl.searchParams.get("mode") === "ids") {
      const ids = await resolveFilteredCustomerIds(filters)
      return NextResponse.json({ customerIds: ids, total: ids.length }, { headers: noCache })
    }

    const result = await queryNegotiations(filters)
    const stageCounts = buildStageCounts(result.byStage)
    const reconciles = countersReconcile(result.byStage, result.total)

    return NextResponse.json(
      {
        rows: result.rows,
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
        pageCount: Math.max(1, Math.ceil(result.total / result.pageSize)),
        stageCounts,
        // "assert visível": a soma dos contadores fecha com o total filtrado (§5).
        countersReconcile: reconciles,
      },
      { headers: noCache },
    )
  } catch (err) {
    console.error("[negociacoes] list error:", (err as Error).message)
    return NextResponse.json({ error: "Erro ao consultar" }, { status: 500, headers: noCache })
  }
}
