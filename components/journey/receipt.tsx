"use client"

// Recibo do acordo (F4): reúne o resumo da dívida (GET ?action=summary) e o
// estado do pagamento (GET /api/chat/payment). Botão de impressão (window.print).
import { useEffect, useState } from "react"

interface PaymentData {
  billingType: string | null
  installments: number | null
  installmentAmount: number | null
  total: number | null
  dueDate: string | null
}
interface DebtSummary {
  creditorName: string
  originalValue: number
  oldestDueDate: string | null
}

const BRL = (v: number | null | undefined) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v || 0)
const formatDate = (iso: string | null | undefined) => {
  if (!iso) return "—"
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("pt-BR")
}
const billingLabel = (t: string | null) =>
  t === "PIX" ? "PIX" : t === "BOLETO" ? "Boleto" : t === "CREDIT_CARD" ? "Cartão de crédito" : "—"

export function JourneyReceipt({ footerText }: { footerText: string | null }) {
  const [payment, setPayment] = useState<PaymentData | null>(null)
  const [summary, setSummary] = useState<DebtSummary | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    ;(async () => {
      try {
        const [pRes, sRes] = await Promise.all([
          fetch("/api/chat/payment", { cache: "no-store" }),
          fetch("/api/chat/session?action=summary", { cache: "no-store" }),
        ])
        const pData = await pRes.json().catch(() => ({}))
        const sData = await sRes.json().catch(() => ({}))
        if (pData?.status === "ready" && pData.payment) setPayment(pData.payment)
        if (sData?.ok && sData.summary) setSummary(sData.summary)
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  if (loading) {
    return <p className="py-10 text-center text-sm text-neutral-500">Carregando comprovante…</p>
  }

  return (
    <div className="flex flex-1 flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Comprovante do acordo</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Guarde este comprovante. Ele resume os termos da sua negociação.
        </p>
      </div>

      <div className="rounded-lg bg-white p-4 shadow-sm">
        <dl className="divide-y divide-neutral-100 text-sm">
          {summary?.creditorName ? (
            <div className="flex justify-between py-2">
              <dt className="text-neutral-500">Credor</dt>
              <dd className="text-neutral-800">{summary.creditorName}</dd>
            </div>
          ) : null}
          <div className="flex justify-between py-2">
            <dt className="text-neutral-500">Forma de pagamento</dt>
            <dd className="text-neutral-800">{billingLabel(payment?.billingType ?? null)}</dd>
          </div>
          <div className="flex justify-between py-2">
            <dt className="text-neutral-500">Parcelamento</dt>
            <dd className="text-neutral-800">
              {payment?.installments && payment.installments > 1
                ? `${payment.installments}x de ${BRL(payment.installmentAmount)}`
                : "à vista"}
            </dd>
          </div>
          <div className="flex justify-between py-2">
            <dt className="text-neutral-500">Vencimento</dt>
            <dd className="text-neutral-800">{formatDate(payment?.dueDate)}</dd>
          </div>
          <div className="flex justify-between py-2">
            <dt className="font-medium text-neutral-700">Total acordado</dt>
            <dd className="text-lg font-semibold" style={{ color: "var(--brand-primary)" }}>
              {BRL(payment?.total)}
            </dd>
          </div>
        </dl>
      </div>

      {footerText ? <p className="text-[11px] text-neutral-400">{footerText}</p> : null}

      <button
        type="button"
        onClick={() => window.print()}
        style={{ backgroundColor: "var(--brand-secondary)" }}
        className="mt-auto h-11 rounded-md text-base font-semibold text-white"
      >
        Imprimir / Salvar PDF
      </button>
    </div>
  )
}
