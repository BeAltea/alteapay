"use client"

// Componente de prompt com botões (onda R). Ordem por id (1/0 aparecem como
// Sim/Não; 98/99 ao final). Desabilita após o clique. Trata 409 prompt_not_active
// devolvendo o controle ao pai (que recarrega o estado). Sem termos técnicos ao
// cliente e sem badge de id (o badge do button_id é só no painel admin).
import { useMemo, useState } from "react"

export interface PromptButton {
  id: number
  label: string
  value?: string
}

export interface ActivePrompt {
  id: string
  kind: string
  question: string
  buttons: PromptButton[]
}

export interface PromptClickResult {
  ok: boolean
  code?: string
}

export function PromptButtons({
  prompt,
  onClick,
}: {
  prompt: ActivePrompt
  /** Envia o clique; retorna ok/erro. 409 prompt_not_active volta pro pai recarregar. */
  onClick: (promptId: string, buttonId: number) => Promise<PromptClickResult>
}) {
  const [pending, setPending] = useState<number | null>(null)
  const [answered, setAnswered] = useState(false)

  const buttons = useMemo(() => [...prompt.buttons].sort((a, b) => a.id - b.id), [prompt.buttons])

  async function handle(buttonId: number) {
    if (pending !== null || answered) return
    setPending(buttonId)
    try {
      const res = await onClick(prompt.id, buttonId)
      if (res.ok) {
        setAnswered(true)
      }
      // 409 prompt_not_active: o pai recarrega o prompt ativo; aqui só liberamos.
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="space-y-2 rounded-lg border border-neutral-200 bg-white p-3">
      <p className="text-sm text-neutral-800">{prompt.question}</p>
      <div className="flex flex-wrap gap-2">
        {buttons.map((b) => (
          <button
            key={b.id}
            type="button"
            onClick={() => handle(b.id)}
            disabled={answered || pending !== null}
            style={{ backgroundColor: "var(--brand-secondary)" }}
            className="h-9 rounded-md px-4 text-sm font-semibold text-white disabled:opacity-40"
          >
            {pending === b.id ? "..." : b.label}
          </button>
        ))}
      </div>
    </div>
  )
}
