// Confirmação de atendimento humano acionado (F4). Página estática de aviso.
import { notFound } from "next/navigation"

export const dynamic = "force-dynamic"

export default function JourneyAtendimentoPage() {
  if (process.env.CHAT_JOURNEY_ENABLED !== "true") notFound()
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center">
      <div
        className="flex h-12 w-12 items-center justify-center rounded-full text-white"
        style={{ backgroundColor: "var(--brand-secondary)" }}
        aria-hidden
      >
        ✓
      </div>
      <h1 className="text-lg font-semibold text-neutral-800">Atendimento acionado</h1>
      <p className="max-w-sm text-sm text-neutral-500">
        Um atendente foi notificado e entrará em contato para dar continuidade. Você já pode
        fechar esta página.
      </p>
    </div>
  )
}
