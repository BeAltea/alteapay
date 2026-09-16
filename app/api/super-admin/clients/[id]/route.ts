import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { createClient as createAuthClient } from "@/lib/supabase/server"
import { getServerSupabaseUrl } from "@/lib/supabase/url"

export const dynamic = "force-dynamic"
export const revalidate = 0

// Cache-busting headers for all responses
const noCacheHeaders = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  "Pragma": "no-cache",
}

const supabase = createClient(
  getServerSupabaseUrl(),
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Helper to verify super admin (also allows viewer for read operations)
async function verifySuperAdmin(allowViewer = true) {
  const authSupabase = await createAuthClient()
  const { data: { user } } = await authSupabase.auth.getUser()

  if (!user) {
    return { error: "Nao autenticado", status: 401 }
  }

  const { data: profile } = await authSupabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single()

  const allowedRoles = allowViewer ? ["super_admin", "viewer"] : ["super_admin"]
  if (!allowedRoles.includes(profile?.role || "")) {
    return { error: "Sem permissao", status: 403 }
  }

  return { user, profile }
}

// GET - Fetch full client data for editing
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const tableName = request.nextUrl.searchParams.get("tableName") || "VMAX"
    const companyId = request.nextUrl.searchParams.get("companyId")

    const authResult = await verifySuperAdmin()
    if ("error" in authResult) {
      return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: noCacheHeaders })
    }

    // Fetch full client data from company table
    const { data: clientData, error: clientError } = await supabase
      .from(tableName)
      .select("*")
      .eq("id", id)
      .single()

    if (clientError) {
      return NextResponse.json({ error: clientError.message }, { status: 500, headers: noCacheHeaders })
    }

    // Also get data from customers table if exists (for email/phone)
    const cpf = (clientData["CPF/CNPJ"] || clientData.cpf_cnpj || "").replace(/\D/g, "")
    if (cpf && companyId) {
      const { data: customerData } = await supabase
        .from("customers")
        .select("id, email, phone, name")
        .eq("document", cpf)
        .eq("company_id", companyId)
        .maybeSingle()

      if (customerData) {
        clientData._customer_id = customerData.id
        clientData._customer_email = customerData.email
        clientData._customer_phone = customerData.phone
        clientData._customer_name = customerData.name
      }
    }

    return NextResponse.json(clientData, { headers: noCacheHeaders })
  } catch (error: any) {
    console.error("[Get Client] Exception:", error.message)
    return NextResponse.json({ error: error.message }, { status: 500, headers: noCacheHeaders })
  }
}

// PUT - Update client data (super_admin only, not viewer)
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const body = await request.json()
    const { tableName, companyId, ...updateData } = body

    if (!tableName) {
      return NextResponse.json({ error: "tableName is required" }, { status: 400, headers: noCacheHeaders })
    }

    const authResult = await verifySuperAdmin(false) // Only super_admin can update
    if ("error" in authResult) {
      return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: noCacheHeaders })
    }

    console.log("[Update Client] ID:", id, "Table:", tableName)

    // Remove internal fields before updating
    const cleanData = { ...updateData }
    delete cleanData._customer_id
    delete cleanData._customer_email
    delete cleanData._customer_phone
    delete cleanData._customer_name

    // Update company-specific table (VMAX)
    const { error: updateError } = await supabase
      .from(tableName)
      .update(cleanData)
      .eq("id", id)

    if (updateError) {
      console.error("[Update Client] Error:", updateError.message)
      return NextResponse.json({ error: updateError.message }, { status: 500, headers: noCacheHeaders })
    }

    // Also update customers table if email/phone changed
    const cpf = (cleanData["CPF/CNPJ"] || cleanData.cpf_cnpj || "").replace(/\D/g, "")
    if (cpf && companyId) {
      const customerUpdate: any = {}

      if (cleanData.Cliente || cleanData.cliente) {
        customerUpdate.name = cleanData.Cliente || cleanData.cliente
      }
      if (cleanData.Email || cleanData.email) {
        customerUpdate.email = cleanData.Email || cleanData.email
      }
      if (cleanData["Telefone 1"] || cleanData.telefone_1) {
        customerUpdate.phone = cleanData["Telefone 1"] || cleanData.telefone_1
      }

      if (Object.keys(customerUpdate).length > 0) {
        await supabase
          .from("customers")
          .update(customerUpdate)
          .eq("document", cpf)
          .eq("company_id", companyId)
      }
    }

    return NextResponse.json({ success: true }, { headers: noCacheHeaders })
  } catch (error: any) {
    console.error("[Update Client] Exception:", error.message)
    return NextResponse.json({ error: error.message }, { status: 500, headers: noCacheHeaders })
  }
}

// DELETE - Delete client (super_admin only, not viewer)
export async function DELETE(
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

    const authResult = await verifySuperAdmin(false) // Only super_admin can delete
    if ("error" in authResult) {
      return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: noCacheHeaders })
    }

    console.log("[Delete Client] ID:", id, "Table:", tableName, "Company:", companyId)

    // Get the client document to find related records
    const { data: clientData } = await supabase
      .from(tableName)
      .select('id, "CPF/CNPJ"')
      .eq("id", id)
      .single()

    const clientDocument = clientData?.["CPF/CNPJ"]?.replace(/\D/g, "") || null

    // Get ASAAS API key (try company-specific first, then global)
    let apiKey = process.env.ASAAS_API_KEY
    if (companyId) {
      const { data: company } = await supabase
        .from("companies")
        .select("asaas_api_key")
        .eq("id", companyId)
        .single()
      if (company?.asaas_api_key) {
        apiKey = company.asaas_api_key
      }
    }

    const asaasUrl = process.env.ASAAS_API_URL || "https://api.asaas.com/v3"

    // 1. Find related customer records and ASAAS data
    if (clientDocument) {
      const { data: customers } = await supabase
        .from("customers")
        .select("id")
        .eq("document", clientDocument)
        .eq("company_id", companyId)

      if (customers && customers.length > 0) {
        const customerIds = customers.map((c) => c.id)

        // Get agreements with ASAAS data before deleting
        const { data: agreements } = await supabase
          .from("agreements")
          .select("id, asaas_payment_id, asaas_customer_id")
          .in("customer_id", customerIds)

        // 1a. Delete ASAAS payments first
        if (apiKey && agreements && agreements.length > 0) {
          const asaasCustomerIds = new Set<string>()

          for (const agreement of agreements) {
            // Delete ASAAS payment
            if (agreement.asaas_payment_id) {
              try {
                const res = await fetch(`${asaasUrl}/payments/${agreement.asaas_payment_id}`, {
                  method: "DELETE",
                  headers: { "access_token": apiKey },
                })
                if (res.ok) {
                  console.log("[Delete Client] Deleted ASAAS payment:", agreement.asaas_payment_id)
                } else {
                  console.log("[Delete Client] ASAAS payment delete failed (may already be deleted):", agreement.asaas_payment_id)
                }
              } catch (e) {
                console.log("[Delete Client] ASAAS payment delete error:", agreement.asaas_payment_id)
              }
            }

            // Collect ASAAS customer IDs for later deletion
            if (agreement.asaas_customer_id) {
              asaasCustomerIds.add(agreement.asaas_customer_id)
            }
          }

          // 1b. Delete ASAAS customers
          for (const asaasCustomerId of asaasCustomerIds) {
            try {
              const res = await fetch(`${asaasUrl}/customers/${asaasCustomerId}`, {
                method: "DELETE",
                headers: { "access_token": apiKey },
              })
              if (res.ok) {
                console.log("[Delete Client] Deleted ASAAS customer:", asaasCustomerId)
              } else {
                console.log("[Delete Client] ASAAS customer delete failed (may have active charges):", asaasCustomerId)
              }
            } catch (e) {
              console.log("[Delete Client] ASAAS customer delete error:", asaasCustomerId)
            }
          }
        }

        // 1c. Also try to find ASAAS customer by CPF if no customer ID was stored
        if (apiKey && clientDocument) {
          try {
            const searchRes = await fetch(
              `${asaasUrl}/customers?cpfCnpj=${clientDocument}`,
              { headers: { "access_token": apiKey } }
            )
            const searchData = await searchRes.json()
            if (searchData?.data?.length > 0) {
              for (const customer of searchData.data) {
                try {
                  await fetch(`${asaasUrl}/customers/${customer.id}`, {
                    method: "DELETE",
                    headers: { "access_token": apiKey },
                  })
                  console.log("[Delete Client] Deleted ASAAS customer by CPF:", customer.id)
                } catch (e) {
                  console.log("[Delete Client] ASAAS customer by CPF delete error:", customer.id)
                }
              }
            }
          } catch (e) {
            console.log("[Delete Client] ASAAS customer search by CPF failed")
          }
        }

        // 2. Delete agreements from database
        const { error: agreementsError } = await supabase
          .from("agreements")
          .delete()
          .in("customer_id", customerIds)

        if (agreementsError) {
          console.log("[Delete Client] Agreements delete note:", agreementsError.message)
        } else {
          console.log("[Delete Client] Deleted agreements for customer IDs:", customerIds)
        }

        // 3. Delete debts from database
        const { error: debtsError } = await supabase
          .from("debts")
          .delete()
          .in("customer_id", customerIds)

        if (debtsError) {
          console.log("[Delete Client] Debts delete note:", debtsError.message)
        } else {
          console.log("[Delete Client] Deleted debts for customer IDs:", customerIds)
        }

        // 4. Delete the customers from database
        const { error: customersError } = await supabase
          .from("customers")
          .delete()
          .in("id", customerIds)

        if (customersError) {
          console.log("[Delete Client] Customers delete note:", customersError.message)
        } else {
          console.log("[Delete Client] Deleted customers:", customerIds)
        }
      }
    }

    // 5. Delete the client from the company-specific table (VMAX)
    const { error } = await supabase.from(tableName).delete().eq("id", id)

    if (error) {
      console.error("[Delete Client] Error deleting from", tableName, ":", error)
      return NextResponse.json({ error: error.message }, { status: 500, headers: noCacheHeaders })
    }

    console.log("[Delete Client] Client deleted successfully from", tableName)
    return NextResponse.json({ success: true }, { headers: noCacheHeaders })
  } catch (error: any) {
    console.error("[Delete Client] Exception:", error.message)
    return NextResponse.json({ error: error.message }, { status: 500, headers: noCacheHeaders })
  }
}
