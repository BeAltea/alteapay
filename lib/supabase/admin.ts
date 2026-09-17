import { createClient } from "@supabase/supabase-js"
import { getServerSupabaseUrl } from "./url"

export function createAdminClient() {
  const supabaseUrl = getServerSupabaseUrl()
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error("Missing Supabase environment variables for admin client")
  }

  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  })
}
