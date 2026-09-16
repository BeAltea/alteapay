import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { getServerSupabaseUrl } from "@/lib/supabase/url"

/**
 * ASAAS Payment Webhook Endpoint
 *
 * Receives real-time payment status updates from ASAAS.
 *
 * Webhook Configuration in ASAAS Dashboard:
 * - URL: https://your-domain.com/api/asaas/webhook/payments
 * - Events: PAYMENT_CREATED, PAYMENT_RECEIVED, PAYMENT_CONFIRMED,
 *           PAYMENT_OVERDUE, PAYMENT_DELETED, PAYMENT_REFUNDED, PAYMENT_UPDATED
 * - Access Token: Set same value as ASAAS_WEBHOOK_TOKEN in .env
 */

const supabase = createClient(
  getServerSupabaseUrl(),
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Status mappings based on ASAAS events
const PAYMENT_STATUS_MAP: Record<string, string> = {
  PAYMENT_CREATED: "pending",
  PAYMENT_AWAITING_RISK_ANALYSIS: "pending",
  PAYMENT_PENDING: "pending",
  PAYMENT_CONFIRMED: "confirmed",
  PAYMENT_RECEIVED: "received",
  PAYMENT_OVERDUE: "overdue",
  PAYMENT_REFUNDED: "refunded",
  PAYMENT_REFUND_REQUESTED: "refund_requested",
  PAYMENT_CHARGEBACK_REQUESTED: "chargeback_requested",
  PAYMENT_CHARGEBACK_DISPUTE: "chargeback_dispute",
  PAYMENT_AWAITING_CHARGEBACK_REVERSAL: "chargeback_dispute",
  PAYMENT_DUNNING_RECEIVED: "received",
  PAYMENT_DUNNING_REQUESTED: "overdue",
  PAYMENT_CREDIT_CARD_CAPTURE_REFUSED: "failed",
  PAYMENT_DELETED: "deleted",
  PAYMENT_RESTORED: "pending",
  PAYMENT_UPDATED: null, // Will not change status, just update details
  PAYMENT_CHECKOUT_VIEWED: null, // Notification viewed event
  PAYMENT_VIEWED: null, // Alternative viewed event name
}

// Agreement status based on payment events
// Note: "completed" is the valid status value, not "paid"
const AGREEMENT_STATUS_MAP: Record<string, string | null> = {
  PAYMENT_RECEIVED: "completed",
  PAYMENT_DUNNING_RECEIVED: "completed",
  PAYMENT_CONFIRMED: null, // Keep current status
  PAYMENT_OVERDUE: null, // Keep current status, just update payment_status
  PAYMENT_REFUNDED: "cancelled",
  PAYMENT_DELETED: "cancelled",
  PAYMENT_CREDIT_CARD_CAPTURE_REFUSED: null, // Keep current status
}

// Debt status based on payment events
const DEBT_STATUS_MAP: Record<string, string | null> = {
  PAYMENT_RECEIVED: "paid",
  PAYMENT_DUNNING_RECEIVED: "paid",
  PAYMENT_REFUNDED: "pending", // Revert to open
  PAYMENT_DELETED: "pending", // Revert to open
}

export async function POST(request: NextRequest) {
  const startTime = Date.now()

  try {
    // 1. Validate webhook token (if configured)
    const webhookToken = process.env.ASAAS_WEBHOOK_TOKEN
    if (webhookToken) {
      const requestToken = request.headers.get("asaas-access-token")
      if (requestToken !== webhookToken) {
        console.error("[ASAAS Webhook] Unauthorized - invalid token")
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
      }
    }

    // 2. Parse the webhook payload
    const body = await request.json()
    const { id: eventId, event, payment } = body

    console.log("[ASAAS Webhook] Received:", event, "eventId:", eventId, "paymentId:", payment?.id)

    if (!payment?.id) {
      console.error("[ASAAS Webhook] Invalid payload - missing payment.id")
      return NextResponse.json({ error: "Invalid payload" }, { status: 400 })
    }

    // 3. Check for duplicate events (deduplication)
    if (eventId) {
      const { data: existingEvent } = await supabase
        .from("asaas_webhook_events")
        .select("id, processed")
        .eq("event_id", eventId)
        .maybeSingle()

      if (existingEvent) {
        console.log("[ASAAS Webhook] Duplicate event, skipping:", eventId)
        return NextResponse.json({
          success: true,
          message: "Duplicate event - already processed"
        }, { status: 200 })
      }
    }

    // 4. Log the event (before processing for audit trail)
    const { data: webhookEvent, error: logError } = await supabase
      .from("asaas_webhook_events")
      .insert({
        event_id: eventId,
        event_type: event,
        payment_id: payment.id,
        customer_id: payment.customer,
        payload: body,
        processed: false,
      })
      .select()
      .single()

    if (logError) {
      // If it's a unique constraint violation, it's a duplicate
      if (logError.code === "23505") {
        console.log("[ASAAS Webhook] Duplicate event (constraint), skipping:", eventId)
        return NextResponse.json({
          success: true,
          message: "Duplicate event"
        }, { status: 200 })
      }
      console.error("[ASAAS Webhook] Error logging event:", logError)
      // Continue processing even if logging fails
    }

    // 5. Find the matching agreement
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
        .select(`*, debts!inner(external_id)`)
        .eq("debts.external_id", vmaxId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()

      if (agreementByExternalRef) {
        agreement = agreementByExternalRef
        searchMethod = "external_reference"
      }
    }

    // Strategy 4: Search by Asaas customer ID + amount
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
        await supabase
          .from("agreements")
          .update({ asaas_payment_id: payment.id })
          .eq("id", agreementByCustomer.id)
      }
    }

    // 6. If no agreement found, check if it's a platform subscription
    if (!agreement) {
      const isPlatformSubscription =
        payment.description?.toLowerCase().includes("plano") ||
        payment.description?.toLowerCase().includes("assinatura")

      if (isPlatformSubscription) {
        console.log("[ASAAS Webhook] Platform subscription, ignoring")

        // Mark as processed (no action needed)
        if (webhookEvent?.id) {
          await supabase
            .from("asaas_webhook_events")
            .update({
              processed: true,
              processed_at: new Date().toISOString()
            })
            .eq("id", webhookEvent.id)
        }

        return NextResponse.json({
          success: true,
          message: "Platform subscription - no action needed",
        })
      }

      console.error("[ASAAS Webhook] Agreement not found for payment:", payment.id)

      // Mark event as processed with error
      if (webhookEvent?.id) {
        await supabase
          .from("asaas_webhook_events")
          .update({
            processed: true,
            processed_at: new Date().toISOString(),
            error_message: "Agreement not found"
          })
          .eq("id", webhookEvent.id)
      }

      return NextResponse.json({ error: "Agreement not found" }, { status: 404 })
    }

    console.log("[ASAAS Webhook] Found agreement:", agreement.id, "via:", searchMethod)

    // 7. Determine new statuses based on event type
    const newPaymentStatus = PAYMENT_STATUS_MAP[event] ?? agreement.payment_status
    const newAgreementStatus = AGREEMENT_STATUS_MAP[event] ?? agreement.status
    const newDebtStatus = DEBT_STATUS_MAP[event]

    // 8. Build the update object for agreement
    const agreementUpdate: Record<string, any> = {
      asaas_status: payment.status,
      asaas_last_webhook_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }

    if (newPaymentStatus) {
      agreementUpdate.payment_status = newPaymentStatus
    }

    if (newAgreementStatus) {
      agreementUpdate.status = newAgreementStatus
    }

    // Add payment details from ASAAS
    if (payment.billingType) {
      agreementUpdate.asaas_billing_type = payment.billingType
    }
    if (payment.netValue) {
      agreementUpdate.asaas_net_value = payment.netValue
    }
    if (payment.invoiceUrl) {
      agreementUpdate.asaas_invoice_url = payment.invoiceUrl
    }
    if (payment.paymentDate || payment.clientPaymentDate) {
      agreementUpdate.asaas_payment_date = payment.paymentDate || payment.clientPaymentDate
    }
    // Sync due date from ASAAS (in case it was changed)
    if (payment.dueDate) {
      agreementUpdate.due_date = payment.dueDate
    }

    // Set payment_received_at for received/confirmed events
    if (event === "PAYMENT_RECEIVED" || event === "PAYMENT_CONFIRMED" || event === "PAYMENT_DUNNING_RECEIVED") {
      agreementUpdate.payment_received_at = new Date().toISOString()
    }

    // Handle notification/payment viewed events
    if (event === "PAYMENT_CHECKOUT_VIEWED" || event === "PAYMENT_VIEWED") {
      agreementUpdate.notification_viewed = true
      agreementUpdate.notification_viewed_at = new Date().toISOString()
      agreementUpdate.notification_viewed_channel = "payment_link"
      console.log("[ASAAS Webhook] Payment viewed for agreement:", agreement.id)
    }

    // 9. Update the agreement
    const { error: updateError } = await supabase
      .from("agreements")
      .update(agreementUpdate)
      .eq("id", agreement.id)

    if (updateError) {
      console.error("[ASAAS Webhook] Error updating agreement:", updateError)
      throw updateError
    }

    // 10. Update debt status if needed
    if (newDebtStatus && agreement.debt_id) {
      await supabase
        .from("debts")
        .update({
          status: newDebtStatus,
          updated_at: new Date().toISOString()
        })
        .eq("id", agreement.debt_id)
    }

    // 11. Update VMAX record if linked via debt
    if (newDebtStatus && agreement.debt_id) {
      // Get the debt to find VMAX external_id
      const { data: debt } = await supabase
        .from("debts")
        .select("external_id")
        .eq("id", agreement.debt_id)
        .maybeSingle()

      if (debt?.external_id) {
        // Update VMAX record
        // Both PAYMENT_RECEIVED and PAYMENT_CONFIRMED are "paid" states
        const vmaxUpdate: Record<string, any> = {
          negotiation_status: (event === "PAYMENT_RECEIVED" || event === "PAYMENT_CONFIRMED") ? "PAGO" :
                              event === "PAYMENT_OVERDUE" ? "EM_ATRASO" :
                              event === "PAYMENT_DELETED" || event === "PAYMENT_REFUNDED" ? "CANCELADA" :
                              "EM_ANDAMENTO",
        }

        await supabase
          .from("VMAX")
          .update(vmaxUpdate)
          .eq("id", debt.external_id)
      }
    }

    // 12. Create notification for payment events
    if (agreement.user_id && (
      event === "PAYMENT_RECEIVED" ||
      event === "PAYMENT_CONFIRMED" ||
      event === "PAYMENT_OVERDUE"
    )) {
      const notificationConfig: Record<string, { title: string; description: string }> = {
        PAYMENT_RECEIVED: {
          title: "Pagamento Confirmado",
          description: `Seu pagamento de R$ ${payment.value?.toFixed(2)} foi confirmado com sucesso!`
        },
        PAYMENT_CONFIRMED: {
          title: "Pagamento em Processamento",
          description: `Seu pagamento de R$ ${payment.value?.toFixed(2)} está sendo processado.`
        },
        PAYMENT_OVERDUE: {
          title: "Pagamento em Atraso",
          description: `Seu pagamento de R$ ${payment.value?.toFixed(2)} está em atraso. Por favor, regularize.`
        }
      }

      const notification = notificationConfig[event]
      if (notification) {
        await supabase.from("notifications").insert({
          user_id: agreement.user_id,
          company_id: agreement.company_id,
          type: "payment",
          title: notification.title,
          description: notification.description,
        })
      }
    }

    // 13. Mark webhook event as processed
    if (webhookEvent?.id) {
      await supabase
        .from("asaas_webhook_events")
        .update({
          processed: true,
          processed_at: new Date().toISOString(),
          agreement_id: agreement.id
        })
        .eq("id", webhookEvent.id)
    }

    const duration = Date.now() - startTime
    console.log("[ASAAS Webhook] Processed successfully in", duration, "ms:", {
      event,
      agreementId: agreement.id,
      paymentStatus: newPaymentStatus,
      agreementStatus: newAgreementStatus,
    })

    return NextResponse.json({ success: true })

  } catch (error: any) {
    console.error("[ASAAS Webhook] Error:", error)
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}

// Handle GET requests (for webhook verification)
export async function GET(request: NextRequest) {
  return NextResponse.json({
    status: "ok",
    message: "ASAAS webhook endpoint is active"
  })
}
