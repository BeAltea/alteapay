// Resumo do aceite (F4).
import { notFound } from "next/navigation"
import { JourneySummary } from "@/components/journey/summary"

export const dynamic = "force-dynamic"

export default function JourneyResumoPage() {
  if (process.env.CHAT_JOURNEY_ENABLED !== "true") notFound()
  return <JourneySummary />
}
