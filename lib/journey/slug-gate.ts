// Correção B10 (A2, ALTO) — gate do caminho GENÉRICO /t/{slug} NA ROTA de auth.
//
// O middleware só protege as PÁGINAS (/t/...) e pula /api/, então um
// `POST /api/chat/auth {tenantSlug, document, consent:true}` era aceito direto
// mesmo com `journey_public_enabled=false` (modo admin-only). Agora a rota
// replica a regra do middleware: tenant com jornada pública LIGADA → passa;
// desligada ou sem config → só admin/super_admin autenticado (preview). Quem não
// passa recebe a MESMA resposta de slug inexistente (404), sem revelar o tenant.
import type { NextRequest } from "next/server"
import { createServerClient } from "@supabase/ssr"
import { createServiceClient } from "@/lib/supabase/service"
import { getServerSupabaseUrl } from "@/lib/supabase/url"

/** journey_public_enabled do tenant (sem config = desligado). */
export async function isJourneyPublicEnabled(companyId: string): Promise<boolean> {
  try {
    const supabase = createServiceClient()
    const { data } = await supabase
      .from("tenant_chat_config")
      .select("journey_public_enabled")
      .eq("company_id", companyId)
      .maybeSingle()
    return (data as { journey_public_enabled?: boolean | null } | null)?.journey_public_enabled === true
  } catch {
    return false
  }
}

/** true se a request vem de um usuário admin/super_admin autenticado (preview). */
export async function requestIsJourneyAdmin(req: NextRequest): Promise<boolean> {
  try {
    const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    if (!anon) return false
    const auth = createServerClient(getServerSupabaseUrl(), anon, {
      cookies: { getAll: () => req.cookies.getAll(), setAll: () => {} },
    })
    const { data: { user } } = await auth.auth.getUser()
    if (!user) return false
    const service = createServiceClient()
    const { data: profile } = await service.from("profiles").select("role").eq("id", user.id).maybeSingle()
    const role = (profile as { role?: string } | null)?.role
    return role === "admin" || role === "super_admin"
  } catch {
    return false
  }
}

/** O caminho /t/{slug} pode autenticar por documento para este tenant? */
export async function slugAuthAllowed(req: NextRequest, companyId: string): Promise<boolean> {
  if (await isJourneyPublicEnabled(companyId)) return true
  return requestIsJourneyAdmin(req)
}
