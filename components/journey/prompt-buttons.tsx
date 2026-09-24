"use client"

// Componente de prompt com botões (onda R). Ordem por id (1/0 aparecem como
// Sim/Não; 98/99 ao final). Desabilita após o clique. Trata 409 prompt_not_active
// devolvendo o controle ao pai (que recarrega o estado). Sem termos técnicos ao
// cliente e sem badge de id (o badge do button_id é só no painel admin).
//
// VIVACIDADE: o clique NUNCA fica preso em "..." — quando onClick resolve com
// erro (rede/timeout/4xx/5xx), o `finally` para o loading, reabilita os botões
// (answered continua false) e mostramos um aviso curto ao cliente em vez de
// silêncio. O pai (chat.tsx) garante o resolve via AbortController no fetch.
import { useMemo, useState } from "react"

export interface PromptButton {
  id: number
  label: string
  value?: string
  /** Ordem de exibição contratual (menor primeiro), independente do id — o menu de
   *  3 opções (Pagar › Negociar › Não reconheço) usa order 0/1/2 sobre ids 4/1/0.
   *  Ausente = comportamento legado (ordena por id). Espelha buttons.ts/sortButtons. */
  order?: number
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
  /** Envia o clique; retorna ok/erro. 409 prompt_not_active volta pro pai recarregar.
   *  O `buttonLabel` deixa o pai reconhecer o botão Negociar (pela label, já que a
   *  UI não tem o `kind`) para injetar o indicador optimistic "preparando negociação". */
  onClick: (promptId: string, buttonId: number, buttonLabel: string) => Promise<PromptClickResult>
}) {
  const [pending, setPending] = useState<number | null>(null)
  const [answered, setAnswered] = useState(false)
  // Aviso curto ao cliente quando o clique falha (rede/timeout/servidor). Sem
  // termos técnicos e sem código de erro — só orienta a tentar de novo.
  const [notice, setNotice] = useState<string | null>(null)

  // Ordem contratual order-aware (M2/D.2): se algum botão traz `order`, ordena por
  // order (menor primeiro) com o id como desempate; sem `order`, mantém o legado
  // (sort por id). Espelha lib/journey/buttons.ts:sortButtons — o render NÃO pode
  // re-inverter a ordem que o servidor persistiu (era o ALTO A-01).
  const buttons = useMemo(() => {
    const rank = (b: PromptButton) => (typeof b.order === "number" ? b.order : Number.MAX_SAFE_INTEGER)
    return [...prompt.buttons].sort((a, b) => rank(a) - rank(b) || a.id - b.id)
  }, [prompt.buttons])

  async function handle(buttonId: number) {
    if (pending !== null || answered) return
    setNotice(null)
    setPending(buttonId)
    const label = buttons.find((b) => b.id === buttonId)?.label ?? ""
    try {
      const res = await onClick(prompt.id, buttonId, label)
      if (res.ok) {
        setAnswered(true)
      } else if (res.code === "prompt_not_active") {
        // O pai já recarrega o prompt ativo (este componente será remontado via
        // key={prompt.id}); não mostramos aviso pois o estado será substituído.
      } else {
        // 4xx/5xx/timeout/rede: reabilita os botões (answered continua false) e
        // avisa o cliente em vez de deixar em silêncio.
        setNotice(
          res.code === "timeout"
            ? "A conexão está lenta. Toque no botão novamente."
            : "Não foi possível processar agora. Toque no botão novamente.",
        )
      }
    } finally {
      // SEMPRE para o loading — o botão nunca fica preso em "...". Como o pai
      // garante o resolve (AbortController), este finally sempre roda.
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
      {notice ? <p className="text-xs text-red-600">{notice}</p> : null}
    </div>
  )
}
