// Ações de mensagem do papel B (onda R): o n8n empurra mensagens/prompts para o
// chat do cliente, que as recebe via GET /api/chat/messages?since= (polling).
//
//   chat.send   → grava chat_messages(role='assistant') + n8n_execution_id;
//                 opcionalmente cria um prompt (prompt.ask embutido) e/ou anexa
//                 um payment_ref. Dedupe por event_id (janela 24h).
//   prompt.ask  → cria só um prompt (createPrompt), sem mensagem.
//   prompt.close→ supersede o prompt ativo da sessão.
//
// HMAC/anti-replay/dedupe globais vivem na rota /api/webhooks/n8n. Aqui a
// dedupe por event_id é local (chat_messages não repetem para o mesmo event_id).

import { createServiceClient } from "@/lib/supabase/service"
import { validateButtons, type Button } from "./buttons"
import { createPrompt, closeActivePrompt, type PromptRow } from "./prompts"
import { recordEvent } from "./events"
import type { SessionCtx } from "./actions"

const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000

export interface ChatSendArgs {
  text: string
  prompt?: {
    kind: string
    question: string
    buttons: Button[]
  }
  payment_ref?: { agreement_id?: string; asaas_payment_id?: string }
  n8n_execution_id?: string
}

export type ChatSendResult =
  | { ok: true; message_id: string; prompt_id?: string; duplicate?: boolean }
  | { ok: false; status: number; code: string; message: string }

/** Dedupe local por event_id em chat_messages (janela 24h). */
async function findMessageByEventId(sessionId: string, eventId: string): Promise<string | null> {
  const supabase = createServiceClient()
  const since = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString()
  const { data } = await supabase
    .from("chat_messages")
    .select("id")
    .eq("session_id", sessionId)
    .eq("n8n_event_id", eventId)
    .gte("created_at", since)
    .limit(1)
    .maybeSingle()
  return data?.id ?? null
}

/**
 * chat.send (papel B): grava a mensagem do assistente vinda do n8n. Se `prompt`
 * vier, cria um prompt (validando botões) e vincula à mensagem. Dedupe por
 * event_id: 2ª chamada devolve o mesmo message_id com duplicate:true.
 */
export async function chatSend(
  ctx: SessionCtx,
  args: ChatSendArgs,
  eventId?: string,
): Promise<ChatSendResult> {
  const text = (args.text ?? "").replace(/<[^>]*>/g, "").trim()
  if (!text && !args.prompt) {
    return { ok: false, status: 422, code: "empty_message", message: "text ou prompt obrigatório" }
  }

  // valida botões ANTES de qualquer escrita (rejeita ids inválidos)
  if (args.prompt) {
    const verdict = validateButtons(args.prompt.buttons)
    if (!verdict.ok) {
      return { ok: false, status: 422, code: verdict.error, message: "botões inválidos" }
    }
  }

  // dedupe local por event_id
  if (eventId) {
    const existing = await findMessageByEventId(ctx.sessionId, eventId)
    if (existing) return { ok: true, message_id: existing, duplicate: true }
  }

  const supabase = createServiceClient()

  // Dedupe por CONTEÚDO: fluxos n8n reentrantes (session.start redisparado a cada
  // re-entrada do devedor) empurram a MESMA mensagem com event_ids DIFERENTES — o
  // dedupe por event_id acima não pega, e a tela mostrava a msg repetida. Se uma
  // mensagem de assistente IDÊNTICA já foi gravada nesta sessão nos últimos 15min,
  // não re-insere. Só para mensagem pura de texto (menus/prompts nunca deduplicam).
  if (text && !args.prompt) {
    const since = new Date(Date.now() - 15 * 60_000).toISOString()
    const { data: dup } = await supabase
      .from("chat_messages")
      .select("id")
      .eq("session_id", ctx.sessionId)
      .eq("role", "assistant")
      .eq("text", text)
      .gte("created_at", since)
      .limit(1)
      .maybeSingle()
    if (dup?.id) return { ok: true, message_id: dup.id, duplicate: true }
  }

  // §C3: composição com o placeholder "trabalhando" (chat-turn.recordWorkingPlaceholder,
  // gravado no Negociar). Como chat_messages NÃO tem coluna superseded_at, adotamos a
  // variante SEM migração por ORDENAÇÃO: o placeholder foi gravado no clique (mais
  // antigo) e este chat.send do n8n é mais novo → renderiza ABAIXO dele
  // ("Estou preparando…" → resposta real), leitura natural. A dedup por conteúdo
  // abaixo usa o TEXTO exato, e o placeholder tem texto diferente das respostas do
  // n8n, então nunca há falso-positivo de duplicata entre eles.
  let prompt: PromptRow | null = null
  if (args.prompt) {
    const created = await createPrompt({
      companyId: ctx.companyId,
      sessionId: ctx.sessionId,
      kind: args.prompt.kind,
      question: args.prompt.question,
      buttons: args.prompt.buttons,
      createdBy: "n8n",
      n8nExecutionId: args.n8n_execution_id ?? null,
    })
    if (!created.ok) {
      return { ok: false, status: 422, code: created.error, message: "falha ao criar prompt" }
    }
    prompt = created.prompt
  }

  const { data: message, error } = await supabase
    .from("chat_messages")
    .insert({
      company_id: ctx.companyId,
      session_id: ctx.sessionId,
      role: "assistant",
      text: text || (prompt ? prompt.question : ""),
      prompt_id: prompt?.id ?? null,
      n8n_execution_id: args.n8n_execution_id ?? null,
      n8n_event_id: eventId ?? null,
      engine: "n8n",
      offers_snapshot: args.payment_ref ? { payment_ref: args.payment_ref } : null,
    })
    .select("id")
    .single()
  if (error || !message) {
    return { ok: false, status: 500, code: "send_failed", message: error?.message ?? "falha ao enviar" }
  }

  await recordEvent({
    companyId: ctx.companyId,
    customerId: ctx.customerId,
    debtId: ctx.debtId,
    sessionId: ctx.sessionId,
    type: "chat.turn.assistant",
    actor: "n8n",
    eventId: eventId ? `chat.send|${eventId}` : undefined,
    payload: { message_id: message.id, prompt_id: prompt?.id ?? null, n8n_execution_id: args.n8n_execution_id ?? null },
  })

  return { ok: true, message_id: message.id, prompt_id: prompt?.id }
}

export type PromptAskResult =
  | { ok: true; prompt_id: string }
  | { ok: false; status: number; code: string; message: string }

/** prompt.ask (papel B): cria só um prompt (sem mensagem). */
export async function promptAsk(
  ctx: SessionCtx,
  args: { kind: string; question: string; buttons: Button[]; n8n_execution_id?: string },
): Promise<PromptAskResult> {
  const created = await createPrompt({
    companyId: ctx.companyId,
    sessionId: ctx.sessionId,
    kind: args.kind,
    question: args.question,
    buttons: args.buttons,
    createdBy: "n8n",
    n8nExecutionId: args.n8n_execution_id ?? null,
  })
  if (!created.ok) {
    return { ok: false, status: 422, code: created.error, message: "prompt inválido" }
  }
  return { ok: true, prompt_id: created.prompt.id }
}

/** prompt.close (papel B): supersede o prompt ativo da sessão. */
export async function promptClose(ctx: SessionCtx): Promise<{ ok: true; closed: boolean }> {
  const closed = await closeActivePrompt(ctx.sessionId)
  return { ok: true, closed }
}
