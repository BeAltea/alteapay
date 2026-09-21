import { createClient } from "@supabase/supabase-js"
import { getServerSupabaseUrl } from "./url"

/**
 * @param opts.noStore injeta `fetch` com `cache: 'no-store'` — para leituras que
 *   NÃO podem ser cacheadas pelo Data Cache do Next (ex.: flags MUTÁVEIS do link
 *   público `public_link_enabled`/`public_link_valid_until`, que precisam
 *   refletir ligar/DESLIGAR em tempo real, inclusive rollback/kill rápido).
 */
export function createServiceClient(opts?: { noStore?: boolean }) {
  const supabaseUrl = getServerSupabaseUrl()
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error("Missing Supabase service role credentials")
  }

  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    ...(opts?.noStore
      ? {
          global: {
            fetch: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
              fetch(input, { ...init, cache: "no-store" }),
          },
        }
      : {}),
  })
}
