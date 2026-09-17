// Tela de ESCOLHA da jornada (V1/V4): três ações sem nenhum dado da dívida e
// antes de qualquer autenticação. Registra link.clicked na primeira abertura.
import { notFound } from "next/navigation"
import { ChoiceScreen } from "@/components/journey/choice-screen"
import { recordEvent } from "@/lib/journey/events"
import { consumeOpen, validateToken } from "@/lib/journey/tokens"
import { loadJourneyTenant } from "./_lib/tenant"

export const dynamic = "force-dynamic"

export default async function JourneyChoicePage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  if (process.env.CHAT_JOURNEY_ENABLED !== "true") notFound()
  const { token } = await params
  const result = await loadJourneyTenant(token)
  if (!result.ok) notFound()

  // link.clicked na primeira abertura (só para o token de consulta; opt-out e
  // block têm seus próprios fluxos). consumeOpen é idempotente por first_opened.
  const tv = await validateToken(token)
  if (tv.ok && (tv.tokenRow.purpose ?? "consult") === "consult" && !tv.tokenRow.first_opened_at) {
    await consumeOpen(tv.tokenRow.id)
    await recordEvent({
      companyId: tv.tokenRow.company_id,
      customerId: tv.tokenRow.customer_id,
      campaignId: tv.tokenRow.campaign_id,
      messageId: tv.tokenRow.message_id,
      type: "link.clicked",
      actor: "customer",
      payload: { via: "choice_screen" },
    })
    if (tv.tokenRow.message_id) {
      const { createServiceClient } = await import("@/lib/supabase/service")
      await createServiceClient()
        .from("whatsapp_messages")
        .update({ clicked_at: new Date().toISOString() })
        .eq("id", tv.tokenRow.message_id)
        .is("clicked_at", null)
    }
  }

  return <ChoiceScreen token={token} brandName={result.tenant.branding.brandName} />
}
