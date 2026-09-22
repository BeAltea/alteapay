import { createAdminClient, createClient } from "@/lib/supabase/server"
import { NextRequest, NextResponse } from "next/server"
import {
  NEGOTIATION_REQUEST_STATUSES,
  NEGOTIATION_REQUEST_TYPES,
  isValidDiscountPercentage,
  isValidInstallments,
  MAX_DISCOUNT_PERCENTAGE,
  MAX_INSTALLMENTS,
  type CreateNegotiationRequestInput,
} from "@/lib/constants/negotiation-request"

export const dynamic = "force-dynamic"

const noCacheHeaders = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  Pragma: "no-cache",
}

/**
 * GET /api/negotiation-requests
 * List negotiation requests with optional filters
 */
export async function GET(request: NextRequest) {
  try {
    const authSupabase = await createClient()
    const {
      data: { user },
    } = await authSupabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: "Nao autenticado" }, { status: 401, headers: noCacheHeaders })
    }

    const { data: profile } = await authSupabase
      .from("profiles")
      .select("role, company_id, cpf_cnpj")
      .eq("id", user.id)
      .single()

    if (!profile) {
      return NextResponse.json({ error: "Perfil nao encontrado" }, { status: 404, headers: noCacheHeaders })
    }

    const supabase = createAdminClient()

    // Parse query parameters
    const searchParams = request.nextUrl.searchParams
    const companyId = searchParams.get("companyId")
    const status = searchParams.get("status")
    const customerId = searchParams.get("customerId")
    const limit = parseInt(searchParams.get("limit") || "100")
    const offset = parseInt(searchParams.get("offset") || "0")

    // Build query based on role
    let query = supabase
      .from("negotiation_requests")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1)

    if (profile.role === "super_admin") {
      // Super admin can see all, optionally filter by company
      if (companyId) {
        query = query.eq("company_id", companyId)
      }
    } else if (profile.role === "admin") {
      // Admin can only see their company's requests
      query = query.eq("company_id", profile.company_id)
    } else {
      // Regular user can only see their own requests
      const normalizedDoc = (profile.cpf_cnpj || "").replace(/\D/g, "")
      query = query.or(`created_by.eq.${user.id},customer_document.eq.${normalizedDoc}`)
    }

    // Apply additional filters
    if (status) {
      query = query.eq("status", status)
    }
    if (customerId) {
      query = query.eq("customer_id", customerId)
    }

    const { data: requests, error, count } = await query

    if (error) {
      console.error("[negotiation-requests] Error fetching:", error)
      return NextResponse.json({ error: error.message }, { status: 500, headers: noCacheHeaders })
    }

    return NextResponse.json(
      {
        requests: requests || [],
        total: count || 0,
        limit,
        offset,
      },
      { headers: noCacheHeaders }
    )
  } catch (error: any) {
    console.error("[negotiation-requests] Error:", error)
    return NextResponse.json({ error: error.message || "Erro interno" }, { status: 500, headers: noCacheHeaders })
  }
}

/**
 * POST /api/negotiation-requests
 * Create a new negotiation request
 */
export async function POST(request: NextRequest) {
  try {
    const authSupabase = await createClient()
    const {
      data: { user },
    } = await authSupabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: "Nao autenticado" }, { status: 401, headers: noCacheHeaders })
    }

    const { data: profile } = await authSupabase
      .from("profiles")
      .select("role, company_id, cpf_cnpj, full_name")
      .eq("id", user.id)
      .single()

    if (!profile) {
      return NextResponse.json({ error: "Perfil nao encontrado" }, { status: 404, headers: noCacheHeaders })
    }

    // Only users and super_admins can create requests
    if (!["user", "super_admin"].includes(profile.role)) {
      return NextResponse.json(
        { error: "Apenas usuarios e super admins podem criar solicitacoes" },
        { status: 403, headers: noCacheHeaders }
      )
    }

    const body: CreateNegotiationRequestInput = await request.json()

    // Validate required fields
    if (!body.company_id) {
      return NextResponse.json({ error: "company_id obrigatorio" }, { status: 400, headers: noCacheHeaders })
    }
    if (!body.original_amount || body.original_amount <= 0) {
      return NextResponse.json({ error: "original_amount deve ser maior que zero" }, { status: 400, headers: noCacheHeaders })
    }
    if (!body.request_type || !Object.values(NEGOTIATION_REQUEST_TYPES).includes(body.request_type)) {
      return NextResponse.json({ error: "request_type invalido" }, { status: 400, headers: noCacheHeaders })
    }

    // Validate discount if provided
    if (body.requested_discount_percentage !== undefined && body.requested_discount_percentage !== null) {
      if (!isValidDiscountPercentage(body.requested_discount_percentage)) {
        return NextResponse.json(
          { error: `Desconto deve estar entre 0 e ${MAX_DISCOUNT_PERCENTAGE}%` },
          { status: 400, headers: noCacheHeaders }
        )
      }
    }

    // Validate installments if provided
    if (body.requested_installments !== undefined && body.requested_installments !== null) {
      if (!isValidInstallments(body.requested_installments)) {
        return NextResponse.json(
          { error: `Parcelas devem estar entre 1 e ${MAX_INSTALLMENTS}` },
          { status: 400, headers: noCacheHeaders }
        )
      }
    }

    // For regular users, validate they can create request for this company/customer
    if (profile.role === "user") {
      // User must be creating for themselves
      const normalizedUserDoc = (profile.cpf_cnpj || "").replace(/\D/g, "")
      const normalizedCustomerDoc = (body.customer_document || "").replace(/\D/g, "")

      if (normalizedUserDoc && normalizedCustomerDoc && normalizedUserDoc !== normalizedCustomerDoc) {
        return NextResponse.json(
          { error: "Voce so pode criar solicitacoes para suas proprias dividas" },
          { status: 403, headers: noCacheHeaders }
        )
      }
    }

    const supabase = createAdminClient()

    // Privacidade (A5): a lista super-admin não envia mais o documento em claro.
    // Se o body não trouxer customer_document mas trouxer vmax_id, resolvemos o
    // CPF/CNPJ no servidor (escopado por company) para persistir corretamente.
    let resolvedCustomerDocument = body.customer_document || null
    if (!resolvedCustomerDocument && body.vmax_id) {
      const { data: vmaxRow } = await supabase
        .from("VMAX")
        .select('"CPF/CNPJ"')
        .eq("id", body.vmax_id)
        .eq("id_company", body.company_id)
        .maybeSingle()
      resolvedCustomerDocument = (vmaxRow?.["CPF/CNPJ"] as string | null) || null
    }

    // Create the request
    const { data: newRequest, error: createError } = await supabase
      .from("negotiation_requests")
      .insert({
        agreement_id: body.agreement_id || null,
        customer_id: body.customer_id || null,
        company_id: body.company_id,
        vmax_id: body.vmax_id || null,
        customer_name: body.customer_name || null,
        customer_document: resolvedCustomerDocument,
        customer_email: body.customer_email || null,
        customer_phone: body.customer_phone || null,
        original_amount: body.original_amount,
        original_due_date: body.original_due_date || null,
        original_installments: body.original_installments || 1,
        original_discount_percentage: body.original_discount_percentage || 0,
        request_type: body.request_type,
        requested_discount_percentage: body.requested_discount_percentage || null,
        requested_installments: body.requested_installments || null,
        requested_first_due_date: body.requested_first_due_date || null,
        customer_justification: body.customer_justification || null,
        original_asaas_payment_id: body.original_asaas_payment_id || null,
        status: NEGOTIATION_REQUEST_STATUSES.PENDING,
        created_by: user.id,
        created_by_role: profile.role,
      })
      .select()
      .single()

    if (createError) {
      console.error("[negotiation-requests] Error creating:", createError)
      return NextResponse.json({ error: createError.message }, { status: 500, headers: noCacheHeaders })
    }

    return NextResponse.json({ request: newRequest }, { status: 201, headers: noCacheHeaders })
  } catch (error: any) {
    console.error("[negotiation-requests] Error:", error)
    return NextResponse.json({ error: error.message || "Erro interno" }, { status: 500, headers: noCacheHeaders })
  }
}
