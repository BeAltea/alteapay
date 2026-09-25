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
// Copy dos degraus (03-copy.md §2). D1 não tem texto próprio (só o indicador).
// A copy do D0 (eco A.2) é gravada no servidor pelo clique NEGOCIAR (D1) e vem
// no histórico — aqui só as trocas narradas que a máquina reescreve na bolha de
// espera (não empilha bolha nova).
// ---------------------------------------------------------------------------
/** Copy narrada exibida em cada degrau da espera (bolha de espera reescrita).
 *  Vazio ("") = sem texto próprio (D0 usa o eco do servidor; D1 é só indicador). */
export function waitStepCopy(step: WaitStep): string {
  switch (step) {
    case "d2_narrated":
      return "Estou consultando as condições de pagamento disponíveis para você. Só um instante."
    case "d3_slow":
      return "Está demorando um pouco mais que o normal, mas já estou quase lá. Se preferir, você já pode resolver agora:"
    default:
      // d0_suppressed / d1_typing: sem texto próprio (o eco A.2 do servidor
      // permanece na bolha anterior). d4_degraded usa a copy de degradação (§4).
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
