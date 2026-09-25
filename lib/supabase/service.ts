import { createClient } from "@supabase/supabase-js"
import { getServerSupabaseUrl } from "./url"

/**
 * Client de service role (server-side).
 *
 * N1 (2026-09-25): o `fetch` interno do supabase-js é interceptado pelo Data
 * Cache do Next 14 em Route Handlers/serverless (Netlify "Durable"): a MESMA URL
 * de PostgREST (ex.: o prompt ativo da sessão) voltava congelada por dezenas de
 * minutos mesmo com `dynamic = "force-dynamic"`. Um client de service role
 * nunca deve servir leitura cacheada — por isso `cache: 'no-store'` passa a ser
 * o PADRÃO. A assinatura é mantida: `{ noStore: false }` é o opt-out explícito
 * (só para quem QUER o Data Cache, hoje ninguém).
 */
export function createServiceClient(opts?: { noStore?: boolean }) {
  const supabaseUrl = getServerSupabaseUrl()
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error("Missing Supabase service role credentials")
  }

  const noStore = opts?.noStore !== false

  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    ...(noStore
      ? {
          global: {
            fetch: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
              fetch(input, { ...init, cache: "no-store" }),
          },
        }
      : {}),
  })
}
