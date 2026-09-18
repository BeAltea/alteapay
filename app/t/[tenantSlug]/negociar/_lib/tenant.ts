// Contexto white-label do endpoint GENÉRICO por slug (N1). Espelha
// (journey)/c/[token]/_lib/tenant.ts, mas resolve o tenant pelo SLUG (não por
// token). Nunca expõe PII: só nome/branding/políticas e a flag de abertura.
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveCompanyBySlug } from "@/lib/journey/resolver"

export interface GenericJourneyBranding {
  brandName: string
  brandPrimaryColor: string
  brandSecondaryColor: string
  logoUrl: string | null
}

export interface GenericJourneyTenant {
  companyId: string
  slug: string
  branding: GenericJourneyBranding
  privacyPolicyUrl: string | null
  dpoContact: string | null
  journeyPublicEnabled: boolean
}

const DEFAULT_PRIMARY = "#0f172a"
const DEFAULT_SECONDARY = "#2563eb"

export type LoadGenericTenantResult =
  | { ok: true; tenant: GenericJourneyTenant }
  | { ok: false }

/** Resolve o tenant pelo slug. null/erro → { ok:false } → a página faz notFound(). */
export async function loadGenericTenant(slug: string): Promise<LoadGenericTenantResult> {
  const companyId = await resolveCompanyBySlug(slug)
  if (!companyId) return { ok: false }

  const supabase = createServiceClient()
  const [{ data: cfg }, { data: company }] = await Promise.all([
    supabase
      .from("tenant_chat_config")
      .select("company_id, branding, privacy_policy_url, dpo_contact, journey_public_enabled")
      .eq("company_id", companyId)
      .maybeSingle(),
    supabase.from("companies").select("name").eq("id", companyId).maybeSingle(),
  ])

  const branding = (cfg?.branding ?? {}) as Record<string, unknown>
  const brandName =
    (typeof branding.brand_name === "string" && branding.brand_name) || company?.name || "Credor"

  return {
    ok: true,
    tenant: {
      companyId,
      slug: slug.trim().toLowerCase(),
      branding: {
        brandName,
        brandPrimaryColor:
          (typeof branding.brand_primary_color === "string" && branding.brand_primary_color) ||
          DEFAULT_PRIMARY,
        brandSecondaryColor:
          (typeof branding.brand_secondary_color === "string" && branding.brand_secondary_color) ||
          DEFAULT_SECONDARY,
        logoUrl: (typeof branding.logo_url === "string" && branding.logo_url) || null,
      },
      privacyPolicyUrl: cfg?.privacy_policy_url ?? null,
      dpoContact: cfg?.dpo_contact ?? null,
      journeyPublicEnabled: Boolean(cfg?.journey_public_enabled),
    },
  }
}
