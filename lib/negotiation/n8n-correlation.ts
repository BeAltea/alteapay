// N8N-16 — correlação de callbacks do n8n com eventos que a PLATAFORMA enviou.
//
// Problema: o webhook do `1. Main` aceita POST sem assinatura; os subfluxos
// assinam com o segredo real e postam `chat.send` (e outras ações com efeito)
// para o `session_id` que o chamador informou. Um POST correto na assinatura não
// prova que a plataforma pediu aquela resposta.
//
// Defesa: uma ação do n8n que escreve no chat do devedor ou cria efeito
// (COVERED_ACTIONS) só é aceita quando ecoa um evento que NÓS enviamos ao n8n
// para a MESMA sessão/empresa, dentro de uma janela, e com um teto de respostas
// por evento. O id ecoado vem de `origin_event_id` (topo do corpo) ou, na falta
// dele, do próprio `event_id` do callback (o handoff 09 §3 pede "ecoar o
// event_id" no modo async).
//
// Registros usados (nenhuma tabela nova):
//  - chat.turn: event_id DETERMINÍSTICO = chatTurnEventId(session_id, id da
//    mensagem inbound em conversation_messages), gravada ANTES do POST. Recalculado
//    aqui a partir das mensagens inbound recentes da sessão.
//  - negotiation.start (e chat.turn sem turnRef): linha `n8n_out:<event_id>` em
//    journey_events, gravada ANTES do POST (recordN8nOutbound). Também aceitamos as
//    linhas de auditoria já existentes `neg_start:`/`neg_start_unavailable:`.
//  - session.start: engine_outbox (ausente em produção; consulta tolerante).
//  - teto de respostas: linhas `n8n_reply:<origin>:<k>` em journey_events
//    (k = 1..MAX; event_id UNIQUE garante o slot). Replay do MESMO callback
//    (mesma ação + mesmo event_id) reusa o slot e não consome o teto.
//
// Flag: N8N_REQUIRE_EVENT_CORRELATION (default OFF). OFF → só telemetria
// (journey_events `n8n.correlation_miss`, sem PII) e o callback segue. ON →
// 403/409 com código estável. Os fluxos n8n ainda NÃO ecoam o event_id: ligar a
// flag antes de ajustar os fluxos derruba o tráfego legítimo.
//
// HMAC, janela de timestamp e rate limit continuam no route, inalterados.

import { createHash, randomUUID } from "node:crypto"

import { chatTurnEventId } from "./payload"

/** Ações do n8n que escrevem no chat do devedor ou criam efeito de domínio. */
export const COVERED_ACTIONS = new Set<string>([
  // escrevem no chat do devedor
  "chat.send", "prompt.ask", "prompt.close",
  // dinheiro / acordo
  "payment.create", "payment.record", "offer.propose", "offer.accept", "offer.reject",
  "agreement.close",
  // casos, notas, encerramento
  "dispute.register", "payment_claim.register", "human.transfer", "negotiation.note",
  "session.close",
  // legado papel B com sessão existente (grava em conversation_messages / funil)
  "session.message", "session.record", "session.redirect",
  // N8N-13 (branch fix/n8n-data-source): grava o passo do roteador
  "flow.state.set",
])

/** Ações cobertas que NÃO consomem o teto de respostas (estado interno do fluxo). */
const CAP_EXEMPT_ACTIONS = new Set<string>(["flow.state.set"])

export type CorrelationCode =
  | "n8n_origin_missing"
  | "n8n_origin_unknown"
  | "n8n_origin_wrong_session"
  | "n8n_origin_wrong_company"
  | "n8n_origin_expired"
  | "n8n_reply_cap"
  | "n8n_correlation_unavailable"

export type CorrelationVerdict =
  | { ok: true; covered: false }
  | {
      ok: true
      covered: true
      origin: string
      source: OutboundSource
      replay: boolean
      /** N87-07: quando a plataforma enviou o evento de origem (null = desconhecido). */
      sentAt: string | null
    }
  | { ok: false; status: number; code: CorrelationCode; message: string }

export type OutboundSource = "ledger" | "chat_turn" | "outbox"

export interface OutboundRecord {
  event_id: string
  session_id: string | null
  company_id: string | null
  occurred_at: string
}

export interface ReplySlot {
  event_id: string
  callback_key: string | null
}

/** Acesso a dados da correlação — injetável nos testes. */
export interface CorrelationStore {
  loadSession(sessionId: string): Promise<{ id: string; company_id: string } | null>
  /** Linhas de journey_events com esses event_id (ledger de saída). */
  findLedger(eventIds: string[]): Promise<OutboundRecord[]>
  /** ids das mensagens inbound da sessão/empresa desde `sinceIso`. */
  recentInboundIds(sessionId: string, companyId: string, sinceIso: string): Promise<string[]>
  /** N87-07 (opcional): as mesmas mensagens com o instante de gravação — dá o
   *  `sentAt` de um chat.turn. Sem ele, o `sentAt` do chat.turn fica null. */
  recentInbound?(sessionId: string, companyId: string, sinceIso: string): Promise<Array<{ id: string; created_at: string | null }>>
  /** Linha do engine_outbox com esse event_id (null se ausente ou tabela ausente). */
  findOutbox(eventId: string): Promise<OutboundRecord | null>
  listReplySlots(slotIds: string[]): Promise<ReplySlot[]>
  /** true = slot gravado; false = slot já ocupado (UNIQUE). Lança em outro erro. */
  claimReplySlot(row: {
    slotId: string
    sessionId: string
    companyId: string
    action: string
    origin: string
    callbackKey: string | null
  }): Promise<boolean>
  recordOutbound(row: { eventId: string; sessionId: string; companyId: string; event: string }): Promise<void>
  recordMiss(row: {
    sessionId: string
    companyId: string
    action: string
    code: CorrelationCode
    enforced: boolean
  }): Promise<void>
}

// ---------------------------------------------------------------------------
// Config

export function correlationRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.N8N_REQUIRE_EVENT_CORRELATION ?? "").trim().toLowerCase()
  return v === "1" || v === "true" || v === "on" || v === "yes"
}

function intEnv(name: string, def: number, min: number, max: number): number {
  const n = Number(process.env[name])
  return Number.isInteger(n) && n >= min && n <= max ? n : def
}

/** Janela (s) entre o envio do evento e o callback. Default 15 min. */
export function correlationWindowSeconds(): number {
  return intEnv("N8N_CORRELATION_WINDOW_SECONDS", 900, 30, 86_400)
}

/** Teto de callbacks com efeito por evento de origem. Default 12. */
export function correlationMaxReplies(): number {
  return intEnv("N8N_CORRELATION_MAX_REPLIES", 12, 1, 100)
}

// ---------------------------------------------------------------------------
// Ids

const LEDGER_PREFIX = "n8n_out:"
const LEGACY_LEDGER_PREFIXES = ["neg_start:", "neg_start_unavailable:"]
const DETERMINISTIC_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const ORIGIN_RE = /^[A-Za-z0-9:_.-]{8,128}$/

function replySlotId(origin: string, k: number): string {
  return `n8n_reply:${origin}:${k}`
}

function callbackKey(action: string, eventId: string | null | undefined): string | null {
  if (!eventId) return null
  return createHash("sha256").update(`${action}|${eventId}`).digest("hex").slice(0, 32)
}

/** Lê o id ecoado: `origin_event_id` (topo) → `event_id` do callback. */
export function extractOriginEventId(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null
  const b = body as Record<string, unknown>
  const candidates = [b.origin_event_id, b.event_id]
  for (const c of candidates) {
    if (typeof c === "string" && ORIGIN_RE.test(c.trim())) return c.trim()
  }
  return null
}

// ---------------------------------------------------------------------------
// Store padrão (Supabase, service role)

async function supabase() {
  const { createServiceClient } = await import("@/lib/supabase/service")
  return createServiceClient()
}

export const supabaseCorrelationStore: CorrelationStore = {
  async loadSession(sessionId) {
    const { data, error } = await (await supabase())
      .from("negotiation_sessions")
      .select("id, company_id")
      .eq("id", sessionId)
      .maybeSingle()
    if (error) throw new Error(`session:${error.code ?? "err"}`)
    return (data as { id: string; company_id: string } | null) ?? null
  },
  async findLedger(eventIds) {
    const { data, error } = await (await supabase())
      .from("journey_events")
      .select("event_id, session_id, company_id, occurred_at")
      .in("event_id", eventIds)
    if (error) throw new Error(`ledger:${error.code ?? "err"}`)
    return (data ?? []) as OutboundRecord[]
  },
  async recentInboundIds(sessionId, companyId, sinceIso) {
    const { data, error } = await (await supabase())
      .from("conversation_messages")
      .select("id")
      .eq("session_id", sessionId)
      .eq("company_id", companyId)
      .eq("direction", "inbound")
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(200)
    if (error) throw new Error(`inbound:${error.code ?? "err"}`)
    return ((data ?? []) as { id: string }[]).map((r) => r.id)
  },
  async recentInbound(sessionId, companyId, sinceIso) {
    const { data, error } = await (await supabase())
      .from("conversation_messages")
      .select("id, created_at")
      .eq("session_id", sessionId)
      .eq("company_id", companyId)
      .eq("direction", "inbound")
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(200)
    if (error) throw new Error(`inbound:${error.code ?? "err"}`)
    return (data ?? []) as Array<{ id: string; created_at: string | null }>
  },
  async findOutbox(eventId) {
    try {
      const { data, error } = await (await supabase())
        .from("engine_outbox")
        .select("event_id, session_id, company_id, created_at")
        .eq("event_id", eventId)
        .maybeSingle()
      if (error || !data) return null // tabela ausente em produção (PGRST205) → sem registro
      const row = data as { event_id: string; session_id: string; company_id: string; created_at: string }
      return { event_id: row.event_id, session_id: row.session_id, company_id: row.company_id, occurred_at: row.created_at }
    } catch {
      return null
    }
  },
  async listReplySlots(slotIds) {
    const { data, error } = await (await supabase())
      .from("journey_events")
      .select("event_id, payload")
      .in("event_id", slotIds)
    if (error) throw new Error(`slots:${error.code ?? "err"}`)
    return ((data ?? []) as { event_id: string; payload: Record<string, unknown> | null }[]).map((r) => ({
      event_id: r.event_id,
      callback_key: typeof r.payload?.callback_key === "string" ? (r.payload.callback_key as string) : null,
    }))
  },
  async claimReplySlot(row) {
    const { error } = await (await supabase()).from("journey_events").insert({
      company_id: row.companyId,
      session_id: row.sessionId,
      event_type: "n8n.callback",
      event_id: row.slotId,
      actor: "n8n",
      payload: { action: row.action, origin_event_id: row.origin, callback_key: row.callbackKey },
    })
    if (!error) return true
    if (error.code === "23505") return false
    throw new Error(`claim:${error.code ?? "err"}`)
  },
  async recordOutbound(row) {
    const { error } = await (await supabase()).from("journey_events").insert({
      company_id: row.companyId,
      session_id: row.sessionId,
      event_type: "n8n.outbound",
      event_id: `${LEDGER_PREFIX}${row.eventId}`,
      actor: "system",
      payload: { event: row.event },
    })
    if (error && error.code !== "23505") throw new Error(`outbound:${error.code ?? "err"}`)
  },
  async recordMiss(row) {
    // Telemetria sem PII: só ids internos, ação e código. customer_id omitido de
    // propósito (não aciona a projeção negotiation_state).
    await (await supabase()).from("journey_events").insert({
      company_id: row.companyId,
      session_id: row.sessionId,
      event_type: "n8n.correlation_miss",
      event_id: `n8n_miss:${randomUUID()}`,
      actor: "n8n",
      payload: { action: row.action, code: row.code, enforced: row.enforced },
    })
  },
}

let storeOverride: CorrelationStore | null = null
/** Só para testes: troca o store (null restaura o Supabase). */
export function setCorrelationStoreForTests(store: CorrelationStore | null): void {
  storeOverride = store
}
function currentStore(): CorrelationStore {
  return storeOverride ?? supabaseCorrelationStore
}

// ---------------------------------------------------------------------------
// Ledger de saída

/**
 * Registra, ANTES do POST, que a plataforma enviou `eventId` ao n8n para a
 * sessão. Best-effort: nunca lança (um erro aqui só faz o callback cair na
 * telemetria/recusa, nunca derruba o envio).
 */
export async function recordN8nOutbound(row: {
  eventId: string
  sessionId: string
  companyId: string
  event: string
}): Promise<void> {
  try {
    await currentStore().recordOutbound(row)
  } catch (err) {
    console.warn("[n8n-correlation] ledger de saída não gravado (não-fatal):", (err as Error).message)
  }
}

// ---------------------------------------------------------------------------
// Verificação

type FindResult =
  | { found: true; source: OutboundSource; record: OutboundRecord; sentAt: string | null }
  | { found: false; code: "n8n_origin_unknown" | "n8n_origin_wrong_session" | "n8n_origin_wrong_company" | "n8n_origin_expired" }

async function findOutbound(
  store: CorrelationStore,
  origin: string,
  session: { id: string; company_id: string },
  nowMs: number,
  windowMs: number,
): Promise<FindResult> {
  const sinceMs = nowMs - windowMs
  let mismatch: FindResult | null = null

  const judge = (source: OutboundSource, rec: OutboundRecord): FindResult => {
    if (rec.session_id !== session.id) return { found: false, code: "n8n_origin_wrong_session" }
    if (rec.company_id !== session.company_id) return { found: false, code: "n8n_origin_wrong_company" }
    const at = Date.parse(rec.occurred_at)
    if (!Number.isFinite(at) || at < sinceMs || at > nowMs + 60_000) return { found: false, code: "n8n_origin_expired" }
    return { found: true, source, record: rec, sentAt: rec.occurred_at }
  }

  // 1) ledger em journey_events (negotiation.start e afins)
  const ledgerIds = [LEDGER_PREFIX, ...LEGACY_LEDGER_PREFIXES].map((p) => `${p}${origin}`)
  const ledger = await store.findLedger(ledgerIds)
  for (const rec of ledger) {
    const v = judge("ledger", rec)
    if (v.found) return v
    mismatch ??= v
  }

  // 2) chat.turn: id determinístico a partir das mensagens inbound da sessão
  if (DETERMINISTIC_UUID_RE.test(origin)) {
    const since = new Date(sinceMs).toISOString()
    // N87-07: com o instante da mensagem inbound, o chat.turn também tem sentAt.
    const rows = store.recentInbound
      ? await store.recentInbound(session.id, session.company_id, since)
      : (await store.recentInboundIds(session.id, session.company_id, since)).map((id) => ({ id, created_at: null }))
    const hit = rows.find((r) => chatTurnEventId(session.id, r.id) === origin)
    if (hit) {
      return {
        found: true,
        source: "chat_turn",
        record: { event_id: origin, session_id: session.id, company_id: session.company_id, occurred_at: new Date(nowMs).toISOString() },
        sentAt: typeof hit.created_at === "string" ? hit.created_at : null,
      }
    }
  }

  // 3) engine_outbox (session.start). Ausente em produção → null.
  const outbox = await store.findOutbox(origin)
  if (outbox) {
    const v = judge("outbox", outbox)
    if (v.found) return v
    mismatch ??= v
  }

  return mismatch ?? { found: false, code: "n8n_origin_unknown" }
}

const MESSAGES: Record<CorrelationCode, string> = {
  n8n_origin_missing: "callback sem origin_event_id/event_id de um evento enviado pela plataforma",
  n8n_origin_unknown: "evento de origem não foi enviado pela plataforma",
  n8n_origin_wrong_session: "evento de origem pertence a outra sessão",
  n8n_origin_wrong_company: "evento de origem pertence a outra empresa",
  n8n_origin_expired: "evento de origem fora da janela de resposta",
  n8n_reply_cap: "limite de respostas para este evento de origem atingido",
  n8n_correlation_unavailable: "correlação indisponível, tente novamente",
}

const STATUS: Record<CorrelationCode, number> = {
  n8n_origin_missing: 403,
  n8n_origin_unknown: 403,
  n8n_origin_wrong_session: 403,
  n8n_origin_wrong_company: 403,
  n8n_origin_expired: 409,
  n8n_reply_cap: 409,
  n8n_correlation_unavailable: 503,
}

function fail(code: CorrelationCode): CorrelationVerdict {
  return { ok: false, status: STATUS[code], code, message: MESSAGES[code] }
}

/**
 * Veredito PURO (sem aplicar a flag). Com correlação válida, ocupa um slot de
 * resposta do evento de origem (efeito: uma linha em journey_events).
 */
export async function checkN8nCorrelation(
  body: { action: string; session_id?: string | null; event_id?: string | null },
  rawBody: unknown,
  opts: { store?: CorrelationStore; nowMs?: number; windowSeconds?: number; maxReplies?: number } = {},
): Promise<CorrelationVerdict & { session?: { id: string; company_id: string } }> {
  if (!COVERED_ACTIONS.has(body.action) || !body.session_id) return { ok: true, covered: false }
  const store = opts.store ?? currentStore()
  const nowMs = opts.nowMs ?? Date.now()
  const windowMs = (opts.windowSeconds ?? correlationWindowSeconds()) * 1000
  const maxReplies = opts.maxReplies ?? correlationMaxReplies()

  let session: { id: string; company_id: string } | null
  try {
    session = await store.loadSession(body.session_id)
  } catch {
    return fail("n8n_correlation_unavailable")
  }
  // Sessão inexistente: o handler responde 404 como antes (nada a correlacionar).
  if (!session) return { ok: true, covered: false }

  const origin = extractOriginEventId(rawBody)
  if (!origin) return { ...fail("n8n_origin_missing"), session }

  let found: FindResult
  try {
    found = await findOutbound(store, origin, session, nowMs, windowMs)
  } catch {
    return { ...fail("n8n_correlation_unavailable"), session }
  }
  if (!found.found) return { ...fail(found.code), session }

  const sentAt = found.sentAt
  if (CAP_EXEMPT_ACTIONS.has(body.action)) {
    return { ok: true, covered: true, origin, source: found.source, replay: false, sentAt, session }
  }

  // Teto de respostas por evento de origem, com replay idempotente.
  const key = callbackKey(body.action, body.event_id)
  const slotIds = Array.from({ length: maxReplies }, (_, i) => replySlotId(origin, i + 1))
  try {
    const taken = await store.listReplySlots(slotIds)
    if (key && taken.some((s) => s.callback_key === key)) {
      return { ok: true, covered: true, origin, source: found.source, replay: true, sentAt, session }
    }
    const takenIds = new Set(taken.map((s) => s.event_id))
    for (const slotId of slotIds) {
      if (takenIds.has(slotId)) continue
      const claimed = await store.claimReplySlot({
        slotId, sessionId: session.id, companyId: session.company_id,
        action: body.action, origin, callbackKey: key,
      })
      if (claimed) return { ok: true, covered: true, origin, source: found.source, replay: false, sentAt, session }
    }
  } catch {
    return { ...fail("n8n_correlation_unavailable"), session }
  }
  return { ...fail("n8n_reply_cap"), session }
}

export type CorrelationGate =
  | {
      reject: false
      /** N87-07: evento de origem correlacionado (só com veredito positivo e coberto). */
      origin?: { eventId: string; sentAt: string | null }
    }
  | { reject: true; status: number; code: CorrelationCode; error: string }

/**
 * Aplica a flag. OFF (default): nunca recusa; um veredito negativo vira
 * telemetria (`n8n.correlation_miss`, sem PII) e log curto. ON: recusa com
 * 403/409/503 e código estável; a recusa também gera a telemetria.
 * Nunca lança.
 */
export async function enforceN8nCorrelation(
  body: { action: string; session_id?: string | null; event_id?: string | null },
  rawBody: unknown,
  opts: { store?: CorrelationStore; nowMs?: number; required?: boolean } = {},
): Promise<CorrelationGate> {
  const required = opts.required ?? correlationRequired()
  const store = opts.store ?? currentStore()
  let verdict: Awaited<ReturnType<typeof checkN8nCorrelation>>
  try {
    verdict = await checkN8nCorrelation(body, rawBody, { store, nowMs: opts.nowMs })
  } catch {
    verdict = fail("n8n_correlation_unavailable")
  }
  if (verdict.ok) {
    return verdict.covered ? { reject: false, origin: { eventId: verdict.origin, sentAt: verdict.sentAt } } : { reject: false }
  }

  console.warn(`[n8n-correlation] ${required ? "recusado" : "seria recusado"}: action=${body.action} code=${verdict.code}`)
  if (verdict.session) {
    try {
      await store.recordMiss({
        sessionId: verdict.session.id,
        companyId: verdict.session.company_id,
        action: body.action,
        code: verdict.code,
        enforced: required,
      })
    } catch {
      /* telemetria best-effort */
    }
  }
  if (!required) return { reject: false }
  return { reject: true, status: verdict.status, code: verdict.code, error: verdict.message }
}
