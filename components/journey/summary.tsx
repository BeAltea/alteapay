"use client"

// Resumo do aceite (F4): reexecuta o passo `accept` para obter os termos +
// termsHash da sessão e, ao confirmar, envia `confirm` com o mesmo hash.
import { useCallback, useEffect, useState } from "react"
import { useRouter } from "next/navigation"

interface OfferTerms {
  original_value: number
  discount_pct: number
  discount_value: number
  entry_value: number
  installments: number
  installment_value: number
  total_value: number
  billing_type: string
  first_due_date: string
}
interface AcceptSummary {
  offerId: string
  terms: OfferTerms
  validUntil: string | null
  creditorName: string
  termsHash: string
}

const BRL = (v: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v || 0)
const billingLabel = (t: string) =>
  t === "PIX" ? "PIX" : t === "BOLETO" ? "Boleto" : t === "CREDIT_CARD" ? "Cartão de crédito" : t
const formatDate = (iso: string | null) => {
  if (!iso) return "—"
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("pt-BR")
}

export function JourneySummary() {
  const router = useRouter()
  const [summary, setSummary] = useState<AcceptSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    let offerId = ""
    try {
      offerId = sessionStorage.getItem("journey_offer_id") ?? ""
    } catch {
      /* ignore */
    }
    if (!offerId) {
      setError("Não encontramos a condição escolhida. Volte e selecione novamente.")
      setLoading(false)
      return
    }
    try {
      const res = await fetch("/api/chat/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "accept", offerId }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data?.ok && data.summary) {
        setSummary(data.summary as AcceptSummary)
      } else {
        setError("Esta condição não está mais disponível. Volte e escolha outra.")
      }
    } catch {
      setError("Não foi possível carregar o resumo. Tente novamente.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function confirm() {
    if (!summary || confirming) return
    setConfirming(true)
    setError(null)
    try {
      const res = await fetch("/api/chat/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "confirm",
          offerId: summary.offerId,
          termsHash: summary.termsHash,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data?.ok) {
        router.push("./pagamento")
        return
      }
      setError("Não foi possível concluir. A condição pode ter expirado. Volte e escolha outra.")
    } catch {
      setError("Não foi possível concluir agora. Tente novamente.")
    } finally {
      setConfirming(false)
    }
  }

  if (loading) {
    return <p className="py-10 text-center text-sm text-neutral-500">Carregando resumo…</p>
  }

  if (error || !summary) {
    return (
      <div className="flex flex-1 flex-col gap-4">
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
        <button
          type="button"
          onClick={() => router.push("./chat")}
          className="h-11 rounded-md border border-neutral-300 bg-white text-sm font-semibold text-neutral-700"
        >
          Voltar
        </button>
      </div>
    )
  }

  const t = summary.terms
  return (
    <div className="flex flex-1 flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Resumo da negociação</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Confira os termos antes de gerar o pagamento com {summary.creditorName}.
        </p>
      </div>

      <div className="rounded-lg bg-white p-4 shadow-sm">
        <dl className="divide-y divide-neutral-100 text-sm">
          <div className="flex justify-between py-2">
            <dt className="text-neutral-500">Valor original</dt>
            <dd className="text-neutral-400 line-through">{BRL(t.original_value)}</dd>
          </div>
          {t.discount_value > 0 ? (
            <div className="flex justify-between py-2">
              <dt className="text-neutral-500">Desconto</dt>
              <dd className="font-medium text-green-700">
                −{BRL(t.discount_value)} ({t.discount_pct.toFixed(0)}%)
              </dd>
            </div>
          ) : null}
          <div className="flex justify-between py-2">
            <dt className="text-neutral-500">Forma de pagamento</dt>
            <dd className="text-neutral-800">{billingLabel(t.billing_type)}</dd>
          </div>
          <div className="flex justify-between py-2">
            <dt className="text-neutral-500">Parcelamento</dt>
            <dd className="text-neutral-800">
              {t.installments > 1 ? `${t.installments}x de ${BRL(t.installment_value)}` : "à vista"}
            </dd>
          </div>
          <div className="flex justify-between py-2">
            <dt className="text-neutral-500">Primeiro vencimento</dt>
            <dd className="text-neutral-800">{formatDate(t.first_due_date)}</dd>
          </div>
          <div className="flex justify-between py-2">
            <dt className="font-medium text-neutral-700">Total</dt>
            <dd className="text-lg font-semibold" style={{ color: "var(--brand-primary)" }}>
              {BRL(t.total_value)}
            </dd>
          </div>
        </dl>
      </div>

      <p className="text-[11px] text-neutral-400">
        Identificador dos termos: <span className="font-mono">{summary.termsHash.slice(0, 16)}…</span>
        {summary.validUntil ? ` · válido até ${formatDate(summary.validUntil)}` : ""}
      </p>

      {error ? (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      ) : null}

      <button
        type="button"
        onClick={confirm}
        disabled={confirming}
        style={{ backgroundColor: "var(--brand-secondary)" }}
        className="mt-auto h-11 rounded-md text-base font-semibold text-white disabled:opacity-40"
      >
        {confirming ? "Gerando pagamento..." : "Aceitar e gerar pagamento"}
      </button>
    </div>
  )
}
