// Layout público white-label do LINK ÚNICO /n/{code}.
// - Sem shell dos dashboards; mobile-first (espelha /c/[token]/layout.tsx).
// - Link inválido/desligado/expirado → página neutra "não há negociação
//   disponível" (não revela nada; sem 404 que ajude a enumerar), noindex.
// - Marca do credor SÓ pós-login: exige cookie de sessão de chat válido cujo
//   company_id casa com o tenant do code (verifyChatJwt + cid). Antes disso,
//   casca neutra AlteaPay.
import type React from "react"
import type { Metadata } from "next"
import { unstable_noStore as noStore } from "next/cache"
import { cookies } from "next/headers"
import { CHAT_COOKIE_NAME, verifyChatJwt } from "@/lib/negotiation/crypto"
import { adaptiveTextColor } from "@/lib/journey/contrast"
import { loadPublicLinkTenant } from "./_lib/tenant"

export const dynamic = "force-dynamic"

const NEUTRAL_PRIMARY = "#0f172a"
const NEUTRAL_SECONDARY = "#2563eb"

/** Só revela a identidade do credor DEPOIS do login (mesma regra do /c/[token]). */
async function isAuthenticatedFor(companyId: string): Promise<boolean> {
  try {
    const value = (await cookies()).get(CHAT_COOKIE_NAME)?.value
    if (!value) return false
    const claims = verifyChatJwt(value)
    return Boolean(claims && claims.cid === companyId)
  } catch {
    return false
  }
}

export const metadata: Metadata = {
  title: "Negociação",
  robots: { index: false, follow: false },
}

/** Página neutra: NÃO revela se o code existe (mesma casca para
 *  inexistente/desligado/expirado). Sem "404" que ajude a enumerar. */
function UnavailableNotice() {
  return (
    <main
      style={{ minHeight: "100dvh" }}
      className="flex flex-col items-center justify-center gap-3 bg-neutral-50 px-6 text-center"
    >
      <div className="max-w-sm">
        <h1 className="text-lg font-semibold text-neutral-800">
          Não há negociação disponível neste momento
        </h1>
        <p className="mt-2 text-sm text-neutral-500">
          Se você recebeu uma mensagem nossa, aguarde um novo contato ou fale com o nosso
          atendimento.
        </p>
      </div>
    </main>
  )
}

export default async function PublicLinkLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ code: string }>
}) {
  // Disponibilidade do link é MUTÁVEL: opta o render fora do Route/Data Cache
  // para ligar/DESLIGAR valer em tempo real (sem clear-cache/redeploy).
  noStore()
  if (process.env.CHAT_JOURNEY_ENABLED !== "true") {
    return <UnavailableNotice />
  }

  const { code } = await params
  const result = await loadPublicLinkTenant(code)
  if (!result.ok) {
    return <UnavailableNotice />
  }

  const authed = await isAuthenticatedFor(result.tenant.companyId)
  const { branding, privacyPolicyUrl, dpoContact } = result.tenant

  // Identidade do credor só aparece pós-login. Antes disso, casca neutra AlteaPay.
  const view = authed
    ? {
        brandName: branding.brandName,
        subtitle: `AlteaPay · canal oficial de negociação da ${branding.brandName}`,
        logoUrl: branding.logoUrl,
        primary: branding.brandPrimaryColor,
        secondary: branding.brandSecondaryColor,
        footer: `Atendimento operado pela AlteaPay em nome da ${branding.brandName}.`,
        privacyHref: privacyPolicyUrl,
        dpoContact,
      }
    : {
        brandName: "AlteaPay",
        subtitle: "Central de negociação segura",
        logoUrl: null as string | null,
        primary: NEUTRAL_PRIMARY,
        secondary: NEUTRAL_SECONDARY,
        footer: "Atendimento seguro operado pela AlteaPay.",
        privacyHref: null as string | null,
        dpoContact: null as string | null,
      }

  // R-23 (contraste AA): cor de TEXTO adaptativa sobre o secundário do tenant
  // (#000/#fff pelo maior contraste). Botões de marca usam color: var(...).
  const cssVars = {
    "--brand-primary": view.primary,
    "--brand-secondary": view.secondary,
    "--brand-secondary-fg": adaptiveTextColor(view.secondary),
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
          {view.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={view.logoUrl}
              alt={view.brandName}
              className="h-8 w-auto rounded bg-white/10 p-0.5"
            />
          ) : null}
          <div className="min-w-0">
            <p className="truncate text-base font-semibold">{view.brandName}</p>
            <p className="truncate text-[11px] text-white/70">{view.subtitle}</p>
          </div>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 py-5 sm:px-6">
        {children}
      </div>

      <footer className="border-t border-neutral-200 bg-white px-4 py-4 text-[11px] text-neutral-500 sm:px-6">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <span>{view.footer}</span>
          <span className="flex flex-wrap gap-x-3 gap-y-1">
            {view.privacyHref ? (
              <a
                href={view.privacyHref}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex min-h-[24px] items-center underline underline-offset-2"
              >
                Política de privacidade
              </a>
            ) : (
              <a href="/politica-de-privacidade" className="inline-flex min-h-[24px] items-center underline underline-offset-2">
                Política de privacidade
              </a>
            )}
            {view.dpoContact ? <span>Contato: {view.dpoContact}</span> : null}
          </span>
        </div>
      </footer>
    </div>
  )
}
