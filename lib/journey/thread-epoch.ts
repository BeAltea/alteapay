// N8N-9 — época (thread) das linhas que o n8n grava no chat do devedor.
//
// O reset de 24h (acknowledgement.resetStaleChatIfInactive) arquiva as linhas da
// thread corrente e faz negotiation_sessions.thread_epoch + 1. O GET
// /api/chat/messages e o recap mostram só a época corrente (NULL = época 0). Uma
// linha do n8n sem carimbo (ou com uma época velha) some da tela depois do reset.
//
// Regras deste módulo (a ÚNICA fonte da época das linhas vindas do n8n):
//   1. a época é lida da SESSÃO no momento da escrita. Nunca vem do payload do n8n;
//   2. uma resposta do n8n a um evento de uma época ANTERIOR não entra na thread
//      nova: 409 `thread_epoch_stale`, nada é gravado (ver resolveN8nReplyEpoch);
//   3. carimbo só quando a época > 0 (época 0 = NULL = default da coluna), mesma
//      convenção de persistAssistantMessage/createPrompt.
// Leitura best-effort: falha de leitura nunca derruba a escrita (cai na época 0,
// o comportamento anterior).

import { createServiceClient } from "@/lib/supabase/service"
import { currentThreadEpoch } from "./prompts"

export type EpochTagged = { thread_epoch?: number | null; archived_at?: string | null }

/** Época de uma linha de chat_messages/chat_prompts (NULL = época 0, compat). */
export function epochOfRow(row: EpochTagged | null | undefined): number {
  const e = row?.thread_epoch
  return typeof e === "number" && Number.isFinite(e) ? e : 0
}

/** A linha pertence à thread `epoch` e ainda não foi arquivada por um reset? */
export function isInThread(row: EpochTagged | null | undefined, epoch: number): boolean {
  return !!row && row.archived_at == null && epochOfRow(row) === epoch
}

/**
 * Dois prompts da mesma thread? Um prompt de uma época anterior (ou arquivado
 * pelo reset) nunca responde pelo ativo da thread nova (sem re-alvejamento
 * através do reset de 24h).
 */
export function samePromptThread(clickedRow: object, activeRow: object): boolean {
  // PromptRow não declara as colunas de época (select("*") as traz).
  const clicked = clickedRow as EpochTagged
  const active = activeRow as EpochTagged
  return clicked.archived_at == null && active.archived_at == null && epochOfRow(clicked) === epochOfRow(active)
}

/** Colunas de época para um insert: `{}` na época 0 (NULL), senão `{thread_epoch}`. */
export function epochColumn(epoch: number): { thread_epoch?: number } {
  return epoch > 0 ? { thread_epoch: epoch } : {}
}

export type ThreadEpochStale = {
  ok: false
  status: 409
  code: "thread_epoch_stale"
  message: string
  current_epoch: number
  reason: "execution_from_previous_thread" | "origin_before_thread_start"
}

export type N8nReplyEpoch = { ok: true; epoch: number } | ThreadEpochStale

/**
 * Época em que uma resposta do n8n deve ser gravada, ou a recusa quando ela
 * responde a algo de uma thread já encerrada pelo reset de 24h.
 *
 * Sinais de "resposta atrasada" (só avaliados com época > 0, porque sem reset
 * não existe thread anterior):
 *   - `n8nExecutionId`: a mesma execução do n8n já gravou linhas SÓ em época
 *     anterior (arquivadas). A execução nasceu na thread velha → recusa. Se ela
 *     já tem linha na thread corrente, a resposta é da thread corrente.
 *   - `originSentAt`: instante em que a plataforma enviou o evento que o n8n está
 *     respondendo (a correlação N8N-16 resolve isso pelo origin_event_id). Antes
 *     do início da thread corrente (o archived_at do último reset) → recusa.
 * Sem sinal nenhum, a resposta entra na época corrente (é o caso comum: o n8n
 * respondendo a um evento desta thread). Nunca lança.
 */
export async function resolveN8nReplyEpoch(
  sessionId: string,
  hints: { n8nExecutionId?: string | null; originSentAt?: string | null } = {},
): Promise<N8nReplyEpoch> {
  const epoch = await currentThreadEpoch(sessionId)
  if (epoch <= 0) return { ok: true, epoch }
  try {
    const supabase = createServiceClient()
    const execId = typeof hints.n8nExecutionId === "string" ? hints.n8nExecutionId.trim() : ""
    if (execId) {
      const [msgs, prompts] = await Promise.all([
        supabase
          .from("chat_messages")
          .select("thread_epoch, archived_at")
          .eq("session_id", sessionId)
          .eq("n8n_execution_id", execId)
          .limit(50),
        supabase
          .from("chat_prompts")
          .select("thread_epoch, archived_at")
          .eq("session_id", sessionId)
          .eq("n8n_execution_id", execId)
          .limit(50),
      ])
      const rows = [...((msgs.data ?? []) as EpochTagged[]), ...((prompts.data ?? []) as EpochTagged[])]
      if (rows.length > 0 && !rows.some((r) => isInThread(r, epoch))) {
        return stale(epoch, "execution_from_previous_thread")
      }
    }
    const originMs = Date.parse(hints.originSentAt ?? "")
    if (Number.isFinite(originMs)) {
      const { data } = await supabase
        .from("chat_messages")
        .select("archived_at")
        .eq("session_id", sessionId)
        .not("archived_at", "is", null)
        .order("archived_at", { ascending: false })
        .limit(1)
        .maybeSingle()
      const startedMs = Date.parse((data as { archived_at?: string | null } | null)?.archived_at ?? "")
      if (Number.isFinite(startedMs) && originMs < startedMs) return stale(epoch, "origin_before_thread_start")
    }
  } catch (err) {
    console.warn("[journey] resolveN8nReplyEpoch: leitura falhou (segue na época corrente):", (err as Error).message)
  }
  return { ok: true, epoch }
}

function stale(epoch: number, reason: ThreadEpochStale["reason"]): ThreadEpochStale {
  return {
    ok: false,
    status: 409,
    code: "thread_epoch_stale",
    message: "resposta do n8n a um evento de uma conversa já encerrada (reset de 24h); nada foi gravado",
    current_epoch: epoch,
    reason,
  }
}
