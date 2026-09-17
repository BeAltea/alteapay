import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { getServerSupabaseUrl } from "@/lib/supabase/url"

export const dynamic = "force-dynamic"
export const revalidate = 0
export const fetchCache = "force-no-store"

/**
 * GET /api/super-admin/localize/clients
 *
 * Lists clients from VMAX table with Localize status using RPC functions.
 * Supports filters: all, no_email_never_queried, no_phone_never_queried,
 * incomplete_never_queried, incomplete_already_queried
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = createClient(
      getServerSupabaseUrl(),
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } }
    )

    const searchParams = request.nextUrl.searchParams
    const companyId = searchParams.get("company_id")
    const filter = searchParams.get("filter") || "all"
    const page = parseInt(searchParams.get("page") || "1")
    const perPage = parseInt(searchParams.get("per_page") || "50")
    const search = searchParams.get("search") || ""

    if (!companyId) {
      return NextResponse.json(
        { error: "company_id é obrigatório" },
        { status: 400 }
      )
    }

    // Get summary stats using RPC
    const { data: summaryData, error: summaryError } = await supabase.rpc(
      "get_localize_summary",
      { p_company_id: companyId }
    )

    if (summaryError) {
      console.error("[Localize API] Error fetching summary:", summaryError)
      // Fall back to basic query if RPC doesn't exist yet
      return await fallbackQuery(supabase, companyId, filter, page, perPage, search)
    }

    // Get paginated clients using RPC
    const { data: clientsData, error: clientsError } = await supabase.rpc(
      "get_localize_clients",
      {
        p_company_id: companyId,
        p_filter: filter,
        p_search: search,
        p_page: page,
        p_per_page: perPage,
      }
    )

    if (clientsError) {
      console.error("[Localize API] Error fetching clients:", clientsError)
      return await fallbackQuery(supabase, companyId, filter, page, perPage, search)
    }

    // Get total count for pagination
    const { data: totalCount, error: countError } = await supabase.rpc(
      "get_localize_clients_count",
      {
        p_company_id: companyId,
        p_filter: filter,
        p_search: search,
      }
    )

    if (countError) {
      console.error("[Localize API] Error fetching count:", countError)
    }

    const total = totalCount || 0

    // Format clients for frontend
    const formattedClients = (clientsData || []).map((client: any) => {
      const cpfCnpj = client.cpf_cnpj || ""
      const cleanDoc = cpfCnpj.replace(/\D/g, "")
      const documentType = cleanDoc.length === 14 ? "cnpj" : "cpf"

      const phone1 = client.phone1?.trim() || null
      const phone2 = client.phone2?.trim() || null
      const bestPhone = phone1 || phone2

      return {
        id: client.id,
        name: client.name || "",
        cpf_cnpj: cpfCnpj,
        document_type: documentType,
        email: client.email?.trim() || null,
        phone: bestPhone,
        phone2: phone2 && phone1 ? phone2 : null,
        last_assertiva_query: client.localize_last_query || null,
        localize_queried: client.localize_queried || false,
        status: client.localize_status || "no_data",
      }
    })

    const summary = summaryData || {}

    return NextResponse.json(
      {
        clients: formattedClients,
        pagination: {
          total,
          page,
          per_page: perPage,
          total_pages: Math.ceil(total / perPage),
        },
        summary: {
          total: summary.total || 0,
          with_email: summary.with_email || 0,
          without_email: summary.without_email || 0,
          with_phone: summary.with_phone || 0,
          without_phone: summary.without_phone || 0,
          no_email_never_queried: summary.no_email_never_queried || 0,
          no_phone_never_queried: summary.no_phone_never_queried || 0,
          incomplete_never_queried: summary.incomplete_never_queried || 0,
          incomplete_already_queried: summary.incomplete_already_queried || 0,
        },
      },
      {
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
          "Pragma": "no-cache",
          "Expires": "0",
        },
      }
    )
  } catch (error: any) {
    console.error("[Localize API] Error:", error)
    return NextResponse.json(
      { error: "Erro interno do servidor", details: error.message },
      { status: 500 }
    )
  }
}

/**
 * Fallback query when RPC functions don't exist yet
 */
async function fallbackQuery(
  supabase: any,
  companyId: string,
  filter: string,
  page: number,
  perPage: number,
  search: string
) {
  console.log("[Localize API] Using fallback query (RPC not available)")

  // Fetch all clients with keyset pagination
  let allClients: any[] = []
  let lastCliente: string | null = null
  const pageSize = 1000
  let hasMore = true

  while (hasMore) {
    let query = supabase
      .from("VMAX")
      .select(`id, Cliente, "CPF/CNPJ", Email, "Telefone 1", "Telefone 2", id_company, created_at, updated_at`)
      .eq("id_company", companyId)
      .order("Cliente", { ascending: true })
      .limit(pageSize)

    if (lastCliente !== null) {
      query = query.gt("Cliente", lastCliente)
    }

    const { data: pageData, error: fetchError } = await query

    if (fetchError) {
      console.error("[Localize API] Fallback error:", fetchError)
      return NextResponse.json(
        { error: "Erro ao buscar clientes", details: fetchError.message },
        { status: 500 }
      )
    }

    if (pageData && pageData.length > 0) {
      allClients = [...allClients, ...pageData]
      lastCliente = pageData[pageData.length - 1].Cliente
      hasMore = pageData.length === pageSize
    } else {
      hasMore = false
    }
  }

  // Fetch all logs for this company
  const allClientIds = allClients.map((c) => c.id)
  const localizeMap = new Map<string, { queried: boolean; lastQuery: string | null }>()

  const logChunkSize = 500
  for (let i = 0; i < allClientIds.length; i += logChunkSize) {
    const chunkIds = allClientIds.slice(i, i + logChunkSize)
    const { data: logData } = await supabase
      .from("assertiva_localize_logs")
      .select("client_id, created_at")
      .eq("company_id", companyId)
      .in("client_id", chunkIds)
      .order("created_at", { ascending: false })

    for (const log of logData || []) {
      if (!localizeMap.has(log.client_id)) {
        localizeMap.set(log.client_id, {
          queried: true,
          lastQuery: log.created_at,
        })
      }
    }
  }

  // Helper functions
  const hasEmail = (c: any) => !!(c.Email && c.Email.trim() !== "")
  const hasPhone = (c: any) => {
    const t1 = c["Telefone 1"] && c["Telefone 1"].trim() !== ""
    const t2 = c["Telefone 2"] && c["Telefone 2"].trim() !== ""
    return t1 || t2
  }
  const isQueried = (c: any) => localizeMap.get(c.id)?.queried || false

  // Apply filter
  let filtered = allClients
  switch (filter) {
    case "no_email_never_queried":
      filtered = allClients.filter((c) => !hasEmail(c) && !isQueried(c))
      break
    case "no_phone_never_queried":
      filtered = allClients.filter((c) => !hasPhone(c) && !isQueried(c))
      break
    case "incomplete_never_queried":
      filtered = allClients.filter((c) => (!hasEmail(c) || !hasPhone(c)) && !isQueried(c))
      break
    case "incomplete_already_queried":
      filtered = allClients.filter((c) => (!hasEmail(c) || !hasPhone(c)) && isQueried(c))
      break
  }

  // Apply search
  if (search) {
    const searchLower = search.toLowerCase()
    filtered = filtered.filter((c) => {
      const name = (c.Cliente || "").toLowerCase()
      const doc = (c["CPF/CNPJ"] || "").toLowerCase()
      return name.includes(searchLower) || doc.includes(searchLower)
    })
  }

  // Paginate
  const total = filtered.length
  const offset = (page - 1) * perPage
  const clients = filtered.slice(offset, offset + perPage)

  // Format
  const formattedClients = clients.map((client) => {
    const cpfCnpj = client["CPF/CNPJ"] || ""
    const cleanDoc = cpfCnpj.replace(/\D/g, "")
    const documentType = cleanDoc.length === 14 ? "cnpj" : "cpf"
    const localizeInfo = localizeMap.get(client.id)

    const t1 = client["Telefone 1"]?.trim() || null
    const t2 = client["Telefone 2"]?.trim() || null
    const bestPhone = t1 || t2

    let status: string
    if (hasEmail(client) && hasPhone(client)) {
      status = "complete"
    } else if (!hasEmail(client) && localizeInfo?.queried) {
      status = "localize_no_email"
    } else if (!hasPhone(client) && localizeInfo?.queried) {
      status = "localize_no_phone"
    } else if (!hasEmail(client)) {
      status = "no_email"
    } else if (!hasPhone(client)) {
      status = "no_phone"
    } else {
      status = "no_data"
    }

    return {
      id: client.id,
      name: client.Cliente || "",
      cpf_cnpj: cpfCnpj,
      document_type: documentType,
      email: client.Email?.trim() || null,
      phone: bestPhone,
      phone2: t2 && t1 ? t2 : null,
      last_assertiva_query: localizeInfo?.lastQuery || null,
      localize_queried: localizeInfo?.queried || false,
      status,
    }
  })

  // Calculate summary
  const summary = {
    total: allClients.length,
    with_email: allClients.filter(hasEmail).length,
    without_email: allClients.filter((c) => !hasEmail(c)).length,
    with_phone: allClients.filter(hasPhone).length,
    without_phone: allClients.filter((c) => !hasPhone(c)).length,
    no_email_never_queried: allClients.filter((c) => !hasEmail(c) && !isQueried(c)).length,
    no_phone_never_queried: allClients.filter((c) => !hasPhone(c) && !isQueried(c)).length,
    incomplete_never_queried: allClients.filter((c) => (!hasEmail(c) || !hasPhone(c)) && !isQueried(c)).length,
    incomplete_already_queried: allClients.filter((c) => (!hasEmail(c) || !hasPhone(c)) && isQueried(c)).length,
  }

  return NextResponse.json(
    {
      clients: formattedClients,
      pagination: {
        total,
        page,
        per_page: perPage,
        total_pages: Math.ceil(total / perPage),
      },
      summary,
    },
    {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
      },
    }
  )
}
