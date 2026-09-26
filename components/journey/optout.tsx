"use client"

// Opt-out pelo site (F4). Não há endpoint próprio de opt-out na session route;
// registramos como handoff humano com reason='optout_site' (sem inventar API).
// Também orientamos o canal oficial de opt-out (responder PARAR no WhatsApp).
import { useState } from "react"
import { useRouter } from "next/navigation"

export function JourneyOptout() {
  const router = useRouter()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function requestOptout() {
    if (submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch("/api/chat/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "human_transfer", reason: "optout_site" }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data?.ok) {
        router.push("./atendimento")
        return
      }
      setError("Não foi possível registrar agora. Tente novamente em instantes.")
    } catch {
      setError("Não foi possível registrar agora. Tente novamente em instantes.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex flex-1 flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Não quero mais receber mensagens</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Para deixar de receber mensagens, responda <strong>PARAR</strong> no WhatsApp ou fale com
          o atendimento. Você também pode registrar sua solicitação abaixo.
        </p>
      </div>

      <div className="rounded-lg bg-white p-4 text-sm text-neutral-600 shadow-sm">
        <p>
          Ao registrar, um atendente será acionado para tratar sua solicitação. As mensagens
          automáticas serão suspensas.
        </p>
      </div>

      {error ? (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      ) : null}

      <button
        type="button"
        onClick={requestOptout}
        disabled={submitting}
        style={{ backgroundColor: "var(--brand-secondary)" }}
        className="mt-auto h-11 rounded-md text-base font-semibold text-white disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-2"
      >
        {submitting ? "Registrando..." : "Registrar solicitação"}
      </button>
    </div>
  )
}
