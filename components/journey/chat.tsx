"use client"

// Chat da jornada (F4): mensagens + input + chips de ação rápida + cartões de
// oferta (matriz). Aceite navega para o resumo. Sem termos técnicos ao cliente.
import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"

interface ChatMsg {
  id: string
  from: "customer" | "assistant"
  text: string
}

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
interface Offer {
  id: string
  terms: OfferTerms
  valid_until: string | null
}

const QUICK_ACTIONS: { label: string; text: string }[] = [
  { label: "Ver faturas", text: "Quero ver minhas faturas" },
  { label: "Opções de pagamento", text: "Quais são as opções de pagamento?" },
  { label: "Já paguei", text: "Já paguei essa dívida" },
  { label: "Contestar", text: "Quero contestar essa cobrança" },
  { label: "Falar com atendente", text: "Quero falar com um atendente" },
]

const BRL = (v: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v || 0)

const billingLabel = (t: string) =>
  t === "PIX" ? "PIX" : t === "BOLETO" ? "Boleto" : t === "CREDIT_CARD" ? "Cartão de crédito" : t

function formatDate(iso: string | null): string {
  if (!iso) return ""
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("pt-BR")
}

let msgSeq = 0
const nextId = () => `m${Date.now()}_${msgSeq++}`

export function JourneyChat() {
  const router = useRouter()
  const [messages, setMessages] = useState<ChatMsg[]>([
    {
      id: nextId(),
      from: "assistant",
      text: "Olá! Estou aqui para ajudar você a regularizar sua situação. Como posso ajudar?",
    },
  ])
  const [input, setInput] = useState("")
  const [offers, setOffers] = useState<Offer[]>([])
  const [sending, setSending] = useState(false)
  const [enginePreparing, setEnginePreparing] = useState(false)
  const [accepting, setAccepting] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" })
  }, [messages, offers, enginePreparing])

  async function loadOffers() {
    try {
      const res = await fetch("/api/chat/session?action=offers")
      if (!res.ok) return
      const data = await res.json()
      if (Array.isArray(data?.offers)) setOffers(data.offers)
    } catch {
      /* silencioso */
    }
  }

  useEffect(() => {
    loadOffers()
  }, [])

  async function sendMessage(text: string) {
    const clean = text.trim()
    if (!clean || sending) return
    setMessages((m) => [...m, { id: nextId(), from: "customer", text: clean }])
    setInput("")
    setSending(true)
    setEnginePreparing(true)
    try {
      const res = await fetch("/api/chat/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: clean }),
      })
      const data = await res.json().catch(() => ({}))
      const reply =
        typeof data?.reply === "string" && data.reply.trim()
          ? data.reply
          : "Nosso assistente está preparando sua resposta. Enquanto isso, veja as opções disponíveis abaixo."
      setMessages((m) => [...m, { id: nextId(), from: "assistant", text: reply }])
      // o próprio turno já devolve as ofertas atuais; recarrega como fallback
      if (Array.isArray(data?.offers)) setOffers(data.offers)
      else loadOffers()
    } catch {
      setMessages((m) => [
        ...m,
        {
          id: nextId(),
          from: "assistant",
          text: "Não consegui responder agora. Você pode usar as opções abaixo para continuar.",
        },
      ])
    } finally {
      setSending(false)
      setEnginePreparing(false)
    }
  }

  async function acceptOffer(offerId: string) {
    if (accepting) return
    setAccepting(offerId)
    try {
      const res = await fetch("/api/chat/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "accept", offerId }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data?.ok) {
        // Guarda só o id da oferta (UUID, não é PII) para o passo de resumo.
        try {
          sessionStorage.setItem("journey_offer_id", offerId)
        } catch {
          /* ignore */
        }
        router.push("./resumo")
        return
      }
      setMessages((m) => [
        ...m,
        {
          id: nextId(),
          from: "assistant",
          text: "Essa condição não está mais disponível. Veja as opções atualizadas.",
        },
      ])
      loadOffers()
    } catch {
      setMessages((m) => [
        ...m,
        { id: nextId(), from: "assistant", text: "Não foi possível selecionar agora. Tente novamente." },
      ])
    } finally {
      setAccepting(null)
    }
  }

  return (
    <div className="flex flex-1 flex-col gap-3">
      <div
        ref={scrollRef}
        className="flex-1 space-y-3 overflow-y-auto rounded-lg bg-white p-3 shadow-sm"
        style={{ minHeight: 320 }}
      >
        {messages.map((m) => (
          <div
            key={m.id}
            className={m.from === "customer" ? "flex justify-end" : "flex justify-start"}
          >
            <div
              style={
                m.from === "customer"
                  ? { backgroundColor: "var(--brand-secondary)" }
                  : undefined
              }
              className={
                m.from === "customer"
                  ? "max-w-[85%] rounded-2xl rounded-br-sm px-3.5 py-2 text-sm text-white"
                  : "max-w-[85%] rounded-2xl rounded-bl-sm bg-neutral-100 px-3.5 py-2 text-sm text-neutral-800"
              }
            >
              {m.text}
            </div>
          </div>
        ))}

        {enginePreparing ? (
          <div className="flex justify-start">
            <div className="rounded-2xl rounded-bl-sm bg-neutral-100 px-3.5 py-2 text-sm italic text-neutral-500">
              assistente em preparação…
            </div>
          </div>
        ) : null}

        {offers.length > 0 ? (
          <div className="space-y-2 pt-1">
            <p className="text-xs font-medium text-neutral-500">Condições disponíveis</p>
            {offers.map((o) => (
              <div key={o.id} className="rounded-lg border border-neutral-200 p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs text-neutral-400 line-through">
                    {BRL(o.terms.original_value)}
                  </span>
                  <span
                    className="text-lg font-semibold"
                    style={{ color: "var(--brand-primary)" }}
                  >
                    {BRL(o.terms.total_value)}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-neutral-600">
                  {o.terms.discount_pct > 0 ? (
                    <span className="font-medium text-green-700">
                      {o.terms.discount_pct.toFixed(0)}% de desconto
                    </span>
                  ) : null}
                  <span>{billingLabel(o.terms.billing_type)}</span>
                  <span>
                    {o.terms.installments > 1
                      ? `${o.terms.installments}x de ${BRL(o.terms.installment_value)}`
                      : "à vista"}
                  </span>
                  {o.valid_until ? <span>válida até {formatDate(o.valid_until)}</span> : null}
                </div>
                <button
                  type="button"
                  onClick={() => acceptOffer(o.id)}
                  disabled={accepting === o.id}
                  style={{ backgroundColor: "var(--brand-secondary)" }}
                  className="mt-3 h-9 w-full rounded-md text-sm font-semibold text-white disabled:opacity-40"
                >
                  {accepting === o.id ? "Selecionando..." : "Escolher"}
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {QUICK_ACTIONS.map((a) => (
          <button
            key={a.label}
            type="button"
            onClick={() => sendMessage(a.text)}
            disabled={sending}
            className="rounded-full border border-neutral-300 bg-white px-3 py-1.5 text-xs text-neutral-700 disabled:opacity-40"
          >
            {a.label}
          </button>
        ))}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          sendMessage(input)
        }}
        className="flex gap-2"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Escreva sua mensagem"
          className="h-11 flex-1 rounded-md border border-neutral-300 bg-white px-3 text-sm outline-none focus:border-[var(--brand-secondary)] focus:ring-2 focus:ring-[var(--brand-secondary)]/30"
        />
        <button
          type="submit"
          disabled={sending || !input.trim()}
          style={{ backgroundColor: "var(--brand-secondary)" }}
          className="h-11 rounded-md px-4 text-sm font-semibold text-white disabled:opacity-40"
        >
          Enviar
        </button>
      </form>
    </div>
  )
}
