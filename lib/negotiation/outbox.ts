// Outbox transacional dos eventos plataforma → n8n (Frente A, onda D1; N8N-10).
//
// Fluxo de vida de uma linha (tabela engine_outbox):
//   1) INSERT na MESMA "transação" da sessão (idempotente por event_id UNIQUE).
//      Gated: engine 'disabled' → status='skipped_engine_disabled' (nunca envia).
//   2) Entrega best-effort ao n8n FORA do caminho da resposta ao devedor
//      (deferDelivery: waitUntil do runtime quando existe; senão solta). O login
//      e os cliques NUNCA aguardam o POST ao n8n.
//   3) Drenos (at-least-once, dedup por event_id no n8n):
//        - próximo turno do chat (flushOutbox da sessão, com orçamento curto);
//        - rota /api/cron/flush-engine-outbox (Bearer CRON_SECRET), chamada a
//          cada minuto pela scheduled function do Netlify — NÃO depende do worker;
//        - worker Fargate (engine-outbox.drainer), quando a imagem for refeita;
//        - scripts/ops/flush-engine-outbox.ts (manual).
//      Cada envio primeiro REIVINDICA a linha (compare-and-set em `attempts` +
//      lease em next_attempt_at): dois drenos concorrentes não postam a mesma
//      linha ao mesmo tempo. Backoff exponencial; teto de tentativas → 'failed'.
//
// Tabela ausente (migration não aplicada, PGRST205/42P01): no-op EXPLÍCITO — log
// 1x e sai cedo; a indisponibilidade é revista a cada ENGINE_OUTBOX_RECHECK_MS
// (default 5 min), para que um processo quente passe a usar a tabela assim que a
// migration for aplicada, sem precisar reciclar.
//
// Segurança: HMAC ${ts}.${body} + headers x-alteapay-* + Basic Auth (reusa
// buildN8nOutboundHeaders de n8n.ts). O corpo POSTado é EXATAMENTE o `payload`
// serializado de forma estável (stableStringify) — a assinatura cobre byte-a-byte.
// NENHUM segredo em log; NUNCA logar corpo de erro do n8n.

import { deferAfterResponse } from "@/lib/journey/after-response"
import { createServiceClient } from "@/lib/supabase/service"
import { buildN8nOutboundHeaders } from "./n8n"
import { engineName, resolveEventFlowUrl } from "./engine"
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

/** Lease (ms) de uma linha reivindicada: enquanto vale, nenhum outro dreno a
 *  pega. Cobre o POST em voo (e uma função serverless congelada no meio dele). */
export function outboxLeaseMs(): number {
  const n = Number(process.env.ENGINE_OUTBOX_LEASE_MS)
  return Number.isFinite(n) && n > 0 ? n : 60_000
}

function leaseUntil(): string {
  return new Date(Date.now() + outboxLeaseMs()).toISOString()
}

/** Intervalo (ms) para rever a tabela depois de constatá-la ausente (default 5 min). */
function recheckMs(): number {
  const n = Number(process.env.ENGINE_OUTBOX_RECHECK_MS)
  return Number.isFinite(n) && n >= 0 ? n : 5 * 60_000
}

// ---------------------------------------------------------------------------
// A2 / N-D2-7: a tabela engine_outbox NÃO existe em produção (PGRST205). Sem a
// migration (fora desta onda), todo acesso virava um no-op SILENCIOSO — a
// "entrega durável" era fictícia e ninguém sabia. Agora: o erro de tabela ausente
// é reconhecido, logado UMA vez por processo (rótulo curto, sem PII/segredo) e as
// funções saem cedo (no-op EXPLÍCITO), sem repetir a round-trip falha a cada clique.
// ---------------------------------------------------------------------------
// Memória de indisponibilidade COM PRAZO: 0 = disponível (ou ainda não vista).
let outboxUnavailableUntil = 0

/** true para o erro do PostgREST/Postgres de tabela inexistente (PGRST205 = schema
 *  cache sem a relação; 42P01 = undefined_table). Nunca lança. */
export function isOutboxUnavailableError(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!error) return false
  if (error.code === "PGRST205" || error.code === "42P01") return true
  const msg = (error.message ?? "").toLowerCase()
  return msg.includes("engine_outbox") && (msg.includes("does not exist") || msg.includes("schema cache") || msg.includes("could not find"))
}

/** Marca o outbox como indisponível neste processo (até o próximo recheck) e loga
 *  1x por episódio (no-op explícito). */
export function noteOutboxUnavailable(where: string): void {
  if (outboxKnownUnavailable()) return
  outboxUnavailableUntil = Date.now() + recheckMs()
  console.warn(`[engine:outbox] engine_outbox ausente (migration pendente) — entrega durável DESATIVADA; ${where} vira no-op explícito`)
}

/** true quando este processo constatou há pouco que a tabela não existe. */
export function outboxKnownUnavailable(): boolean {
  return outboxUnavailableUntil > 0 && Date.now() < outboxUnavailableUntil
}

/** Só para testes: zera a memória de indisponibilidade. */
export function resetOutboxAvailability(): void {
  outboxUnavailableUntil = 0
}

// ---------------------------------------------------------------------------
// Entrega FORA do caminho da resposta. Next 14 não tem `after()`; o runtime do
// Netlify (@netlify/plugin-nextjs v5) expõe `waitUntil` no request-context. A
// detecção e o registro ficam num lugar só: lib/journey/after-response.ts
// (deferAfterResponse — integração N8N-10 × latência). Com waitUntil a função
// só termina quando o POST acaba; sem ele o trabalho segue solto: se a função
// congelar, a linha continua reivindicável depois do lease e um dos drenos
// reentrega. NUNCA aguardado pelo chamador; NUNCA rejeita.
// ---------------------------------------------------------------------------
export function deferDelivery(label: string, work: () => Promise<unknown>): void {
  deferAfterResponse(`engine:outbox ${label}`, work)
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
  if (outboxKnownUnavailable()) return { ok: false, error: "engine_outbox_unavailable" } // no-op explícito (N-D2-7)
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
  | { kind: "retry"; error: string }
  | { kind: "failed"; error: string }

/** UMA tentativa de POST ao n8n. Não lança; classifica o desfecho. Sem segredo/PII. */
async function postToN8n(url: string, payload: CanonicalEnvelope, timeoutMs: number): Promise<DispatchOutcome> {
  // corpo EXATO e estável — a assinatura cobre byte-a-byte o que trafega.
  const body = stableStringify(payload)
  const { headers } = buildN8nOutboundHeaders(body, payload.event_id)
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
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

export type DispatchableRow = Pick<OutboxRow, "id" | "payload" | "attempts" | "status"> & { company_id?: string }

/**
 * Reivindica a linha (compare-and-set): só quem ainda vê `attempts` igual ao que
 * leu a leva. Conta a tentativa JÁ (um POST perdido também consome o teto) e
 * empurra next_attempt_at para o fim do lease (os outros drenos não a veem).
 * Devolve false se outro dreno chegou antes ou se a linha deixou de ser 'pending'.
 */
async function claimRow(
  supabase: ReturnType<typeof createServiceClient>,
  row: DispatchableRow,
): Promise<boolean> {
  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from("engine_outbox")
    .update({ attempts: row.attempts + 1, next_attempt_at: leaseUntil(), updated_at: now })
    .eq("id", row.id)
    .eq("status", "pending")
    .eq("attempts", row.attempts)
    .select("id")
  if (error) {
    if (isOutboxUnavailableError(error)) noteOutboxUnavailable("claimRow")
    return false
  }
  return Array.isArray(data) && data.length > 0
}

export interface DispatchOptions {
  /** Timeout do POST (ms). Default ENGINE_OUTBOX_TIMEOUT_MS (2500). */
  postTimeoutMs?: number
}

/**
 * Entrega UMA linha do outbox ao n8n e persiste o desfecho. Best-effort e
 * não-fatal: nunca lança. Gated ('skipped_engine_disabled') → no-op (não envia).
 * Sem URL de fluxo neste processo → não toca a linha (fica para um dreno que a
 * tenha). Linha já reivindicada por outro dreno → não envia de novo.
 * Retorna o status da linha depois da tentativa.
 */
export async function dispatchOutboxRow(
  row: DispatchableRow,
  supabase: ReturnType<typeof createServiceClient> = createServiceClient(),
  opts: DispatchOptions = {},
): Promise<OutboxStatus> {
  if (row.status !== "pending") return row.status
  try {
    // mesma URL do negotiation.start e dos turnos: dedicada → por tenant → env.
    const url = await resolveEventFlowUrl(row.company_id ?? row.payload.company_id)
    if (!url) return "pending"
    if (!(await claimRow(supabase, row))) return "pending"

    const attempts = row.attempts + 1
    const outcome = await postToN8n(url, row.payload, opts.postTimeoutMs ?? outboxPostTimeoutMs())
    const now = new Date().toISOString()

    if (outcome.kind === "sent") {
      await supabase
        .from("engine_outbox")
        .update({ status: "sent", sent_at: now, next_attempt_at: null, last_error: null, updated_at: now })
        .eq("id", row.id)
        .select("id")
      return "sent"
    }

    const reachedCap = outcome.kind === "failed" || attempts >= outboxMaxAttempts()
    const nextStatus: OutboxStatus = reachedCap ? "failed" : "pending"
    await supabase
      .from("engine_outbox")
      .update({
        status: nextStatus,
        last_error: outcome.error, // rótulo técnico curto (timeout|network_error|http_5xx) — sem segredo/PII
        next_attempt_at: nextStatus === "pending" ? nextAttemptAt(attempts) : null,
        updated_at: now,
      })
      .eq("id", row.id)
      .select("id")
    return nextStatus
  } catch (err) {
    // nunca lança: a linha volta a ser elegível quando o lease vence.
    console.warn("[engine:outbox] dispatch falhou (não-fatal):", err instanceof Error ? err.name : "error")
    return "pending"
  }
}

export interface FlushResult {
  scanned: number
  sent: number
  failed: number
  pending: number
}

export interface FlushOptions {
  /** Restringe à própria sessão (caminho do turno); sem ele, flush global. */
  sessionId?: string
  limit?: number
  /** Orçamento total (ms): passado dele, não inicia novas entregas. */
  budgetMs?: number
  /** Timeout de cada POST (ms). */
  postTimeoutMs?: number
}

/**
 * Flush ordenado do outbox: entrega as linhas 'pending' elegíveis (next_attempt_at
 * no passado ou nulo) na ORDEM de criação — session.start antes do 1º chat.turn.
 * Best-effort e não-fatal: nunca lança. Chamado no próximo turno (da sessão), pela
 * rota de cron, pelo drenador do worker e pelo script ops (global).
 */
export async function flushOutbox(opts?: FlushOptions): Promise<FlushResult> {
  const empty: FlushResult = { scanned: 0, sent: 0, failed: 0, pending: 0 }
  if (outboxKnownUnavailable()) return empty // no-op explícito (N-D2-7)
  try {
    const supabase = createServiceClient()
    const limit = opts?.limit ?? 50
    const t0 = Date.now()
    const nowIso = new Date().toISOString()

    let query = supabase
      .from("engine_outbox")
      .select("id, company_id, payload, attempts, status, next_attempt_at")
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
    for (const row of data as DispatchableRow[]) {
      if (opts?.budgetMs !== undefined && Date.now() - t0 >= opts.budgetMs) {
        result.pending++ // fica para o próximo dreno
        continue
      }
      const status = await dispatchOutboxRow(row, supabase, { postTimeoutMs: opts?.postTimeoutMs })
      if (status === "sent") result.sent++
      else if (status === "failed") result.failed++
      else result.pending++
    }
    return result
  } catch (err) {
    console.warn("[engine:outbox] flush falhou (não-fatal):", err instanceof Error ? err.name : "error")
    return empty
  }
}
