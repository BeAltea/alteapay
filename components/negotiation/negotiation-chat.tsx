"use client"

// Chat público de negociação (mobile-first). Fluxo: resolve token → consenti-
// mento LGPD → conversa. Toda a inteligência fica no backend (BFF → agente);
// aqui é só apresentação + os cliques que geram eventos auditáveis (redirect).

import { useCallback, useEffect, useRef, useState } from "react"
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  FileText,
  Loader2,
  MessageCircle,
  QrCode,
  Send,
  ShieldCheck,
  UserRound,
} from "lucide-react"

type Branding = {
  displayName?: string
  primaryColor?: string
  secondaryColor?: string
  logoUrl?: string | null
  welcomeMessage?: string
}

type ResolveResponse = {
  success: boolean
  error?: string
  session?: {
    id: string
    frontend_mode: "alteapay" | "whitelabel"
    fulfillment_mode: "A" | "B" | "C" | null
    outcome: string
    identity_verified: boolean
    consent_pending: boolean
  }
  debtor?: {
    name_masked: string
    document_masked: string
    amount: number
    due_date: string
    description: string | null
    aging_days: number
  } | null
  tenant?: {
    branding: Branding
    privacy_policy_url: string | null
    dpo_contact: string | null
    official_channel_label: string | null
  }
}

type ChatMessage = {
  id: string
  sender: "debtor" | "agent" | "system"
  content: string
  failed?: boolean
}

type AgreementLinks = {
  id: string
  agreed_amount: number
  installments: number | null
  installment_amount: number | null
  asaas_boleto_url: string | null
  asaas_pix_qrcode_url: string | null
  asaas_invoice_url: string | null
  asaas_payment_url: string | null
} | null

const brl = (v: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v)

const dateBR = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split("-")
  return `${d}/${m}/${y}`
}

let msgSeq = 0
const nextId = () => `m${++msgSeq}`

export function NegotiationChat({ token, embed = false }: { token: string; embed?: boolean }) {
  const [phase, setPhase] = useState<"loading" | "error" | "consent" | "chat">("loading")
  const [errorKind, setErrorKind] = useState<string>("")
  const [ctx, setCtx] = useState<ResolveResponse | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState("")
  const [sending, setSending] = useState(false)
  const [consenting, setConsenting] = useState(false)
  const [agreement, setAgreement] = useState<AgreementLinks>(null)
  const [redirectReady, setRedirectReady] = useState(false)
  const [redirecting, setRedirecting] = useState(false)
  const [closed, setClosed] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const lastFailedRef = useRef<string | null>(null)

  const branding = ctx?.tenant?.branding ?? {}
  const primary = branding.primaryColor || "#0A0F1E"
  const accent = branding.secondaryColor || "#EAB308"
  const displayName = branding.displayName || "AlteaPay"

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages, sending, agreement, redirectReady])

  // 1) Resolve do token → cookie httpOnly + contexto público
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const resp = await fetch("/api/negotiation/session/resolve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ token }),
        })
        const data: ResolveResponse = await resp.json().catch(() => ({ success: false }))
        if (cancelled) return
        if (!resp.ok || !data.success) {
          setErrorKind(data.error || `erro ${resp.status}`)
          setPhase("error")
          return
        }
        setCtx(data)
        setPhase(data.session?.consent_pending ? "consent" : "chat")
      } catch {
        if (!cancelled) {
          setErrorKind("network")
          setPhase("error")
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [token])

  // Saudação determinística (composta pela plataforma, não pelo LLM)
  useEffect(() => {
    if (phase !== "chat" || messages.length > 0 || !ctx) return
    const d = ctx.debtor
    const hello = branding.welcomeMessage || "Olá! Estou aqui para ajudar você a resolver sua pendência."
    const parts: ChatMessage[] = [{ id: nextId(), sender: "agent", content: hello }]
    if (d && ctx.session?.identity_verified) {
      parts.push({
        id: nextId(),
        sender: "agent",
        content: `${d.name_masked ? `Olá, ${d.name_masked}! ` : ""}Encontrei sua pendência${
          d.description ? ` referente a "${d.description}"` : ""
        } no valor de ${brl(d.amount)}, vencida em ${dateBR(d.due_date)}. Vamos resolver? Me diga como prefere: à vista com desconto ou parcelado.`,
      })
    } else {
      parts.push({
        id: nextId(),
        sender: "agent",
        content:
          "Antes de falarmos sobre qualquer valor, preciso confirmar sua identidade. Por favor, me informe seu CPF e sua data de nascimento (AAAA-MM-DD).",
      })
    }
    setMessages(parts)
  }, [phase, ctx]) // eslint-disable-line react-hooks/exhaustive-deps

  const acceptConsent = useCallback(async () => {
    setConsenting(true)
    try {
      const resp = await fetch("/api/negotiation/consent", { method: "POST", credentials: "include" })
      if (resp.ok) setPhase("chat")
    } finally {
      setConsenting(false)
    }
  }, [])

  const pollAgreement = useCallback(async () => {
    // Links mock do ASAAS são preenchidos async pela fila de charge
    for (let i = 0; i < 20; i++) {
      try {
        const resp = await fetch("/api/negotiation/session/status", { credentials: "include" })
        const data = await resp.json()
        if (data?.agreement?.asaas_invoice_url || data?.agreement?.asaas_payment_url) {
          setAgreement(data.agreement)
          return
        }
        if (data?.agreement) setAgreement(data.agreement)
      } catch {
        /* tenta de novo */
      }
      await new Promise((r) => setTimeout(r, 3000))
    }
  }, [])

  const send = useCallback(
    async (text: string) => {
      const content = text.trim()
      if (!content || sending) return
      setInput("")
      const mine: ChatMessage = { id: nextId(), sender: "debtor", content }
      setMessages((prev) => [...prev, mine])
      setSending(true)
      try {
        const resp = await fetch("/api/negotiation/message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ message: content }),
        })
        const data = await resp.json().catch(() => null)
        if (!resp.ok || !data?.success) {
          lastFailedRef.current = content
          setMessages((prev) =>
            prev.map((m) => (m.id === mine.id ? { ...m, failed: true } : m)),
          )
          setMessages((prev) => [
            ...prev,
            {
              id: nextId(),
              sender: "system",
              content:
                resp.status === 429
                  ? "Muitas mensagens em sequência — aguarde um instante e tente de novo."
                  : "Não consegui enviar agora. Toque em “tentar novamente”.",
            },
          ])
          return
        }
        lastFailedRef.current = null
        setMessages((prev) => [...prev, { id: nextId(), sender: "agent", content: data.reply }])
        if (data.action === "agreement_closed") {
          setClosed(true)
          void pollAgreement()
        } else if (data.action === "redirect_payment") {
          setRedirectReady(true)
        }
      } catch {
        lastFailedRef.current = content
        setMessages((prev) => prev.map((m) => (m.id === mine.id ? { ...m, failed: true } : m)))
      } finally {
        setSending(false)
      }
    },
    [sending, pollAgreement],
  )

  const doRedirect = useCallback(async () => {
    setRedirecting(true)
    try {
      const resp = await fetch("/api/negotiation/redirect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ confirmed_intent: true }),
      })
      const data = await resp.json()
      if (resp.ok && data?.success && data.official_channel_url) {
        setClosed(true)
        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            sender: "system",
            content: `Você está sendo direcionado para ${data.official_channel_label || "o canal oficial"}. Obrigado!`,
          },
        ])
        window.open(data.official_channel_url, "_blank", "noopener")
      }
    } finally {
      setRedirecting(false)
    }
  }, [])

  // ---------- estados de erro/carregamento ----------
  if (phase === "loading") {
    return (
      <Shell embed={embed} primary={primary} accent={accent} displayName={displayName} branding={branding}>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-slate-500">
          <Loader2 className="h-8 w-8 animate-spin" />
          <p>Abrindo sua negociação…</p>
        </div>
      </Shell>
    )
  }

  if (phase === "error") {
    const msg =
      errorKind === "expired"
        ? "Este link de negociação expirou. Solicite um novo link pelo canal em que você foi contatado."
        : errorKind === "already_used"
          ? "Este link já foi utilizado em outro dispositivo. Por segurança, solicite um novo link."
          : "Link de negociação inválido. Confira se o endereço foi copiado por completo."
    return (
      <Shell embed={embed} primary={primary} accent={accent} displayName={displayName} branding={branding}>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <AlertTriangle className="h-10 w-10 text-amber-500" />
          <p className="max-w-sm text-slate-600">{msg}</p>
        </div>
      </Shell>
    )
  }

  // ---------- consentimento LGPD ----------
  if (phase === "consent") {
    const t = ctx?.tenant
    return (
      <Shell embed={embed} primary={primary} accent={accent} displayName={displayName} branding={branding}>
        <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-4 p-6">
          <div className="flex items-center gap-2 text-lg font-semibold" style={{ color: primary }}>
            <ShieldCheck className="h-6 w-6" style={{ color: accent }} />
            Aviso de privacidade
          </div>
          <div className="space-y-3 rounded-xl border bg-white p-4 text-sm leading-relaxed text-slate-700 shadow-sm">
            <p>
              Esta conversa de negociação é operada pela <strong>AlteaPay</strong> em nome de{" "}
              <strong>{displayName}</strong> (controlador dos dados), com a finalidade de
              negociação de débito.
            </p>
            <p>
              Dados tratados: CPF, data de nascimento, telefone e o conteúdo desta conversa.
              Usamos apenas o necessário para confirmar sua identidade e registrar o acordo
              (LGPD, art. 6º, III).
            </p>
            <p>
              As propostas são geradas de forma automatizada segundo regras aprovadas pelo
              credor. Você pode solicitar revisão humana a qualquer momento pelo botão
              “Falar com atendente” (LGPD, art. 20).
            </p>
            <p className="text-xs text-slate-500">
              {t?.privacy_policy_url && (
                <>
                  <a className="underline" href={t.privacy_policy_url} target="_blank" rel="noreferrer">
                    Política de privacidade
                  </a>
                  {" · "}
                </>
              )}
              {t?.dpo_contact && <>Encarregado (DPO): {t.dpo_contact}</>}
            </p>
          </div>
          <button
            onClick={acceptConsent}
            disabled={consenting}
            className="flex items-center justify-center gap-2 rounded-xl px-4 py-3 font-medium text-white shadow disabled:opacity-60"
            style={{ backgroundColor: primary }}
          >
            {consenting ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            Aceito e quero negociar
          </button>
        </div>
      </Shell>
    )
  }

  // ---------- chat ----------
  const d = ctx?.debtor
  const isModeB = ctx?.session?.fulfillment_mode === "B"
  const quickChips =
    !closed && ctx?.session?.identity_verified
      ? isModeB
        ? ["Quero regularizar meu débito", "Como funciona o pagamento?"]
        : ["Ver opções de pagamento", "Quero pagar à vista", "Quero parcelar", "Aceito a proposta"]
      : []

  return (
    <Shell embed={embed} primary={primary} accent={accent} displayName={displayName} branding={branding}>
      {d && (
        <div className="border-b bg-white/80 px-4 py-3 backdrop-blur">
          <div className="mx-auto flex max-w-2xl items-center justify-between text-sm">
            <div className="flex items-center gap-2 text-slate-600">
              <UserRound className="h-4 w-4" />
              <span>{d.name_masked}</span>
              <span className="text-slate-400">·</span>
              <span className="text-slate-400">{d.document_masked}</span>
            </div>
            <div className="text-right">
              <div className="font-semibold" style={{ color: primary }}>
                {brl(d.amount)}
              </div>
              <div className="text-xs text-slate-400">venceu em {dateBR(d.due_date)}</div>
            </div>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-4 py-4" role="log" aria-live="polite" aria-label="Conversa de negociação">
        <div className="mx-auto flex max-w-2xl flex-col gap-3">
          {messages.map((m) => (
            <Bubble key={m.id} msg={m} primary={primary} onRetry={m.failed ? () => send(m.content) : undefined} />
          ))}

          {sending && (
            <div className="flex items-center gap-2 self-start rounded-2xl bg-white px-4 py-3 text-sm text-slate-500 shadow-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              Nosso assistente está analisando sua mensagem — isso pode levar até um minuto…
            </div>
          )}

          {redirectReady && !closed && (
            <div className="self-stretch rounded-xl border-2 p-4 shadow-sm" style={{ borderColor: accent }}>
              <p className="mb-3 text-sm text-slate-700">
                O pagamento deste débito é feito no canal oficial de {displayName}. Ao continuar,
                você será direcionado para concluir por lá.
              </p>
              <button
                onClick={doRedirect}
                disabled={redirecting}
                className="flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 font-medium text-white disabled:opacity-60"
                style={{ backgroundColor: primary }}
              >
                {redirecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
                Pagar no canal oficial{ctx?.tenant?.official_channel_label ? ` — ${ctx.tenant.official_channel_label}` : ""}
              </button>
            </div>
          )}

          {agreement && (
            <div className="self-stretch rounded-xl border bg-white p-4 shadow-sm">
              <div className="mb-2 flex items-center gap-2 font-medium" style={{ color: primary }}>
                <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                Acordo registrado — {brl(Number(agreement.agreed_amount))}
                {agreement.installments && agreement.installments > 1
                  ? ` em ${agreement.installments}x de ${brl(Number(agreement.installment_amount))}`
                  : " à vista"}
              </div>
              <div className="flex flex-col gap-2 text-sm">
                {agreement.asaas_invoice_url && (
                  <PayLink href={agreement.asaas_invoice_url} icon={<FileText className="h-4 w-4" />} label="Ver fatura" />
                )}
                {agreement.asaas_boleto_url && (
                  <PayLink href={agreement.asaas_boleto_url} icon={<FileText className="h-4 w-4" />} label="Boleto (PDF)" />
                )}
                {agreement.asaas_pix_qrcode_url && (
                  <PayLink href={agreement.asaas_pix_qrcode_url} icon={<QrCode className="h-4 w-4" />} label="Pagar com PIX" />
                )}
                {agreement.asaas_payment_url && (
                  <PayLink href={agreement.asaas_payment_url} icon={<ExternalLink className="h-4 w-4" />} label="Página de pagamento" />
                )}
                {!agreement.asaas_invoice_url && !agreement.asaas_payment_url && (
                  <p className="flex items-center gap-2 text-slate-500">
                    <Loader2 className="h-4 w-4 animate-spin" /> Gerando seus links de pagamento…
                  </p>
                )}
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </div>

      {quickChips.length > 0 && (
        <div className="mx-auto flex w-full max-w-2xl flex-wrap gap-2 px-4 pb-2">
          {quickChips.map((chip) => (
            <button
              key={chip}
              onClick={() => send(chip)}
              disabled={sending}
              className="rounded-full border bg-white px-3 py-1.5 text-xs text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"
            >
              {chip}
            </button>
          ))}
        </div>
      )}

      <div className="border-t bg-white p-3">
        <form
          className="mx-auto flex max-w-2xl items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void send(input)
          }}
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                void send(input)
              }
            }}
            rows={1}
            maxLength={2000}
            disabled={closed && !isModeB}
            placeholder={closed ? "Negociação concluída" : "Escreva sua mensagem…"}
            aria-label="Mensagem"
            className="max-h-32 flex-1 resize-none rounded-xl border px-3 py-2.5 text-sm outline-none focus:ring-2"
          />
          <button
            type="submit"
            disabled={sending || !input.trim()}
            aria-label="Enviar"
            className="rounded-xl p-3 text-white disabled:opacity-50"
            style={{ backgroundColor: primary }}
          >
            <Send className="h-4 w-4" />
          </button>
        </form>
        <div className="mx-auto mt-2 flex max-w-2xl items-center justify-between text-[11px] text-slate-400">
          <button className="flex items-center gap-1 underline" onClick={() => send("Quero falar com um atendente humano.")}>
            <MessageCircle className="h-3 w-3" /> Falar com atendente
          </button>
          {embed && <span>tecnologia AlteaPay</span>}
        </div>
      </div>
    </Shell>
  )
}

function Shell({
  children,
  embed,
  primary,
  accent,
  displayName,
  branding,
}: {
  children: React.ReactNode
  embed: boolean
  primary: string
  accent: string
  displayName: string
  branding: Branding
}) {
  return (
    <div className="flex h-dvh flex-col bg-slate-100">
      {!embed && (
        <header className="px-4 py-3 text-white" style={{ backgroundColor: primary }}>
          <div className="mx-auto flex max-w-2xl items-center gap-2">
            {branding.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={branding.logoUrl} alt={displayName} className="h-7" />
            ) : (
              <span
                className="flex h-7 w-7 items-center justify-center rounded-full text-sm font-bold"
                style={{ backgroundColor: accent, color: primary }}
              >
                {displayName.charAt(0)}
              </span>
            )}
            <span className="font-semibold">{displayName}</span>
            <span className="ml-auto text-xs opacity-70">negociação segura</span>
          </div>
        </header>
      )}
      {children}
    </div>
  )
}

function Bubble({ msg, primary, onRetry }: { msg: ChatMessage; primary: string; onRetry?: () => void }) {
  if (msg.sender === "system") {
    return <div className="self-center rounded-full bg-slate-200 px-3 py-1 text-xs text-slate-600">{msg.content}</div>
  }
  const mine = msg.sender === "debtor"
  return (
    <div className={`flex max-w-[85%] flex-col gap-1 ${mine ? "self-end items-end" : "self-start items-start"}`}>
      <div
        className={`whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm shadow-sm ${
          mine ? "text-white" : "bg-white text-slate-800"
        } ${msg.failed ? "opacity-60" : ""}`}
        style={mine ? { backgroundColor: primary } : undefined}
      >
        {msg.content}
      </div>
      {msg.failed && onRetry && (
        <button onClick={onRetry} className="text-xs text-red-500 underline">
          tentar novamente
        </button>
      )}
    </div>
  )
}

function PayLink({ href, icon, label }: { href: string; icon: React.ReactNode; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-2 rounded-lg border px-3 py-2 text-slate-700 hover:bg-slate-50"
    >
      {icon}
      {label}
      <ExternalLink className="ml-auto h-3 w-3 text-slate-400" />
    </a>
  )
}
