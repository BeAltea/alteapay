"use client"

// Formulário de autenticação genérico por documento (N1, /t/{slug}/negociar).
// Aceita CPF (11) ou CNPJ (14). Único fator = documento; consentimento LGPD
// obrigatório antes do 1º turno. Erro SEMPRE genérico (resposta uniforme).
// Nunca guarda PII em title/localStorage/query.
import { useState } from "react"
import { useRouter } from "next/navigation"
import { entrySealText, entrySealWhoText, ENTRY_SEAL_WHO_LABEL } from "@/lib/journey/entry-seal"

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

export function JourneyGenericAuthForm({
  tenantSlug,
  successHref = "./chat",
  captchaEnabled = false,
  creditorName = "",
}: {
  tenantSlug: string
  successHref?: string
  captchaEnabled?: boolean
  /** R4 — nome do credor (companies.name via branding) para o SELO da porta. */
  creditorName?: string
}) {
  const router = useRouter()
  const [doc, setDoc] = useState("")
  const [consent, setConsent] = useState(false)
  const [captchaToken, setCaptchaToken] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [showWho, setShowWho] = useState(false)

  const digits = doc.replace(/\D/g, "")
  const canSubmit =
    consent &&
    (digits.length === 11 || digits.length === 14) &&
    (!captchaEnabled || captchaToken.length > 0) &&
    !submitting

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
          tenantSlug,
          document: digits,
          consent,
          captchaToken: captchaEnabled ? captchaToken : undefined,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data?.ok) {
        router.replace(successHref)
        return
      }
      setError(
        typeof data?.message === "string" && data.message && data.message !== "not found"
          ? data.message
          : "Não foi possível confirmar seus dados. Verifique e tente novamente.",
      )
    } catch {
      setError("Não foi possível confirmar seus dados. Verifique e tente novamente.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-1 flex-col gap-5" autoComplete="off">
      {/* R4 — SELO DE LEGITIMIDADE na porta (antes do CPF); não revela o débito. */}
      <div className="rounded-md border border-neutral-200 bg-white/70 px-3 py-2.5 text-sm text-neutral-600">
        <p>{entrySealText(creditorName)}</p>
        <button
          type="button"
          onClick={() => setShowWho((v) => !v)}
          aria-expanded={showWho}
          className="mt-1 inline-flex items-center text-xs font-medium text-[var(--brand-secondary)] underline underline-offset-2"
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
        <h1 className="text-xl font-semibold">Acesse sua negociação</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Informe seu CPF ou CNPJ para continuar. Não exibimos nenhuma informação antes da
          confirmação.
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
          className="h-11 rounded-md border border-neutral-300 bg-white px-3 text-base outline-none focus:border-[var(--brand-secondary)] focus:ring-2 focus:ring-[var(--brand-secondary)]/30"
        />
      </label>

      {captchaEnabled ? (
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium text-neutral-700">Verificação de segurança</span>
          <input
            value={captchaToken}
            onChange={(e) => setCaptchaToken(e.target.value)}
            placeholder="Confirme que você não é um robô"
            className="h-11 rounded-md border border-neutral-300 bg-white px-3 text-base outline-none focus:border-[var(--brand-secondary)]"
          />
        </label>
      ) : null}

      <label className="flex items-start gap-2.5 text-sm text-neutral-600">
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          className="mt-0.5 h-4 w-4 flex-shrink-0"
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
        style={{ backgroundColor: "var(--brand-secondary)" }}
        className="mt-auto h-11 rounded-md text-base font-semibold text-white transition-opacity disabled:opacity-40"
      >
        {submitting ? "Confirmando..." : "Continuar"}
      </button>
    </form>
  )
}
