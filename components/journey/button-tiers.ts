// D3 — HIERARQUIA VISUAL dos botões do prompt (C11 / R-18, carta de voz §10.3),
// SEPARAÇÃO anti-clique-errado (R-20) e ALVO DE TOQUE (R-19 / C12). Lógica PURA,
// num .ts sem React/JSX para ser TESTÁVEL no ambiente node do vitest (mesmo padrão
// de chat-display.ts / wait-machine.ts / contrast.ts — "a decisão vive fora do
// .tsx"; o componente prompt-buttons.tsx apenas CONSOME estas funções).
//
// Por quê separar do .tsx: o vitest deste repo roda em `environment: node` e só
// inclui `*.test.ts` — importar um .tsx (JSX no topo do módulo) quebra o transform.
// Extraindo a derivação de tier/estilo para cá, a hierarquia fica coberta por teste
// sem montar React.

// ids do catálogo (espelham lib/journey/buttons.ts — não importamos o módulo server
// para manter esta unidade leve e reusável pelo componente client).
export const ID_NO = 0
export const ID_NEGOTIATE = 1
export const ID_CONSULT = 2
export const ID_PAY = 4
export const ID_BACK = 98
export const ID_HANDOFF = 99

/** Nível visual do botão. primary = ação de maior recuperação (PAGAR); secondary =
 *  negociar; tertiary = consultar/não-reconheço/voltar/atendimento. */
export type ButtonTier = "primary" | "secondary" | "tertiary"

/**
 * Deriva o TIER visual de um botão a partir do (kind, id). PURA/testável (R-18).
 *  - menu de 3 opções (debt_three_options): PAGAR(4)=primary, NEGOCIAR(1)=secondary,
 *    CONSULTAR(2)/NÃO-RECONHEÇO(0)=tertiary; VOLTAR(98)/ATENDIMENTO(99)=tertiary.
 *  - escolha de parcelas (offer_choice): os itens de lista (2..97) são as CONDIÇÕES
 *    de pagamento → primary (o "(recomendado)" no rótulo orienta a à vista);
 *    VOLTAR(98)/ATENDIMENTO(99)=tertiary.
 *  - demais kinds (reconhecimento legado, debt_consult, genéricos): a 1ª ação
 *    afirmativa (SIM/NEGOCIAR) é primary; NÃO/VOLTAR/ATENDIMENTO são tertiary.
 */
export function buttonTier(kind: string, id: number): ButtonTier {
  if (id === ID_BACK || id === ID_HANDOFF) return "tertiary"

  if (kind === "debt_three_options") {
    if (id === ID_PAY) return "primary"
    if (id === ID_NEGOTIATE) return "secondary"
    return "tertiary" // CONSULTAR / NÃO-RECONHEÇO
  }

  if (kind === "offer_choice") {
    // 2..97 = condições de pagamento (à vista/parcelas) — todas são ação de resolver.
    if (id >= 2 && id <= 97) return "primary"
    return "tertiary"
  }

  // kinds afirmativos (Sim/Negociar) x contestação (Não).
  if (id === ID_NO) return "tertiary"
  if (id === ID_NEGOTIATE || id === ID_CONSULT || (id >= 2 && id <= 97)) return "primary"
  return "primary"
}

/** true quando o botão é a CONTESTAÇÃO ("Não reconheço", id 0) num menu de 3
 *  opções — deve ficar SEPARADO do grupo de resolução (R-20). */
export function isContestation(kind: string, id: number): boolean {
  return kind === "debt_three_options" && id === ID_NO
}

// Estilo por tier. Todos os alvos têm min-h-[44px] (R-19) e px generoso. O primary
// preenche com a marca (fundo var(--brand-secondary), texto adaptativo AA); o
// secondary usa contorno de marca (peso menor que o primary, maior que o tertiary);
// o tertiary é discreto (contorno neutro/ghost). foco visível (focus-visible ring).
export const BASE_BTN =
  "inline-flex min-h-[44px] items-center justify-center rounded-md text-sm font-semibold " +
  "transition-colors disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 " +
  "focus-visible:ring-offset-1 focus-visible:ring-[var(--brand-secondary)]"

/** className por tier. O primary recebe estilo inline (cor de marca) no render. */
export function tierClass(tier: ButtonTier): string {
  switch (tier) {
    case "primary":
      // maior (px-5, text-base), preenchido — o destaque da tela.
      return `${BASE_BTN} w-full px-5 text-base shadow-sm sm:w-auto`
    case "secondary":
      // contorno de marca, peso intermediário.
      return (
        `${BASE_BTN} border-2 px-4 ` +
        "border-[var(--brand-secondary)] text-[var(--brand-secondary)] hover:bg-[var(--brand-secondary)]/10"
      )
    case "tertiary":
    default:
      // discreto: contorno neutro, texto neutro.
      return (
        `${BASE_BTN} border border-neutral-300 px-4 font-medium text-neutral-600 hover:bg-neutral-50`
      )
  }
}
