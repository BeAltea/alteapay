// Pagamento da jornada (F4).
import { notFound } from "next/navigation"
import { JourneyPayment } from "@/components/journey/payment"

export const dynamic = "force-dynamic"

export default function JourneyPagamentoPage() {
  if (process.env.CHAT_JOURNEY_ENABLED !== "true") notFound()
  return <JourneyPayment />
}
