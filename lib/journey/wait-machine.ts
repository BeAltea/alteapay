// D2 — ESPERA CONFIÁVEL (client-side). Lógica PURA da máquina de espera do §6.3
// e do Apêndice B, num .ts sem React para ser testada no ambiente node do vitest
// (mesmo padrão de components/journey/chat-display.ts). O componente
// (components/journey/chat.tsx) apenas CONSOME estas funções — a decisão vive
// aqui, fora do .tsx.
//
// Princípios (02-design-estados.md §0):
//  - A espera NÃO é um await: o clique NEGOCIAR resolve ≤2500ms; a resposta do
//    n8n chega DEPOIS por poll. Esta máquina só governa o que o devedor vê.
//  - O degrau (1,2/4/10/15s) é FUNÇÃO PURA do tempo, derivado de wait_started_at
//    (não é persistido) — reabrir aos 8s cai direto no degrau >=4s (M11).
//  - A espera nunca é cancelada por uma saída: aos 10s abrimos atalhos SEM parar
//    o polling; aos 15s trocamos o VISUAL por um menu, mas a sessão segue podendo
//    receber a resposta tardia (M12).
//  - Estados ABSORVENTES (link_entregue/quitada/nao_reconhecida) vencem a tardia:
//    a resposta do motor é descartada (nunca reabre negociação, nunca aparece
//    após pagamento). menu_degradado NÃO é absorvente (a tardia ainda renderiza).
//  - NUNCA erro técnico/HTTP/"n8n" ao devedor: toda saída cai num menu acionável.

// ---------------------------------------------------------------------------
// Estados persistíveis (espelham o CHECK da migration M-4 e o contrato G1).
// 'idle' = NULL no servidor (sem espera). 'negociando'/'quitada' derivam de sinais
// que já existem (mensagem engine='n8n' e outcome/pagamento) — não precisam de
// linha de wait, mas 'quitada' entra no client como estado absorvente derivado.
// ---------------------------------------------------------------------------
export type WaitState =
  | "idle"
  | "aguardando_motor"
  | "negociando"
  | "menu_degradado"
  | "gerando_cobranca"
  | "link_entregue"
  | "erro_cobranca"
  | "quitada"
  | "nao_reconhecida"

/** Estados persistidos no servidor (subconjunto do CHECK da M-4). 'idle' = NULL. */
export const PERSISTED_WAIT_STATES: readonly WaitState[] = [
  "aguardando_motor",
  "menu_degradado",
  "gerando_cobranca",
  "link_entregue",
  "erro_cobranca",
  "nao_reconhecida",
] as const

// ---------------------------------------------------------------------------
// Degraus da espera (só quando waitState === 'aguardando_motor'). Derivados de
// elapsed = now - wait_started_at (02-design-estados.md §2). Limiares aprovados
// no G1 (espera=15s; saídas abertas aos 10s sem cancelar).
// ---------------------------------------------------------------------------
export type WaitStep = "d0_suppressed" | "d1_typing" | "d2_narrated" | "d3_slow" | "d4_degraded"

export const WAIT_STEP_MS = {
  /** t<1,2s: indicador SUPRIMIDO (resposta <1s não deve "piscar" indicador). */
  TYPING: 1_200,
  /** t>=4s: troca a copy para progresso narrado. */
  NARRATED: 4_000,
  /** t>=10s: "demorando um pouco mais" + abre saídas SEM cancelar a espera. */
  SLOW: 10_000,
  /** t=15s: encerra o visual → menu_degradado (único degrau que MUDA o estado). */
  DEGRADED: 15_000,
} as const

/**
 * Deriva o degrau da espera a partir do elapsed (ms desde wait_started_at).
 * Função PURA — o mesmo elapsed sempre dá o mesmo degrau (sobrevive ao reload).
 * elapsed inválido/negativo → d0 (indicador suprimido), nunca "pula" degraus.
 */
export function deriveWaitStep(elapsedMs: number): WaitStep {
  if (!Number.isFinite(elapsedMs) || elapsedMs < WAIT_STEP_MS.TYPING) return "d0_suppressed"
  if (elapsedMs < WAIT_STEP_MS.NARRATED) return "d1_typing"
  if (elapsedMs < WAIT_STEP_MS.SLOW) return "d2_narrated"
  if (elapsedMs < WAIT_STEP_MS.DEGRADED) return "d3_slow"
  return "d4_degraded"
}

/** Calcula o elapsed (ms) a partir do wait_started_at ISO e um "agora" (ms). */
export function elapsedSince(waitStartedAt: string | null | undefined, nowMs: number): number {
  if (!waitStartedAt) return 0
  const started = Date.parse(waitStartedAt)
  if (!Number.isFinite(started)) return 0
  const d = nowMs - started
  return d > 0 ? d : 0
}

/** true quando o indicador "digitando" (aria-live) deve aparecer: só de d1 em
 *  diante (supressão inicial <1,2s — §6.3 t<1,2s / pesquisa §3 do prompt). */
export function shouldShowTypingIndicator(step: WaitStep): boolean {
  return step === "d1_typing" || step === "d2_narrated" || step === "d3_slow"
}

/** true quando os atalhos [Pagar {valor} agora] [Falar com atendimento] devem
 *  aparecer (aos 10s, SEM cancelar a espera) e no menu de degradação (15s). */
export function shouldShowSlowExits(step: WaitStep): boolean {
  return step === "d3_slow" || step === "d4_degraded"
}

// ---------------------------------------------------------------------------
// QA round 1 (QAA1-01, BLOQUEANTE em produção) — o bloco de espera nascia no
// instante do clique em "Negociar", sob o ponteiro, com [Falar com atendimento]
// habilitado: um toque duplo transferia ao atendimento, suprimia o devedor e
// encerrava a conversa. Regras PURAS (o chat.tsx só as consome):
//  - o clique NÃO arma a espera: ela só arma quando o servidor responde SEM
//    parcelas (wait_state) ou quando o poll reidrata (negotiateWaitOnResponse);
//  - as saídas de um bloco de espera/degradação/erro ficam INERTES por
//    WAIT_EXITS_ARM_MS depois de o bloco aparecer (areWaitExitsArmed);
//  - "Falar com atendimento" a partir da espera só existe do degrau d3 (10 s)
//    em diante (shouldShowWaitHandoffExit) — antes disso, só "Pagar agora".
// ---------------------------------------------------------------------------

/** Tempo mínimo entre o bloco de saídas aparecer e as suas ações responderem. */
export const WAIT_EXITS_ARM_MS = 1500

/** true quando as saídas já podem responder a um toque (≥ WAIT_EXITS_ARM_MS
 *  desde que o bloco apareceu). Sem instante conhecido → inerte. */
export function areWaitExitsArmed(shownAtMs: number | null | undefined, nowMs: number): boolean {
  if (typeof shownAtMs !== "number" || !Number.isFinite(shownAtMs)) return false
  return nowMs - shownAtMs >= WAIT_EXITS_ARM_MS
}

/** "Falar com atendimento" a partir da ESPERA (aguardando_motor): só de d3 em
 *  diante. Na degradação (d4) e nos painéis de erro/processing a saída existe
 *  desde o início (com o arming acima). */
export function shouldShowWaitHandoffExit(step: WaitStep): boolean {
  return shouldShowSlowExits(step)
}

/** Shape mínimo da resposta do POST do clique Negociar. */
export interface NegotiateResponseLike {
  ok?: boolean
  action?: string | null
  offers_presented?: boolean
  wait_state?: string | null
}

/**
 * Decide se a resposta do Negociar ARMA a espera: só quando o servidor não
 * apresentou parcelas e sinalizou `wait_state:'aguardando_motor'`. Com parcelas
 * no corpo (A2) ou qualquer outro desfecho, nada de espera (nem bloco, nem
 * saídas) — o menu de parcelas é a ação imediatamente disponível.
 */
export function negotiateWaitOnResponse(data: NegotiateResponseLike | null | undefined): boolean {
  if (!data || data.ok !== true) return false
  if (data.action !== "negotiate") return false
  if (data.offers_presented === true) return false
  return data.wait_state === "aguardando_motor"
}

// ---------------------------------------------------------------------------
// Copy dos degraus (03-copy.md §2). D1 não tem texto próprio (só o indicador).
// A copy do D0 (eco A.2) é gravada no servidor pelo clique NEGOCIAR (D1) e vem
// no histórico — aqui só as trocas narradas que a máquina reescreve na bolha de
// espera (não empilha bolha nova).
// ---------------------------------------------------------------------------
/**
 * A4/S7 (Apêndice B "Negociar - antes") — a frase de confirmação do clique
 * Negociar QUANDO AS PARCELAS VÊM NA SEQUÊNCIA (termina em dois-pontos: promete
 * a lista logo abaixo). É persistida pelo servidor (T2, button/route.ts),
 * injetada como bolha optimistic pelo client (T3, chat.tsx) e é a pergunta do
 * prompt de parcelas (offerChoiceQuestion): uma só frase para o mesmo instante,
 * nunca duplicada. Vive aqui (módulo puro, client-safe) para servidor e client
 * importarem a MESMA constante (N-D5-8). Sem PII.
 */
export const NEGOTIATION_PENDING_TEXT = "Certo. Estas são as condições disponíveis para você:"

/**
 * A4 r2 (B3-F2) — confirmação do Negociar quando NENHUMA condição vem na
 * sequência: legado "Sim, reconheço" (só kickoff em background, sem matriz) e
 * legado "Negociar Dívida" sem faixa de matriz/falha (cai na espera). Frase
 * completa, sem dois-pontos e sem prometer uma lista que não aparece (é a T2 da
 * geração anterior, já aprovada). Fonte única (N-D5-8). Sem PII.
 */
export const NEGOTIATION_SEARCHING_TEXT = "Certo. Vou buscar as condições de pagamento disponíveis para você."

/** Copy narrada exibida em cada degrau da espera (bolha de espera reescrita).
 *  Vazio ("") = sem texto próprio (D0 usa o eco do servidor; D1 é só indicador). */
export function waitStepCopy(step: WaitStep): string {
  switch (step) {
    case "d3_slow":
      // A4/S19: sem "já estou quase lá" (promessa vazia). Frases curtas.
      return "Está demorando mais que o normal. Se preferir, você pode resolver agora:"
    default:
      // d0_suppressed / d1_typing / d2_narrated: sem texto próprio — o eco S7
      // ("Certo. Estas são as condições…") já está na tela e é a ÚNICA frase de
      // espera (A4/S19). d4_degraded usa a copy de degradação (§4).
      return ""
  }
}

/** Copy do menu de degradação (T10 / R-31, t=15s). Frases curtas, uma ideia; sem
 *  "não te impede de resolver hoje" (vendedor) e sem expor falha interna/n8n/HTTP. */
export const DEGRADED_MENU_COPY =
  "As opções de parcelamento não carregaram agora. " +
  "Você ainda pode resolver: pague o valor à vista, tente as opções de novo, ou fale com o nosso atendimento."

// ---------------------------------------------------------------------------
// Resposta tardia (M12) — renderiza-vs-descarta. Anteparo CLIENT (defensivo): o
// anteparo autoritativo é do servidor, mas se por corrida a bolha já chegou ao
// poll, o client aplica esta regra. menu_degradado é o ÚNICO estado não-absorvente
// onde a tardia RENDERIZA (o devedor não seguiu outro caminho → ainda útil).
// ---------------------------------------------------------------------------
/** Estados ABSORVENTES para a mensagem do motor (Apêndice B). Uma resposta do
 *  n8n que chegue nestes estados é DESCARTADA (nunca reabre negociação; nunca
 *  aparece após pagamento). */
export function isAbsorbingForEngineMsg(state: WaitState): boolean {
  return state === "link_entregue" || state === "quitada" || state === "nao_reconhecida"
}

/** Decisão da resposta tardia do motor no client (M12). true = renderiza a bolha;
 *  false = descarta. Renderiza em aguardando_motor/negociando/menu_degradado;
 *  descarta nos absorventes. */
export function shouldRenderEngineMsg(state: WaitState): boolean {
  return !isAbsorbingForEngineMsg(state)
}

// ---------------------------------------------------------------------------
// A2 (N-D2-6 / N-D5-9) — TEXTO DO MOTOR SEM BOTÕES × ASSISTIDO. Regra de
// EXIBIÇÃO pura: enquanto o prompt ativo é um menu do ASSISTIDO da plataforma
// (3 opções / parcelas / pós-link), uma mensagem engine='n8n' SEM prompt (texto
// solto) não é "condução": não empurra as parcelas para fora da tela nem soa como
// resposta — vira uma NOTA discreta (ou some, quando é o fallback genérico do
// fluxo, que expõe nome de sistema/"opções válidas"). Markdown é sanitizado.
// ---------------------------------------------------------------------------
/** Kinds do assistido da plataforma (espelho de prompts.PLATFORM_PROTECTED_KINDS —
 *  duplicado aqui de propósito: este módulo é importado pelo client bundle). */
export const PLATFORM_ASSISTED_KINDS: ReadonlySet<string> = new Set([
  "debt_three_options",
  "offer_choice",
  "post_payment_link",
])

/** Padrões do FALLBACK GENÉRICO do fluxo n8n (não é resposta ao devedor: expõe
 *  "canal de atendimento automático"/"opções válidas"/nome de sistema). */
const GENERIC_ENGINE_FALLBACK: readonly RegExp[] = [
  /op[cç][õo]es v[áa]lidas/i,
  /canal de atendimento autom[áa]tico/i,
  /selecione uma das op/i,
  /\bn8n\b|\bworkflow\b|\bwebhook\b/i,
]

/** Remove markdown leve (**negrito**, __negrito__, *itálico*, `código`, #títulos)
 *  e normaliza espaços/quebras. Nunca injeta HTML; puro. */
export function sanitizeEngineText(raw: string): string {
  return (raw ?? "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/** true quando o texto é o fallback genérico do fluxo (nunca chega ao devedor). */
export function isGenericEngineFallback(text: string): boolean {
  const t = text ?? ""
  return GENERIC_ENGINE_FALLBACK.some((re) => re.test(t))
}

export type EngineTextMode = "hidden" | "note" | "bubble"

export interface EngineTextDisplayInput {
  text: string
  /** true quando a mensagem está ligada a um prompt (n8n mandou botões). */
  hasPrompt: boolean
  /** kind do prompt ATIVO na tela (null = nenhum). */
  activePromptKind: string | null | undefined
  waitState: WaitState
}

/**
 * Decide COMO uma mensagem engine='n8n' aparece (pura, testável):
 *  - estado absorvente → hidden (M12, regra existente);
 *  - fallback genérico do fluxo → hidden (nome de sistema/código nunca ao devedor);
 *  - com prompt (n8n mandou botões acionáveis) → bubble;
 *  - texto solto com um menu do assistido ATIVO → note (discreta, não empurra
 *    nem "responde" — o assistido continua sendo o caminho);
 *  - demais → bubble. O texto devolvido já vem sanitizado.
 */
export function engineTextDisplay(input: EngineTextDisplayInput): { mode: EngineTextMode; text: string } {
  const text = sanitizeEngineText(input.text)
  if (isAbsorbingForEngineMsg(input.waitState)) return { mode: "hidden", text }
  if (!text) return { mode: "hidden", text }
  if (isGenericEngineFallback(text)) return { mode: "hidden", text }
  if (input.hasPrompt) return { mode: "bubble", text }
  if (input.activePromptKind && PLATFORM_ASSISTED_KINDS.has(input.activePromptKind)) return { mode: "note", text }
  return { mode: "bubble", text }
}

// ---------------------------------------------------------------------------
// Reidratação no reload (M11). O client reconstrói o waitState a partir de
// (wait_state, wait_started_at) do servidor + o relógio local. Um wait_state
// desconhecido/ausente → idle (degradação graciosa: sem a coluna M-4, a UI só
// não restaura o degrau — nunca quebra).
// ---------------------------------------------------------------------------
export interface ServerWaitSnapshot {
  wait_state?: string | null
  wait_started_at?: string | null
}

/** Reconstrói o WaitState client a partir do snapshot do servidor. Só aceita os
 *  estados persistíveis conhecidos; qualquer outro (ou null) → 'idle'. */
export function hydrateWaitState(snapshot: ServerWaitSnapshot | null | undefined): WaitState {
  const raw = snapshot?.wait_state
  if (typeof raw !== "string") return "idle"
  return (PERSISTED_WAIT_STATES as readonly string[]).includes(raw) ? (raw as WaitState) : "idle"
}

/**
 * Resolve o que o client deve MOSTRAR agora, dado o estado reidratado e o tempo.
 * Regra-chave do reload (§2): se o estado persistido é 'aguardando_motor' MAS o
 * relógio já cruzou 15s, o client entra JÁ em menu_degradado (não recomeça a
 * animação do zero). Se o servidor persistiu 'menu_degradado', respeita direto.
 * Demais estados passam intactos. Retorna também o degrau (para a UI da espera).
 */
export function resolveWaitView(
  state: WaitState,
  waitStartedAt: string | null | undefined,
  nowMs: number,
): { state: WaitState; step: WaitStep; elapsedMs: number } {
  const elapsedMs = elapsedSince(waitStartedAt, nowMs)
  if (state === "aguardando_motor") {
    const step = deriveWaitStep(elapsedMs)
    // Cruzou 15s enquanto a aba estava fechada/adormecida → já degradado (M11).
    if (step === "d4_degraded") return { state: "menu_degradado", step, elapsedMs }
    return { state: "aguardando_motor", step, elapsedMs }
  }
  // menu_degradado reidratado mantém o degrau em d4 (visual desligado).
  const step: WaitStep = state === "menu_degradado" ? "d4_degraded" : "d0_suppressed"
  return { state, step, elapsedMs }
}
