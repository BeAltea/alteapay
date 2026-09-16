import { createServerClient } from "@supabase/ssr"
import { cookies } from "next/headers"
import { getServerSupabaseUrl } from "./url"

export async function createSupabaseServerClient() {
  const cookieStore = await cookies()

  return createServerClient(getServerSupabaseUrl(), process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options))
        } catch {
          // The "setAll" method was called from a Server Component.
          // This can be ignored if you have middleware refreshing
          // user sessions.
        }
      },
    },
  })
}

export async function createSupabaseServiceClient() {
  const cookieStore = await cookies()

  return createServerClient(
    getServerSupabaseUrl(),
    process.env.SUPABASE_SERVICE_ROLE_KEY!, // Service role bypassa RLS
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options))
          } catch {
            // Ignorar erros de cookie em Server Components
          }
        },
      },
    },
  )
}

export async function getCurrentUser() {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return user
}

export async function getCurrentUserProfile() {
  console.log("[v0] Getting current user profile")
  const user = await getCurrentUser()

  if (!user) {
    console.log("[v0] No user found")
    return null
  }

  console.log("[v0] User found, fetching profile for ID:", user.id)

  try {
    const supabase = await createSupabaseServiceClient()

    const { data: profile, error } = await supabase
      .from("profiles")
      .select("*, companies(name)")
      .eq("id", user.id)
      .single()

    if (error) {
      console.log("[v0] Profile fetch error:", error)

      if (error.code === "PGRST116") {
        // No rows found
        console.log("[v0] Creating profile for user:", user.email)

        const { data: newProfile, error: insertError } = await supabase
          .from("profiles")
          .insert({
            id: user.id,
            email: user.email,
            role: "user", // Default role
            full_name: user.user_metadata?.full_name || null,
            company_id: null,
          })
          .select("*, companies(name)")
          .single()

        if (insertError) {
          console.log("[v0] Error creating profile:", insertError)
          return null
        }

        console.log("[v0] Profile created successfully:", newProfile)
        return newProfile
      }

      return null
    }

    console.log("[v0] Profile found:", profile)
    return profile
  } catch (error) {
    console.log("[v0] Profile fetch exception:", error)
    return null
  }
}

export async function isAdmin() {
  const profile = await getCurrentUserProfile()
  return profile?.role === "admin"
}

export async function isSuperAdmin() {
  const profile = await getCurrentUserProfile()
  return profile?.role === "super_admin"
}

export async function requireAdmin() {
  const adminStatus = await isAdmin()
  if (!adminStatus) {
    throw new Error("Admin access required")
  }
  return true
}

export async function requireSuperAdmin() {
  const superAdminStatus = await isSuperAdmin()
  if (!superAdminStatus) {
    throw new Error("Super admin access required")
  }
  return true
}

export async function requireUser() {
  const profile = await getCurrentUserProfile()
  if (!profile || profile.role !== "user") {
    throw new Error("User access required")
  }
  return profile
}

export async function isUser() {
  const profile = await getCurrentUserProfile()
  return profile?.role === "user"
}

export async function getUserRole() {
  const profile = await getCurrentUserProfile()
  return profile?.role || null
}

export async function redirectBasedOnRole() {
  const role = await getUserRole()

  if (role === "super_admin") {
    return "/super-admin"
  } else if (role === "admin") {
    return "/dashboard"
  } else if (role === "user") {
    return "/user-dashboard"
  }

  return "/auth/login"
}

export async function getUserCompany() {
  const profile = await getCurrentUserProfile()
  if (!profile?.company_id) return null

  const supabase = await createSupabaseServerClient()
  const { data: company } = await supabase.from("companies").select("*").eq("id", profile.company_id).single()

  return company
}

export async function canAccessCompany(companyId: string) {
  const profile = await getCurrentUserProfile()

  // Super admins can access all companies
  if (profile?.role === "super_admin") {
    return true
  }

  // Regular admins and users can only access their own company
  return profile?.company_id === companyId
}

export async function getAccessibleCompanies() {
  const profile = await getCurrentUserProfile()
  const supabase = await createSupabaseServerClient()

  if (profile?.role === "super_admin") {
    // Super admins can see all companies
    const { data: companies } = await supabase.from("companies").select("*").order("name")
    return companies || []
  } else if (profile?.company_id) {
    // Regular users can only see their own company
    const { data: company } = await supabase.from("companies").select("*").eq("id", profile.company_id).single()
    return company ? [company] : []
  }

  return []
}
