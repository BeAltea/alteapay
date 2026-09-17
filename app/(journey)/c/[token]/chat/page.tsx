// Chat da jornada (F4). A sessão vem do cookie httpOnly; toda a interação é
// client-side contra /api/chat/session.
import { notFound } from "next/navigation"
import { JourneyChat } from "@/components/journey/chat"

export const dynamic = "force-dynamic"

export default function JourneyChatPage() {
  if (process.env.CHAT_JOURNEY_ENABLED !== "true") notFound()
  return <JourneyChat />
}
