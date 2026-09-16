import { createClient } from "@supabase/supabase-js"
import { NextResponse } from "next/server"
import { getServerSupabaseUrl } from "@/lib/supabase/url"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const companyId = searchParams.get("companyId")

    console.log("[v0] API vmax-clientes - Company ID:", companyId)

    if (!companyId) {
      return NextResponse.json(
        { success: false, error: "Company ID obrigatório", customers: [], total: 0 },
        { status: 200 },
      )
    }

    // Service role client para bypassar RLS
    const supabase = createClient(getServerSupabaseUrl(), process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })

    // Buscar TODOS os clientes VMAX
    const { data: vmaxData, error: vmaxError } = await supabase.from("VMAX").select("*")

    if (vmaxError) {
      console.error("[v0] Erro ao buscar VMAX:", vmaxError)
      return NextResponse.json({ success: false, error: vmaxError.message, customers: [], total: 0 }, { status: 200 })
    }

    console.log("[v0] Total registros VMAX:", vmaxData?.length || 0)

    const clientesDaEmpresa = (vmaxData || []).filter(
      (cliente: any) =>
        String(cliente.id_company || "")
          .toLowerCase()
          .trim() === String(companyId).toLowerCase().trim(),
    )

    console.log("[v0] Clientes da empresa filtrados:", clientesDaEmpresa.length)

    // Buscar dados complementares na integration_logs
    let integrationData = []
    if (clientesDaEmpresa.length > 0) {
      const vmaxIds = clientesDaEmpresa.map((c: any) => c.id).filter(Boolean)
      const { data: logsData } = await supabase.from("integration_logs").select("*").in("id", vmaxIds)

      integrationData = logsData || []
      console.log(`[v0] Integration logs encontrados: ${integrationData.length}`)
    }

    return NextResponse.json(
      {
        success: true,
        customers: clientesDaEmpresa,
        integrationData,
        total: clientesDaEmpresa.length,
      },
      { status: 200 },
    )
  } catch (error: any) {
    console.error("[v0] Erro na API:", error)
    return NextResponse.json({ success: false, error: error.message, customers: [], total: 0 }, { status: 200 })
  }
}
