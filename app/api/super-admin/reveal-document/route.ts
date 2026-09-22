// Reveal auditado de documento (privacidade A5). As listas super-admin exibem o
// CPF/CNPJ SEMPRE mascarado; o documento em claro NUNCA trafega no payload da
// lista. Este endpoint dedicado é o ÚNICO caminho para revelar o documento de
// UMA linha, sob demanda:
//   1. exige super_admin (viewer NÃO pode revelar);
//   2. resolve o documento em claro no servidor a partir do id da linha VMAX,
//      escopado por companyId (multi-tenant: id_company);
//   3. grava `journey_events` (type='document.revealed', actor='admin') ANTES de
//      devolver o claro — com ator (user id), motivo e o doc MASCARADO no payload
//      (o append-only + maskPayload garantem que o claro jamais fica no evento).
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { recordEvent } from "@/lib/journey/events"
import { maskDocument, normalizeDocument } from "@/lib/journey/document"

export const dynamic = "force-dynamic"
export const revalidate = 0

const noCacheHeaders = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  Pragma: "no-cache",
}

const DEFAULT_REASON = "consulta operacional"

export async function POST(request: NextRequest) {
  try {
    // 1. super_admin obrigatório (viewer não revela PII).
    const authSupabase = await createClient()
    const {
      data: { user },
    } = await authSupabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: "Nao autenticado" }, { status: 401, headers: noCacheHeaders })
    }
    const { data: profile } = await authSupabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single()
    if (profile?.role !== "super_admin") {
      return NextResponse.json({ error: "Sem permissao" }, { status: 403, headers: noCacheHeaders })
    }

    const body = (await request.json().catch(() => ({}))) as {
      id?: string
      companyId?: string
      reason?: string
    }
    const rowId = typeof body.id === "string" ? body.id.trim() : ""
    const companyId = typeof body.companyId === "string" ? body.companyId.trim() : ""
    const reason =
      typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 240) : DEFAULT_REASON

    if (!rowId || !companyId) {
      return NextResponse.json(
        { error: "id e companyId obrigatorios" },
        { status: 400, headers: noCacheHeaders },
      )
    }

    // 2. Resolve o documento em claro no servidor, SEMPRE escopado por company
    //    (VMAX usa id_company). Fora do escopo → 404 (não vaza existência).
    const service = createServiceClient()
    const { data: row, error } = await service
      .from("VMAX")
      .select('id, "CPF/CNPJ", id_company')
      .eq("id", rowId)
      .eq("id_company", companyId)
      .maybeSingle()

    if (error) {
      console.error("[reveal-document] VMAX lookup falhou:", error.message)
      return NextResponse.json({ error: "Erro ao consultar" }, { status: 500, headers: noCacheHeaders })
    }
    if (!row) {
      return NextResponse.json({ error: "Registro nao encontrado" }, { status: 404, headers: noCacheHeaders })
    }

    const clearDocument = (row["CPF/CNPJ"] as string | null) ?? ""
    const normalized = normalizeDocument(clearDocument)
    if (!normalized) {
      return NextResponse.json({ error: "Sem documento" }, { status: 404, headers: noCacheHeaders })
    }

    // 3. Grava o evento de auditoria ANTES de devolver o claro. Melhor esforço:
    //    o payload leva SÓ dados mascarados/motivo/ator (maskPayload é defensivo).
    await recordEvent({
      companyId,
      type: "document.revealed",
      actor: "admin",
      payload: {
        actor_user_id: user.id,
        row_id: rowId,
        source: "VMAX",
        document_masked: maskDocument(normalized),
        reason,
      },
    })

    // Só agora devolvemos o documento em claro (nunca em GET/cache).
    return NextResponse.json({ document: clearDocument }, { headers: noCacheHeaders })
  } catch (err: any) {
    console.error("[reveal-document] exceção:", err?.message)
    return NextResponse.json({ error: "Erro interno" }, { status: 500, headers: noCacheHeaders })
  }
}
