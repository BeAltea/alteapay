// Lógica PURA de EXIBIÇÃO do chat do devedor (C1-client). Fica num .ts separado
// (sem React) para ser testável no ambiente node do vitest — mesmo padrão dos
// demais concerns (a decisão vive fora do componente; o .tsx apenas consome).
//
// Cobre:
//  - "MANTER SÓ A ÚLTIMA RESPOSTA": colapsar bolhas assistant de conteúdo
//    idêntico no render (dedupAssistantByContent).
//  - Indicador "trabalhando" ao Negociar: reconhecer o botão de negociação pelo
//    rótulo (isNegotiateLabel), já que a UI não tem o `kind` do botão.
//  - PODA §2.4 (A3): geração corrente (currentGenerationOf), colapso de decisões
//    consecutivas iguais (collapseConsecutiveDecisions) e RETOMADA (§2.2):
//    tudo o que veio antes do menu corrente fica recolhido atrás de "Ver
//    conversa completa", salvo o último outcome (splitResumeHistory).

import {
  classifyMessage,
  CURRENT_GENERATION,
  generationOfKind,
  isProtectedClass,
  OUTCOME_STAGES,
  type DisplayClass,
} from "@/lib/journey/display-class"
import type { WaitState } from "@/lib/journey/wait-machine"

export interface MsgAction {
  type: string
  label: string
  href: string
  /** A1-R1 — `false` quando o servidor sabe que a cobrança daquele link já não
   *  está viva (acordo terminal): a bolha fica como histórico (outcome), sem
   *  painel Abrir/Copiar e sem contar como "link entregue". Ausente = viva. */
  live?: boolean
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
  // marcador de estágio (offers_snapshot.stage — A1): outcome/greeting.
  stage?: string | null
  /** A3 (§2.4) — GERAÇÃO do fluxo a que a bolha pertence, anotada pelo SERVIDOR
   *  (join em memória com os chat_prompts da sessão). null/undefined =
   *  desconhecida (bolha local/otimista): nunca é podada por geração. */
  generation?: number | null
  /** created_at da linha (ISO). A retomada recolhe o que veio ANTES do menu
   *  corrente; bolhas locais (sem createdAt) nunca são recolhidas. */
  createdAt?: string | null
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
 *  bolha no histórico (M4). A4 (N-D5-8): a constante vive em UM lugar
 *  (lib/journey/wait-machine.ts) e é re-exportada aqui para o client. */
export { NEGOTIATION_PENDING_TEXT } from "@/lib/journey/wait-machine"

/** Reconhece o botão que dispara a negociação pelo rótulo (a UI não tem o kind
 *  do botão). Casa o rótulo canônico "Negociar" (A4/S2) e o legado "Negociar
 *  Dívida"; NUNCA "Detalhes da dívida"/"Não reconheço"/"Pagar …". */
export function isNegotiateLabel(label: string): boolean {
  return /\bnegociar\b/i.test(label)
}

/** QA round 1 (F-QAA3-1 / QAA1-06): bolha do assistente que é o RESULTADO de um
 *  clique (ação anexada ou stage de outcome) — cada eco tem a sua resposta, o
 *  dedup por conteúdo nunca a apaga (senão o clique parece "não ter feito nada"). */
function isClickBoundOutcome(m: ChatMsg): boolean {
  if (m.from !== "assistant") return false
  if (m.action) return true
  return !!m.stage && OUTCOME_STAGES.has(m.stage)
}

// Colapsa bolhas do ASSISTENTE com texto idêntico, mantendo apenas a ÚLTIMA
// ocorrência (na posição original da última). O servidor pode re-persistir a
// mesma resposta ("Aqui estão os dados...", saudação re-bootstrapada) — aqui
// garantimos "só a última resposta" na EXIBIÇÃO, sem tocar no buffer bruto nem
// no backend. Bolhas do cliente, bolhas com <a> de ação e OUTCOMES ligados a um
// clique (stage detail/payment_link/…) nunca são colapsadas aqui — a repetição
// de um par "clique → mesmo resultado" é tratada por collapseConsecutiveDecisions
// (QA round 1: antes, o dedup apagava a resposta dos ecos anteriores e o colapso,
// que já tinha rodado, deixava os ecos órfãos e consecutivos).
export function dedupAssistantByContent(list: ChatMsg[]): ChatMsg[] {
  // 1º passo: para cada texto assistant "colapsável", achar o índice da ÚLTIMA
  // ocorrência.
  const lastIdxByText = new Map<string, number>()
  list.forEach((m, i) => {
    if (m.from !== "assistant") return
    if (isClickBoundOutcome(m)) return // resultado de um clique: preserva sempre
    lastIdxByText.set(m.text.trim(), i)
  })
  // 2º passo: manter cliente sempre; manter assistant só na última ocorrência
  // do seu texto (ou se não for colapsável).
  return list.filter((m, i) => {
    if (m.from !== "assistant") return true
    if (isClickBoundOutcome(m)) return true
    return lastIdxByText.get(m.text.trim()) === i
  })
}

/** Ação `open_payment_link` de uma bolha do LINK: a anexada pelo servidor ou,
 *  para uma bolha persistida com stage 'payment_link' que chegou sem a ação
 *  (shape malformado), derivada da URL http(s) do próprio texto — o painel
 *  Abrir/Copiar sempre deriva da bolha, em qualquer viewport (QAA1-08). */
export function paymentLinkActionOf(m: ChatMsg): MsgAction | null {
  if (m.from !== "assistant") return null
  if (m.action?.type === "open_payment_link") return m.action
  if (m.action) return null // outra ação (external_link): não é link de pagamento
  if (m.stage !== "payment_link") return null
  const url = /https?:\/\/\S+/i.exec(m.text ?? "")?.[0] ?? null
  return url ? { type: "open_payment_link", label: "Abrir link de pagamento", href: url } : null
}

/** QA round 1 (QAA1-07): um link está VIVO quando o servidor não o marcou morto
 *  na mensagem (`live:false`) NEM listou o href entre as cobranças terminais do
 *  cliente (`dead_payment_links`, atualizado a cada poll — inclusive incremental). */
export function isLivePaymentLink(
  action: MsgAction | null | undefined,
  deadHrefs: ReadonlySet<string> | null | undefined,
): boolean {
  if (!action || action.type !== "open_payment_link") return false
  if (action.live === false) return false
  return !(deadHrefs && deadHrefs.has(action.href))
}

/** id da ÚLTIMA bolha de link VIVO (a única que ganha o painel Abrir/Copiar). */
export function latestLivePaymentLinkId(
  list: ChatMsg[],
  deadHrefs: ReadonlySet<string> | null | undefined,
): string | null {
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]
    if (isLivePaymentLink(paymentLinkActionOf(m), deadHrefs)) return m.id
  }
  return null
}

// ============================================================================
// PODA §10.1 / §2.4 (C4/C5/C6/C8) — de APRESENTAÇÃO, no client. Opera sobre a
// CLASSE de cada bolha (classifyMessage), NUNCA sobre journey_events (auditoria
// intacta — C2/D44). Roda no render, depois do filtro de prompt ativo.
// ============================================================================

/** Deriva a DisplayClass de uma ChatMsg do render (mapeia os sinais que a bolha
 *  carrega para o classificador puro). `activePromptId`/`waitState` vêm do estado
 *  do chat; `currentGeneration` (A3) é a geração do menu corrente — bolhas de
 *  gerações anteriores viram superseded (salvo outcome). null = regra desligada. */
export function classOf(
  m: ChatMsg,
  activePromptId: string | null,
  waitState: WaitState | null,
  currentGeneration: number | null = null,
): DisplayClass {
  return classifyMessage(
    {
      role: m.from === "customer" ? "customer" : "assistant",
      buttonId: m.buttonId ?? null,
      engine: m.engine ?? null,
      hasAction: !!m.action,
      promptId: m.promptId ?? null,
      text: m.text,
      stage: m.stage ?? null,
      generation: m.generation ?? null,
    },
    { activePromptId, waitState, currentGeneration },
  )
}

/**
 * A3 (§2.4) — GERAÇÃO CORRENTE da tela: a do menu ATIVO (kind → geração); sem
 * menu ativo, a maior geração vista nas bolhas (nunca esconde por acidente: sem
 * nenhuma anotação, cai na geração corrente do código). Pura.
 */
export function currentGenerationOf(
  list: ChatMsg[],
  activePromptKind: string | null | undefined,
): number {
  if (activePromptKind) return generationOfKind(activePromptKind)
  let max: number | null = null
  for (const m of list) {
    if (typeof m.generation === "number") max = max === null ? m.generation : Math.max(max, m.generation)
  }
  return max ?? CURRENT_GENERATION
}

/**
 * PODA por CLASSE (§10.1). Aplica, na ordem:
 *   (1) SYSTEM fora: itens de classe system NUNCA renderizam (R-16).
 *   (2) SUPERSEDED colapsa: bolhas-pergunta de menus não-ativos somem — só o menu
 *       vivo (no bloco de botões) fica; menus antigos não empilham (C5/R-13) — e,
 *       com `currentGeneration` (A3/§2.4), as bolhas de GERAÇÕES ANTERIORES do
 *       fluxo (Sim/Não reconheço, Consultar/Negociar e as respostas entre elas).
 * NÃO remove decision nem outcome da geração corrente (C8/R-15). Guidance
 * permanece (o colapso de guidance idêntica é do dedupAssistantByContent).
 * Determinística e pura.
 */
export function prunePresentation(
  list: ChatMsg[],
  activePromptId: string | null,
  waitState: WaitState | null,
  currentGeneration: number | null = null,
): ChatMsg[] {
  return list.filter((m) => {
    const cls = classOf(m, activePromptId, waitState, currentGeneration)
    if (cls === "system") return false // (1) nunca renderiza (R-16)
    if (cls === "superseded") return false // (2) menu/geração substituídos não empilham (R-13)
    return true
  })
}

/** Chave de igualdade de uma decision: mesmo button_id E mesmo rótulo
 *  (normalizado). Só o id não basta — o id 2 é "Detalhes" no menu de 3 opções e
 *  uma parcela no offer_choice. */
function decisionKey(m: ChatMsg): string {
  const label = m.text.trim().replace(/\s+/g, " ").toLowerCase()
  return `${m.buttonId ?? "-"}|${label}`
}

/** Um TURNO = uma decision + o que o assistente respondeu até a próxima decision.
 *  `outcomes` = textos (normalizados) dos resultados do turno — a "assinatura" do
 *  que aquele clique produziu. */
interface DecisionTurn {
  decision: ChatMsg
  outcomes: ChatMsg[]
}

const normText = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase()

function outcomeSignature(t: DecisionTurn): string {
  return t.outcomes.map((o) => normText(o.text)).sort().join("\u0000")
}

/**
 * A3 (§2.4) — COLAPSO DE DECISÕES CONSECUTIVAS IGUAIS: cliques repetidos no
 * mesmo botão (mesmo button_id + mesmo rótulo) viram UM — fica a ÚLTIMA
 * ocorrência, na posição dela. Guidance entre os cliques não separa (a pilha
 * "Consultar › Consultar" é ruído). Um OUTCOME DIFERENTE separa (cada clique que
 * produziu um resultado distinto é memória legítima: "Pagar › link › Pagar › já
 * tem"). QA round 1 (QAA1-06 / F-QAA3-1): dois turnos consecutivos com a MESMA
 * decisão e o MESMO resultado ("Detalhes › vencimento… › Detalhes › vencimento…")
 * também colapsam — ficam o último eco e o seu resultado, nunca um eco órfão
 * sem resposta. Só decisions da geração corrente contam (as anteriores já são
 * superseded). Pura, determinística; preserva a ordem.
 */
export function collapseConsecutiveDecisions(
  list: ChatMsg[],
  activePromptId: string | null,
  waitState: WaitState | null,
  currentGeneration: number | null = null,
): ChatMsg[] {
  // 1) agrupa em turnos (o que vem antes da 1ª decision não é turno).
  const turns: DecisionTurn[] = []
  for (const m of list) {
    const cls = classOf(m, activePromptId, waitState, currentGeneration)
    if (cls === "decision") {
      turns.push({ decision: m, outcomes: [] })
      continue
    }
    if (cls === "outcome" && turns.length > 0) turns[turns.length - 1].outcomes.push(m)
  }
  // 2) turno anterior colapsa no seguinte quando a decisão é a mesma e
  //    (a) o anterior não produziu resultado (clique repetido, ruído), ou
  //    (b) produziu EXATAMENTE o mesmo resultado (par clique→resposta repetido).
  const drop = new Set<string>()
  for (let i = 1; i < turns.length; i++) {
    const prev = turns[i - 1]
    const cur = turns[i]
    if (decisionKey(prev.decision) !== decisionKey(cur.decision)) continue
    const sameOutcome = prev.outcomes.length > 0 && outcomeSignature(prev) === outcomeSignature(cur)
    if (prev.outcomes.length === 0 || sameOutcome) {
      drop.add(prev.decision.id)
      for (const o of prev.outcomes) drop.add(o.id)
    }
  }
  return drop.size === 0 ? list : list.filter((m) => !drop.has(m.id))
}

/** Instante numérico de um ISO (null se não parsear). */
function timeOf(iso: string): number | null {
  const n = Date.parse(iso)
  return Number.isNaN(n) ? null : n
}

/** a < b (estritamente). Compara por instante; se algum não parsear, por texto. */
function isBefore(a: string, b: string): boolean {
  const ta = timeOf(a)
  const tb = timeOf(b)
  if (ta !== null && tb !== null) return ta < tb
  return a < b
}

export interface ResumeSplit {
  /** itens que ficam na tela na retomada (após o corte + o último outcome). */
  visible: ChatMsg[]
  /** itens de ANTES do menu corrente, recolhidos atrás de "Ver conversa completa". */
  collapsed: ChatMsg[]
  /** id do último outcome (link/acordo/desfecho) preservado acima do menu, se houver. */
  lastOutcomeId: string | null
}

/**
 * A3 (§2.2) — RETOMADA: card + saudação de retorno + (último outcome) + menu.
 * Nada mais por padrão. `cutoffAt` = created_at do menu corrente no 1º poll da
 * retomada (null = 1º login/sem retomada → nada recolhido). Tudo com createdAt
 * ANTES do corte é recolhido, EXCETO o último outcome que não seja mero detalhe
 * (link/acordo, "não reconheço", "já paguei"): "Se a última escolha produziu um
 * resultado, o resultado vem acima do menu". Bolhas locais (sem createdAt) e as
 * que chegam depois do corte ficam visíveis. `expanded` devolve tudo.
 */
export function splitResumeHistory(
  list: ChatMsg[],
  opts: {
    cutoffAt: string | null
    expanded?: boolean
    activePromptId: string | null
    waitState: WaitState | null
    currentGeneration?: number | null
  },
): ResumeSplit {
  const cutoff = opts.cutoffAt
  if (!cutoff || opts.expanded) return { visible: list, collapsed: [], lastOutcomeId: null }
  const gen = opts.currentGeneration ?? null
  let lastOutcomeId: string | null = null
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]
    if (m.stage === "detail") continue // detalhes já estão resumidos na saudação de retorno
    if (classOf(m, opts.activePromptId, opts.waitState, gen) === "outcome") {
      lastOutcomeId = m.id
      break
    }
  }
  const visible: ChatMsg[] = []
  const collapsed: ChatMsg[] = []
  for (const m of list) {
    const before = typeof m.createdAt === "string" && m.createdAt ? isBefore(m.createdAt, cutoff) : false
    if (before && m.id !== lastOutcomeId) collapsed.push(m)
    else visible.push(m)
  }
  return { visible, collapsed, lastOutcomeId }
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
  opts: { cap?: number; expanded?: boolean; currentGeneration?: number | null } = {},
): CappedHistory {
  const cap = opts.cap ?? HISTORY_VISIBLE_CAP
  if (opts.expanded || list.length <= cap) {
    return { visible: list, collapsed: [], hasMore: false }
  }
  const gen = opts.currentGeneration ?? null
  // orçamento = quantos itens NÃO-protegidos podem ficar visíveis. Protegidos não
  // consomem orçamento (ficam sempre). Percorre do mais novo ao mais velho.
  let budget = cap
  const keep = new Set<string>()
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]
    const cls = classOf(m, activePromptId, waitState, gen)
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

/**
 * A3 (§2.2) — UMA só pergunta na tela: se a saudação de retorno já termina com a
 * pergunta do menu ("… Como prefere seguir?"), o bloco de botões vem SEM a
 * pergunta (não a repete). Perguntas diferentes (ex.: o menu-volta do "não
 * reconheço") ficam. Puro; não altera o prompt quando não há duplicidade.
 */
export function stripDuplicateQuestion<T extends { question: string }>(
  prompt: T,
  greeting: string | null | undefined,
): T {
  const q = (prompt.question ?? "").trim()
  const g = (greeting ?? "").trim()
  if (!q || !g) return prompt
  const norm = (s: string) => s.replace(/\s+/g, " ").toLowerCase()
  return norm(g).endsWith(norm(q)) ? { ...prompt, question: "" } : prompt
}

/** Texto da bolha do ASSISTENTE que fica imediatamente acima do bloco de botões:
 *  a última entrada do log visível, quando é do assistente. null quando o log
 *  está vazio ou termina numa bolha do cliente (aí nada "encosta" no bloco). */
export function lastAssistantVisibleText(visible: ChatMsg[]): string | null {
  const last = visible[visible.length - 1]
  return last && last.from === "assistant" ? last.text : null
}

/**
 * A4 (correção r1 / B3-F1) — a pergunta do prompt ativo aparece UMA vez na tela.
 * O prompt renderiza `question` num bloco próprio, acima dos botões; se essa
 * frase já é a última bolha visível do assistente (ex.: T2 = S7 persistida antes
 * do prompt de parcelas, cuja pergunta S8 = S7) ou já fecha a saudação de
 * retorno (A3: "… Como prefere seguir?"), o bloco vem só com os botões.
 * Composição pura do que chat.tsx monta como `promptForRender`; as duas fontes
 * são independentes (qualquer uma basta) e o prompt volta intacto quando não há
 * duplicidade.
 */
export function resolvePromptForRender<T extends { question: string }>(
  prompt: T | null,
  visible: ChatMsg[],
  recapText: string | null | undefined,
): T | null {
  if (!prompt) return null
  const againstLog = stripDuplicateQuestion(prompt, lastAssistantVisibleText(visible))
  return stripDuplicateQuestion(againstLog, recapText)
}
