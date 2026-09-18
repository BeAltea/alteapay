import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { getServerSupabaseUrl } from "@/lib/supabase/url"

/**
 * ROBUST Cancel ASAAS Payment API
 *
 * This endpoint handles cancellation comprehensively:
 * 1. Finds agreement by multiple fields (agreementId, asaas_payment_id, or both)
 * 2. Updates ALL active agreements for the same customer -> status: 'cancelled'
 * 3. Updates debts table -> status: 'pending' (reopens the debt)
 * 4. Deletes ALL ASAAS payments for the customer
 * 5. Deletes ASAAS customer by stored ID (if available)
 * 6. Clears VMAX negotiation_status to null (multiple fallback methods)
 * 7. ALWAYS searches by CPF and deletes ALL remaining ASAAS customers
 *    (handles duplicates created across multiple negotiations)
 * 8. Logs EVERY step with success/error
 */

const supabase = createClient(
  getServerSupabaseUrl(),
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: NextRequest) {
  console.log("=".repeat(60))
  console.log("[Cancel] === STARTING CANCEL OPERATION ===")

  try {
    const body = await request.json()
    const { agreementId, asaasPaymentId, vmaxId, companyId, customerId, debtId } = body

    console.log("[Cancel] Input params:", JSON.stringify({ agreementId, asaasPaymentId, vmaxId, companyId, customerId, debtId }, null, 2))

    // Get ASAAS API key
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

    if (!apiKey) {
      console.error("[Cancel] ERROR: No ASAAS API key available")
      return NextResponse.json({ error: "ASAAS API key not configured" }, { status: 500 })
    }
    console.log("[Cancel] ASAAS API key loaded")

    // ====== STEP 1: Find the agreement ======
    let agreement: any = null

    // Try by agreementId first
    if (agreementId) {
      const { data, error } = await supabase
        .from("agreements")
        .select("*, customers(id, document, external_id)")
        .eq("id", agreementId)
        .single()

      if (!error && data) {
        agreement = data
        console.log("[Cancel] Found agreement by ID:", agreement.id)
      } else {
        console.log("[Cancel] Agreement not found by ID:", agreementId, error?.message)
      }
    }

    // Fallback: try by asaas_payment_id
    if (!agreement && asaasPaymentId) {
      const { data, error } = await supabase
        .from("agreements")
        .select("*, customers(id, document, external_id)")
        .eq("asaas_payment_id", asaasPaymentId)
        .single()

      if (!error && data) {
        agreement = data
        console.log("[Cancel] Found agreement by asaas_payment_id:", agreement.id)
      } else {
        console.log("[Cancel] Agreement not found by asaas_payment_id:", asaasPaymentId, error?.message)
      }
    }

    if (!agreement) {
      console.error("[Cancel] ERROR: No agreement found with provided identifiers")
      // Don't fail - still try to delete from ASAAS and update VMAX
    } else {
      console.log("[Cancel] Agreement found:", {
        id: agreement.id,
        status: agreement.status,
        payment_status: agreement.payment_status,
        asaas_payment_id: agreement.asaas_payment_id,
        debt_id: agreement.debt_id,
        customer_id: agreement.customer_id,
      })
    }

    // ====== STEP 2: Delete from ASAAS ======
    const paymentIdToDelete = agreement?.asaas_payment_id || asaasPaymentId
    const asaasUrl = process.env.ASAAS_API_URL || "https://api.asaas.com/v3"

    if (paymentIdToDelete) {
      console.log("[Cancel] Deleting ASAAS payment:", paymentIdToDelete)
      try {
        const deleteResponse = await fetch(`${asaasUrl}/payments/${paymentIdToDelete}`, {
          method: "DELETE",
          headers: {
            "access_token": apiKey,
            "Content-Type": "application/json",
          },
        })

        if (deleteResponse.ok) {
          console.log("[Cancel] SUCCESS: ASAAS payment deleted")
        } else if (deleteResponse.status === 404) {
          console.log("[Cancel] ASAAS payment already deleted or not found (404)")
        } else {
          const errorData = await deleteResponse.json().catch(() => ({}))
          console.error("[Cancel] ASAAS delete failed:", deleteResponse.status, errorData)
        }
      } catch (asaasErr: any) {
        console.error("[Cancel] ASAAS delete exception:", asaasErr.message)
      }
    } else {
      console.log("[Cancel] WARNING: No ASAAS payment ID to delete")
    }

    // ====== STEP 3: Update agreement in DB + Cancel ALL active agreements for same customer ======
    let cancelledAgreementsCount = 0
    const allAsaasPaymentIds: string[] = []

    if (agreement) {
      // First, cancel the target agreement
      console.log("[Cancel] Updating target agreement to cancelled...")
      const { error: agreementError } = await supabase
        .from("agreements")
        .update({
          status: "cancelled",
          payment_status: "cancelled",
          asaas_status: "DELETED",
        })
        .eq("id", agreement.id)

      if (agreementError) {
        console.error("[Cancel] ERROR updating agreement:", agreementError.message)
      } else {
        console.log("[Cancel] SUCCESS: Agreement updated to cancelled")
        cancelledAgreementsCount++
      }

      // Collect the payment ID
      if (agreement.asaas_payment_id) {
        allAsaasPaymentIds.push(agreement.asaas_payment_id)
      }

      // Now find and cancel ALL other active agreements for the same customer
      if (agreement.customer_id) {
        const { data: otherAgreements, error: otherError } = await supabase
          .from("agreements")
          .select("id, asaas_payment_id")
          .eq("customer_id", agreement.customer_id)
          .eq("status", "active")
          .neq("id", agreement.id) // Exclude the one we already cancelled

        if (otherError) {
          console.error("[Cancel] ERROR finding other agreements:", otherError.message)
        } else if (otherAgreements && otherAgreements.length > 0) {
          console.log("[Cancel] Found", otherAgreements.length, "other active agreements for this customer")

          for (const other of otherAgreements) {
            // Cancel the agreement
            const { error: cancelErr } = await supabase
              .from("agreements")
              .update({
                status: "cancelled",
                payment_status: "cancelled",
                asaas_status: "DELETED",
              })
              .eq("id", other.id)

            if (cancelErr) {
              console.error("[Cancel] ERROR cancelling agreement", other.id, ":", cancelErr.message)
            } else {
              console.log("[Cancel] SUCCESS: Cancelled extra agreement:", other.id)
              cancelledAgreementsCount++
            }

            // Collect payment ID for deletion
            if (other.asaas_payment_id) {
              allAsaasPaymentIds.push(other.asaas_payment_id)
            }
          }
        } else {
          console.log("[Cancel] No other active agreements for this customer")
        }
      }

      // Delete ALL collected ASAAS payments
      for (const paymentId of allAsaasPaymentIds) {
        if (paymentId === paymentIdToDelete) continue // Already deleted above
        try {
          const delRes = await fetch(`${asaasUrl}/payments/${paymentId}`, {
            method: "DELETE",
            headers: { "access_token": apiKey, "Content-Type": "application/json" },
          })
          console.log("[Cancel] Deleted extra ASAAS payment:", paymentId, "status:", delRes.status)
        } catch (e: any) {
          console.log("[Cancel] Extra payment delete failed:", paymentId, e.message)
        }
      }
    }

    // ====== STEP 4: Update debt to pending (reopens the debt) ======
    const debtIdToUpdate = agreement?.debt_id || debtId
    if (debtIdToUpdate) {
      console.log("[Cancel] Updating debt to pending:", debtIdToUpdate)
      const { error: debtError } = await supabase
        .from("debts")
        .update({
          status: "pending",
        })
        .eq("id", debtIdToUpdate)

      if (debtError) {
        console.error("[Cancel] ERROR updating debt:", debtError.message)
      } else {
        console.log("[Cancel] SUCCESS: Debt updated to pending")
      }
    } else {
      console.log("[Cancel] WARNING: No debt_id to update")
    }

    // ====== STEP 5: Clear VMAX negotiation_status ======
    // Try multiple methods to find the VMAX record

    let vmaxUpdated = false

    // Method 1: Direct vmaxId if provided
    if (vmaxId) {
      console.log("[Cancel] Clearing VMAX by direct vmaxId:", vmaxId)
      const { error: vmaxError } = await supabase
        .from("VMAX")
        .update({ negotiation_status: null })
        .eq("id", vmaxId)

      if (vmaxError) {
        console.error("[Cancel] ERROR updating VMAX by ID:", vmaxError.message)
      } else {
        console.log("[Cancel] SUCCESS: VMAX cleared by direct ID")
        vmaxUpdated = true
      }
    }

    // Method 2: Via customer's external_id
    if (!vmaxUpdated && agreement?.customers?.external_id) {
      const externalId = agreement.customers.external_id
      console.log("[Cancel] Clearing VMAX by customer external_id:", externalId)
      const { error: vmaxError } = await supabase
        .from("VMAX")
        .update({ negotiation_status: null })
        .eq("id", externalId)

      if (vmaxError) {
        console.error("[Cancel] ERROR updating VMAX by external_id:", vmaxError.message)
      } else {
        console.log("[Cancel] SUCCESS: VMAX cleared by customer external_id")
        vmaxUpdated = true
      }
    }

    // Method 3: Via debt's external_id
    if (!vmaxUpdated && debtIdToUpdate) {
      const { data: debt } = await supabase
        .from("debts")
        .select("external_id")
        .eq("id", debtIdToUpdate)
        .single()

      if (debt?.external_id) {
        console.log("[Cancel] Clearing VMAX by debt external_id:", debt.external_id)
        const { error: vmaxError } = await supabase
          .from("VMAX")
          .update({ negotiation_status: null })
          .eq("id", debt.external_id)

        if (vmaxError) {
          console.error("[Cancel] ERROR updating VMAX by debt external_id:", vmaxError.message)
        } else {
          console.log("[Cancel] SUCCESS: VMAX cleared by debt external_id")
          vmaxUpdated = true
        }
      }
    }

    // Method 4: Search VMAX by customer CPF/CNPJ
    if (!vmaxUpdated) {
      let customerDoc: string | null = null

      // Get document from customer
      if (agreement?.customers?.document) {
        customerDoc = agreement.customers.document
      } else if (agreement?.customer_id || customerId) {
        const { data: customer } = await supabase
          .from("customers")
          .select("document")
          .eq("id", agreement?.customer_id || customerId)
          .single()

        customerDoc = customer?.document || null
      }

      if (customerDoc) {
        const normalizedDoc = customerDoc.replace(/\D/g, "")
        console.log("[Cancel] Searching VMAX by CPF/CNPJ:", normalizedDoc)

        // Search VMAX by CPF/CNPJ
        const { data: vmaxRecords, error: vmaxSearchError } = await supabase
          .from("VMAX")
          .select("id")
          .or(`"CPF/CNPJ".ilike.%${normalizedDoc}%,"CPF/CNPJ".eq.${normalizedDoc}`)
          .eq("id_company", companyId || agreement?.company_id)

        if (vmaxSearchError) {
          console.error("[Cancel] ERROR searching VMAX:", vmaxSearchError.message)
        } else if (vmaxRecords && vmaxRecords.length > 0) {
          console.log("[Cancel] Found", vmaxRecords.length, "VMAX records by CPF")
          for (const vmax of vmaxRecords) {
            const { error: updateErr } = await supabase
              .from("VMAX")
              .update({ negotiation_status: null })
              .eq("id", vmax.id)

            if (updateErr) {
              console.error("[Cancel] ERROR updating VMAX", vmax.id, ":", updateErr.message)
            } else {
              console.log("[Cancel] SUCCESS: VMAX", vmax.id, "cleared by CPF search")
              vmaxUpdated = true
            }
          }
        } else {
          console.log("[Cancel] No VMAX records found by CPF")
        }
      }
    }

    if (!vmaxUpdated) {
      console.log("[Cancel] WARNING: Could not find/update any VMAX record")
    }

    // ====== STEP 6: Delete ASAAS customer ======
    let asaasCustomerDeleted = false
    const asaasCustomerId = agreement?.asaas_customer_id

    if (asaasCustomerId && apiKey) {
      console.log("[Cancel] Attempting to delete ASAAS customer:", asaasCustomerId)
      try {
        const res = await fetch(`${asaasUrl}/customers/${asaasCustomerId}`, {
          method: "DELETE",
          headers: { "access_token": apiKey },
        })
        console.log("[Cancel] ASAAS customer delete status:", res.status)

        if (res.ok) {
          console.log("[Cancel] SUCCESS: ASAAS customer deleted")
          asaasCustomerDeleted = true
        } else if (res.status === 409) {
          // Customer has active charges — delete them first
          console.log("[Cancel] Customer has active charges, deleting them first...")
          const chargesRes = await fetch(
            `${asaasUrl}/payments?customer=${asaasCustomerId}`,
            { headers: { "access_token": apiKey } }
          )
          const charges = await chargesRes.json()

          for (const charge of (charges.data || [])) {
            if (charge.status !== "RECEIVED" && charge.status !== "CONFIRMED") {
              await fetch(`${asaasUrl}/payments/${charge.id}`, {
                method: "DELETE",
                headers: { "access_token": apiKey },
              })
              console.log("[Cancel] Deleted ASAAS charge:", charge.id)
            }
          }

          // Retry customer delete
          const retryRes = await fetch(`${asaasUrl}/customers/${asaasCustomerId}`, {
            method: "DELETE",
            headers: { "access_token": apiKey },
          })
          console.log("[Cancel] ASAAS customer retry delete status:", retryRes.status)
          if (retryRes.ok) {
            asaasCustomerDeleted = true
          }
        } else if (res.status === 404) {
          console.log("[Cancel] ASAAS customer already deleted (404)")
          asaasCustomerDeleted = true
        }
      } catch (e: any) {
        console.log("[Cancel] ASAAS customer delete failed:", e.message)
      }
    }

    // ====== STEP 7: ALWAYS search by CPF and delete ALL remaining ASAAS customers ======
    // (Multiple customers may have been created across multiple negotiations)
    let totalAsaasCustomersDeleted = asaasCustomerDeleted ? 1 : 0

    if (agreement?.customer_id && apiKey) {
      const { data: customer } = await supabase
        .from("customers")
        .select("document")
        .eq("id", agreement.customer_id)
        .single()

      if (customer?.document) {
        const cpf = customer.document.replace(/\D/g, "")
        console.log("[Cancel] Searching ASAAS for ALL customers with CPF:", cpf)

        let hasMore = true
        let offset = 0

        while (hasMore) {
          const searchRes = await fetch(
            `${asaasUrl}/customers?cpfCnpj=${cpf}&offset=${offset}&limit=100`,
            { headers: { "access_token": apiKey } }
          )
          const searchData = await searchRes.json()
          const customers = searchData.data || []

          console.log("[Cancel] Found", customers.length, "ASAAS customers with this CPF (offset:", offset, ")")

          for (const asaasCust of customers) {
            // Skip if this is the one we already deleted
            if (asaasCust.id === asaasCustomerId && asaasCustomerDeleted) {
              console.log("[Cancel] Skipping already deleted customer:", asaasCust.id)
              continue
            }

            // First delete all payments for this customer
            const paymentsRes = await fetch(
              `${asaasUrl}/payments?customer=${asaasCust.id}&limit=100`,
              { headers: { "access_token": apiKey } }
            )
            const paymentsData = await paymentsRes.json()

            let hasSettledPayment = false
            for (const payment of (paymentsData.data || [])) {
              if (payment.status !== "RECEIVED" && payment.status !== "CONFIRMED") {
                await fetch(`${asaasUrl}/payments/${payment.id}`, {
                  method: "DELETE",
                  headers: { "access_token": apiKey },
                })
                console.log("[Cancel] Deleted remaining ASAAS payment:", payment.id)
              } else {
                // Pagamento liquidado nunca é deletado (guard acima).
                hasSettledPayment = true
                console.log("[Cancel] Kept settled ASAAS payment:", payment.id, payment.status)
              }
            }

            // Guard anti-órfão: só deleta o customer se NÃO restar pagamento
            // liquidado (RECEIVED/CONFIRMED). Deletar um customer que ainda tem
            // pagamento pago deixaria esse pagamento órfão no ASAAS.
            if (hasSettledPayment) {
              console.log("[Cancel] Skipping customer delete (has settled payment):", asaasCust.id)
              continue
            }

            // Then delete the customer
            const delRes = await fetch(`${asaasUrl}/customers/${asaasCust.id}`, {
              method: "DELETE",
              headers: { "access_token": apiKey },
            })
            console.log("[Cancel] Deleted ASAAS customer:", asaasCust.id, "Name:", asaasCust.name, "Status:", delRes.status)
            if (delRes.ok || delRes.status === 404) {
              totalAsaasCustomersDeleted++
            }
          }

          hasMore = searchData.hasMore === true
          offset += 100
        }

        console.log("[Cancel] Total ASAAS customers deleted by CPF search:", totalAsaasCustomersDeleted)
      }
    }

    console.log("[Cancel] === CANCEL OPERATION COMPLETE ===")
    console.log("[Cancel] Summary:", {
      agreementsCancelled: cancelledAgreementsCount,
      asaasPaymentsDeleted: allAsaasPaymentIds.length,
      asaasCustomersDeleted: totalAsaasCustomersDeleted,
      vmaxCleared: vmaxUpdated,
    })
    console.log("=".repeat(60))

    return NextResponse.json({
      success: true,
      message: "Negotiation cancelled successfully",
      updated: {
        agreement: agreement?.id || null,
        agreementsCancelled: cancelledAgreementsCount,
        asaasPaymentsDeleted: allAsaasPaymentIds.length,
        asaasCustomersDeleted: totalAsaasCustomersDeleted,
        debt: debtIdToUpdate || null,
        vmax: vmaxUpdated,
      },
    })
  } catch (error: any) {
    console.error("[Cancel] FATAL ERROR:", error)
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}
