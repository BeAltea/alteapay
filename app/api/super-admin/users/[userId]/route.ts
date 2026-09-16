import { createClient } from "@supabase/supabase-js"
import { createClient as createServerClient } from "@/lib/supabase/server"
import { NextRequest, NextResponse } from "next/server"
import { getServerSupabaseUrl } from "@/lib/supabase/url"

export const dynamic = "force-dynamic"

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    const { userId } = await params

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

    // 2. Cannot delete your own account
    if (userId === currentUser.id) {
      return NextResponse.json(
        { error: "Você não pode excluir sua própria conta" },
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
        { error: "Não é possível excluir um Super Admin" },
        { status: 403 }
      )
    }

    // 4. Delete profile record first (before auth deletion)
    const { error: profileError } = await supabaseAdmin
      .from("profiles")
      .delete()
      .eq("id", userId)

    if (profileError) {
      console.error("[Delete] Profile delete error:", profileError)
      // Continue anyway - the auth user deletion is more important
    }

    // 5. Delete from Supabase Auth
    const { error: authError } = await supabaseAdmin.auth.admin.deleteUser(userId)

    if (authError) {
      console.error("[Delete] Auth delete error:", authError)
      return NextResponse.json({ error: authError.message }, { status: 500 })
    }

    console.log(`[Delete] User ${userId} (${targetProfile.email}) deleted by ${currentUser.email}`)

    return NextResponse.json({
      success: true,
      userId,
      userName: targetProfile.full_name,
    })
  } catch (error: any) {
    console.error("[Delete User] Error:", error)
    return NextResponse.json(
      { error: error.message || "Erro interno" },
      { status: 500 }
    )
  }
}
