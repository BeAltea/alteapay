import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { headers } from "next/headers"
import { getServerSupabaseUrl } from "@/lib/supabase/url"

/**
 * ASAAS Notification Status Check
 *
 * Fetches payment view status from ASAAS for all active agreements
 * and updates the notification_viewed fields in the database.
 *
 * Called on Negociações page load to update visualization status.
 */

export const dynamic = "force-dynamic"
export const maxDuration = 60

const supabase = createClient(
  getServerSupabaseUrl(),
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const ASAAS_BASE_URL = process.env.ASAAS_API_URL || process.env.ASAAS_BASE_URL || "https://api.asaas.com/v3"

interface PaymentViewStatus {
  viewed: boolean
  viewedDate: string | null
  viewedChannel: string | null
}

async function getAsaasApiKey(): Promise<string> {
  // Try to get from environment
  const apiKey = process.env.ASAAS_API_KEY
  if (apiKey) return apiKey

  throw new Error("ASAAS_API_KEY not configured")
}

async function checkPaymentViewed(asaasPaymentId: string): Promise<PaymentViewStatus> {
  try {
    const apiKey = await getAsaasApiKey()

    // Fetch payment details from ASAAS
    const response = await fetch(`${ASAAS_BASE_URL}/payments/${asaasPaymentId}`, {
      headers: {
        "access_token": apiKey,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    })

    if (!response.ok) {
      console.error(`[ASAAS Check] Failed to fetch payment ${asaasPaymentId}: ${response.status}`)
      return { viewed: false, viewedDate: null, viewedChannel: null }
    }

    const contentType = response.headers.get("content-type") || ""
    if (!contentType.includes("application/json")) {
      console.error(`[ASAAS Check] Non-JSON response for payment ${asaasPaymentId}`)
      return { viewed: false, viewedDate: null, viewedChannel: null }
    }

    const payment = await response.json()

    // Check for viewed indicators
    // ASAAS may have fields like: viewedDate, lastViewed, invoiceViewedDate
    const viewedDate = payment.viewedDate || payment.lastViewed || payment.invoiceViewedDate || null

    return {
      viewed: !!viewedDate,
      viewedDate,
      viewedChannel: viewedDate ? "payment_link" : null,
    }
  } catch (error: any) {
    console.error(`[ASAAS Check] Error checking payment ${asaasPaymentId}:`, error.message)
    return { viewed: false, viewedDate: null, viewedChannel: null }
  }
}

async function checkNotificationHistory(asaasPaymentId: string): Promise<PaymentViewStatus> {
  try {
    const apiKey = await getAsaasApiKey()

    // Fetch notification history from ASAAS
    const response = await fetch(`${ASAAS_BASE_URL}/payments/${asaasPaymentId}/notifications`, {
      headers: {
        "access_token": apiKey,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    })

    if (!response.ok) {
      // 404 is normal if no notifications exist
      if (response.status !== 404) {
        console.error(`[ASAAS Check] Failed to fetch notifications for ${asaasPaymentId}: ${response.status}`)
      }
      return { viewed: false, viewedDate: null, viewedChannel: null }
    }

    const contentType = response.headers.get("content-type") || ""
    if (!contentType.includes("application/json")) {
      return { viewed: false, viewedDate: null, viewedChannel: null }
    }

    const data = await response.json()
    const notifications = data.data || data || []

    // Look for viewed notifications
    for (const notif of notifications) {
      if (notif.viewedDate || notif.viewed) {
        // Determine channel from notification type
        let channel = "unknown"
        if (notif.type?.toLowerCase().includes("whatsapp")) {
          channel = "whatsapp"
        } else if (notif.type?.toLowerCase().includes("sms")) {
          channel = "sms"
        } else if (notif.type?.toLowerCase().includes("email")) {
          channel = "email"
        }

        return {
          viewed: true,
          viewedDate: notif.viewedDate || notif.sentDate,
          viewedChannel: channel,
        }
      }
    }

    return { viewed: false, viewedDate: null, viewedChannel: null }
  } catch (error: any) {
    console.error(`[ASAAS Check] Error checking notifications for ${asaasPaymentId}:`, error.message)
    return { viewed: false, viewedDate: null, viewedChannel: null }
  }
}

export async function POST(request: NextRequest) {
  const startTime = Date.now()

  try {
    const body = await request.json()
    const { companyId, agreementIds } = body as {
      companyId?: string
      agreementIds?: string[]
    }

    if (!companyId && !agreementIds) {
      return NextResponse.json({ error: "companyId or agreementIds required" }, { status: 400 })
    }

    // Build query for agreements to check
    let query = supabase
      .from("agreements")
      .select("id, asaas_payment_id, notification_viewed")
      .not("asaas_payment_id", "is", null)

    if (companyId) {
      query = query.eq("company_id", companyId)
    }

    if (agreementIds && agreementIds.length > 0) {
      query = query.in("id", agreementIds)
    }

    // Only check agreements that haven't been marked as viewed yet
    query = query.or("notification_viewed.is.null,notification_viewed.eq.false")

    const { data: agreements, error: queryError } = await query

    if (queryError) {
      console.error("[ASAAS Check] Query error:", queryError)
      return NextResponse.json({ error: queryError.message }, { status: 500 })
    }

    if (!agreements || agreements.length === 0) {
      return NextResponse.json({
        success: true,
        checked: 0,
        updated: 0,
        message: "No pending agreements to check",
      })
    }

    console.log(`[ASAAS Check] Checking ${agreements.length} agreements...`)

    // Process in chunks to avoid rate limits
    const CHUNK_SIZE = 5
    let updatedCount = 0
    const results: { agreementId: string; viewed: boolean; error?: string }[] = []

    for (let i = 0; i < agreements.length; i += CHUNK_SIZE) {
      const chunk = agreements.slice(i, i + CHUNK_SIZE)

      const chunkResults = await Promise.allSettled(
        chunk.map(async (agreement) => {
          // First try payment view status
          let status = await checkPaymentViewed(agreement.asaas_payment_id)

          // If not viewed via payment, check notification history
          if (!status.viewed) {
            status = await checkNotificationHistory(agreement.asaas_payment_id)
          }

          if (status.viewed) {
            // Update the agreement
            const { error: updateError } = await supabase
              .from("agreements")
              .update({
                notification_viewed: true,
                notification_viewed_at: status.viewedDate || new Date().toISOString(),
                notification_viewed_channel: status.viewedChannel,
              })
              .eq("id", agreement.id)

            if (updateError) {
              console.error(`[ASAAS Check] Failed to update agreement ${agreement.id}:`, updateError)
              return { agreementId: agreement.id, viewed: true, error: updateError.message }
            }

            updatedCount++
            return { agreementId: agreement.id, viewed: true }
          }

          return { agreementId: agreement.id, viewed: false }
        })
      )

      // Collect results
      for (const result of chunkResults) {
        if (result.status === "fulfilled") {
          results.push(result.value)
        } else {
          results.push({ agreementId: "unknown", viewed: false, error: result.reason?.message })
        }
      }

      // Small delay between chunks to avoid rate limiting
      if (i + CHUNK_SIZE < agreements.length) {
        await new Promise(resolve => setTimeout(resolve, 200))
      }
    }

    const duration = Date.now() - startTime
    console.log(`[ASAAS Check] Completed in ${duration}ms: checked ${agreements.length}, updated ${updatedCount}`)

    return NextResponse.json({
      success: true,
      checked: agreements.length,
      updated: updatedCount,
      duration,
      results,
    })

  } catch (error: any) {
    console.error("[ASAAS Check] Error:", error)
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}

// GET endpoint for simple status check
export async function GET(request: NextRequest) {
  return NextResponse.json({
    status: "ok",
    message: "ASAAS notification check endpoint is active",
  })
}
