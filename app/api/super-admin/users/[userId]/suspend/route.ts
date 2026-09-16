import { createClient } from "@supabase/supabase-js"
import { createClient as createServerClient } from "@/lib/supabase/server"
import { NextRequest, NextResponse } from "next/server"
import { getServerSupabaseUrl } from "@/lib/supabase/url"

export const dynamic = "force-dynamic"

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    const { userId } = await params
    const { action } = await request.json()

    if (!action || !["suspend", "reactivate"].includes(action)) {
      return NextResponse.json(
        { error: "Invalid action. Use 'suspend' or 'reactivate'" },
        { status: 400 }
      )
    }

    // 1. Verify current user is authenticated and is super_admin
    const authSupabase = await createServerClient()
    const { data: { user: currentUser } } = await authSupabase.auth.getUser()

    if (!currentUser) {
      return NextResponse.json({ error: "Não autenticado" }, { status: 401 })
    }

    const { data: currentProfile } = await authSupabase
      .from("profiles")
      .select("role")
      .eq("id", currentUser.id)
      .single()

    if (currentProfile?.role !== "super_admin") {
      return NextResponse.json({ error: "Sem permissão" }, { status: 403 })
    }

    // 2. Cannot modify your own account
    if (userId === currentUser.id) {
      return NextResponse.json(
        { error: "Você não pode suspender sua própria conta" },
        { status: 403 }
      )
    }

    // Create admin client for user management
    const supabaseAdmin = createClient(
      getServerSupabaseUrl(),
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    // 3. Verify target user exists and is NOT a super_admin
    const { data: targetProfile } = await supabaseAdmin
      .from("profiles")
      .select("role, full_name, email")
      .eq("id", userId)
      .single()

    if (!targetProfile) {
      return NextResponse.json({ error: "Usuário não encontrado" }, { status: 404 })
    }

    if (targetProfile.role === "super_admin") {
      return NextResponse.json(
        { error: "Não é possível suspender um Super Admin" },
        { status: 403 }
      )
    }

    // 4. Perform the action
    if (action === "suspend") {
      // Ban the user in Supabase Auth (876000h ≈ 100 years)
      const { error: authError } = await supabaseAdmin.auth.admin.updateUserById(userId, {
        ban_duration: "876000h",
      })

      if (authError) {
        console.error("[Suspend] Auth error:", authError)
        return NextResponse.json({ error: authError.message }, { status: 500 })
      }

      console.log(`[Suspend] User ${userId} (${targetProfile.email}) suspended by ${currentUser.email}`)
    } else if (action === "reactivate") {
      // Remove ban
      const { error: authError } = await supabaseAdmin.auth.admin.updateUserById(userId, {
        ban_duration: "none",
      })

      if (authError) {
        console.error("[Reactivate] Auth error:", authError)
        return NextResponse.json({ error: authError.message }, { status: 500 })
      }

      console.log(`[Reactivate] User ${userId} (${targetProfile.email}) reactivated by ${currentUser.email}`)
    }

    return NextResponse.json({
      success: true,
      action,
      userId,
      userName: targetProfile.full_name,
    })
  } catch (error: any) {
    console.error("[Suspend/Reactivate] Error:", error)
    return NextResponse.json(
      { error: error.message || "Erro interno" },
      { status: 500 }
    )
  }
}
