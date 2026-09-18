// Chat do endpoint GENÉRICO (N1). A sessão vem do cookie httpOnly emitido pelo
// /api/chat/auth; a interação é client-side contra /api/chat/message. Reutiliza
// o mesmo componente do fluxo de campanha.
import { notFound } from "next/navigation"
import { JourneyChat } from "@/components/journey/chat"

export const dynamic = "force-dynamic"

export default function GenericJourneyChatPage() {
  if (process.env.CHAT_JOURNEY_ENABLED !== "true") notFound()
  return <JourneyChat />
}
