import { createAdminClient, createClient } from "@/lib/supabase/server"
import { NextRequest, NextResponse } from "next/server"
import { PAID_AGREEMENT_STATUSES, PAID_PAYMENT_STATUSES, PAID_ASAAS_STATUSES } from "@/lib/constants/payment-status"

export const dynamic = "force-dynamic"
export const revalidate = 0

const noCacheHeaders = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  "Pragma": "no-cache",
}

export async function GET(request: NextRequest) {
  try {
    // Verify the user is a super admin
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

    // Allow both super_admin and viewer roles
    const allowedRoles = ["super_admin", "viewer"]
    if (!allowedRoles.includes(profile?.role || "")) {
      return NextResponse.json({ error: "Sem permissao" }, { status: 403, headers: noCacheHeaders })
    }

    const companyId = request.nextUrl.searchParams.get("companyId")
    if (!companyId) {
      return NextResponse.json({ error: "companyId obrigatorio" }, { status: 400, headers: noCacheHeaders })
    }

    const supabase = createAdminClient()

    // Load all VMAX customers for this company with pagination
    let vmaxCustomers: any[] = []
    let page = 0
    const pageSize = 1000
    let hasMore = true

    while (hasMore) {
      const { data: vmaxPage, error } = await supabase
        .from("VMAX")
        .select("*")
        .eq("id_company", companyId)
        .range(page * pageSize, (page + 1) * pageSize - 1)

      if (error) {
        console.error("[v0] VMAX fetch error:", error.message)
        break
      }

      if (vmaxPage && vmaxPage.length > 0) {
        vmaxCustomers = [...vmaxCustomers, ...vmaxPage]
        page++
        hasMore = vmaxPage.length === pageSize
      } else {
        hasMore = false
      }
    }

    // Load existing agreements for this company to check negotiation status
    // Include "completed"/"paid" for paid agreements and "cancelled" for cancelled negotiations
    // Also fetch notification viewed fields for visualization tracking
    // JOIN with customers to get document directly (more reliable than separate lookup)
    // IMPORTANT: Use pagination to avoid Supabase 1000-row default limit
    let agreements: any[] = []
    let agreementPage = 0
    let agreementHasMore = true

    while (agreementHasMore) {
      // Include pago_ao_cliente status for customers who paid directly to provider
      const { data: agreementPage_, error: agreementError } = await supabase
        .from("agreements")
        .select("id, customer_id, status, payment_status, asaas_status, asaas_payment_id, asaas_customer_id, due_date, notification_viewed, notification_viewed_at, notification_viewed_channel, customers(document)")
        .eq("company_id", companyId)
        .in("status", ["active", "draft", "pending", "completed", "paid", "cancelled", "pago_ao_cliente"])
        .range(agreementPage * pageSize, (agreementPage + 1) * pageSize - 1)

      if (agreementError) {
        console.error("[v0] Agreements fetch error:", agreementError.message)
        break
      }

      if (agreementPage_ && agreementPage_.length > 0) {
        agreements = [...agreements, ...agreementPage_]
        agreementPage++
        agreementHasMore = agreementPage_.length === pageSize
      } else {
        agreementHasMore = false
      }
    }

    // Load customers mapping (document -> customer data) so we can match agreements and get contact info
    // IMPORTANT: Use pagination to avoid Supabase 1000-row default limit
    let dbCustomers: any[] = []
    let customerPage = 0
    let customerHasMore = true

    while (customerHasMore) {
      const { data: customerPage_, error: customerError } = await supabase
        .from("customers")
        .select("id, document, email, phone")
        .eq("company_id", companyId)
        .range(customerPage * pageSize, (customerPage + 1) * pageSize - 1)

      if (customerError) {
        console.error("[v0] Customers fetch error:", customerError.message)
        break
      }

      if (customerPage_ && customerPage_.length > 0) {
        dbCustomers = [...dbCustomers, ...customerPage_]
        customerPage++
        customerHasMore = customerPage_.length === pageSize
      } else {
        customerHasMore = false
      }
    }

    // Build maps for document -> customer id and document -> contact info
    // IMPORTANT: All documents must be normalized (digits only) for consistent lookups
    const customerIdToNormalizedDoc = new Map<string, string>()
    const docToContactInfo = new Map<string, { email: string | null; phone: string | null }>()
    for (const c of dbCustomers || []) {
      const normalizedDoc = (c.document || "").replace(/\D/g, "")
      if (normalizedDoc) {
        customerIdToNormalizedDoc.set(c.id, normalizedDoc)
        docToContactInfo.set(normalizedDoc, { email: c.email, phone: c.phone })
      }
    }

    // Build maps for agreement status by customer document (normalized)
    const docsWithActiveAgreements = new Set<string>()
    const docsWithPaidAgreements = new Set<string>()
    const docsWithCancelledAgreements = new Set<string>() // Cancelled negotiations
    const docsWithAnyNegotiation = new Set<string>() // Any negotiation sent (active or paid, NOT cancelled)
    const docToCancelledCount = new Map<string, number>() // Count of cancelled agreements per customer
    const docToPaymentStatus = new Map<string, {
      paymentStatus: string | null;
      asaasStatus: string | null;
      agreementId: string | null;
      asaasPaymentId: string | null;
      agreementStatus: string | null;
      dueDate: string | null;
      notificationViewed: boolean;
      notificationViewedAt: string | null;
      notificationViewedChannel: string | null;
    }>()

    for (const a of agreements || []) {
      // Try to get document from joined customer first, then fallback to customerIdToNormalizedDoc
      const customer = a.customers as { document?: string } | null
      const docFromJoin = customer?.document ? (customer.document || "").replace(/\D/g, "") : ""
      const docFromMap = customerIdToNormalizedDoc.get(a.customer_id) || ""
      const normalizedDoc = docFromJoin || docFromMap

      if (normalizedDoc) {
        if (a.status === "cancelled") {
          docsWithCancelledAgreements.add(normalizedDoc)
          // Increment cancelled count for this customer
          docToCancelledCount.set(normalizedDoc, (docToCancelledCount.get(normalizedDoc) || 0) + 1)
          // Only track as "any negotiation" if not cancelled (cancelled = can send again)
        } else {
          // Check all paid status indicators for consistency with other views
          const isPaidAgreement =
            PAID_AGREEMENT_STATUSES.includes(a.status as any) ||
            PAID_PAYMENT_STATUSES.includes(a.payment_status as any) ||
            PAID_ASAAS_STATUSES.includes(a.asaas_status as any)

          // Only count as "Enviada" if a negotiation was actually sent through ASAAS
          // pago_ao_cliente WITHOUT asaas_payment_id means they paid directly to provider without ASAAS
          const wasSentThroughAsaas = !!(a.asaas_payment_id || a.asaas_customer_id)
          const isPagoAoClienteDirecto = a.status === "pago_ao_cliente" && !wasSentThroughAsaas

          if (!isPagoAoClienteDirecto) {
            docsWithAnyNegotiation.add(normalizedDoc) // Track negotiations actually sent
          }

          if (isPaidAgreement) {
            docsWithPaidAgreements.add(normalizedDoc)
          } else {
            docsWithActiveAgreements.add(normalizedDoc)
          }
        }
        // Store the payment status for this customer
        // Prioritize agreements with asaas_payment_id and due_date over those without
        const existingStatus = docToPaymentStatus.get(normalizedDoc)

        // Calculate a "quality score" for the current agreement
        // Higher score = better agreement to use for display
        const currentHasAsaasId = !!a.asaas_payment_id
        const currentHasDueDate = !!a.due_date
        const currentIsActive = a.status !== "cancelled"

        // Determine if we should use this agreement over the existing one
        let shouldUseThisAgreement = false

        if (!existingStatus) {
          // No existing data, use this one
          shouldUseThisAgreement = true
        } else if (!currentIsActive) {
          // Current agreement is cancelled, don't overwrite with it
          shouldUseThisAgreement = false
        } else {
          // Both exist and current is not cancelled - compare quality
          const existingHasAsaasId = !!existingStatus.asaasPaymentId
          const existingHasDueDate = !!existingStatus.dueDate

          // Prioritize: asaas_payment_id + due_date > asaas_payment_id only > due_date only > neither
          const currentScore = (currentHasAsaasId ? 2 : 0) + (currentHasDueDate ? 1 : 0)
          const existingScore = (existingHasAsaasId ? 2 : 0) + (existingHasDueDate ? 1 : 0)

          // Only overwrite if current has better or equal score
          // (equal score means we keep the first one found, which is fine)
          shouldUseThisAgreement = currentScore > existingScore
        }

        if (shouldUseThisAgreement) {
          docToPaymentStatus.set(normalizedDoc, {
            paymentStatus: a.payment_status || null,
            asaasStatus: a.asaas_status || null,
            agreementId: a.id || null,
            asaasPaymentId: a.asaas_payment_id || null,
            agreementStatus: a.status || null,
            dueDate: a.due_date || null,
            notificationViewed: !!a.notification_viewed,
            notificationViewedAt: a.notification_viewed_at || null,
            notificationViewedChannel: a.notification_viewed_channel || null,
          })
        }
      }
    }

    // Also check VMAX negotiation_status field
    const customers = vmaxCustomers.map((vmax) => {
      const cpfCnpj = (vmax["CPF/CNPJ"] || "").replace(/\D/g, "")
      const vencidoStr = String(vmax.Vencido || "0")
      const totalDebt =
        Number(vencidoStr.replace(/[^\d,]/g, "").replace(",", ".")) || 0
      const diasInadStr = String(vmax["Dias Inad."] || "0")
      const daysOverdue = Number(diasInadStr.replace(/\./g, "")) || 0

      // Check if this customer's last agreement was cancelled
      const isCancelled = docsWithCancelledAgreements.has(cpfCnpj) &&
        !docsWithActiveAgreements.has(cpfCnpj) &&
        !docsWithPaidAgreements.has(cpfCnpj)

      // Removed from the creditor's portfolio: batch import marks CANCELADA on
      // customers the creditor dropped and that never had an ASAAS negotiation.
      // These are not pending sends - they must never be charged.
      const isRemovedFromPortfolio =
        vmax.negotiation_status === "CANCELADA" && !docsWithAnyNegotiation.has(cpfCnpj)

      // Check if paid (VMAX status or agreement status)
      const isPaid =
        docsWithPaidAgreements.has(cpfCnpj) ||
        vmax.negotiation_status === "PAGO"

      // Check if ANY negotiation was sent (paid or active, NOT cancelled) - for "Status Negociação" column
      // Cancelled negotiations should NOT count as "Enviada"
      // NOTE: PAGO is excluded from VMAX fallback - it's only counted if there's an ASAAS agreement
      // This correctly excludes "pago_ao_cliente" customers who paid directly without ASAAS
      const hasNegotiation =
        !isCancelled && (
          docsWithAnyNegotiation.has(cpfCnpj) ||
          (vmax.negotiation_status &&
            ["active", "sent", "pending", "in_negotiation"].includes(
              vmax.negotiation_status
            ))
        )

      // Check if has active negotiation (not paid, not cancelled) - for filtering
      const hasActiveNegotiation =
        !isPaid && !isCancelled && (
          docsWithActiveAgreements.has(cpfCnpj) ||
          (vmax.negotiation_status &&
            ["active", "sent", "pending", "in_negotiation"].includes(
              vmax.negotiation_status
            ))
        )

      let status: "active" | "overdue" | "negotiating" | "paid" = "active"
      if (isPaid) status = "paid"
      else if (hasActiveNegotiation) status = "negotiating"
      else if (daysOverdue > 0) status = "overdue"

      // Get contact info from customers table if VMAX doesn't have it
      const contactInfo = docToContactInfo.get(cpfCnpj)
      const email = vmax.Email || contactInfo?.email || null
      const phone = vmax["Telefone 1"] || vmax["Telefone 2"] || contactInfo?.phone || null

      // Get payment status from agreement
      const paymentInfo = docToPaymentStatus.get(cpfCnpj)

      return {
        id: vmax.id,
        name: vmax.Cliente || "Cliente",
        document: vmax["CPF/CNPJ"] || "N/A",
        email,
        phone,
        status,
        totalDebt, // Always return original debt value
        originalDebt: totalDebt, // Keep original for reference
        daysOverdue: isPaid ? 0 : daysOverdue,
        hasNegotiation: !!hasNegotiation, // Any negotiation sent (for "Enviada" status)
        hasActiveNegotiation: !!hasActiveNegotiation, // Active (non-paid) negotiation
        isPaid: !!isPaid,
        isCancelled: !!isCancelled, // Was cancelled (can send new negotiation)
        isRemovedFromPortfolio, // Dropped by the creditor; excluded from pending sends
        cancelledCount: docToCancelledCount.get(cpfCnpj) || 0, // Number of cancelled negotiations
        paymentStatus: paymentInfo?.paymentStatus || null,
        asaasStatus: paymentInfo?.asaasStatus || null,
        agreementStatus: paymentInfo?.agreementStatus || null,
        agreementId: paymentInfo?.agreementId || null,
        asaasPaymentId: paymentInfo?.asaasPaymentId || null,
        dueDate: paymentInfo?.dueDate || null, // ASAAS charge due date only (not VMAX Vecto)
        notificationViewed: paymentInfo?.notificationViewed || false,
        notificationViewedAt: paymentInfo?.notificationViewedAt || null,
        notificationViewedChannel: paymentInfo?.notificationViewedChannel || null,
      }
    })

    return NextResponse.json({ customers }, { headers: noCacheHeaders })
  } catch (error: any) {
    console.error("[v0] Error in negotiations customers API:", error)
    return NextResponse.json(
      { error: error.message || "Erro interno" },
      { status: 500, headers: noCacheHeaders }
    )
  }
}
