// Carregamento server-side do contexto do LINK ÚNICO /n/{code}.
// Resolve code → tenant (respeitando public_link_enabled + validade) e carrega
// só branding/políticas do tenant para o layout white-label. Nunca expõe PII.
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { resolvePublicLink } from "@/lib/journey/public-link"

export interface PublicLinkBranding {
  brandName: string
  brandPrimaryColor: string
  brandSecondaryColor: string
  logoUrl: string | null
}

export interface PublicLinkTenantContext {
  companyId: string
  code: string
  branding: PublicLinkBranding
  privacyPolicyUrl: string | null
  dpoContact: string | null
}

const DEFAULT_PRIMARY = "#0f172a"
const DEFAULT_SECONDARY = "#2563eb"

export type LoadPublicTenantResult =
  | { ok: true; tenant: PublicLinkTenantContext }
  | { ok: false; reason: "not_found" | "disabled" | "expired" }

/**
 * Resolve o code e monta o contexto white-label. Qualquer indisponibilidade
 * (inexistente/desligado/expirado) → `ok:false` e o layout mostra a página
 * neutra "não há negociação disponível" (mesma casca, sem enumeração).
 */
export async function loadPublicLinkTenant(code: string): Promise<LoadPublicTenantResult> {
  const link = await resolvePublicLink(code)
  if (!link.ok) return { ok: false, reason: link.reason }

  const supabase = createServiceClient()
  const [{ data: cfg }, { data: company }] = await Promise.all([
    supabase
      .from("tenant_chat_config")
      .select("company_id, branding, privacy_policy_url, dpo_contact")
      .eq("company_id", link.tenant.companyId)
      .maybeSingle(),
    supabase.from("companies").select("name").eq("id", link.tenant.companyId).maybeSingle(),
  ])

  const branding = (cfg?.branding ?? {}) as Record<string, unknown>
  const brandName =
    (typeof branding.brand_name === "string" && branding.brand_name) || company?.name || "Credor"

  return {
    ok: true,
    tenant: {
      companyId: link.tenant.companyId,
      code: link.tenant.code,
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
    },
  }
}
