// Lógica PURA de EXIBIÇÃO do chat do devedor (C1-client). Fica num .ts separado
// (sem React) para ser testável no ambiente node do vitest — mesmo padrão dos
// demais concerns (a decisão vive fora do componente; o .tsx apenas consome).
//
// Cobre dois objetivos do comportamento desejado:
//  - "MANTER SÓ A ÚLTIMA RESPOSTA": colapsar bolhas assistant de conteúdo
//    idêntico no render (dedupAssistantByContent).
//  - Indicador "trabalhando" ao Negociar: reconhecer o botão de negociação pelo
//    rótulo (isNegotiateLabel), já que a UI não tem o `kind` do botão.

import {
  classifyMessage,
  isProtectedClass,
  type DisplayClass,
} from "@/lib/journey/display-class"
import type { WaitState } from "@/lib/journey/wait-machine"

export interface MsgAction {
  type: string
  label: string
  href: string
}

export interface ChatMsg {
  id: string
  from: "customer" | "assistant"
  text: string
  action?: MsgAction | null
  // prompt_id da pergunta que originou esta bolha (quando é a mensagem do prompt).
  promptId?: string | null
  // engine de origem ('platform' | 'n8n' | null) — sinal p/ classificar system.
  engine?: string | null
  // button_id (eco do clique) — sinal p/ classificar decision.
  buttonId?: number | null
}

// TETO de itens visíveis antes de "ver conversa completa" (Apêndice D.4 = 20). O
// teto NUNCA esconde decision/outcome (C8): itens protegidos ficam sempre
// visíveis, mesmo acima do teto. Só guidance/superseded são recolhidos.
export const HISTORY_VISIBLE_CAP = 20

/** Texto da bolha optimistic local injetada ao clicar Negociar (feedback
 *  imediato de "trabalhando" enquanto o backend dispara negotiation.start ao n8n
 *  e aguardamos a 1ª resposta chegar via poll). É texto plano, sem PII.
 *  T3 / R-26: IDÊNTICO à confirmação persistida pelo servidor (T2 em
 *  button/route.ts) — uma única frase para o MESMO instante, para não duplicar a
 *  bolha no histórico (M4). "Certo." (não "Perfeito.") e "para você" (não "seu caso"). */
export const NEGOTIATION_PENDING_TEXT =
  "Certo. Vou buscar as condições de pagamento disponíveis para você."

/** Reconhece o botão que dispara a negociação n8n pelo rótulo (a UI não tem o
 *  kind do botão). Casa "Negociar" / "Negociar Dívida" sem depender do id. */
export function isNegotiateLabel(label: string): boolean {
  return /negociar/i.test(label)
}

// Colapsa bolhas do ASSISTENTE com texto idêntico, mantendo apenas a ÚLTIMA
// ocorrência (na posição original da última). O servidor pode re-persistir a
// mesma resposta ("Aqui estão os dados...", saudação re-bootstrapada) — aqui
// garantimos "só a última resposta" na EXIBIÇÃO, sem tocar no buffer bruto nem
// no backend. Bolhas do cliente e bolhas com <a> de ação nunca são colapsadas.
export function dedupAssistantByContent(list: ChatMsg[]): ChatMsg[] {
  // 1º passo: para cada texto assistant "colapsável", achar o índice da ÚLTIMA
  // ocorrência.
  const lastIdxByText = new Map<string, number>()
  list.forEach((m, i) => {
    if (m.from !== "assistant") return
    if (m.action) return // ação anexada: preserva sempre
    lastIdxByText.set(m.text.trim(), i)
  })
  // 2º passo: manter cliente sempre; manter assistant só na última ocorrência
  // do seu texto (ou se não for colapsável).
  return list.filter((m, i) => {
    if (m.from !== "assistant") return true
    if (m.action) return true
    return lastIdxByText.get(m.text.trim()) === i
  })
}

// ============================================================================
// PODA §10.1 (C4/C5/C6/C8) — de APRESENTAÇÃO, no client. Opera sobre a CLASSE de
// cada bolha (classifyMessage), NUNCA sobre journey_events (auditoria intacta —
// C2). Roda no render, depois do filtro de prompt ativo e do dedup por conteúdo.
// ============================================================================

/** Deriva a DisplayClass de uma ChatMsg do render (mapeia os sinais que a bolha
 *  carrega para o classificador puro). `activePromptId`/`waitState` vêm do estado
 *  do chat. Uma bolha do cliente é decision; assistant com action é outcome; etc. */
export function classOf(
  m: ChatMsg,
  activePromptId: string | null,
  waitState: WaitState | null,
): DisplayClass {
  return classifyMessage(
    {
      role: m.from === "customer" ? "customer" : "assistant",
      buttonId: m.buttonId ?? null,
      engine: m.engine ?? null,
      hasAction: !!m.action,
      promptId: m.promptId ?? null,
      text: m.text,
    },
    { activePromptId, waitState },
  )
}

/**
 * PODA por CLASSE (§10.1). Aplica, na ordem:
 *   (1) SYSTEM fora: itens de classe system NUNCA renderizam (R-16).
 *   (2) SUPERSEDED colapsa: bolhas-pergunta de menus não-ativos somem — só o menu
 *       vivo (no bloco de botões) fica; menus antigos não empilham (C5/R-13).
 * NÃO remove decision nem outcome (C8/R-15). Guidance permanece (o colapso de
 * guidance idêntica é do dedupAssistantByContent, chamado à parte).
 * Determinística e pura.
 */
export function prunePresentation(
  list: ChatMsg[],
  activePromptId: string | null,
  waitState: WaitState | null,
): ChatMsg[] {
  return list.filter((m) => {
    const cls = classOf(m, activePromptId, waitState)
    if (cls === "system") return false // (1) nunca renderiza (R-16)
    if (cls === "superseded") return false // (2) menu substituído não empilha (R-13)
    return true
  })
}

export interface CappedHistory {
  /** itens visíveis (dentro do teto + TODOS os decision/outcome protegidos). */
  visible: ChatMsg[]
  /** itens recolhidos atrás de "ver conversa completa" (guidance antigos). */
  collapsed: ChatMsg[]
  /** true quando há itens recolhidos (a UI mostra o controle de expansão). */
  hasMore: boolean
}

/**
 * TETO DE ITENS (§10.1 / R-41 / Apêndice D.4=20). Mantém no máximo `cap` itens
 * visíveis; o excedente MAIS ANTIGO é recolhido atrás de "ver conversa completa".
 * REGRA DURA (C8): itens decision/outcome NUNCA são recolhidos — permanecem
 * visíveis mesmo acima do teto (o teto conta e recolhe só guidance).
 *
 * Estratégia: percorre do mais NOVO ao mais VELHO; um item entra em `visible` se
 * for protegido (sempre) OU se ainda houver orçamento do teto (o teto conta só os
 * NÃO-protegidos, para não "gastar" o teto com itens que ficam de qualquer forma).
 * Os guidance velhos que estouram o orçamento vão para `collapsed`. A ordem
 * original (cronológica) é preservada nas duas listas.
 *
 * `expanded=true` (usuário clicou "ver conversa completa") devolve tudo visível.
 */
export function capHistory(
  list: ChatMsg[],
  activePromptId: string | null,
  waitState: WaitState | null,
  opts: { cap?: number; expanded?: boolean } = {},
): CappedHistory {
  const cap = opts.cap ?? HISTORY_VISIBLE_CAP
  if (opts.expanded || list.length <= cap) {
    return { visible: list, collapsed: [], hasMore: false }
  }
  // orçamento = quantos itens NÃO-protegidos podem ficar visíveis. Protegidos não
  // consomem orçamento (ficam sempre). Percorre do mais novo ao mais velho.
  let budget = cap
  const keep = new Set<string>()
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]
    const cls = classOf(m, activePromptId, waitState)
    if (isProtectedClass(cls)) {
      keep.add(m.id) // decision/outcome: sempre visível (C8), não gasta orçamento
      continue
    }
    if (budget > 0) {
      keep.add(m.id)
      budget -= 1
    }
    // sem orçamento e não-protegido → fica em collapsed (não adiciona a keep)
  }
  const visible: ChatMsg[] = []
  const collapsed: ChatMsg[] = []
  for (const m of list) {
    if (keep.has(m.id)) visible.push(m)
    else collapsed.push(m)
  }
  return { visible, collapsed, hasMore: collapsed.length > 0 }
}
