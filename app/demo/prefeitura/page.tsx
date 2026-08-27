"use client"

// Demonstração local do fluxo white-label: simula o site de uma prefeitura
// com o widget AlteaPay embedado. O devedor "chega" com ?t={token} (como
// viria do link do WhatsApp); sem token, o botão cria uma sessão mock no
// tenant VMAX (modo B) para validar o fluxo ponta a ponta.

import { useCallback, useEffect, useState } from "react"
import Script from "next/script"
import { Building2, FileText, Landmark, Loader2, Phone } from "lucide-react"

const VMAX_COMPANY_ID = "1f7729ee-a537-43fc-a27f-5747c177988d"

export default function DemoPrefeituraPage() {
  const [token, setToken] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setToken(new URLSearchParams(window.location.search).get("t"))
  }, [])

  const simulateArrival = useCallback(async () => {
    setCreating(true)
    setError(null)
    try {
      const resp = await fetch("/api/negotiation/dev/create-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company_id: VMAX_COMPANY_ID, identity_verified: true }),
      })
      const data = await resp.json()
      if (!resp.ok || !data.success) {
        setError(data.error || "falha ao criar sessão mock")
        return
      }
      const url = new URL(window.location.href)
      url.searchParams.set("t", data.token)
      window.location.href = url.toString()
    } finally {
      setCreating(false)
    }
  }, [])

  return (
    <div className="min-h-dvh bg-stone-100">
      {/* casca visual "oficial" da prefeitura fictícia */}
      <header className="bg-[#14532D] text-white">
        <div className="mx-auto flex max-w-4xl items-center gap-3 px-6 py-4">
          <Landmark className="h-8 w-8 text-yellow-400" />
          <div>
            <div className="text-lg font-bold">Prefeitura Demo</div>
            <div className="text-xs opacity-80">Secretaria da Fazenda — Dívida Ativa</div>
          </div>
        </div>
        <nav className="border-t border-white/20 bg-[#0F3D21]">
          <div className="mx-auto flex max-w-4xl gap-6 px-6 py-2 text-sm">
            <span className="opacity-90">Início</span>
            <span className="opacity-90">IPTU</span>
            <span className="font-semibold text-yellow-300">Negocie seu débito</span>
            <span className="opacity-90">Atendimento</span>
          </div>
        </nav>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-8">
        <h1 className="mb-2 text-2xl font-bold text-stone-800">Negociação de débitos municipais</h1>
        <p className="mb-6 max-w-2xl text-stone-600">
          Se você recebeu uma mensagem sobre um débito em aberto, use o atendimento digital
          abaixo para consultar condições e regularizar sua situação.
        </p>

        <div className="grid gap-6 md:grid-cols-[1fr_400px]">
          <div className="space-y-4">
            <div className="rounded-lg border bg-white p-4 text-sm text-stone-600">
              <div className="mb-1 flex items-center gap-2 font-medium text-stone-800">
                <FileText className="h-4 w-4" /> 2ª via de guias
              </div>
              Emissão de segunda via de IPTU, ISS e taxas municipais.
            </div>
            <div className="rounded-lg border bg-white p-4 text-sm text-stone-600">
              <div className="mb-1 flex items-center gap-2 font-medium text-stone-800">
                <Building2 className="h-4 w-4" /> Certidões
              </div>
              Certidão negativa de débitos e regularidade fiscal.
            </div>
            <div className="rounded-lg border bg-white p-4 text-sm text-stone-600">
              <div className="mb-1 flex items-center gap-2 font-medium text-stone-800">
                <Phone className="h-4 w-4" /> Atendimento presencial
              </div>
              Rua Exemplo, 100 — segunda a sexta, 8h às 17h.
            </div>
          </div>

          <div>
            {token ? (
              <>
                {/* container inline do widget white-label */}
                <div id="alteapay-chat" className="overflow-hidden rounded-xl border shadow" style={{ height: 620 }} />
                <Script src="/widget/alteapay-chat.js" data-token-param="t" data-mode="inline" strategy="afterInteractive" />
              </>
            ) : (
              <div className="flex h-[620px] flex-col items-center justify-center gap-4 rounded-xl border-2 border-dashed bg-white p-8 text-center">
                <p className="text-sm text-stone-500">
                  Nenhum token de negociação na URL (<code>?t=…</code>). Em produção, o devedor
                  chega aqui pelo link enviado no WhatsApp.
                </p>
                <button
                  onClick={simulateArrival}
                  disabled={creating}
                  className="flex items-center gap-2 rounded-lg bg-[#14532D] px-4 py-2.5 text-sm font-medium text-white disabled:opacity-60"
                >
                  {creating && <Loader2 className="h-4 w-4 animate-spin" />}
                  Simular chegada pelo WhatsApp (mock)
                </button>
                {error && <p className="text-xs text-red-600">{error}</p>}
              </div>
            )}
          </div>
        </div>
      </main>

      <footer className="mt-8 border-t bg-white py-4 text-center text-xs text-stone-400">
        Prefeitura Demo — ambiente de demonstração local · atendimento digital com tecnologia AlteaPay
      </footer>
    </div>
  )
}
