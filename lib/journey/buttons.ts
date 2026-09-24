// Catálogo de botões/IDs do chat (onda R, contrato §2). Puro e testável.
//
// IDs reservados (contrato inegociável — GATE R0):
//   1  = Sim   (booleano)
//   0  = Não   (booleano)
//   2..N = itens de lista (value = offer_id / PIX / BOLETO / CREDIT_CARD, na
//          ordem exibida)
//   98 = Voltar
//   99 = Atendente (handoff)
//
// Fluxo Consultar/Negociar (dono pediu — o prompt inicial deixa de ser Sim/Não
// isolado): reusa os ids de "item de lista" 2 e 3 no prompt kind 'debt_consult'.
//   2 = Consultar Dívida (mostra o resumo, sem iniciar o n8n)
//   3 = Negociar Dívida  (mostra o resumo E inicia a negociação no n8n)
// "Não reconheço a dívida" reusa o BTN_NO (0). Assim o catálogo booleano
// (1/0/99) segue intacto para os demais prompts.
//
// Onda "3 opções" (§6.1, decisão G1 D.2/ordem): o prompt inicial pós-login passa
// a oferecer TRÊS botões, sempre nesta ordem — Pagar(4) › Negociar(1) › Não
// reconheço(0) — no kind 'debt_three_options'. Ids:
//   4 = PAGAR (id livre; NÃO colide com Consultar=2/Negociar=3/booleano 0,1)
//   1 = NEGOCIAR (reusa BTN_YES: "quero negociar" implica reconhecimento)
//   0 = NAO_RECONHECO (reusa BTN_NO)
// O clique em Pagar(4) ou Negociar(1) grava reconhecimento IMPLÍCITO (M4).
//
// prompt_kind conhecidos; kinds novos vindos do n8n são aceitos e registrados
// (o servidor não impõe um enum fechado, só valida a estrutura dos botões).

export type PromptKind =
  | "debt_acknowledgement"
  | "debt_consult"
  | "debt_three_options"
  | "offer_choice"
  | "payment_method_choice"
  | "payment_confirmation"
  | "generic_yes_no"

export const KNOWN_PROMPT_KINDS: readonly PromptKind[] = [
  "debt_acknowledgement",
  "debt_consult",
  "debt_three_options",
  "offer_choice",
  "payment_method_choice",
  "payment_confirmation",
  "generic_yes_no",
] as const

export const BTN_YES = 1
export const BTN_NO = 0
export const BTN_CONSULT = 2
export const BTN_NEGOTIATE = 3
/** Onda "3 opções": botão PAGAR do menu pós-login (id livre; decisão G1). */
export const BTN_PAY = 4
export const BTN_BACK = 98
export const BTN_HANDOFF = 99

/** IDs reservados com significado fixo. 2..97 são itens de lista. */
export const RESERVED_IDS = new Set([BTN_YES, BTN_NO, BTN_BACK, BTN_HANDOFF])

export interface Button {
  id: number
  label: string
  value?: string
  /**
   * Ordem de exibição EXPLÍCITA (menor primeiro). Quando presente, tem precedência
   * sobre o id no sortButtons. Necessário para o menu de 3 opções, cuja ordem
   * contratual (Pagar › Negociar › Não reconheço) NÃO coincide com a ordem dos ids
   * (4,1,0). Botões sem `order` mantêm o comportamento legado (sort por id).
   */
  order?: number
}

export type ButtonValidation =
  | { ok: true }
  | { ok: false; error: string }

/**
 * Valida um catálogo de botões:
 *  - ids inteiros >= 0;
 *  - ids ÚNICOS (sem colisão);
 *  - labels não-vazios;
 *  - itens de lista usam 2..97 (não podem colidir com reservados);
 *  - booleano só admite 1/0 (+99 opcional): validado por assertBooleanButtons.
 */
export function validateButtons(buttons: unknown): ButtonValidation {
  if (!Array.isArray(buttons) || buttons.length === 0) {
    return { ok: false, error: "buttons_empty" }
  }
  const seen = new Set<number>()
  for (const b of buttons) {
    if (typeof b !== "object" || b === null) return { ok: false, error: "button_shape" }
    const id = (b as Button).id
    const label = (b as Button).label
    if (typeof id !== "number" || !Number.isInteger(id) || id < 0) {
      return { ok: false, error: "button_id_invalid" }
    }
    if (typeof label !== "string" || label.trim().length === 0) {
      return { ok: false, error: "button_label_missing" }
    }
    if (seen.has(id)) return { ok: false, error: "button_id_duplicate" }
    seen.add(id)
  }
  return { ok: true }
}

/**
 * Para prompts booleanos (Sim/Não): só aceitam ids 1, 0 e opcionalmente 99.
 * Nenhum item de lista (2..N) é permitido num booleano.
 */
export function assertBooleanButtons(buttons: Button[]): ButtonValidation {
  const base = validateButtons(buttons)
  if (!base.ok) return base
  for (const b of buttons) {
    if (b.id !== BTN_YES && b.id !== BTN_NO && b.id !== BTN_HANDOFF) {
      return { ok: false, error: "boolean_button_id_invalid" }
    }
  }
  const ids = new Set(buttons.map((b) => b.id))
  if (!ids.has(BTN_YES) || !ids.has(BTN_NO)) return { ok: false, error: "boolean_missing_yes_no" }
  return { ok: true }
}

/**
 * Ordena os botões para exibição. Regra:
 *  - se QUALQUER botão traz `order`, ordena por `order` (menor primeiro), com o id
 *    como desempate (botões sem `order` vão ao final, preservando o id-sort entre
 *    eles). Isto atende o menu de 3 opções (Pagar › Negociar › Não reconheço), cuja
 *    ordem contratual não coincide com a ordem dos ids (4,1,0);
 *  - caso contrário, comportamento legado: id crescente (Sim/Não como 1/0; 98/99 ao
 *    final).
 */
export function sortButtons(buttons: Button[]): Button[] {
  const hasOrder = buttons.some((b) => typeof b.order === "number")
  if (!hasOrder) return [...buttons].sort((a, b) => a.id - b.id)
  const rank = (b: Button) => (typeof b.order === "number" ? b.order : Number.MAX_SAFE_INTEGER)
  return [...buttons].sort((a, b) => rank(a) - rank(b) || a.id - b.id)
}

/** Localiza um botão pelo id no catálogo (após validado). */
export function findButton(buttons: Button[], buttonId: number): Button | null {
  return buttons.find((b) => b.id === buttonId) ?? null
}
