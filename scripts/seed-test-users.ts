/**
 * Seed Test Users Script
 *
 * Creates 3 test users with different roles:
 * 1. Super Admin - relacionamento@alteapay.com
 * 2. Company Admin - cliente-test@alteapay.com (linked to VMAX company)
 * 3. End Customer - usuario@alteapay.com (linked as VMAX client)
 *
 * Usage:
 *   npx tsx scripts/seed-test-users.ts
 *
 * Or via API:
 *   POST /api/seed-test-users
 */

import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !supabaseServiceKey) {
  console.error("Missing Supabase environment variables")
  console.error("Required: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY")
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  },
})

// Test users configuration
const TEST_PASSWORD = "Gj4gx3h4wUruEdXZ"

const testUsers = [
  {
    email: "relacionamento@alteapay.com",
    fullName: "Relacionamento Altea Pay",
    role: "super_admin" as const,
    companyId: null, // Super admins have global access
    dashboard: "/super-admin",
  },
  {
    email: "cliente-test@alteapay.com",
    fullName: "Admin VMAX",
    role: "admin" as const,
    companyName: "VMAX", // Will be resolved to company_id
    dashboard: "/dashboard",
  },
  {
    email: "usuario@alteapay.com",
    fullName: "Joao da Silva",
    role: "user" as const,
    companyName: "VMAX", // Will be resolved to company_id
    dashboard: "/user-dashboard",
  },
]

async function findVmaxCompany(): Promise<string | null> {
  console.log("[seed] Looking for VMAX company...")

  // Try to find VMAX company by name
  const { data: companies, error } = await supabase
    .from("companies")
    .select("id, name")
    .ilike("name", "%VMAX%")
    .limit(1)

  if (error) {
    console.error("[seed] Error finding VMAX company:", error)
    return null
  }

  if (companies && companies.length > 0) {
    console.log(`[seed] Found VMAX company: ${companies[0].name} (${companies[0].id})`)
    return companies[0].id
  }

  // If not found, get the first available company
  const { data: firstCompany, error: firstError } = await supabase
    .from("companies")
    .select("id, name")
    .limit(1)
    .single()

  if (firstError || !firstCompany) {
    console.warn("[seed] No companies found in database. Admin user will be created without company association.")
    return null
  }

  console.log(`[seed] Using first available company: ${firstCompany.name} (${firstCompany.id})`)
  return firstCompany.id
}

async function findOrCreateVmaxClient(companyId: string, userId: string): Promise<void> {
  console.log("[seed] Looking for existing VMAX client to link...")

  // Try to find an existing VMAX record to link
  const { data: vmaxRecord, error: vmaxError } = await supabase
    .from("VMAX")
    .select("id, Cliente, \"CPF/CNPJ\"")
    .eq("id_company", companyId)
    .limit(1)
    .single()

  if (vmaxRecord && !vmaxError) {
    console.log(`[seed] Found VMAX client: ${vmaxRecord.Cliente}`)
    // Update profile with cpf_cnpj from VMAX record
    const { error: updateError } = await supabase
      .from("profiles")
      .update({ cpf_cnpj: vmaxRecord["CPF/CNPJ"] })
      .eq("id", userId)

    if (updateError) {
      console.warn("[seed] Warning: Could not update profile with CPF/CNPJ:", updateError)
    }
  } else {
    console.log("[seed] No VMAX records found, user will see empty dashboard")
  }
}

async function createOrUpdateUser(
  email: string,
  password: string,
  fullName: string,
  role: "super_admin" | "admin" | "user",
  companyId: string | null
): Promise<{ success: boolean; userId?: string; error?: string }> {
  console.log(`\n[seed] Processing user: ${email} (${role})`)

  try {
    // Check if user already exists by email
    const { data: existingUsers, error: listError } = await supabase.auth.admin.listUsers()

    if (listError) {
      throw new Error(`Failed to list users: ${listError.message}`)
    }

    const existingUser = existingUsers.users.find(u => u.email === email)

    if (existingUser) {
      console.log(`[seed] User ${email} already exists, updating profile...`)

      // Update the user's password and ensure email is confirmed
      const { error: updateAuthError } = await supabase.auth.admin.updateUserById(
        existingUser.id,
        {
          password: password,
          email_confirm: true,
          user_metadata: { full_name: fullName },
        }
      )

      if (updateAuthError) {
        console.warn(`[seed] Warning: Could not update auth user: ${updateAuthError.message}`)
      }

      // Update profile
      const { error: updateProfileError } = await supabase
        .from("profiles")
        .upsert({
          id: existingUser.id,
          email: email,
          full_name: fullName,
          role: role,
          company_id: companyId,
        }, { onConflict: "id" })

      if (updateProfileError) {
        throw new Error(`Failed to update profile: ${updateProfileError.message}`)
      }

      console.log(`[seed] Updated existing user: ${email}`)
      return { success: true, userId: existingUser.id }
    }

    // Create new auth user
    console.log(`[seed] Creating new user: ${email}`)
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: email,
      password: password,
      email_confirm: true, // This bypasses email verification
      user_metadata: {
        full_name: fullName,
      },
    })

    if (authError) {
      throw new Error(`Failed to create auth user: ${authError.message}`)
    }

    if (!authData.user) {
      throw new Error("Auth user was not created")
    }

    console.log(`[seed] Auth user created: ${authData.user.id}`)

    // Create profile record
    const { error: profileError } = await supabase
      .from("profiles")
      .insert({
        id: authData.user.id,
        email: email,
        full_name: fullName,
        role: role,
        company_id: companyId,
      })

    if (profileError) {
      // Profile might already exist from a trigger, try to update instead
      if (profileError.code === "23505") { // Unique violation
        const { error: updateError } = await supabase
          .from("profiles")
          .update({
            email: email,
            full_name: fullName,
            role: role,
            company_id: companyId,
          })
          .eq("id", authData.user.id)

        if (updateError) {
          throw new Error(`Failed to update profile: ${updateError.message}`)
        }
      } else {
        throw new Error(`Failed to create profile: ${profileError.message}`)
      }
    }

    console.log(`[seed] Profile created for: ${email}`)
    return { success: true, userId: authData.user.id }

  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error(`[seed] Error processing user ${email}:`, message)
    return { success: false, error: message }
  }
}

async function seedTestUsers() {
  console.log("=" .repeat(60))
  console.log("SEED TEST USERS")
  console.log("=" .repeat(60))
  console.log("")
  console.log("Creating 3 test users:")
  console.log("  1. Super Admin: relacionamento@alteapay.com")
  console.log("  2. Company Admin: cliente-test@alteapay.com")
  console.log("  3. End Customer: usuario@alteapay.com")
  console.log(`  Password for all: ${TEST_PASSWORD}`)
  console.log("")

  // Find VMAX company for admin and user
  const vmaxCompanyId = await findVmaxCompany()

  const results = []

  for (const user of testUsers) {
    const companyId = user.role === "super_admin"
      ? null
      : (user.companyName === "VMAX" ? vmaxCompanyId : null)

    const result = await createOrUpdateUser(
      user.email,
      TEST_PASSWORD,
      user.fullName,
      user.role,
      companyId
    )

    // For user role, try to link to VMAX client
    if (result.success && result.userId && user.role === "user" && vmaxCompanyId) {
      await findOrCreateVmaxClient(vmaxCompanyId, result.userId)
    }

    results.push({
      email: user.email,
      role: user.role,
      dashboard: user.dashboard,
      ...result,
    })
  }

  console.log("\n" + "=" .repeat(60))
  console.log("RESULTS")
  console.log("=" .repeat(60))

  let allSuccess = true
  for (const result of results) {
    const status = result.success ? "OK" : "FAILED"
    console.log(`  [${status}] ${result.email} (${result.role}) -> ${result.dashboard}`)
    if (!result.success) {
      console.log(`       Error: ${result.error}`)
      allSuccess = false
    }
  }

  console.log("")
  console.log("=" .repeat(60))

  if (allSuccess) {
    console.log("All users created/updated successfully!")
    console.log("")
    console.log("You can now log in with:")
    console.log("  Email: relacionamento@alteapay.com -> /super-admin")
    console.log("  Email: cliente-test@alteapay.com -> /dashboard")
    console.log("  Email: usuario@alteapay.com -> /user-dashboard")
    console.log(`  Password: ${TEST_PASSWORD}`)
  } else {
    console.log("Some users failed to create. Check the errors above.")
  }

  console.log("=" .repeat(60))

  return results
}

// Run if executed directly
seedTestUsers()
  .then((results) => {
    const allSuccess = results.every(r => r.success)
    process.exit(allSuccess ? 0 : 1)
  })
  .catch((error) => {
    console.error("Fatal error:", error)
    process.exit(1)
  })
