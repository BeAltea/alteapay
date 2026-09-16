import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { getServerSupabaseUrl } from "@/lib/supabase/url"
import { asaasChargeCreateQueue } from "@/lib/queue"
import type { AsaasChargeCreateJobData } from "@/lib/queue"

export const dynamic = "force-dynamic"

interface ChargeRequest {
  customer: {
    name: string
    cpfCnpj: string
    email?: string
    phone?: string
    mobilePhone?: string
    postalCode?: string
    address?: string
    addressNumber?: string
    province?: string
  }
  payment: {
    billingType: "BOLETO" | "PIX" | "CREDIT_CARD" | "UNDEFINED"
    value: number
    dueDate: string
    description?: string
    externalReference?: string
    installmentCount?: number
    installmentValue?: number
  }
  agreementId?: string
  debtId?: string
  sendEmail?: boolean
  emailTemplate?: {
    subject: string
    html: string
  }
}

interface BatchChargesRequest {
  charges: ChargeRequest[]
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

    const body: BatchChargesRequest = await request.json()
    const { charges, companyId, metadata } = body

    if (!charges || !Array.isArray(charges) || charges.length === 0) {
      return NextResponse.json(
        { error: "charges array is required and must not be empty" },
        { status: 400 }
      )
    }

    if (!companyId) {
      return NextResponse.json(
        { error: "companyId is required" },
        { status: 400 }
      )
    }

    console.log(`[BATCH-CHARGES] Creating batch for ${charges.length} charges`)

    // Create batch record
    const { data: batch, error: batchError } = await supabase
      .from("asaas_batches")
      .insert({
        company_id: companyId,
        type: "charge_create",
        total_jobs: charges.length,
        status: "pending",
        metadata: {
          ...metadata,
          createdVia: "api",
          chargeCount: charges.length,
        },
      })
      .select()
      .single()

    if (batchError || !batch) {
      console.error("[BATCH-CHARGES] Failed to create batch:", batchError)
      return NextResponse.json(
        { error: "Failed to create batch record" },
        { status: 500 }
      )
    }

    console.log(`[BATCH-CHARGES] Created batch ${batch.id}`)

    // Queue all jobs
    const jobs = charges.map((charge, index) => ({
      name: `charge-create-${batch.id}-${index}`,
      data: {
        batchId: batch.id,
        jobIndex: index,
        customer: charge.customer,
        payment: charge.payment,
        agreementId: charge.agreementId,
        debtId: charge.debtId,
        companyId,
        sendEmail: charge.sendEmail,
        emailTemplate: charge.emailTemplate,
      } as AsaasChargeCreateJobData,
    }))

    await asaasChargeCreateQueue.addBulk(jobs)

    console.log(`[BATCH-CHARGES] Queued ${jobs.length} jobs for batch ${batch.id}`)

    return NextResponse.json({
      success: true,
      batchId: batch.id,
      totalJobs: charges.length,
      message: `Batch created with ${charges.length} charge(s). Processing will begin shortly.`,
    })
  } catch (error: any) {
    console.error("[BATCH-CHARGES] Error:", error)
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}
