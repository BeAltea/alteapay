// Autenticação por CPF (V4): só acontece DEPOIS de "Consultar atualização" na
// tela de escolha. O formulário posta em /api/chat/auth (fluxo já definido na
// onda da jornada) e, ao autenticar, segue para o chat.
import { notFound } from "next/navigation"
import { JourneyAuthForm } from "@/components/journey/auth-form"
import { loadJourneyTenant } from "../_lib/tenant"

export const dynamic = "force-dynamic"

export default async function JourneyConsultPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  if (process.env.CHAT_JOURNEY_ENABLED !== "true") notFound()
  const { token } = await params
  const result = await loadJourneyTenant(token)
  if (!result.ok) notFound()

  // A partir de /c/{token}/consultar, o chat vive em /c/{token}/chat.
  return (
    <JourneyAuthForm
      token={token}
      requireBirthDate={result.tenant.authRequireBirthDate}
      successHref="../chat"
    />
  )
}
