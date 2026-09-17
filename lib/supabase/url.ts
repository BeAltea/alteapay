/**
 * Server-side Supabase URL resolver.
 *
 * The browser reaches Supabase via NEXT_PUBLIC_SUPABASE_URL (baked into the
 * client bundle, e.g. http://127.0.0.1:54321). When the app runs inside a
 * Kubernetes pod, server-side code may need a different network path to the
 * SAME Supabase instance (e.g. http://host.orb.internal:54321). Set
 * SUPABASE_URL to override the address used by server-side clients only;
 * when unset, server code falls back to the public URL.
 */
export function getServerSupabaseUrl(): string {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL

  if (!url) {
    throw new Error(
      "Missing Supabase URL: set SUPABASE_URL (server-side override) or NEXT_PUBLIC_SUPABASE_URL",
    )
  }

  return url
}
