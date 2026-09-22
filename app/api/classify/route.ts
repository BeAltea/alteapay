import { createClient } from "@/lib/supabase/server"
import { ClassificationEngine, createClassificationCriteria } from "@/lib/classification-engine"
import { type NextRequest, NextResponse } from "next/server"

export const dynamic = "force-dynamic"

// `debts` não tem coluna `days_overdue` no schema real — computa-se a partir de
// `due_date` (dias inteiros de atraso, nunca negativo).
function daysOverdueFrom(dueDate: string | null): number {
  if (!dueDate) return 0
  const due = Date.parse(dueDate)
  if (!Number.isFinite(due)) return 0
  const diff = Date.now() - due
  return Math.max(0, Math.floor(diff / 86_400_000))
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()

    // Get authenticated user
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const body = await request.json()
    const { debtIds } = body

    // Get debts to classify
    let query = supabase
      .from("debts")
      .select(`
        id,
        amount,
        due_date,
        customer_id,
        customers (
          id,
          name,
          email,
          document
        )
      `)
      .eq("user_id", user.id)

    if (debtIds && debtIds.length > 0) {
      query = query.in("id", debtIds)
    }

    const { data: debts, error: debtsError } = await query

    if (debtsError) {
      console.error("Error fetching debts:", debtsError)
      return NextResponse.json({ error: "Failed to fetch debts" }, { status: 500 })
    }

    if (!debts || debts.length === 0) {
      return NextResponse.json({ message: "No debts found to classify" })
    }

    // Initialize classification engine
    const classificationEngine = new ClassificationEngine()

    // Classify each debt
    const classifications = []
    for (const debt of debts) {
      const criteria = createClassificationCriteria({
        daysOverdue: daysOverdueFrom(debt.due_date),
        currentAmount: debt.amount,
        // In a real implementation, you would fetch customer history here
        customerHistory: {
          previousPayments: 0,
          averageDelayDays: 0,
          totalDebts: 1,
          paymentBehavior: "average" as const,
        },
      })

      const result = classificationEngine.classify(criteria)
      classifications.push({
        debtId: debt.id,
        classification: result.classification,
        score: result.score,
        appliedRule: result.appliedRule,
      })

      // Update debt classification in database
      await supabase.from("debts").update({ classification: result.classification }).eq("id", debt.id)
    }

    // Get classification stats
    const criteriaList = debts.map((debt) =>
      createClassificationCriteria({
        daysOverdue: daysOverdueFrom(debt.due_date),
        currentAmount: debt.amount,
      }),
    )
    const stats = classificationEngine.getClassificationStats(criteriaList)

    return NextResponse.json({
      success: true,
      message: `${classifications.length} debts classified successfully`,
      classifications,
      stats,
    })
  } catch (error) {
    console.error("Classification error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient()

    // Get authenticated user
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Get classification statistics
    const { data: debts, error } = await supabase
      .from("debts")
      .select("classification, amount")
      .eq("user_id", user.id)

    if (error) {
      console.error("Error fetching debts:", error)
      return NextResponse.json({ error: "Failed to fetch debts" }, { status: 500 })
    }

    const stats = {
      total: debts.length,
      low: debts.filter((d) => d.classification === "low").length,
      medium: debts.filter((d) => d.classification === "medium").length,
      high: debts.filter((d) => d.classification === "high").length,
      critical: debts.filter((d) => d.classification === "critical").length,
      totalAmount: debts.reduce((sum, debt) => sum + (debt.amount || 0), 0),
    }

    return NextResponse.json({ stats })
  } catch (error) {
    console.error("Classification stats error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
