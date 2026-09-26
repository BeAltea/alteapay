"use client"

// Formulário de autenticação do LINK ÚNICO público /n/{code} (Hub §1/§3).
// - Campo ÚNICO: CPF ou CNPJ, máscara DINÂMICA pelo comprimento.
// - Consentimento LGPD obrigatório.
// - Captcha REAL (Cloudflare Turnstile) quando ligado — não é stub: renderiza o
//   widget oficial e usa o token gerado. O sitekey é público
//   (NEXT_PUBLIC_CHAT_CAPTCHA_SITEKEY); o secret fica só no servidor.
// - Nunca guarda PII em title/localStorage/query. Erro/no_debt/blocked têm a
//   MESMA aparência de mensagem uniforme (o servidor devolve o texto).
import { useCallback, useEffect, useRef, useState } from "react"
import { FOCUS_RING } from "./button-tiers"
import { entrySealText, entrySealWhoText, ENTRY_SEAL_WHO_LABEL } from "@/lib/journey/entry-seal"

const NO_DEBT_FALLBACK =
  "Não encontramos dívidas cadastradas para negociação com este documento. Se você recebeu uma mensagem nossa, confira se digitou o documento corretamente. Se preferir, fale com nosso atendimento."

function maskDoc(raw: string): string {
  const d = raw.replace(/\D/g, "").slice(0, 14)
  if (d.length <= 11) {
    const p = [d.slice(0, 3), d.slice(3, 6), d.slice(6, 9), d.slice(9, 11)].filter(Boolean)
    if (p.length <= 1) return p[0] ?? ""
    const head = p.slice(0, 3).join(".")
    return p.length === 4 ? `${head}-${p[3]}` : head
  }
  // CNPJ 00.000.000/0000-00
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}${
    d.length > 12 ? `-${d.slice(12, 14)}` : ""
  }`
}

// Tipagem mínima do Turnstile (evita @types externo).
declare global {
  interface Window {
    turnstile?: {
      render: (
        el: HTMLElement,
        opts: {
          sitekey: string
          callback: (token: string) => void
          "expired-callback"?: () => void
          "error-callback"?: () => void
          theme?: "light" | "dark" | "auto"
        },
      ) => string
      reset: (id?: string) => void
      remove: (id?: string) => void
    }
  }
}

const TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js"

/** Carrega o script do Turnstile uma vez (idempotente). */
function useTurnstileScript(enabled: boolean): boolean {
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    if (!enabled) return
    if (typeof window !== "undefined" && window.turnstile) {
      setLoaded(true)
      return
    }
    const existing = document.querySelector<HTMLScriptElement>(`script[src^="${TURNSTILE_SRC}"]`)
    if (existing) {
      existing.addEventListener("load", () => setLoaded(true))
      if (window.turnstile) setLoaded(true)
      return
    }
    const s = document.createElement("script")
    s.src = TURNSTILE_SRC
    s.async = true
    s.defer = true
    s.addEventListener("load", () => setLoaded(true))
    document.head.appendChild(s)
  }, [enabled])
  return loaded
}

export function PublicAuthForm({
  code,
  successHref,
  captchaEnabled = false,
  captchaSiteKey = "",
  creditorName = "",
}: {
  code: string
  /** ABSOLUTO (ex.: /n/{code}/chat). Navegação HARD após o login para o layout
   *  re-renderizar no servidor e revelar a marca do credor só então. */
  successHref: string
  captchaEnabled?: boolean
  captchaSiteKey?: string
  /** R4 — nome do credor (companies.name via branding do tenant) para o SELO da
   *  porta. NÃO revela o débito; ausente → texto genérico seguro (entry-seal.ts). */
  creditorName?: string
}) {
  const [doc, setDoc] = useState("")
  const [consent, setConsent] = useState(false)
  const [captchaToken, setCaptchaToken] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  // R4 — "quem somos" é um disclosure inline (sem página nova); começa fechado.
  const [showWho, setShowWho] = useState(false)

  const widgetRef = useRef<HTMLDivElement | null>(null)
  const widgetIdRef = useRef<string | null>(null)
  const scriptLoaded = useTurnstileScript(captchaEnabled && Boolean(captchaSiteKey))

  const renderWidget = useCallback(() => {
    if (!captchaEnabled || !captchaSiteKey) return
    if (!scriptLoaded || !window.turnstile || !widgetRef.current) return
    if (widgetIdRef.current) return // já renderizado
    widgetIdRef.current = window.turnstile.render(widgetRef.current, {
      sitekey: captchaSiteKey,
      theme: "auto",
      callback: (token: string) => setCaptchaToken(token),
      "expired-callback": () => setCaptchaToken(""),
      "error-callback": () => setCaptchaToken(""),
    })
  }, [captchaEnabled, captchaSiteKey, scriptLoaded])

  useEffect(() => {
    renderWidget()
  }, [renderWidget])

  const digits = doc.replace(/\D/g, "")
  const canSubmit =
    consent &&
    (digits.length === 11 || digits.length === 14) &&
    (!captchaEnabled || captchaToken.length > 0) &&
    !submitting

  function resetCaptcha() {
    setCaptchaToken("")
    if (widgetIdRef.current && window.turnstile) {
      try {
        window.turnstile.reset(widgetIdRef.current)
      } catch {
        /* noop */
      }
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch("/api/chat/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          document: digits,
          consent,
          captchaToken: captchaEnabled ? captchaToken : undefined,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data?.ok) {
        // Navegação HARD: força o layout server-side a re-renderizar com o cookie
        // → revela a marca do credor só pós-login.
        window.location.assign(successHref)
        return
      }
      // no_debt / blocked / invalid: mensagem vem do servidor (uniforme por caso).
      setError(
        typeof data?.message === "string" && data.message && data.message !== "not available"
          ? data.message
          : NO_DEBT_FALLBACK,
      )
      resetCaptcha() // novo token para a próxima tentativa
    } catch {
      setError(NO_DEBT_FALLBACK)
      resetCaptcha()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-1 flex-col gap-5" autoComplete="off">
      {/* R4 — SELO DE LEGITIMIDADE na porta (antes do CPF): diz de QUEM veio o
          link e que a AlteaPay só OPERA o canal. NÃO revela o débito (D6/D17). */}
      <div className="rounded-md border border-neutral-200 bg-white/70 px-3 py-2.5 text-sm text-neutral-600">
        <p>{entrySealText(creditorName)}</p>
        <button
          type="button"
          onClick={() => setShowWho((v) => !v)}
          aria-expanded={showWho}
          className="mt-1 inline-flex min-h-[44px] items-center text-sm font-medium text-[var(--brand-secondary)] underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-2"
        >
          {ENTRY_SEAL_WHO_LABEL}
        </button>
        {showWho ? (
          <p className="mt-2 text-xs leading-relaxed text-neutral-500">
            {entrySealWhoText(creditorName)}
          </p>
        ) : null}
      </div>

      <div>
        <h1 className="text-xl font-semibold">Consulte sua negociação com segurança</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Informe seu CPF ou CNPJ para continuar. Por segurança, nenhuma informação é exibida
          antes da confirmação dos seus dados.
        </p>
      </div>

      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium text-neutral-700">CPF ou CNPJ</span>
        <input
          inputMode="numeric"
          autoComplete="off"
          placeholder="000.000.000-00"
          value={maskDoc(doc)}
          onChange={(e) => setDoc(e.target.value)}
          className="h-11 rounded-md border border-neutral-300 bg-white px-3 text-base outline-none focus:border-neutral-900 focus:ring-2 focus:ring-neutral-900"
        />
      </label>

      {captchaEnabled && captchaSiteKey ? (
        <div className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium text-neutral-700">Verificação de segurança</span>
          <div ref={widgetRef} />
        </div>
      ) : null}

      <label className="flex items-start gap-2.5 text-sm text-neutral-600">
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          // QA round 4 (R-19): anel de foco ≥ 3:1 (neutral-900 + offset branco).
          className={`${FOCUS_RING} mt-0.5 h-4 w-4 flex-shrink-0 rounded-sm`}
        />
        <span>
          Autorizo o tratamento dos meus dados para fins desta negociação, conforme a Lei Geral
          de Proteção de Dados (LGPD).
        </span>
      </label>

      {error ? (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={!canSubmit}
        style={{ backgroundColor: "var(--brand-secondary)", color: "var(--brand-secondary-fg, #ffffff)" }}
        className="mt-auto h-11 rounded-md text-base font-semibold transition-opacity disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-2"
      >
        {submitting ? "Confirmando..." : "Continuar"}
      </button>
    </form>
  )
}
