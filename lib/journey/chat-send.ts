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
import {
  assertBooleanButtons,
  BTN_BACK,
  BTN_HANDOFF,
  BTN_NO,
  BTN_YES,
  validateButtons,
  type Button,
} from "./buttons"
import {
  createPrompt,
  closeActivePrompt,
  getActivePrompt,
  isProtectedPlatformPrompt,
  type PromptRow,
} from "./prompts"
import { recordEvent } from "./events"
import type { SessionCtx } from "./actions"

const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// A2 (N-D2-5) — ACIONABILIDADE de um prompt vindo do n8n. Regra §2.3/§2.5 (D1
// híbrido): o assistido da plataforma é a rede de segurança sempre presente; o
// n8n só CONDUZ (substitui o menu ativo) quando manda um prompt que a plataforma
// sabe executar no clique. "Acionável" = validateButtons OK **e** ação mapeável:
//   - offer_choice: todo item de lista (2..97) carrega `value` = offer_id de uma
//     oferta 'presented' desta sessão (a matriz é do SERVIDOR — D8/D11);
//   - payment_method_choice: itens com `value` ∈ {PIX, BOLETO, CREDIT_CARD};
//   - kinds booleanos (debt_acknowledgement, generic_yes_no,
//     payment_confirmation): catálogo Sim/Não (+99);
//   - kind desconhecido: só se TODO botão for reservado (0/1/98/99) ou mapear um
//     offer_id da sessão;
//   - kinds reservados à plataforma (debt_three_options, debt_consult,
//     post_payment_link): nunca (colidiriam com a semântica do assistido).
// Puro e testável. Texto sem prompt NUNCA passa por aqui (não supersede nada).
// ---------------------------------------------------------------------------
export type PromptActionability = { ok: true; reason: string } | { ok: false; code: string }

const BILLING_TYPE_VALUES: ReadonlySet<string> = new Set(["PIX", "BOLETO", "CREDIT_CARD"])
const PLATFORM_RESERVED_KINDS: ReadonlySet<string> = new Set(["debt_three_options", "debt_consult", "post_payment_link"])
const BOOLEAN_KINDS: ReadonlySet<string> = new Set(["debt_acknowledgement", "generic_yes_no", "payment_confirmation"])

function isReservedId(id: number): boolean {
  return id === BTN_YES || id === BTN_NO || id === BTN_BACK || id === BTN_HANDOFF
}

export function assessPromptActionability(
  prompt: { kind: string; buttons: Button[] },
  sessionOfferIds: ReadonlySet<string>,
): PromptActionability {
  const verdict = validateButtons(prompt.buttons)
  if (!verdict.ok) return { ok: false, code: verdict.error }
  const kind = (prompt.kind ?? "").trim()
  if (!kind) return { ok: false, code: "kind_missing" }
  if (PLATFORM_RESERVED_KINDS.has(kind)) return { ok: false, code: "kind_reserved_platform" }

  const listItems = prompt.buttons.filter((b) => !isReservedId(b.id))
  const mapsOffer = (b: Button) => typeof b.value === "string" && sessionOfferIds.has(b.value)

  if (kind === "offer_choice") {
    if (listItems.length === 0) return { ok: false, code: "offer_choice_without_items" }
    if (!listItems.every(mapsOffer)) return { ok: false, code: "offer_id_unknown" }
    return { ok: true, reason: "offer_choice_matrix" }
  }
  if (kind === "payment_method_choice") {
    if (listItems.length === 0) return { ok: false, code: "payment_method_without_items" }
    if (!listItems.every((b) => typeof b.value === "string" && BILLING_TYPE_VALUES.has(b.value))) {
      return { ok: false, code: "billing_type_unknown" }
    }
    return { ok: true, reason: "payment_method_choice" }
  }
  if (BOOLEAN_KINDS.has(kind)) {
    const bool = assertBooleanButtons(prompt.buttons)
    if (!bool.ok) return { ok: false, code: bool.error }
    return { ok: true, reason: "boolean_prompt" }
  }
  // kind desconhecido: acionável só quando TODO botão é mapeável pela plataforma.
  if (!listItems.every(mapsOffer)) return { ok: false, code: "button_action_unmapped" }
  return { ok: true, reason: "all_buttons_mapped" }
}

/** offer_ids 'presented' (válidas) da sessão — o universo de valores que um
 *  botão de lista pode mapear. Leitura enxuta; nunca lança (vazio em falha). */
async function sessionPresentedOfferIds(sessionId: string): Promise<Set<string>> {
  try {
    const supabase = createServiceClient()
    const { data } = await supabase
      .from("negotiation_offers")
      .select("id")
      .eq("session_id", sessionId)
      .eq("status", "presented")
    return new Set(((data ?? []) as Array<{ id: string }>).map((o) => o.id))
  } catch {
    return new Set()
  }
}

/** QA round 4 (R-18/R-27): janela (ms) em que o n8n ainda pode tomar as parcelas do assistido. */
export function n8nTakeoverWindowMs(): number {
  const n = Number(process.env.N8N_TAKEOVER_WINDOW_MS)
  return Number.isFinite(n) && n > 0 ? n : 15_000
}

/** PURA: `createdAt` (ISO) do offer_choice ainda dentro da janela de tomada? Sem data → dentro (compat). */
export function isWithinTakeoverWindow(createdAt: string | null | undefined, nowMs: number, windowMs = n8nTakeoverWindowMs()): boolean {
  const t = Date.parse(createdAt ?? "")
  if (!Number.isFinite(t)) return true
  return nowMs - t < windowMs
}

type ProtectedGuard =
  | { actionable: true; protectedActive: boolean }
  | { actionable: false; refusal: { ok: false; status: 422; code: string; message: string } }

/**
 * Guard do supersede (A2): se o prompt ATIVO é um menu protegido do assistido da
 * plataforma, o prompt do n8n só entra se for acionável; senão 422 e o assistido
 * fica. Sem prompt protegido ativo → comportamento legado (supersede livre).
 */
async function guardProtectedActive(
  ctx: SessionCtx,
  prompt: { kind: string; buttons: Button[] },
): Promise<ProtectedGuard> {
  const active = await getActivePrompt(ctx.sessionId)
  if (!isProtectedPlatformPrompt(active)) return { actionable: true, protectedActive: false }
  // QA round 4 (R-18/R-27, S9 §3): JANELA DO MOTOR — com as parcelas do assistido
  // (offer_choice) na tela, o n8n só as substitui até N8N_TAKEOVER_WINDOW_MS
  // depois de apresentadas. Fora da janela o devedor já está lendo/escolhendo:
  // 422 e o assistido permanece (nunca troca de menu sob o dedo).
  if (active!.kind === "offer_choice" && !isWithinTakeoverWindow(active!.created_at, Date.now())) {
    return {
      actionable: false,
      refusal: {
        ok: false,
        status: 422,
        code: "prompt_outside_window",
        message: "prompt do n8n fora da janela de tomada; as parcelas do assistido foram preservadas",
      },
    }
  }
  const offerIds = await sessionPresentedOfferIds(ctx.sessionId)
  const verdict = assessPromptActionability(prompt, offerIds)
  if (verdict.ok) return { actionable: true, protectedActive: true }
  return {
    actionable: false,
    refusal: {
      ok: false,
      status: 422,
      code: "prompt_not_actionable",
      message: `prompt do n8n não acionável (${verdict.code}); o menu assistido (${active!.kind}) foi preservado`,
    },
  }
}

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
  let promptActionable = false
  if (args.prompt) {
    const verdict = validateButtons(args.prompt.buttons)
    if (!verdict.ok) {
      return { ok: false, status: 422, code: verdict.error, message: "botões inválidos" }
    }
    // A2 (N-D2-5): com um menu protegido do assistido ATIVO, o prompt só entra se
    // for acionável (422 caso contrário — nada é gravado; o assistido fica).
    const guard = await guardProtectedActive(ctx, args.prompt)
    if (!guard.actionable) return guard.refusal
    promptActionable = true
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
  // Texto SEM prompt nunca toca chat_prompts (não supersede, não cala o
  // assistido — provado em D2 §4.3); só a bolha é gravada.
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
      actionable: promptActionable,
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

/** prompt.ask (papel B): cria só um prompt (sem mensagem). A2: com um menu
 *  protegido do assistido ativo, só um prompt ACIONÁVEL substitui (senão 422). */
export async function promptAsk(
  ctx: SessionCtx,
  args: { kind: string; question: string; buttons: Button[]; n8n_execution_id?: string },
): Promise<PromptAskResult> {
  const verdict = validateButtons(args.buttons)
  if (!verdict.ok) return { ok: false, status: 422, code: verdict.error, message: "botões inválidos" }
  const guard = await guardProtectedActive(ctx, { kind: args.kind, buttons: args.buttons })
  if (!guard.actionable) return guard.refusal
  const created = await createPrompt({
    companyId: ctx.companyId,
    sessionId: ctx.sessionId,
    kind: args.kind,
    question: args.question,
    buttons: args.buttons,
    createdBy: "n8n",
    n8nExecutionId: args.n8n_execution_id ?? null,
    actionable: true,
  })
  if (!created.ok) {
    return { ok: false, status: 422, code: created.error, message: "prompt inválido" }
  }
  return { ok: true, prompt_id: created.prompt.id }
}

export type PromptCloseResult =
  | { ok: true; closed: boolean }
  | { ok: false; status: 422; code: "platform_prompt_protected"; message: string }

/** prompt.close (papel B): supersede o prompt ativo da sessão. A2: NÃO fecha um
 *  menu protegido do assistido da plataforma (fechar sem substituir por algo
 *  acionável deixaria o devedor sem caminho) → 422 e o assistido fica. */
export async function promptClose(ctx: SessionCtx): Promise<PromptCloseResult> {
  const active = await getActivePrompt(ctx.sessionId)
  if (isProtectedPlatformPrompt(active)) {
    return {
      ok: false,
      status: 422,
      code: "platform_prompt_protected",
      message: `o menu assistido ativo (${active!.kind}) só é substituído por um prompt acionável (chat.send/prompt.ask)`,
    }
  }
  const closed = await closeActivePrompt(ctx.sessionId)
  return { ok: true, closed }
}
