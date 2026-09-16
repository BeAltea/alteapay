import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { createClient as createAuthClient } from "@/lib/supabase/server"
import { getServerSupabaseUrl } from "@/lib/supabase/url"

export const dynamic = "force-dynamic"
export const revalidate = 0

const noCacheHeaders = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  "Pragma": "no-cache",
}

const supabase = createClient(
  getServerSupabaseUrl(),
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const { companyId, tableName } = await request.json()

    if (!id || !tableName) {
      return NextResponse.json(
        { error: "Missing client ID or table name" },
        { status: 400, headers: noCacheHeaders }
      )
    }

    // Verify the user is a super admin
    const authSupabase = await createAuthClient()
    const { data: { user } } = await authSupabase.auth.getUser()

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

    console.log("[Reactivate Client] ID:", id, "Table:", tableName, "Company:", companyId)

    // 1. Get the client document to find related records
    const { data: clientData } = await supabase
      .from(tableName)
      .select('*')
      .eq("id", id)
      .single()

    if (!clientData) {
      return NextResponse.json({ error: "Cliente nao encontrado" }, { status: 404, headers: noCacheHeaders })
    }

    const clientDocument = (clientData["CPF/CNPJ"] || clientData.cpf_cnpj || "").replace(/\D/g, "")

    // 2. Update company table — clear paid/negotiation status
    const { error: vmaxError } = await supabase
      .from(tableName)
      .update({ negotiation_status: null })
      .eq("id", id)

    if (vmaxError) {
      console.error("[Reactivate Client] VMAX update error:", vmaxError.message)
    } else {
      console.log("[Reactivate Client] VMAX status cleared for:", id)
    }

    // 3. Find and update related customer records
    if (clientDocument && companyId) {
      const { data: customers } = await supabase
        .from("customers")
        .select("id")
        .eq("document", clientDocument)
        .eq("company_id", companyId)

      if (customers && customers.length > 0) {
        const customerIds = customers.map((c) => c.id)

        // 4. Update debts — set back to pending/overdue
        const { error: debtsError } = await supabase
          .from("debts")
          .update({ status: "pending" })
          .in("customer_id", customerIds)
          .eq("status", "paid")

        if (debtsError) {
          console.log("[Reactivate Client] Debts update note:", debtsError.message)
        } else {
          console.log("[Reactivate Client] Debts status reset for customer IDs:", customerIds)
        }

        // 5. Cancel the most recent completed agreement
        const { data: latestAgreement } = await supabase
          .from("agreements")
          .select("id")
          .in("customer_id", customerIds)
          .eq("status", "completed")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle()

        if (latestAgreement) {
          const { error: agreementError } = await supabase
            .from("agreements")
            .update({
              status: "cancelled",
              payment_status: "cancelled",
            })
            .eq("id", latestAgreement.id)

          if (agreementError) {
            console.log("[Reactivate Client] Agreement update note:", agreementError.message)
          } else {
            console.log("[Reactivate Client] Agreement cancelled:", latestAgreement.id)
          }
        }
      }
    }

    console.log("[Reactivate Client] Client reactivated successfully")
    return NextResponse.json({ success: true }, { headers: noCacheHeaders })
  } catch (error: any) {
    console.error("[Reactivate Client] Exception:", error.message)
    return NextResponse.json({ error: error.message }, { status: 500, headers: noCacheHeaders })
  }
}
