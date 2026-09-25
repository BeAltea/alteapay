// Prompts com botões (onda R). Uma pergunta ATIVA por sessão: ao criar uma nova
// as anteriores 'active' viram 'superseded'. Ao responder, valida a integridade
// do clique (prompt da sessão, ativo, botão existe) e transiciona para
// 'answered', gravando também a mensagem do cliente (label + button_id).
//
// Toda escrita via service role. Sem PII em log. O clique NÃO decide desconto —
// o servidor é a autoridade de ofertas/matriz.

import { createServiceClient } from "@/lib/supabase/service"
import {
  type Button,
  type PromptKind,
  findButton,
  sortButtons,
  validateButtons,
} from "./buttons"
import { recordEvent } from "./events"

/**
 * C3 (trilha D2): época (thread) corrente da sessão para carimbar nas inserts de
 * chat_prompts/chat_messages. O reset 24h incrementa negotiation_sessions.
 * thread_epoch; sem o carimbo, um prompt/clique novo cairia na época 0 (velha) e
 * sumiria da tela nova. Best-effort: coluna ausente (20260935 pendente) → 0
 * (comportamento de hoje). O caller só inclui o campo quando > 0 (época 0 = default
 * = dispensa a coluna, para não quebrar em prod antes da migration). NUNCA lança.
 */
export async function currentThreadEpoch(sessionId: string): Promise<number> {
  try {
    const supabase = createServiceClient()
    const { data } = await supabase
      .from("negotiation_sessions")
      .select("thread_epoch")
      .eq("id", sessionId)
      .maybeSingle()
    const raw = (data as { thread_epoch?: number | null } | null)?.thread_epoch
    return typeof raw === "number" ? raw : 0
  } catch {
    return 0
  }
}

export interface PromptRow {
  id: string
  company_id: string
  session_id: string
  kind: string
  question: string
  buttons: Button[]
  context: Record<string, unknown> | null
  status: "active" | "answered" | "expired" | "superseded"
  answered_button_id: number | null
  answered_value: string | null
  answered_at: string | null
  created_by: "platform" | "n8n"
  n8n_execution_id: string | null
  expires_at: string | null
  created_at: string
}

/**
 * Shape PÚBLICO do prompt (o mesmo que GET /api/chat/messages devolve em
 * `active_prompt`): id, kind, question, buttons, status, created_at. Usado pelo
 * 409 `prompt_stale` do POST /api/chat/button para o client re-hidratar sem um
 * round-trip extra. Nunca expõe context/épocas.
 */
export interface PromptView {
  id: string
  kind: string
  question: string
  buttons: Button[]
  status: string
  created_at: string
}

export function promptView(p: PromptRow | null | undefined): PromptView | null {
  if (!p) return null
  return {
    id: p.id,
    kind: p.kind,
    question: p.question,
    buttons: p.buttons,
    status: p.status,
    created_at: p.created_at,
  }
}

export interface CreatePromptInput {
  companyId: string
  sessionId: string
  kind: PromptKind | string
  question: string
  buttons: Button[]
  context?: Record<string, unknown> | null
  createdBy?: "platform" | "n8n"
  n8nExecutionId?: string | null
  expiresAt?: string | null
  /** época já lida pelo chamador (evita 1 round-trip); ausente → lê aqui. */
  threadEpoch?: number
  /**
   * A2 (N-D2-5) — só para `createdBy:'n8n'`: resultado da avaliação de
   * acionabilidade (chat-send.assessPromptActionability). Um prompt do n8n só
   * SUPERSEDE um prompt ATIVO do assistido da plataforma (kinds protegidos) quando
   * `actionable === true`; caso contrário a criação é recusada
   * (`platform_prompt_protected`) e o assistido fica. Prompts da plataforma
   * nunca passam por esta regra.
   */
  actionable?: boolean
}

export type CreatePromptResult =
  | { ok: true; prompt: PromptRow }
  | { ok: false; error: string }

/**
 * A2 (N-D2-5) — kinds do ASSISTIDO cujo prompt ativo, quando criado pela
 * plataforma, é PROTEGIDO: só um prompt do n8n ACIONÁVEL (validateButtons + ação
 * mapeável) pode substituí-lo; texto sem botões e prompts inválidos/não mapeáveis
 * NÃO calam o assistido (regra de ouro §2.3/§2.5: o assistido é a rede de
 * segurança sempre presente; o n8n conduz só por prompt acionável).
 */
export const PLATFORM_PROTECTED_KINDS: ReadonlySet<string> = new Set([
  "debt_three_options",
  "offer_choice",
  "post_payment_link",
])

/** true quando `p` é um prompt ATIVO do assistido criado pela plataforma. */
export function isProtectedPlatformPrompt(
  p: Pick<PromptRow, "kind" | "created_by" | "status"> | null | undefined,
): boolean {
  return !!p && p.status === "active" && p.created_by === "platform" && PLATFORM_PROTECTED_KINDS.has(p.kind)
}

/**
 * Cria um prompt novo. Valida os botões (ids únicos/reservados no código) e
 * supersede qualquer prompt 'active' anterior da MESMA sessão (só uma pergunta
 * viva por vez). Retorna a linha criada (com botões normalizados por id).
 * A2: um prompt `createdBy:'n8n'` sem `actionable:true` NÃO supersede um prompt
 * protegido da plataforma (ver isProtectedPlatformPrompt) — devolve
 * `{ ok:false, error:'platform_prompt_protected' }` sem escrever nada.
 */
export async function createPrompt(input: CreatePromptInput): Promise<CreatePromptResult> {
  const verdict = validateButtons(input.buttons)
  if (!verdict.ok) return { ok: false, error: verdict.error }

  if (input.createdBy === "n8n" && input.actionable !== true) {
    const active = await getActivePrompt(input.sessionId)
    if (isProtectedPlatformPrompt(active)) return { ok: false, error: "platform_prompt_protected" }
  }

  const supabase = createServiceClient()
  const now = new Date().toISOString()

  // supersede os ativos anteriores da sessão (transição atômica no nível do row)
  // em PARALELO com a leitura da época (independentes — A1: latência do clique).
  const [, epoch] = await Promise.all([
    supabase
      .from("chat_prompts")
      .update({ status: "superseded" })
      .eq("session_id", input.sessionId)
      .eq("status", "active"),
    typeof input.threadEpoch === "number"
      ? Promise.resolve(input.threadEpoch)
      : currentThreadEpoch(input.sessionId),
  ])

  const buttons = sortButtons(input.buttons)
  // C3: carimba a época corrente (thread) — só quando > 0 (época 0 = default,
  // dispensa a coluna e não quebra em prod antes da 20260935).
  const promptRow: Record<string, unknown> = {
    company_id: input.companyId,
    session_id: input.sessionId,
    kind: input.kind,
    question: input.question,
    buttons,
    context: input.context ?? null,
    status: "active",
    created_by: input.createdBy ?? "platform",
    n8n_execution_id: input.n8nExecutionId ?? null,
    expires_at: input.expiresAt ?? null,
  }
  if (epoch > 0) promptRow.thread_epoch = epoch
  const { data, error } = await supabase
    .from("chat_prompts")
    .insert(promptRow)
    .select("*")
    .single()
  if (error || !data) return { ok: false, error: error?.message ?? "prompt_insert_failed" }

  await recordEvent({
    companyId: input.companyId,
    sessionId: input.sessionId,
    type: "chat.turn.assistant",
    actor: input.createdBy === "n8n" ? "n8n" : "system",
    payload: { prompt: true, prompt_id: data.id, kind: input.kind, created_at: now },
    eventId: `prompt.ask|${data.id}`,
  })
  return { ok: true, prompt: data as PromptRow }
}

/** Prompt 'active' da sessão (no máximo um). null se não houver. */
export async function getActivePrompt(sessionId: string): Promise<PromptRow | null> {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from("chat_prompts")
    .select("*")
    .eq("session_id", sessionId)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data as PromptRow) ?? null
}

/** Carrega um prompt específico da sessão. */
export async function getPrompt(promptId: string, sessionId: string): Promise<PromptRow | null> {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from("chat_prompts")
    .select("*")
    .eq("id", promptId)
    .eq("session_id", sessionId)
    .maybeSingle()
  return (data as PromptRow) ?? null
}

export type AnswerPromptResult =
  | { ok: true; prompt: PromptRow; button: Button }
  | { ok: false; status: number; code: string }

/**
 * Responde um prompt: integridade do clique (§2.3).
 *  - prompt inexistente/de outra sessão → 404 prompt_not_found;
 *  - prompt não-'active' (já respondido, superseded, expirado) → 409 prompt_not_active;
 *  - button_id não existe no catálogo → 409 button_invalid.
 * Ao responder: 'answered' (+answered_button_id, +answered_value, +answered_at) e
 * grava chat_messages(role='customer', text=label, button_id, prompt_id) E o
 * evento de auditoria `chat.turn.customer` (N-D3-2: TODO clique deixa rastro em
 * journey_events; `retargeted_from` marca um clique re-alvejado de um prompt
 * obsoleto para o ativo equivalente — ver POST /api/chat/button).
 * A transição 'active'→'answered' é condicional (eq status='active'): dois
 * cliques concorrentes → só o primeiro converte, o 2º devolve 409.
 */
export async function answerPrompt(input: {
  sessionId: string
  companyId: string
  promptId: string
  buttonId: number
  /** id do prompt obsoleto que o devedor clicou (re-alvejado para este). */
  retargetedFrom?: string | null
}): Promise<AnswerPromptResult> {
  const supabase = createServiceClient()
  const prompt = await getPrompt(input.promptId, input.sessionId)
  if (!prompt) return { ok: false, status: 404, code: "prompt_not_found" }
  if (prompt.status !== "active") return { ok: false, status: 409, code: "prompt_not_active" }

  const button = findButton(prompt.buttons, input.buttonId)
  if (!button) return { ok: false, status: 409, code: "button_invalid" }

  const now = new Date().toISOString()
  // transição condicional: só converte se ainda estiver 'active' (anti-concorrência)
  const { data: updated } = await supabase
    .from("chat_prompts")
    .update({
      status: "answered",
      answered_button_id: button.id,
      answered_value: button.value ?? null,
      answered_at: now,
    })
    .eq("id", prompt.id)
    .eq("session_id", input.sessionId)
    .eq("status", "active")
    .select("*")

  if (!updated || (Array.isArray(updated) && updated.length === 0)) {
    // outro clique já converteu entre a leitura e o update
    return { ok: false, status: 409, code: "prompt_not_active" }
  }

  // o clique também é uma mensagem do cliente (label + button_id + prompt_id).
  // C3: carimba a época corrente para a bolha do clique ficar na thread atual.
  const clickEpoch = await currentThreadEpoch(input.sessionId)
  const clickRow: Record<string, unknown> = {
    company_id: input.companyId,
    session_id: input.sessionId,
    role: "customer",
    text: button.label,
    button_id: button.id,
    prompt_id: prompt.id,
  }
  if (clickEpoch > 0) clickRow.thread_epoch = clickEpoch
  // eco do clique + auditoria em PARALELO (independentes). O evento é dedupado
  // por (prompt, botão) — um prompt só é respondido uma vez.
  await Promise.all([
    supabase.from("chat_messages").insert(clickRow),
    recordEvent({
      companyId: input.companyId,
      sessionId: input.sessionId,
      type: "chat.turn.customer",
      actor: "customer",
      eventId: `chat.turn.customer|${prompt.id}|${button.id}`,
      payload: {
        button_id: button.id,
        prompt_id: prompt.id,
        kind: prompt.kind,
        ...(input.retargetedFrom ? { retargeted_from: input.retargetedFrom } : {}),
      },
    }).catch(() => ({ ok: false, duplicate: false })),
  ])

  const answeredRow = Array.isArray(updated) ? (updated[0] as PromptRow) : (updated as PromptRow)
  return { ok: true, prompt: answeredRow, button }
}

/** Expira prompts 'active' vencidos (expires_at < now). Retorna os ids expirados. */
export async function expirePrompts(sessionId: string): Promise<string[]> {
  const supabase = createServiceClient()
  const now = new Date().toISOString()
  const { data } = await supabase
    .from("chat_prompts")
    .update({ status: "expired" })
    .eq("session_id", sessionId)
    .eq("status", "active")
    .lt("expires_at", now)
    .select("id")
  return (data ?? []).map((r: { id: string }) => r.id)
}

/** Fecha (supersede) o prompt ativo da sessão sem respondê-lo (prompt.close). */
export async function closeActivePrompt(sessionId: string): Promise<boolean> {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from("chat_prompts")
    .update({ status: "superseded" })
    .eq("session_id", sessionId)
    .eq("status", "active")
    .select("id")
  return (data?.length ?? 0) > 0
}
