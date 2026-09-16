import { createServerClient } from "@supabase/ssr"
import { cookies } from "next/headers"
import { getServerSupabaseUrl } from "./url"

/**
 * Especially important if using Fluid compute: Don't put this client in a
 * global variable. Always create a new client within each function when using
 * it.
 */
export async function createClient() {
  try {
    const cookieStore = await cookies()

    if (!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
      throw new Error("Missing Supabase environment variables")
    }

    const client = createServerClient(getServerSupabaseUrl(), process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options))
          } catch {
            // Ignorar erro esperado em Server Components
          }
        },
      },
    })

    return client
  } catch (error) {
    throw error
  }
}

export function createAdminClient() {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY environment variable")
  }

  return createServerClient(getServerSupabaseUrl(), process.env.SUPABASE_SERVICE_ROLE_KEY, {
    cookies: {
      getAll() {
        return []
      },
      setAll() {
        // No-op for admin client
      },
    },
  })
}

export { createClient as createServerClient }
