"use client"

// Formulário de autenticação do devedor (F4). Máscara de CPF só com dígitos,
// data de nascimento condicional, consentimento LGPD obrigatório.
// Nunca guarda PII em title/localStorage/query; erro SEMPRE genérico.
import { useState } from "react"

function maskCpf(digits: string): string {
  const d = digits.replace(/\D/g, "").slice(0, 11)
  const parts = [d.slice(0, 3), d.slice(3, 6), d.slice(6, 9), d.slice(9, 11)].filter(Boolean)
  if (parts.length <= 1) return parts[0] ?? ""
  const head = parts.slice(0, 3).join(".")
  return parts.length === 4 ? `${head}-${parts[3]}` : head
}

export function JourneyAuthForm({
  token,
  requireBirthDate,
  successHref = "./chat",
}: {
  token: string
  requireBirthDate: boolean
  /** Para onde ir após autenticar. Idealmente ABSOLUTO (ex.: /c/{token}/chat):
   *  a navegação é HARD (window.location) de propósito, para o layout
   *  re-renderizar no servidor e revelar a marca do credor só após o login. */
  successHref?: string
}) {
  const [cpf, setCpf] = useState("")
  const [birthDate, setBirthDate] = useState("")
  const [consent, setConsent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const cpfDigits = cpf.replace(/\D/g, "")
  const canSubmit =
    consent && cpfDigits.length >= 11 && (!requireBirthDate || birthDate.length === 10) && !submitting

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
          token,
          document: cpfDigits,
          birthDate: requireBirthDate ? birthDate : undefined,
          consent,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data?.ok) {
        // Navegação HARD (não router.replace): força o layout server-side a
        // re-renderizar já com o cookie de sessão → revela a marca do credor.
        window.location.assign(successHref)
        return
      }
      // Mensagem sempre genérica (410 = link; demais = credencial).
      setError(
        typeof data?.message === "string" && data.message
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
      <div>
        <h1 className="text-xl font-semibold">Confirme seus dados</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Para sua segurança, confirme as informações abaixo antes de ver sua negociação.
        </p>
      </div>

      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium text-neutral-700">CPF</span>
        <input
          inputMode="numeric"
          autoComplete="off"
          placeholder="000.000.000-00"
          value={maskCpf(cpf)}
          onChange={(e) => setCpf(e.target.value)}
          className="h-11 rounded-md border border-neutral-300 bg-white px-3 text-base outline-none focus:border-[var(--brand-secondary)] focus:ring-2 focus:ring-[var(--brand-secondary)]/30"
        />
      </label>

      {requireBirthDate ? (
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium text-neutral-700">Data de nascimento</span>
          <input
            type="date"
            value={birthDate}
            onChange={(e) => setBirthDate(e.target.value)}
            className="h-11 rounded-md border border-neutral-300 bg-white px-3 text-base outline-none focus:border-[var(--brand-secondary)] focus:ring-2 focus:ring-[var(--brand-secondary)]/30"
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
        {submitting ? "Confirmando..." : "Confirmar"}
      </button>
    </form>
  )
}
