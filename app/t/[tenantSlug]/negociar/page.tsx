// Endpoint GENÉRICO por tenant (N1). Só o formulário de autenticação por
// documento — NADA da dívida antes de autenticar (mitigação §3.5). O gate de
// abertura (admin-only enquanto journey_public_enabled=false) é do middleware.
import { notFound } from "next/navigation"
import { JourneyGenericAuthForm } from "@/components/journey/generic-auth-form"
import { loadGenericTenant } from "./_lib/tenant"

export const dynamic = "force-dynamic"

export default async function GenericNegociarPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>
}) {
  if (process.env.CHAT_JOURNEY_ENABLED !== "true") notFound()
  const { tenantSlug } = await params
  const result = await loadGenericTenant(tenantSlug)
  if (!result.ok) notFound()

  return (
    <JourneyGenericAuthForm
      tenantSlug={result.tenant.slug}
      successHref="./negociar/chat"
      captchaEnabled={process.env.CHAT_CAPTCHA_ENABLED === "true"}
    />
  )
}
