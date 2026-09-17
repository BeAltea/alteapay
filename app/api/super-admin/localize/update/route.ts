import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { getServerSupabaseUrl } from "@/lib/supabase/url"

export const dynamic = "force-dynamic"
export const revalidate = 0
export const fetchCache = "force-no-store"

interface UpdateItem {
  client_id: string
  email?: string
  phone?: string
  whatsapp?: boolean
  assertiva_protocolo: string
}

interface UpdateRequest {
  updates: UpdateItem[]
  company_id: string
}

interface UpdateDetailItem {
  client_id: string
  email_updated: boolean
  phone_updated: boolean
  skipped_reason?: string
}

/**
 * POST /api/super-admin/localize/update
 *
 * Apply Assertiva Localize results to client records.
 * CRITICAL: Only updates fields that are currently NULL or empty.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = createClient(
      getServerSupabaseUrl(),
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } }
    )

    const body: UpdateRequest = await request.json()
    const { updates, company_id } = body

    if (!company_id) {
      return NextResponse.json(
        { error: "company_id é obrigatório" },
        { status: 400 }
      )
    }

    if (!updates || !Array.isArray(updates) || updates.length === 0) {
      return NextResponse.json(
        { error: "updates deve ser um array não vazio" },
        { status: 400 }
      )
    }

    // Verify company exists
    const { data: company, error: companyError } = await supabase
      .from("companies")
      .select("id")
      .eq("id", company_id)
      .single()

    if (companyError || !company) {
      return NextResponse.json(
        { error: "Empresa não encontrada" },
        { status: 404 }
      )
    }

    const details: UpdateDetailItem[] = []
    let updated = 0
    let skipped = 0
    let errors = 0

    console.log(`[Localize Update] Processing ${updates.length} updates for company ${company_id}`)

    for (const update of updates) {
      const { client_id, email, phone, whatsapp, assertiva_protocolo } = update

      try {
        // Fetch current client data to verify fields are empty
        const { data: client, error: clientError } = await supabase
          .from("VMAX")
          .select(`id, Email, "Telefone 1", id_company`)
          .eq("id", client_id)
          .eq("id_company", company_id)
          .single()

        if (clientError || !client) {
          details.push({
            client_id,
            email_updated: false,
            phone_updated: false,
            skipped_reason: `Cliente não encontrado: ${clientError?.message || 'null'}`,
          })
          errors++
          continue
        }

        const currentEmail = client.Email?.trim() || ""
        const currentPhone = client["Telefone 1"]?.trim() || ""

        let emailUpdated = false
        let phoneUpdated = false
        const skippedReasons: string[] = []

        // Prepare update object
        const updateData: Record<string, any> = {}

        // Only update email if current is empty AND new email is provided
        if (email && email.trim() !== "") {
          if (currentEmail === "") {
            updateData.Email = email.trim()
            emailUpdated = true
          } else {
            skippedReasons.push(`Email já existente: ${currentEmail}`)
          }
        }

        // Only update phone if current is empty AND new phone is provided
        if (phone && phone.trim() !== "") {
          if (currentPhone === "") {
            updateData["Telefone 1"] = phone.trim()
            phoneUpdated = true
          } else {
            skippedReasons.push(`Telefone já existente: ${currentPhone}`)
          }
        }

        // Apply update if there's anything to update
        if (Object.keys(updateData).length > 0) {
          updateData.updated_at = new Date().toISOString()

          const { data: updateResult, error: updateError } = await supabase
            .from("VMAX")
            .update(updateData)
            .eq("id", client_id)
            .eq("id_company", company_id)
            .select()

          if (updateError) {
            console.error(`[Localize Update] Error updating client ${client_id}:`, updateError)
            details.push({
              client_id,
              email_updated: false,
              phone_updated: false,
              skipped_reason: `Erro ao atualizar: ${updateError.message}`,
            })
            errors++
            continue
          }

          if (!updateResult || updateResult.length === 0) {
            console.error(`[Localize Update] Update returned no rows for client ${client_id}`)
            details.push({
              client_id,
              email_updated: false,
              phone_updated: false,
              skipped_reason: "Update não retornou dados - possível problema de RLS ou ID inválido",
            })
            errors++
            continue
          }

          // Update the log record to mark data as applied
          if (assertiva_protocolo) {
            await supabase
              .from("assertiva_localize_logs")
              .update({
                email_applied: emailUpdated ? email : null,
                phone_applied: phoneUpdated ? phone : null,
                applied_at: new Date().toISOString(),
              })
              .eq("assertiva_protocolo", assertiva_protocolo)
              .eq("client_id", client_id)
          }

          updated++
        } else {
          skipped++
        }

        details.push({
          client_id,
          email_updated: emailUpdated,
          phone_updated: phoneUpdated,
          skipped_reason: skippedReasons.length > 0 ? skippedReasons.join("; ") : undefined,
        })
      } catch (error: any) {
        console.error(`[Localize Update] Error processing client ${client_id}:`, error)
        details.push({
          client_id,
          email_updated: false,
          phone_updated: false,
          skipped_reason: `Erro: ${error.message}`,
        })
        errors++
      }
    }

    console.log(`[Localize Update] Completed: ${updated} updated, ${skipped} skipped, ${errors} errors`)

    return NextResponse.json(
      {
        updated,
        skipped,
        errors,
        details,
      },
      {
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate",
        },
      }
    )
  } catch (error: any) {
    console.error("[Localize Update] Error:", error)
    return NextResponse.json(
      { error: "Erro interno do servidor", details: error.message },
      { status: 500 }
    )
  }
}
