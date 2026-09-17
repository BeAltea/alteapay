// Carregamento server-side do contexto white-label a partir do token do link.
// Nunca expõe PII: só nome/branding/políticas do tenant e as flags de auth.
import "server-only"
import { validateToken } from "@/lib/journey/tokens"
import { createServiceClient } from "@/lib/supabase/service"

export interface JourneyBranding {
  brandName: string
  brandPrimaryColor: string
  brandSecondaryColor: string
  logoUrl: string | null
}

export interface JourneyTenantContext {
  companyId: string
  branding: JourneyBranding
  privacyPolicyUrl: string | null
  dpoContact: string | null
  officialChannelUrl: string | null
  officialChannelLabel: string | null
  journeyPublicEnabled: boolean
  authRequireBirthDate: boolean
  receiptFooterText: string | null
}

const DEFAULT_PRIMARY = "#0f172a"
const DEFAULT_SECONDARY = "#2563eb"

export type TokenFailReason = "not_found" | "expired" | "revoked" | "exhausted"

export type LoadTenantResult =
  | { ok: true; tenant: JourneyTenantContext }
  | { ok: false; reason: TokenFailReason }

/**
 * Valida o token e resolve o contexto do tenant para a UI white-label.
 * Retorno neutro em erro: o layout mostra a página "link indisponível".
 */
export async function loadJourneyTenant(token: string): Promise<LoadTenantResult> {
  const tv = await validateToken(token)
  if (!tv.ok) return { ok: false, reason: tv.reason }

  const supabase = createServiceClient()
  const [{ data: cfg }, { data: company }] = await Promise.all([
    supabase
      .from("tenant_chat_config")
      .select(
        "company_id, branding, privacy_policy_url, dpo_contact, official_channel_url, official_channel_label, journey_public_enabled, auth_require_birth_date, receipt_footer_text",
      )
      .eq("company_id", tv.tokenRow.company_id)
      .maybeSingle(),
    supabase.from("companies").select("name").eq("id", tv.tokenRow.company_id).maybeSingle(),
  ])

  const branding = (cfg?.branding ?? {}) as Record<string, unknown>
  const brandName =
    (typeof branding.brand_name === "string" && branding.brand_name) ||
    company?.name ||
    "Credor"

  return {
    ok: true,
    tenant: {
      companyId: tv.tokenRow.company_id,
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
      officialChannelUrl: cfg?.official_channel_url ?? null,
      officialChannelLabel: cfg?.official_channel_label ?? null,
      journeyPublicEnabled: Boolean(cfg?.journey_public_enabled),
      authRequireBirthDate: Boolean(cfg?.auth_require_birth_date),
      receiptFooterText: cfg?.receipt_footer_text ?? null,
    },
  }
}
