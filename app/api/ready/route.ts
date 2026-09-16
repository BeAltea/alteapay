import { NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const supabase = createServiceClient()

    // Trivial query: head-only count of a single row from companies
    const { error } = await supabase
      .from("companies")
      .select("id", { count: "exact", head: true })
      .limit(1)

    if (error) {
      return NextResponse.json({ status: "not-ready", error: error.message }, { status: 503 })
    }

    return NextResponse.json({ status: "ready" }, { status: 200 })
  } catch (error: any) {
    return NextResponse.json(
      { status: "not-ready", error: error?.message || "Unknown error" },
      { status: 503 },
    )
  }
}
