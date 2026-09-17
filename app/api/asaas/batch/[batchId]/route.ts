import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { getServerSupabaseUrl } from "@/lib/supabase/url"

export const dynamic = "force-dynamic"

interface BatchStatus {
  id: string
  type: string
  status: string
  totalJobs: number
  completedJobs: number
  failedJobs: number
  progress: number
  metadata: Record<string, any>
  results: any[]
  errors: any[]
  createdAt: string
  startedAt: string | null
  completedAt: string | null
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ batchId: string }> }
) {
  try {
    const supabaseUrl = getServerSupabaseUrl()
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

    if (!supabaseUrl || !supabaseServiceKey) {
      return NextResponse.json(
        { error: "Supabase credentials not configured" },
        { status: 500 }
      )
    }

    const { batchId } = await params

    if (!batchId) {
      return NextResponse.json(
        { error: "batchId is required" },
        { status: 400 }
      )
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false },
    })

    const { data: batch, error } = await supabase
      .from("asaas_batches")
      .select("*")
      .eq("id", batchId)
      .single()

    if (error || !batch) {
      return NextResponse.json(
        { error: "Batch not found" },
        { status: 404 }
      )
    }

    const progress =
      batch.total_jobs > 0
        ? Math.round(
            ((batch.completed_jobs + batch.failed_jobs) / batch.total_jobs) * 100
          )
        : 0

    const response: BatchStatus = {
      id: batch.id,
      type: batch.type,
      status: batch.status,
      totalJobs: batch.total_jobs,
      completedJobs: batch.completed_jobs,
      failedJobs: batch.failed_jobs,
      progress,
      metadata: batch.metadata || {},
      results: batch.results || [],
      errors: batch.errors || [],
      createdAt: batch.created_at,
      startedAt: batch.started_at,
      completedAt: batch.completed_at,
    }

    return NextResponse.json(response)
  } catch (error: any) {
    console.error("[BATCH-STATUS] Error:", error)
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}
