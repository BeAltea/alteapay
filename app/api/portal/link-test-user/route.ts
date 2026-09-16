import { createClient } from "@supabase/supabase-js"
import { NextResponse } from "next/server"
import { getServerSupabaseUrl } from "@/lib/supabase/url"

export const dynamic = "force-dynamic"

const supabaseAdmin = createClient(
  getServerSupabaseUrl(),
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: Request) {
  try {
    // Find usuario@alteapay.com in auth
    const {
      data: { users },
    } = await supabaseAdmin.auth.admin.listUsers()
    const targetUser = users?.find((u) => u.email === "usuario@alteapay.com")

    if (!targetUser) {
      return NextResponse.json(
        { error: "usuario@alteapay.com not found in auth.users" },
        { status: 404 }
      )
    }

    // Upsert final_client record
    const { data: existing } = await supabaseAdmin
      .from("final_clients")
      .select("id")
      .eq("document_number", "41719010811")
      .maybeSingle()

    if (existing) {
      // Update existing record
      await supabaseAdmin
        .from("final_clients")
        .update({
          user_id: targetUser.id,
          email: "usuario@alteapay.com",
          full_name: "Fabio Moura Barros",
        })
        .eq("id", existing.id)
    } else {
      // Check if there's one with the old email
      const { data: existingByEmail } = await supabaseAdmin
        .from("final_clients")
        .select("id")
        .eq("email", "usuario@alteapay.com")
        .maybeSingle()

      if (existingByEmail) {
        await supabaseAdmin
          .from("final_clients")
          .update({
            user_id: targetUser.id,
            document_number: "41719010811",
            document_type: "cpf",
            full_name: "Fabio Moura Barros",
          })
          .eq("id", existingByEmail.id)
      } else {
        // Create new record
        await supabaseAdmin.from("final_clients").insert({
          user_id: targetUser.id,
          email: "usuario@alteapay.com",
          full_name: "Fabio Moura Barros",
          document_type: "cpf",
          document_number: "41719010811",
          password_hash: null,
        })
      }
    }

    // Update auth user metadata
    await supabaseAdmin.auth.admin.updateUser(targetUser.id, {
      user_metadata: {
        ...targetUser.user_metadata,
        role: "final_client",
        document_type: "cpf",
        document_number: "41719010811",
        full_name: "Fabio Moura Barros",
      },
    })

    console.log(`[LINK-TEST-USER] Linked CPF 41719010811 to usuario@alteapay.com`)

    return NextResponse.json({
      success: true,
      user_id: targetUser.id,
      message: "Linked CPF 41719010811 to usuario@alteapay.com",
    })
  } catch (err: any) {
    console.error("[LINK-TEST-USER] Error:", err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
