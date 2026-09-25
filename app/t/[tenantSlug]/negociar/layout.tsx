// Layout white-label do endpoint GENÉRICO por slug (N1). Espelha o layout de
// (journey)/c/[token]. noindex, sem shell de dashboard, branding do tenant.
// A abertura ao público é decidida no middleware (admin-only enquanto
// journey_public_enabled=false); aqui só renderiza a casca visual.
import type React from "react"
import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { adaptiveTextColor } from "@/lib/journey/contrast"
import { loadGenericTenant } from "./_lib/tenant"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Negociação",
  robots: { index: false, follow: false },
}

export default async function GenericJourneyLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ tenantSlug: string }>
}) {
  if (process.env.CHAT_JOURNEY_ENABLED !== "true") notFound()
  const { tenantSlug } = await params
  const result = await loadGenericTenant(tenantSlug)
  if (!result.ok) notFound()

  const { branding, privacyPolicyUrl, dpoContact } = result.tenant
  // R-23 (contraste AA): cor de TEXTO adaptativa sobre o secundário do tenant.
  const cssVars = {
    "--brand-primary": branding.brandPrimaryColor,
    "--brand-secondary": branding.brandSecondaryColor,
    "--brand-secondary-fg": adaptiveTextColor(branding.brandSecondaryColor),
  } as React.CSSProperties

  return (
    <div
      style={{ ...cssVars, minHeight: "100dvh" }}
      className="flex flex-col bg-neutral-50 text-neutral-900"
    >
      <header
        style={{ backgroundColor: "var(--brand-primary)" }}
        className="px-4 py-3 text-white sm:px-6"
      >
        <div className="mx-auto flex w-full max-w-2xl items-center gap-3">
          {branding.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={branding.logoUrl}
              alt={branding.brandName}
              className="h-8 w-auto rounded bg-white/10 p-0.5"
            />
          ) : null}
          <div className="min-w-0">
            <p className="truncate text-base font-semibold">{branding.brandName}</p>
            <p className="truncate text-[11px] text-white/70">
              AlteaPay · canal oficial de negociação da {branding.brandName}
            </p>
          </div>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 py-5 sm:px-6">
        {children}
      </div>

      <footer className="border-t border-neutral-200 bg-white px-4 py-4 text-[11px] text-neutral-500 sm:px-6">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <span>Atendimento operado pela AlteaPay em nome de {branding.brandName}.</span>
          <span className="flex flex-wrap gap-x-3 gap-y-1">
            {privacyPolicyUrl ? (
              <a
                href={privacyPolicyUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="underline underline-offset-2"
              >
                Política de privacidade
              </a>
            ) : (
              <a href="/politica-de-privacidade" className="underline underline-offset-2">
                Política de privacidade
              </a>
            )}
            {dpoContact ? <span>Contato: {dpoContact}</span> : null}
          </span>
        </div>
      </footer>
    </div>
  )
}
