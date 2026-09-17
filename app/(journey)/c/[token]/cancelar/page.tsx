// Confirmação de "Cancelar inscrição" (V4). GET só renderiza a confirmação
// (prefetch-safe): a supressão só ocorre no POST /api/chat/optout com CSRF.
import { cookies } from "next/headers"
import { notFound } from "next/navigation"
import { ActionConfirm } from "@/components/journey/action-confirm"
import { issueActionCsrf } from "@/lib/journey/optout"
import { validateActionToken } from "@/lib/journey/tokens"
import { loadJourneyTenant } from "../_lib/tenant"

export const dynamic = "force-dynamic"

export default async function CancelarPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  if (process.env.CHAT_JOURNEY_ENABLED !== "true") notFound()
  const { token } = await params
  const result = await loadJourneyTenant(token)
  if (!result.ok) notFound()

  // O token de ação (purpose=optout) valida separado do token de consulta.
  const tv = await validateActionToken(token, "optout")
  const valid = tv.ok

  const csrf = issueActionCsrf(token, "optout")
  if (valid) {
    ;(await cookies()).set(`ap_csrf_optout`, csrf, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 15 * 60,
    })
  }

  if (!valid) {
    return (
      <div className="flex flex-1 flex-col gap-3">
        <h1 className="text-lg font-semibold text-neutral-800">Link indisponível</h1>
        <p className="text-sm text-neutral-500">
          Esta opção não está mais disponível. Aguarde um novo contato.
        </p>
      </div>
    )
  }

  return (
    <ActionConfirm
      token={token}
      kind="optout"
      csrf={csrf}
      brandName={result.tenant.branding.brandName}
      officialChannelUrl={result.tenant.officialChannelUrl}
      officialChannelLabel={result.tenant.officialChannelLabel}
    />
  )
}
