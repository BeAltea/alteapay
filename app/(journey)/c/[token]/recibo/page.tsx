// Recibo do acordo (F4). Passa o rodapé configurável do tenant para a UI.
import { notFound } from "next/navigation"
import { JourneyReceipt } from "@/components/journey/receipt"
import { loadJourneyTenant } from "../_lib/tenant"

export const dynamic = "force-dynamic"

export default async function JourneyReciboPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  if (process.env.CHAT_JOURNEY_ENABLED !== "true") notFound()
  const { token } = await params
  const result = await loadJourneyTenant(token)
  if (!result.ok) notFound()
  return <JourneyReceipt footerText={result.tenant.receiptFooterText} />
}
