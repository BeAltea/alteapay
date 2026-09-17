"use client"

// Pagamento da jornada (F4): polling em GET /api/chat/payment (2s) até
// status=ready. Renderiza PIX (QR + copia-e-cola), boleto ou link do cartão.
import { useCallback, useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"

interface PaymentData {
  billingType: string | null
  pixQrCodeUrl: string | null
  boletoUrl: string | null
  invoiceUrl: string | null
  installments: number | null
  installmentAmount: number | null
  total: number | null
  dueDate: string | null
}

const BRL = (v: number | null) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v || 0)
const formatDate = (iso: string | null) => {
  if (!iso) return "—"
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("pt-BR")
}

export function JourneyPayment() {
  const router = useRouter()
  const [payment, setPayment] = useState<PaymentData | null>(null)
  const [status, setStatus] = useState<"generating" | "ready" | "error">("generating")
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/chat/payment", { cache: "no-store" })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data?.status === "ready" && data.payment) {
        setPayment(data.payment as PaymentData)
        setStatus("ready")
        return
      }
      // segue em "generating"; agenda nova checagem
      timer.current = setTimeout(poll, 2000)
    } catch {
      timer.current = setTimeout(poll, 2000)
    }
  }, [])

  useEffect(() => {
    poll()
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [poll])

  async function copyPix(value: string) {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    } catch {
      /* ignore */
    }
  }

  if (status !== "ready" || !payment) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center">
        <div
          className="h-8 w-8 animate-spin rounded-full border-4 border-neutral-200"
          style={{ borderTopColor: "var(--brand-secondary)" }}
        />
        <p className="text-sm text-neutral-500">Gerando seu pagamento…</p>
        <p className="text-xs text-neutral-400">Isso leva apenas alguns instantes.</p>
      </div>
    )
  }

  const bt = payment.billingType
  const pixUrl = payment.pixQrCodeUrl
  const boletoUrl = payment.boletoUrl
  const invoiceUrl = payment.invoiceUrl

  return (
    <div className="flex flex-1 flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Pagamento gerado</h1>
        <p className="mt-1 text-sm text-neutral-500">
          {payment.installments && payment.installments > 1
            ? `${payment.installments}x de ${BRL(payment.installmentAmount)} · total ${BRL(payment.total)}`
            : `Total ${BRL(payment.total)}`}
          {payment.dueDate ? ` · vencimento ${formatDate(payment.dueDate)}` : ""}
        </p>
      </div>

      <div className="rounded-lg bg-white p-4 shadow-sm">
        {bt === "PIX" && pixUrl ? (
          <div className="flex flex-col items-center gap-3 text-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={pixUrl} alt="QR Code PIX" className="h-56 w-56 rounded" />
            <button
              type="button"
              onClick={() => copyPix(pixUrl)}
              style={{ backgroundColor: "var(--brand-secondary)" }}
              className="h-11 w-full rounded-md text-sm font-semibold text-white"
            >
              {copied ? "Copiado!" : "Copiar código PIX"}
            </button>
            <p className="text-xs text-neutral-400">
              Abra o app do seu banco, escolha PIX e escaneie o QR Code.
            </p>
          </div>
        ) : bt === "BOLETO" && boletoUrl ? (
          <div className="flex flex-col items-center gap-3 text-center">
            <p className="text-sm text-neutral-600">Seu boleto está pronto.</p>
            <a
              href={boletoUrl}
              target="_blank"
              rel="noreferrer noopener"
              style={{ backgroundColor: "var(--brand-secondary)" }}
              className="flex h-11 w-full items-center justify-center rounded-md text-sm font-semibold text-white"
            >
              Abrir boleto
            </a>
          </div>
        ) : invoiceUrl ? (
          <div className="flex flex-col items-center gap-3 text-center">
            <p className="text-sm text-neutral-600">Conclua o pagamento na página segura.</p>
            <a
              href={invoiceUrl}
              target="_blank"
              rel="noreferrer noopener"
              style={{ backgroundColor: "var(--brand-secondary)" }}
              className="flex h-11 w-full items-center justify-center rounded-md text-sm font-semibold text-white"
            >
              Ir para o pagamento
            </a>
          </div>
        ) : (
          <p className="py-6 text-center text-sm text-neutral-500">
            Seu pagamento foi gerado. Verifique as instruções enviadas pelo seu credor.
          </p>
        )}
      </div>

      <button
        type="button"
        onClick={() => router.push("./recibo")}
        className="h-11 rounded-md border border-neutral-300 bg-white text-sm font-semibold text-neutral-700"
      >
        Ver comprovante do acordo
      </button>
    </div>
  )
}
