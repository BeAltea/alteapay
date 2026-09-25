"use client"

// Componente de prompt com botões (onda R). Ordem por `order` (contratual) e id.
// Desabilita após o clique. Trata 409 prompt_stale/prompt_not_active devolvendo
// o controle ao pai (que re-hidrata o estado) E avisando o devedor — nunca em
// silêncio (A1 / N-D3-3). Sem termos técnicos ao cliente e sem badge de id (o
// badge do button_id é só no painel admin).
//
// HIERARQUIA VISUAL (C11 / R-18, carta de voz §10.3): o peso do botão espelha o
// peso da DECISÃO — PAGAR primário (grande, preenchido, destaque), NEGOCIAR
// secundário (preenchido leve/contorno de marca), CONSULTAR/NÃO-RECONHEÇO
// terciários (discretos, contorno/ghost). Assim o devedor não trata "não pagar"
// como equivalente a "pagar". A hierarquia é derivada por `buttonTier(kind,id)`
// (pura/testável); o estilo por tier vem de `tierClass`.
//
// MOBILE 360px (C12): todo alvo de toque tem min-h-[44px] (R-19); há SEPARAÇÃO
// anti-clique-errado (R-20) entre o grupo de resolução (pagar/negociar) e a
// contestação (não reconheço) — a contestação vai para uma linha própria, abaixo,
// com um divisor; nunca colada ao Negociar com o mesmo peso.
//
// CONTRASTE AA (R-23): botões de marca usam color: var(--brand-secondary-fg)
// (preto/branco adaptativo por luminância — ver lib/journey/contrast.ts). Nunca
// texto branco fixo sobre um secundário claro do tenant.
//
// A11Y (R-43): a pergunta do prompt é anunciada uma vez ao leitor de tela via uma
// região aria-live=polite dedicada (os rótulos dos botões NÃO são relidos em massa
// — o bloco de botões fica fora da live region, no group aria-label do pai).
//
// VIVACIDADE: o clique NUNCA fica preso em "..." — quando onClick resolve com erro
// (rede/timeout/4xx/5xx), o `finally` para o loading, reabilita os botões e
// mostramos um aviso curto. O pai (chat.tsx) garante o resolve via AbortController.
import { useMemo, useState } from "react"
// HIERARQUIA/ALVO/ESTILO derivados por lógica PURA num .ts irmão (button-tiers.ts)
// — testável no node do vitest sem montar React (a decisão vive fora do .tsx).
import {
  buttonTier,
  isContestation,
  tierClass,
  type ButtonTier,
} from "./button-tiers"

export type { ButtonTier }
export { buttonTier, tierClass }

/** A1 — aviso humano quando o prompt clicado já foi substituído (409). */
export const PROMPT_STALE_NOTICE = "Esta opção já foi atualizada. Veja as opções abaixo."

/** Aviso humano por código de falha do clique (puro/testável). null = sem aviso. */
export function clickNotice(code: string | undefined): string | null {
  if (!code) return null
  if (code === "prompt_stale" || code === "prompt_not_active") return PROMPT_STALE_NOTICE
  if (code === "timeout") return "A conexão está lenta. Toque no botão novamente."
  return "Não foi possível processar agora. Toque no botão novamente."
}

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
  /** Envia o clique; retorna ok/erro. 409 prompt_stale volta pro pai re-hidratar.
   *  O `buttonLabel` deixa o pai reconhecer o botão Negociar (pela label, já que a
   *  UI não tem o `kind`) para injetar o indicador optimistic "preparando negociação". */
  onClick: (promptId: string, buttonId: number, buttonLabel: string) => Promise<PromptClickResult>
}) {
  const [pending, setPending] = useState<number | null>(null)
  const [answered, setAnswered] = useState(false)
  // Aviso curto ao cliente quando o clique falha (rede/timeout/servidor/prompt
  // substituído). Sem termos técnicos e sem código de erro.
  const [notice, setNotice] = useState<string | null>(null)

  // Ordem contratual order-aware (M2/D.2): se algum botão traz `order`, ordena por
  // order (menor primeiro) com o id como desempate; sem `order`, mantém o legado
  // (sort por id). Espelha lib/journey/buttons.ts:sortButtons — o render NÃO pode
  // re-inverter a ordem que o servidor persistiu (era o ALTO A-01).
  const buttons = useMemo(() => {
    const rank = (b: PromptButton) => (typeof b.order === "number" ? b.order : Number.MAX_SAFE_INTEGER)
    return [...prompt.buttons].sort((a, b) => rank(a) - rank(b) || a.id - b.id)
  }, [prompt.buttons])

  // Separa a CONTESTAÇÃO (Não reconheço no menu de 3 opções) do grupo de resolução
  // (R-20): a contestação vai para uma linha própria, abaixo de um divisor, para
  // não ficar colada ao Negociar nem com o mesmo peso.
  const { resolution, contestation } = useMemo(() => {
    const res: PromptButton[] = []
    const con: PromptButton[] = []
    for (const b of buttons) {
      if (isContestation(prompt.kind, b.id)) con.push(b)
      else res.push(b)
    }
    return { resolution: res, contestation: con }
  }, [buttons, prompt.kind])

  async function handle(buttonId: number) {
    if (pending !== null || answered) return
    setNotice(null)
    setPending(buttonId)
    const label = buttons.find((b) => b.id === buttonId)?.label ?? ""
    try {
      const res = await onClick(prompt.id, buttonId, label)
      if (res.ok) {
        setAnswered(true)
      } else {
        // A1 (N-D3-3): 409 prompt_stale/prompt_not_active NUNCA é mudo — o pai já
        // re-hidratou o prompt ativo (este componente pode ser remontado via
        // key={prompt.id}); se o mesmo prompt continuar na tela, o devedor vê o
        // aviso e os botões reabilitados. 4xx/5xx/timeout/rede: reabilita os
        // botões (answered continua false) e avisa em vez de deixar em silêncio.
        setNotice(clickNotice(res.code))
      }
    } finally {
      // SEMPRE para o loading — o botão nunca fica preso em "...". Como o pai
      // garante o resolve (AbortController), este finally sempre roda.
      setPending(null)
    }
  }

  const renderButton = (b: PromptButton) => {
    const tier = buttonTier(prompt.kind, b.id)
    const isPrimary = tier === "primary"
    return (
      <button
        key={b.id}
        type="button"
        onClick={() => handle(b.id)}
        disabled={answered || pending !== null}
        data-tier={tier}
        // R-23: primary preenche com a marca e usa a cor de texto adaptativa (AA).
        style={
          isPrimary
            ? { backgroundColor: "var(--brand-secondary)", color: "var(--brand-secondary-fg, #ffffff)" }
            : undefined
        }
        className={tierClass(tier)}
      >
        {pending === b.id ? "…" : b.label}
      </button>
    )
  }

  const question = (prompt.question ?? "").trim()

  return (
    <div className="space-y-3 rounded-lg border border-neutral-200 bg-white p-3">
      {/* R-43: a pergunta entra numa live region dedicada (anunciada 1x); os
          rótulos dos botões NÃO são relidos em massa (ficam fora desta região).
          A1: o menu INICIAL vem sem pergunta (a saudação, no log, já pergunta) —
          não renderiza parágrafo vazio. */}
      {question ? (
        <p className="text-sm text-neutral-800" role="status" aria-live="polite">
          {question}
        </p>
      ) : null}
      {/* Grupo de RESOLUÇÃO (pagar/negociar/consultar/parcelas). gap-2.5 anti-erro.
          O primary ocupa a largura toda no mobile (1º botão acima da dobra, C12). */}
      <div className="flex flex-col gap-2.5 sm:flex-row sm:flex-wrap">{resolution.map(renderButton)}</div>
      {/* R-20: CONTESTAÇÃO separada por um divisor, em linha própria, peso terciário —
          nunca colada ao Negociar. */}
      {contestation.length > 0 ? (
        <div className="mt-1 border-t border-neutral-100 pt-2.5">
          <div className="flex flex-col gap-2.5 sm:flex-row sm:flex-wrap">
            {contestation.map(renderButton)}
          </div>
        </div>
      ) : null}
      {notice ? (
        <p className="text-xs text-red-600" role="status" aria-live="polite">
          {notice}
        </p>
      ) : null}
    </div>
  )
}
