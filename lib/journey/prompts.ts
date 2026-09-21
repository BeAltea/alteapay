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
}

export type CreatePromptResult =
  | { ok: true; prompt: PromptRow }
  | { ok: false; error: string }

/**
 * Cria um prompt novo. Valida os botões (ids únicos/reservados no código) e
 * supersede qualquer prompt 'active' anterior da MESMA sessão (só uma pergunta
 * viva por vez). Retorna a linha criada (com botões normalizados por id).
 */
export async function createPrompt(input: CreatePromptInput): Promise<CreatePromptResult> {
  const verdict = validateButtons(input.buttons)
  if (!verdict.ok) return { ok: false, error: verdict.error }

  const supabase = createServiceClient()
  const now = new Date().toISOString()

  // supersede os ativos anteriores da sessão (transição atômica no nível do row)
  await supabase
    .from("chat_prompts")
    .update({ status: "superseded" })
    .eq("session_id", input.sessionId)
    .eq("status", "active")

  const buttons = sortButtons(input.buttons)
  const { data, error } = await supabase
    .from("chat_prompts")
    .insert({
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
    })
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
 * grava chat_messages(role='customer', text=label, button_id, prompt_id).
 * A transição 'active'→'answered' é condicional (eq status='active'): dois
 * cliques concorrentes → só o primeiro converte, o 2º devolve 409.
 */
export async function answerPrompt(input: {
  sessionId: string
  companyId: string
  promptId: string
  buttonId: number
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

  // o clique também é uma mensagem do cliente (label + button_id + prompt_id)
  await supabase.from("chat_messages").insert({
    company_id: input.companyId,
    session_id: input.sessionId,
    role: "customer",
    text: button.label,
    button_id: button.id,
    prompt_id: prompt.id,
  })

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
