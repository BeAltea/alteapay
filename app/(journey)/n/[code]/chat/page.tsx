// Chat do LINK ÚNICO /n/{code} (pós-login). A sessão vem do cookie httpOnly
// (mesmo cookie do /c/ e /t/); toda a interação é client-side contra
// /api/chat/session. A marca do credor já aparece (layout re-renderizado com o
// cookie válido). Reusa o componente JourneyChat existente.
import { notFound } from "next/navigation"
import { JourneyChat } from "@/components/journey/chat"

export const dynamic = "force-dynamic"

export default function PublicLinkChatPage() {
  if (process.env.CHAT_JOURNEY_ENABLED !== "true") notFound()
  return <JourneyChat />
}
