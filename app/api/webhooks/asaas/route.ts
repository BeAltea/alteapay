import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { getServerSupabaseUrl } from "@/lib/supabase/url"

/**
 * @deprecated This endpoint is kept for backward compatibility.
 * New integrations should use: POST /api/asaas/webhook/payments
 */

const supabase = createClient(getServerSupabaseUrl(), process.env.SUPABASE_SERVICE_ROLE_KEY!)

export async function POST(request: NextRequest) {
  try {
    // Validate webhook token if configured
    const webhookToken = process.env.ASAAS_WEBHOOK_TOKEN
    if (webhookToken) {
      const requestToken = request.headers.get("asaas-access-token")
      if (requestToken !== webhookToken) {
        console.error("[v0] Unauthorized - invalid webhook token")
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
      }
    }

    const body = await request.json()
    const { id: eventId, event, payment } = body

    console.log("[v0] Received Asaas webhook:", event, "eventId:", eventId)

    if (!payment?.id) {
      console.error("[v0] Invalid webhook payload - missing payment.id")
      return NextResponse.json({ error: "Invalid payload" }, { status: 400 })
    }

    // Check for duplicate events
    if (eventId) {
      const { data: existingEvent } = await supabase
        .from("asaas_webhook_events")
        .select("id")
        .eq("event_id", eventId)
        .maybeSingle()

      if (existingEvent) {
        console.log("[v0] Duplicate event, skipping:", eventId)
        return NextResponse.json({ success: true, message: "Duplicate event" })
      }
    }

    // Log webhook event
    await supabase.from("asaas_webhook_events").insert({
      event_id: eventId,
      event_type: event,
      payment_id: payment.id,
      customer_id: payment.customer,
      payload: body,
      processed: false,
    }).catch(() => {}) // Ignore errors (table might not exist yet)

    console.log("[v0] Processing event:", event, "for payment:", payment.id)
    console.log("[v0] Payment details:", {
      description: payment.description,
      externalReference: payment.externalReference,
      customer: payment.customer,
      value: payment.value,
    })

    let agreement = null
    let searchMethod = ""

    // Strategy 1: Direct payment ID match (most reliable)
    const { data: agreementByPaymentId } = await supabase
      .from("agreements")
      .select("*")
      .eq("asaas_payment_id", payment.id)
      .maybeSingle()

    if (agreementByPaymentId) {
      agreement = agreementByPaymentId
      searchMethod = "payment_id"
    }

    // Strategy 2: Subscription ID (for installment payments)
    if (!agreement && payment.subscription) {
      const { data: agreementBySubscription } = await supabase
        .from("agreements")
        .select("*")
        .eq("asaas_subscription_id", payment.subscription)
        .maybeSingle()

      if (agreementBySubscription) {
        agreement = agreementBySubscription
        searchMethod = "subscription_id"
      }
    }

    // Strategy 3: External reference with "agreement_" prefix
    if (!agreement && payment.externalReference?.startsWith("agreement_")) {
      const vmaxId = payment.externalReference.replace("agreement_", "")

      const { data: agreementByExternalRef } = await supabase
        .from("agreements")
        .select(`
          *,
          debts!inner(external_id)
        `)
        .eq("debts.external_id", vmaxId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()

      if (agreementByExternalRef) {
        agreement = agreementByExternalRef
        searchMethod = "external_reference"
      }
    }

    // Strategy 4: Search by Asaas customer ID
    if (!agreement && payment.customer) {
      const { data: agreementByCustomer } = await supabase
        .from("agreements")
        .select("*")
        .eq("asaas_customer_id", payment.customer)
        .eq("agreed_amount", payment.value)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()

      if (agreementByCustomer) {
        agreement = agreementByCustomer
        searchMethod = "customer_id_and_amount"

        // Update with payment ID for future lookups
        await supabase.from("agreements").update({ asaas_payment_id: payment.id }).eq("id", agreementByCustomer.id)
      }
    }

    // If no agreement found, check if this is a platform subscription payment (not debt agreement)
    if (!agreement) {
      console.log("[v0] No agreement found. Checking if this is a platform subscription...")

      // Platform subscriptions have descriptions like "Plano Premium", "Plano Básico", etc.
      const isPlatformSubscription =
        payment.description?.toLowerCase().includes("plano") ||
        payment.description?.toLowerCase().includes("assinatura")

      if (isPlatformSubscription) {
        console.log("[v0] This is a platform subscription payment, not a debt agreement. Ignoring.")
        return NextResponse.json({
          success: true,
          message: "Platform subscription payment - no action needed",
        })
      }

      console.error("[v0] Agreement not found for payment:", payment.id)
      console.error("[v0] Tried all search strategies: payment_id, subscription_id, external_reference, customer_id")
      return NextResponse.json({ error: "Agreement not found" }, { status: 404 })
    }

    console.log("[v0] Found agreement:", agreement.id, "via:", searchMethod)

    // Update agreement status based on payment event
    let paymentStatus = agreement.payment_status
    let agreementStatus = agreement.status
    let debtStatus: string | null = null

    switch (event) {
      case "PAYMENT_CREATED":
      case "PAYMENT_AWAITING_RISK_ANALYSIS":
        paymentStatus = "pending"
        break

      case "PAYMENT_CONFIRMED":
        paymentStatus = "confirmed"
        break

      case "PAYMENT_RECEIVED":
      case "PAYMENT_DUNNING_RECEIVED":
        paymentStatus = "received"
        agreementStatus = "paid"
        debtStatus = "paid"

        // Create notification for customer
        if (agreement.user_id) {
          await supabase.from("notifications").insert({
            user_id: agreement.user_id,
            company_id: agreement.company_id,
            type: "payment",
            title: "Pagamento Confirmado",
            description: `Seu pagamento de R$ ${payment.value?.toFixed(2) || agreement.agreed_amount?.toFixed(2)} foi confirmado com sucesso!`,
          })
        }

        console.log("[v0] Payment received for agreement:", agreement.id)
        break

      case "PAYMENT_OVERDUE":
      case "PAYMENT_DUNNING_REQUESTED":
        paymentStatus = "overdue"
        break

      case "PAYMENT_REFUNDED":
      case "PAYMENT_REFUND_REQUESTED":
        paymentStatus = "refunded"
        agreementStatus = "cancelled"
        debtStatus = "pending" // Revert to open
        break

      case "PAYMENT_DELETED":
        agreementStatus = "cancelled"
        debtStatus = "pending" // Revert to open
        break

      case "PAYMENT_CREDIT_CARD_CAPTURE_REFUSED":
        paymentStatus = "failed"
        break

      case "PAYMENT_UPDATED":
        // Just update the details, don't change status
        break
    }

    // Update debt status if needed
    if (debtStatus && agreement.debt_id) {
      await supabase.from("debts").update({ status: debtStatus, updated_at: new Date().toISOString() }).eq("id", agreement.debt_id)
    }

    // Build agreement update object
    const agreementUpdate: Record<string, any> = {
      payment_status: paymentStatus,
      status: agreementStatus,
      asaas_status: payment.status,
      asaas_last_webhook_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }

    // Add payment details from ASAAS
    if (payment.billingType) agreementUpdate.asaas_billing_type = payment.billingType
    if (payment.netValue) agreementUpdate.asaas_net_value = payment.netValue
    if (payment.invoiceUrl) agreementUpdate.asaas_invoice_url = payment.invoiceUrl
    if (payment.paymentDate || payment.clientPaymentDate) {
      agreementUpdate.asaas_payment_date = payment.paymentDate || payment.clientPaymentDate
    }
    if (event === "PAYMENT_RECEIVED" || event === "PAYMENT_DUNNING_RECEIVED") {
      agreementUpdate.payment_received_at = new Date().toISOString()
    }

    // Update agreement
    const { error: updateError } = await supabase
      .from("agreements")
      .update(agreementUpdate)
      .eq("id", agreement.id)

    if (updateError) {
      console.error("[v0] Error updating agreement:", updateError)
      throw updateError
    }

    // Mark webhook event as processed
    if (eventId) {
      await supabase
        .from("asaas_webhook_events")
        .update({
          processed: true,
          processed_at: new Date().toISOString(),
          agreement_id: agreement.id
        })
        .eq("event_id", eventId)
        .catch(() => {}) // Ignore errors
    }

    console.log("[v0] Agreement updated successfully:", agreement.id, {
      paymentStatus,
      agreementStatus,
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("[v0] Error processing Asaas webhook:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
