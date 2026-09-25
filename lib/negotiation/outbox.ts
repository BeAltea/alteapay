// Outbox transacional dos eventos plataforma → n8n (Frente A, onda D1).
//
// Fluxo de vida de uma linha (tabela engine_outbox):
//   1) INSERT na MESMA "transação" da sessão (idempotente por event_id UNIQUE).
//      Gated: engine 'disabled' → status='skipped_engine_disabled' (nunca envia).
//   2) Entrega best-effort ao n8n (POST assinado, timeout 2500ms) que NÃO soma na
//      resposta ao devedor: no login, Promise.allSettled — o reconhecimento com
//      NOSSOS dados não espera o n8n.
//   3) Flush no próximo turno (ordem preservada) + scripts/ops/flush-engine-outbox.ts.
//      Backoff exponencial; teto de tentativas → status='failed'.
//
// Segurança: HMAC ${ts}.${body} + headers x-alteapay-* + Basic Auth (reusa
// buildN8nOutboundHeaders de n8n.ts). O corpo POSTado é EXATAMENTE o `payload`
// serializado de forma estável (stableStringify) — a assinatura cobre byte-a-byte.
// NENHUM segredo em log; NUNCA logar corpo de erro do n8n.

import { createServiceClient } from "@/lib/supabase/service"
import { buildN8nOutboundHeaders } from "./n8n"
import { engineName } from "./engine"
import { stableStringify, type CanonicalEnvelope } from "./payload"

export type OutboxStatus = "pending" | "sent" | "failed" | "skipped_engine_disabled"

export interface OutboxRow {
  id: string
  session_id: string
  company_id: string
  event_type: string
  event_id: string
  payload: CanonicalEnvelope
  status: OutboxStatus
  attempts: number
  last_error: string | null
  next_attempt_at: string | null
  sent_at: string | null
  created_at: string
  updated_at: string
}

/** Timeout do POST ao n8n (ms). Curto (2500ms default) — não soma na resposta. */
export function outboxPostTimeoutMs(): number {
  const n = Number(process.env.ENGINE_OUTBOX_TIMEOUT_MS)
  return Number.isFinite(n) && n > 0 ? n : 2500
}

/** Teto de tentativas antes de marcar 'failed' (default 6). */
export function outboxMaxAttempts(): number {
  const n = Number(process.env.ENGINE_OUTBOX_MAX_ATTEMPTS)
  return Number.isFinite(n) && n > 0 ? n : 6
}

/** Base do backoff exponencial em ms (default 30_000). delay = base * 2^(attempts-1). */
function backoffBaseMs(): number {
  const n = Number(process.env.ENGINE_OUTBOX_BACKOFF_BASE_MS)
  return Number.isFinite(n) && n > 0 ? n : 30_000
}

function nextAttemptAt(attempts: number): string {
  const delay = backoffBaseMs() * Math.pow(2, Math.max(0, attempts - 1))
  // teto de 6h para não empurrar reentregas para um futuro distante.
  const capped = Math.min(delay, 6 * 3_600_000)
  return new Date(Date.now() + capped).toISOString()
}

// URL do fluxo de eventos do n8n. Reusa N8N_CHAT_FLOW_URL se não houver um
// endpoint dedicado (N8N_EVENT_FLOW_URL) — o fluxo distingue pelo campo `type`.
function eventFlowUrl(): string {
  return process.env.N8N_EVENT_FLOW_URL || process.env.N8N_CHAT_FLOW_URL || ""
}

// ---------------------------------------------------------------------------
// A2 / N-D2-7: a tabela engine_outbox NÃO existe em produção (PGRST205). Sem a
// migration (fora desta onda), todo acesso virava um no-op SILENCIOSO — a
// "entrega durável" era fictícia e ninguém sabia. Agora: o erro de tabela ausente
// é reconhecido, logado UMA vez por processo (rótulo curto, sem PII/segredo) e as
// funções saem cedo (no-op EXPLÍCITO), sem repetir a round-trip falha a cada clique.
// ---------------------------------------------------------------------------
let outboxUnavailable = false

/** true para o erro do PostgREST/Postgres de tabela inexistente (PGRST205 = schema
 *  cache sem a relação; 42P01 = undefined_table). Nunca lança. */
export function isOutboxUnavailableError(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!error) return false
  if (error.code === "PGRST205" || error.code === "42P01") return true
  const msg = (error.message ?? "").toLowerCase()
  return msg.includes("engine_outbox") && (msg.includes("does not exist") || msg.includes("schema cache") || msg.includes("could not find"))
}

/** Marca o outbox como indisponível neste processo e loga 1x (no-op explícito). */
export function noteOutboxUnavailable(where: string): void {
  if (outboxUnavailable) return
  outboxUnavailable = true
  console.warn(`[engine:outbox] engine_outbox ausente (migration pendente) — entrega durável DESATIVADA; ${where} vira no-op explícito`)
}

/** true quando este processo já constatou que a tabela não existe. */
export function outboxKnownUnavailable(): boolean {
  return outboxUnavailable
}

/** Só para testes: zera a memória de indisponibilidade. */
export function resetOutboxAvailability(): void {
  outboxUnavailable = false
}

export interface EnqueueInput {
  sessionId: string
  companyId: string
  envelope: CanonicalEnvelope
  /** Cliente injetado para gravar na MESMA transação/lógica do chamador. */
  supabase?: ReturnType<typeof createServiceClient>
}

export type EnqueueResult =
  | { ok: true; id: string; status: OutboxStatus; created: boolean }
  | { ok: false; error: string }

/**
 * Grava o evento no outbox (idempotente por event_id). Gated: com o engine
 * 'disabled' nasce 'skipped_engine_disabled' (nunca é enviado). Se o event_id já
 * existe (reentrada/reload), NÃO duplica — devolve a linha existente (created:false).
 *
 * NÃO envia aqui — o envio é responsabilidade do chamador (dispatchOutboxRow no
 * login, ou flushOutbox no próximo turno).
 */
export async function enqueueEvent(input: EnqueueInput): Promise<EnqueueResult> {
  if (outboxUnavailable) return { ok: false, error: "engine_outbox_unavailable" } // no-op explícito (N-D2-7)
  const supabase = input.supabase ?? createServiceClient()
  const gated = engineName() === "disabled"
  const status: OutboxStatus = gated ? "skipped_engine_disabled" : "pending"

  // Idempotência: se já existe o event_id, não recria (reentrada da mesma abertura).
  const { data: existing, error: readErr } = await supabase
    .from("engine_outbox")
    .select("id, status")
    .eq("event_id", input.envelope.event_id)
    .maybeSingle()
  if (readErr && isOutboxUnavailableError(readErr)) {
    noteOutboxUnavailable("enqueueEvent")
    return { ok: false, error: "engine_outbox_unavailable" }
  }
  if (existing) {
    return { ok: true, id: existing.id as string, status: existing.status as OutboxStatus, created: false }
  }

  const { data, error } = await supabase
    .from("engine_outbox")
    .insert({
      session_id: input.sessionId,
      company_id: input.companyId,
      event_type: input.envelope.type,
      event_id: input.envelope.event_id,
      payload: input.envelope,
      status,
      attempts: 0,
      next_attempt_at: gated ? null : new Date().toISOString(),
    })
    .select("id, status")
    .single()

  if (error || !data) {
    if (error && isOutboxUnavailableError(error)) {
      noteOutboxUnavailable("enqueueEvent")
      return { ok: false, error: "engine_outbox_unavailable" }
    }
    // corrida rara: outro request inseriu o mesmo event_id entre o SELECT e o
    // INSERT (UNIQUE violado). Trata como já-existe (idempotente), não como erro.
    const { data: race } = await supabase
      .from("engine_outbox")
      .select("id, status")
      .eq("event_id", input.envelope.event_id)
      .maybeSingle()
    if (race) return { ok: true, id: race.id as string, status: race.status as OutboxStatus, created: false }
    return { ok: false, error: error?.message ?? "engine_outbox_insert_failed" }
  }
  return { ok: true, id: data.id as string, status: data.status as OutboxStatus, created: true }
}

type DispatchOutcome =
  | { kind: "sent" }
  | { kind: "skipped" }
  | { kind: "retry"; error: string }
  | { kind: "failed"; error: string }

/** UMA tentativa de POST ao n8n. Não lança; classifica o desfecho. Sem segredo/PII. */
async function postToN8n(payload: CanonicalEnvelope): Promise<DispatchOutcome> {
  const url = eventFlowUrl()
  if (!url) return { kind: "skipped" }
  // corpo EXATO e estável — a assinatura cobre byte-a-byte o que trafega.
  const body = stableStringify(payload)
  const { headers } = buildN8nOutboundHeaders(body, payload.event_id)
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(outboxPostTimeoutMs()),
    })
    // drena o corpo para liberar a conexão; NUNCA logar o conteúdo.
    await resp.text().catch(() => "")
    if (resp.ok || resp.status === 202) return { kind: "sent" }
    // 4xx (exceto 408/429) é permanente → não adianta reentregar.
    if (resp.status >= 400 && resp.status < 500 && resp.status !== 408 && resp.status !== 429) {
      return { kind: "failed", error: `http_${resp.status}` }
    }
    return { kind: "retry", error: `http_${resp.status}` }
  } catch (err) {
    const label = err instanceof Error && err.name === "TimeoutError" ? "timeout" : "network_error"
    return { kind: "retry", error: label }
  }
}

/**
 * Entrega UMA linha do outbox ao n8n e persiste o desfecho. Best-effort e
 * não-fatal: nunca lança. Gated ('skipped_engine_disabled') → no-op (não envia).
 * Retorna o status final da linha.
 */
export async function dispatchOutboxRow(
  row: Pick<OutboxRow, "id" | "payload" | "attempts" | "status">,
  supabase: ReturnType<typeof createServiceClient> = createServiceClient(),
): Promise<OutboxStatus> {
  if (row.status === "skipped_engine_disabled" || row.status === "sent") return row.status

  const outcome = await postToN8n(row.payload)
  const now = new Date().toISOString()

  if (outcome.kind === "sent") {
    await supabase
      .from("engine_outbox")
      .update({ status: "sent", attempts: row.attempts + 1, sent_at: now, next_attempt_at: null, last_error: null, updated_at: now })
      .eq("id", row.id)
      .select("id")
    return "sent"
  }
  if (outcome.kind === "skipped") {
    // n8n não plugado (sem URL): mantém 'pending' com uma tentativa registrada,
    // sem estourar o teto (o flush volta quando a URL existir). Sem next_attempt
    // agressivo para não spammar.
    await supabase
      .from("engine_outbox")
      .update({ attempts: row.attempts + 1, next_attempt_at: nextAttemptAt(row.attempts + 1), last_error: "no_flow_url", updated_at: now })
      .eq("id", row.id)
      .select("id")
    return "pending"
  }

  const attempts = row.attempts + 1
  const reachedCap = outcome.kind === "failed" || attempts >= outboxMaxAttempts()
  const nextStatus: OutboxStatus = reachedCap ? "failed" : "pending"
  await supabase
    .from("engine_outbox")
    .update({
      status: nextStatus,
      attempts,
      last_error: outcome.error, // rótulo técnico curto (timeout|network_error|http_5xx) — sem segredo/PII
      next_attempt_at: nextStatus === "pending" ? nextAttemptAt(attempts) : null,
      updated_at: now,
    })
    .eq("id", row.id)
    .select("id")
  return nextStatus
}

export interface FlushResult {
  scanned: number
  sent: number
  failed: number
  pending: number
}

/**
 * Flush ordenado do outbox: entrega as linhas 'pending' elegíveis (next_attempt_at
 * no passado ou nulo) na ORDEM de criação — session.start antes do 1º chat.turn.
 * Best-effort e não-fatal: nunca lança. Chamado no próximo turno e pelo script ops.
 *
 * `sessionId` opcional restringe ao flush da própria sessão (caminho do turno);
 * sem ele, faz o flush global (script ops).
 */
export async function flushOutbox(opts?: { sessionId?: string; limit?: number }): Promise<FlushResult> {
  const empty: FlushResult = { scanned: 0, sent: 0, failed: 0, pending: 0 }
  if (outboxUnavailable) return empty // no-op explícito (N-D2-7)
  const supabase = createServiceClient()
  const limit = opts?.limit ?? 50
  const nowIso = new Date().toISOString()

  let query = supabase
    .from("engine_outbox")
    .select("id, payload, attempts, status, next_attempt_at")
    .eq("status", "pending")
    .or(`next_attempt_at.is.null,next_attempt_at.lte.${nowIso}`)
    .order("created_at", { ascending: true })
    .limit(limit)
  if (opts?.sessionId) query = query.eq("session_id", opts.sessionId)

  const { data, error } = await query
  if (error && isOutboxUnavailableError(error)) noteOutboxUnavailable("flushOutbox")
  if (error || !data) return empty

  const result: FlushResult = { scanned: data.length, sent: 0, failed: 0, pending: 0 }
  // Ordem preservada: entrega uma a uma (não paraleliza) para não inverter a
  // sequência session.start → chat.turn dentro da mesma sessão.
  for (const row of data as Array<Pick<OutboxRow, "id" | "payload" | "attempts" | "status">>) {
    const status = await dispatchOutboxRow(row, supabase)
    if (status === "sent") result.sent++
    else if (status === "failed") result.failed++
    else result.pending++
  }
  return result
}
