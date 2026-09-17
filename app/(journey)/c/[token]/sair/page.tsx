// Opt-out pelo site (F4).
import { notFound } from "next/navigation"
import { JourneyOptout } from "@/components/journey/optout"

export const dynamic = "force-dynamic"

export default function JourneySairPage() {
  if (process.env.CHAT_JOURNEY_ENABLED !== "true") notFound()
  return <JourneyOptout />
}
