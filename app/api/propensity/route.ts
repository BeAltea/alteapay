import { type NextRequest, NextResponse } from "next/server"
import { createServerClient } from "@supabase/ssr"
import { propensityEngine, type DebtData } from "@/lib/propensity-engine"
import { getServerSupabaseUrl } from "@/lib/supabase/url"

export async function POST(request: NextRequest) {
  try {
    const supabase = createServerClient(getServerSupabaseUrl(), process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            request.cookies.set(name, value)
          })
        },
      },
    })

    // Get authenticated user
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const body = await request.json()
    const { debtIds, mode = "single" } = body

    if (!debtIds || (Array.isArray(debtIds) && debtIds.length === 0)) {
      return NextResponse.json({ error: "Debt IDs are required" }, { status: 400 })
    }

    // Fetch debt data from database
    const { data: debts, error: debtsError } = await supabase
      .from("debts_with_overdue")
      .select(`
        id,
        amount,
        days_overdue,
        classification,
        customer_id,
        customers!inner(id)
      `)
      .in("id", Array.isArray(debtIds) ? debtIds : [debtIds])
      .eq("user_id", user.id)

    if (debtsError) {
      console.error("Error fetching debts:", debtsError)
      return NextResponse.json({ error: "Failed to fetch debts" }, { status: 500 })
    }

    if (!debts || debts.length === 0) {
      return NextResponse.json({ error: "No debts found" }, { status: 404 })
    }

    // Get customer history for better scoring
    const customerIds = debts.map((debt) => debt.customer_id)
    const { data: customerStats } = await supabase
      .from("debts")
      .select("customer_id, status")
      .in("customer_id", customerIds)
      .eq("user_id", user.id)

    // Group stats by customer
    const customerHistory = new Map()
    if (customerStats) {
      customerStats.forEach((stat) => {
        if (!customerHistory.has(stat.customer_id)) {
          customerHistory.set(stat.customer_id, { total: 0, paid: 0 })
        }
        const history = customerHistory.get(stat.customer_id)
        history.total++
        if (stat.status === "paid") {
          history.paid++
        }
      })
    }

    // Prepare debt data for propensity engine
    const debtData: DebtData[] = debts.map((debt) => ({
      id: debt.id,
      amount: Number(debt.amount),
      daysOverdue: debt.days_overdue || 0,
      classification: debt.classification,
      customerHistory: customerHistory.has(debt.customer_id)
        ? {
            totalDebts: customerHistory.get(debt.customer_id).total,
            paidDebts: customerHistory.get(debt.customer_id).paid,
            avgPaymentDelay: 0, // Could be calculated from payment history
          }
        : undefined,
    }))

    let results: Map<string, any>

    if (mode === "batch" && debtData.length > 1) {
      // Batch processing
      results = await propensityEngine.calculateBatchScores(debtData)
    } else {
      // Single processing
      results = new Map()
      for (const debt of debtData) {
        const scores = await propensityEngine.calculateScores(debt)
        results.set(debt.id, scores)
      }
    }

    // Update database with new scores
    const updates = Array.from(results.entries()).map(([debtId, scores]) => ({
      id: debtId,
      propensity_payment_score: scores.paymentScore,
      propensity_loan_score: scores.loanScore,
      last_score_update: new Date().toISOString(),
    }))

    const { error: updateError } = await supabase.from("debts").upsert(updates, { onConflict: "id" })

    if (updateError) {
      console.error("Error updating scores:", updateError)
      return NextResponse.json({ error: "Failed to update scores" }, { status: 500 })
    }

    // Return results
    const response = Array.from(results.entries()).map(([debtId, scores]) => ({
      debtId,
      ...scores,
    }))

    return NextResponse.json({
      success: true,
      results: mode === "single" ? response[0] : response,
      updatedAt: new Date().toISOString(),
    })
  } catch (error) {
    console.error("Propensity API error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

// GET endpoint to retrieve current scores
export async function GET(request: NextRequest) {
  try {
    const supabase = createServerClient(getServerSupabaseUrl(), process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            request.cookies.set(name, value)
          })
        },
      },
    })

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const debtId = searchParams.get("debtId")

    let query = supabase
      .from("debts")
      .select("id, propensity_payment_score, propensity_loan_score, last_score_update")
      .eq("user_id", user.id)

    if (debtId) {
      query = query.eq("id", debtId)
    }

    const { data: scores, error } = await query

    if (error) {
      return NextResponse.json({ error: "Failed to fetch scores" }, { status: 500 })
    }

    return NextResponse.json({ scores })
  } catch (error) {
    console.error("Get propensity scores error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
