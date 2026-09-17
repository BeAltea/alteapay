import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { getServerSupabaseUrl } from "@/lib/supabase/url"
import { asaasSyncQueue } from "@/lib/queue"
import type { AsaasSyncJobData } from "@/lib/queue"

export const dynamic = "force-dynamic"

interface SyncRequest {
  asaasPaymentId: string
  agreementId: string
  debtId?: string
}

interface BatchSyncRequest {
  syncs: SyncRequest[]
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

    const body: BatchSyncRequest = await request.json()
    const { syncs, companyId, metadata } = body

    if (!syncs || !Array.isArray(syncs) || syncs.length === 0) {
      return NextResponse.json(
        { error: "syncs array is required and must not be empty" },
        { status: 400 }
      )
    }

    if (!companyId) {
      return NextResponse.json(
        { error: "companyId is required" },
        { status: 400 }
      )
    }

    console.log(`[BATCH-SYNC] Creating batch for ${syncs.length} syncs`)

    // Create batch record
    const { data: batch, error: batchError } = await supabase
      .from("asaas_batches")
      .insert({
        company_id: companyId,
        type: "sync",
        total_jobs: syncs.length,
        status: "pending",
        metadata: {
          ...metadata,
          createdVia: "api",
          syncCount: syncs.length,
        },
      })
      .select()
      .single()

    if (batchError || !batch) {
      console.error("[BATCH-SYNC] Failed to create batch:", batchError)
      return NextResponse.json(
        { error: "Failed to create batch record" },
        { status: 500 }
      )
    }

    console.log(`[BATCH-SYNC] Created batch ${batch.id}`)

    // Queue all jobs
    const jobs = syncs.map((sync, index) => ({
      name: `sync-${batch.id}-${index}`,
      data: {
        batchId: batch.id,
        jobIndex: index,
        asaasPaymentId: sync.asaasPaymentId,
        agreementId: sync.agreementId,
        debtId: sync.debtId,
        companyId,
      } as AsaasSyncJobData,
    }))

    await asaasSyncQueue.addBulk(jobs)

    console.log(`[BATCH-SYNC] Queued ${jobs.length} jobs for batch ${batch.id}`)

    return NextResponse.json({
      success: true,
      batchId: batch.id,
      totalJobs: syncs.length,
      message: `Batch created with ${syncs.length} sync(s). Processing will begin shortly.`,
    })
  } catch (error: any) {
    console.error("[BATCH-SYNC] Error:", error)
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}
