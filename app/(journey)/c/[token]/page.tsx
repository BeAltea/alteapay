// Página de autenticação da jornada (F4). Server: resolve a flag de data de
// nascimento pelo token; o formulário em si é client (interação + fetch).
import { notFound } from "next/navigation"
import { JourneyAuthForm } from "@/components/journey/auth-form"
import { loadJourneyTenant } from "./_lib/tenant"

export const dynamic = "force-dynamic"

export default async function JourneyAuthPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  if (process.env.CHAT_JOURNEY_ENABLED !== "true") notFound()
  const { token } = await params
  const result = await loadJourneyTenant(token)
  // Layout já trata o caso inválido; aqui só o fallback defensivo.
  if (!result.ok) notFound()

  return (
    <JourneyAuthForm token={token} requireBirthDate={result.tenant.authRequireBirthDate} />
  )
}
