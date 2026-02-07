import { createClient } from "@supabase/supabase-js"
import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"

// Test users configuration
const TEST_PASSWORD = "Gj4gx3h4wUruEdXZ"

const testUsers = [
  {
    email: "relacionamento@alteapay.com",
    fullName: "Relacionamento Altea Pay",
    role: "super_admin" as const,
    companyName: null,
    dashboard: "/super-admin",
  },
  {
    email: "cliente-test@alteapay.com",
    fullName: "Admin VMAX",
    role: "admin" as const,
    companyName: "VMAX",
    dashboard: "/dashboard",
  },
  {
    email: "usuario@alteapay.com",
    fullName: "Joao da Silva",
    role: "user" as const,
    companyName: "VMAX",
    dashboard: "/user-dashboard",
  },
]

function getSupabaseAdmin() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error("Missing Supabase environment variables")
  }

  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  })
}

async function findVmaxCompany(supabase: ReturnType<typeof getSupabaseAdmin>): Promise<string | null> {
  // Try to find VMAX company by name
  const { data: companies, error } = await supabase
    .from("companies")
    .select("id, name")
    .ilike("name", "%VMAX%")
    .limit(1)

  if (!error && companies && companies.length > 0) {
    return companies[0].id
  }

  // If not found, get the first available company
  const { data: firstCompany } = await supabase
    .from("companies")
    .select("id, name")
    .limit(1)
    .single()

  return firstCompany?.id || null
}

async function createOrUpdateUser(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  email: string,
  password: string,
  fullName: string,
  role: "super_admin" | "admin" | "user",
  companyId: string | null
): Promise<{ success: boolean; userId?: string; error?: string }> {
  try {
    // Check if user already exists by email
    const { data: existingUsers, error: listError } = await supabase.auth.admin.listUsers()

    if (listError) {
      throw new Error(`Failed to list users: ${listError.message}`)
    }

    const existingUser = existingUsers.users.find((u) => u.email === email)

    if (existingUser) {
      // Update the user's password and ensure email is confirmed
      await supabase.auth.admin.updateUserById(existingUser.id, {
        password: password,
        email_confirm: true,
        user_metadata: { full_name: fullName },
      })

      // Update profile
      const { error: updateProfileError } = await supabase
        .from("profiles")
        .upsert(
          {
            id: existingUser.id,
            email: email,
            full_name: fullName,
            role: role,
            company_id: companyId,
          },
          { onConflict: "id" }
        )

      if (updateProfileError) {
        throw new Error(`Failed to update profile: ${updateProfileError.message}`)
      }

      return { success: true, userId: existingUser.id }
    }

    // Create new auth user
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: email,
      password: password,
      email_confirm: true,
      user_metadata: {
        full_name: fullName,
      },
    })

    if (authError || !authData.user) {
      throw new Error(`Failed to create auth user: ${authError?.message || "Unknown error"}`)
    }

    // Create profile record
    const { error: profileError } = await supabase.from("profiles").insert({
      id: authData.user.id,
      email: email,
      full_name: fullName,
      role: role,
      company_id: companyId,
    })

    if (profileError) {
      // Profile might already exist from a trigger, try to update instead
      if (profileError.code === "23505") {
        await supabase
          .from("profiles")
          .update({
            email: email,
            full_name: fullName,
            role: role,
            company_id: companyId,
          })
          .eq("id", authData.user.id)
      } else {
        throw new Error(`Failed to create profile: ${profileError.message}`)
      }
    }

    return { success: true, userId: authData.user.id }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    return { success: false, error: message }
  }
}

export async function POST() {
  try {
    console.log("[seed-test-users] Starting...")

    const supabase = getSupabaseAdmin()

    // Find VMAX company for admin and user
    const vmaxCompanyId = await findVmaxCompany(supabase)
    console.log("[seed-test-users] VMAX company ID:", vmaxCompanyId)

    const results = []

    for (const user of testUsers) {
      const companyId = user.role === "super_admin" ? null : (user.companyName === "VMAX" ? vmaxCompanyId : null)

      const result = await createOrUpdateUser(supabase, user.email, TEST_PASSWORD, user.fullName, user.role, companyId)

      results.push({
        email: user.email,
        role: user.role,
        dashboard: user.dashboard,
        ...result,
      })

      console.log(`[seed-test-users] ${user.email}: ${result.success ? "OK" : result.error}`)
    }

    const allSuccess = results.every((r) => r.success)

    return NextResponse.json({
      success: allSuccess,
      message: allSuccess ? "All test users created/updated successfully!" : "Some users failed to create",
      users: results,
      credentials: {
        password: TEST_PASSWORD,
        logins: [
          { email: "relacionamento@alteapay.com", role: "super_admin", dashboard: "/super-admin" },
          { email: "cliente-test@alteapay.com", role: "admin", dashboard: "/dashboard" },
          { email: "usuario@alteapay.com", role: "user", dashboard: "/user-dashboard" },
        ],
      },
    })
  } catch (error) {
    console.error("[seed-test-users] Error:", error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    )
  }
}

// GET method for easier testing from browser
export async function GET() {
  return POST()
}
