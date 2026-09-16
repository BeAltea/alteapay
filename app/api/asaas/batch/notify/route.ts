import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { getServerSupabaseUrl } from "@/lib/supabase/url"
import { asaasNotificationQueue } from "@/lib/queue"
import type { AsaasNotificationJobData } from "@/lib/queue"

export const dynamic = "force-dynamic"

interface NotifyRequest {
  asaasPaymentId: string
  channels?: {
    sms?: boolean
    whatsapp?: boolean
    email?: boolean
  }
  agreementId?: string
  customerId?: string
}

interface BatchNotifyRequest {
  notifications: NotifyRequest[]
  companyId: string
  defaultChannels?: {
    sms?: boolean
    whatsapp?: boolean
    email?: boolean
  }
  metadata?: Record<string, any>
}

export async function POST(request: NextRequest) {
  try {
    const supabaseUrl = getServerSupabaseUrl()
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

    if (!supabaseUrl || !supabaseServiceKey) {
      return NextResponse.json(
        { error: "Supabase credentials not configured" },
        { status: 500 }
      )
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false },
    })

    const body: BatchNotifyRequest = await request.json()
    const { notifications, companyId, defaultChannels, metadata } = body

    if (!notifications || !Array.isArray(notifications) || notifications.length === 0) {
      return NextResponse.json(
        { error: "notifications array is required and must not be empty" },
        { status: 400 }
      )
    }

    if (!companyId) {
      return NextResponse.json(
        { error: "companyId is required" },
        { status: 400 }
      )
    }

    // Default channels: WhatsApp + SMS enabled, email disabled (we use SendGrid)
    const defaultChannelConfig = defaultChannels || {
      sms: true,
      whatsapp: true,
      email: false,
    }

    console.log(`[BATCH-NOTIFY] Creating batch for ${notifications.length} notifications`)

    // Create batch record
    const { data: batch, error: batchError } = await supabase
      .from("asaas_batches")
      .insert({
        company_id: companyId,
        type: "notification",
        total_jobs: notifications.length,
        status: "pending",
        metadata: {
          ...metadata,
          createdVia: "api",
          notificationCount: notifications.length,
          defaultChannels: defaultChannelConfig,
        },
      })
      .select()
      .single()

    if (batchError || !batch) {
      console.error("[BATCH-NOTIFY] Failed to create batch:", batchError)
      return NextResponse.json(
        { error: "Failed to create batch record" },
        { status: 500 }
      )
    }

    console.log(`[BATCH-NOTIFY] Created batch ${batch.id}`)

    // Queue all jobs
    const jobs = notifications.map((notify, index) => ({
      name: `notification-${batch.id}-${index}`,
      data: {
        batchId: batch.id,
        jobIndex: index,
        asaasPaymentId: notify.asaasPaymentId,
        channels: notify.channels || defaultChannelConfig,
        agreementId: notify.agreementId,
        customerId: notify.customerId,
        companyId,
      } as AsaasNotificationJobData,
    }))

    await asaasNotificationQueue.addBulk(jobs)

    console.log(`[BATCH-NOTIFY] Queued ${jobs.length} jobs for batch ${batch.id}`)

    return NextResponse.json({
      success: true,
      batchId: batch.id,
      totalJobs: notifications.length,
      message: `Batch created with ${notifications.length} notification(s). Processing will begin shortly.`,
    })
  } catch (error: any) {
    console.error("[BATCH-NOTIFY] Error:", error)
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}
