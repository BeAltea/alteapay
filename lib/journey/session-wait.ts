// QA round 2 (QAB1-H1) — wait_state da SESSÃO no servidor, escrita ÚNICA.
//
// `negotiation_sessions.wait_state` (migration 20260934, CHECK: aguardando_motor
// | menu_degradado | gerando_cobranca | link_entregue | erro_cobranca |
// nao_reconhecida; NULL = idle) é o que o GET /api/chat/messages devolve para o
// client reconstruir a espera após um reload. Até a rodada 1 só a espera de
// NEGOCIAÇÃO era persistida (aguardando_motor); o PAGAR (e o aceite de parcela)
// vivia só no client — um F5 durante os 11–16 s da cobrança em produção deixava
// a tela sem menu, sem "gerando" e sem link (QAB1-H1). Agora a rota grava
// 'gerando_cobranca' ANTES do payService e limpa/grava 'erro_cobranca' ao final.
//
// DEFENSIVO: nunca lança e nunca derruba o clique — se a coluna não existir ou o
// update falhar, só loga (o client degrada para a UI do clique). Sem PII.
import { createServiceClient } from "@/lib/supabase/service"
import type { WaitState } from "./wait-machine"

export type PersistedWaitState = Exclude<WaitState, "idle" | "negociando" | "quitada">

/**
 * Grava `wait_state` (+ `wait_started_at` = agora) ou limpa os dois (state null).
 * Devolve true quando o update foi aplicado sem erro (informativo).
 */
export async function setSessionWaitState(
  sessionId: string,
  state: PersistedWaitState | null,
): Promise<boolean> {
  try {
    const supabase = createServiceClient()
    const { error } = await supabase
      .from("negotiation_sessions")
      .update(
        state
          ? { wait_state: state, wait_started_at: new Date().toISOString() }
          : { wait_state: null, wait_started_at: null },
      )
      .eq("id", sessionId)
    if (error) {
      console.warn("[journey] wait_state write não aplicado (coluna M-4 pendente?):", error.message)
      return false
    }
    return true
  } catch (err) {
    console.warn("[journey] wait_state write falhou (defensivo):", (err as Error).message)
    return false
  }
}
