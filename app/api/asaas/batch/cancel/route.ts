import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { getServerSupabaseUrl } from "@/lib/supabase/url"
import { asaasChargeCancelQueue } from "@/lib/queue"
import type { AsaasChargeCancelJobData } from "@/lib/queue"

export const dynamic = "force-dynamic"

interface CancelRequest {
  asaasPaymentId: string
  agreementId?: string
  debtId?: string
  reason?: string
}

interface BatchCancelRequest {
  cancellations: CancelRequest[]
  companyId: string
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

    const body: BatchCancelRequest = await request.json()
    const { cancellations, companyId, metadata } = body

    if (!cancellations || !Array.isArray(cancellations) || cancellations.length === 0) {
      return NextResponse.json(
        { error: "cancellations array is required and must not be empty" },
        { status: 400 }
      )
    }

    if (!companyId) {
      return NextResponse.json(
        { error: "companyId is required" },
        { status: 400 }
      )
    }

    console.log(`[BATCH-CANCEL] Creating batch for ${cancellations.length} cancellations`)

    // Create batch record
    const { data: batch, error: batchError } = await supabase
      .from("asaas_batches")
      .insert({
        company_id: companyId,
        type: "charge_cancel",
        total_jobs: cancellations.length,
        status: "pending",
        metadata: {
          ...metadata,
          createdVia: "api",
          cancellationCount: cancellations.length,
        },
      })
      .select()
      .single()

    if (batchError || !batch) {
      console.error("[BATCH-CANCEL] Failed to create batch:", batchError)
      return NextResponse.json(
        { error: "Failed to create batch record" },
        { status: 500 }
      )
    }

    console.log(`[BATCH-CANCEL] Created batch ${batch.id}`)

    // Queue all jobs
    const jobs = cancellations.map((cancel, index) => ({
      name: `charge-cancel-${batch.id}-${index}`,
      data: {
        batchId: batch.id,
        jobIndex: index,
        asaasPaymentId: cancel.asaasPaymentId,
        agreementId: cancel.agreementId,
        debtId: cancel.debtId,
        companyId,
        reason: cancel.reason,
      } as AsaasChargeCancelJobData,
    }))

    await asaasChargeCancelQueue.addBulk(jobs)

    console.log(`[BATCH-CANCEL] Queued ${jobs.length} jobs for batch ${batch.id}`)

    return NextResponse.json({
      success: true,
      batchId: batch.id,
      totalJobs: cancellations.length,
      message: `Batch created with ${cancellations.length} cancellation(s). Processing will begin shortly.`,
    })
  } catch (error: any) {
    console.error("[BATCH-CANCEL] Error:", error)
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}
