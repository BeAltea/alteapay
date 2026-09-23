// Reconhecimento da dívida (onda R, §3). PRIMEIRO passo do chat, determinístico
// e local (não chama n8n antes da resposta). Log append-only auditável.
//
// Fluxo:
//  - buildAcknowledgementPrompt: monta o resumo (credor, valor atualizado, N
//    faturas, vencimento mais antigo) + pergunta Sim/Não e cria o chat_prompts.
//  - recordAcknowledgement: grava numa "transação" lógica (4 efeitos):
//      1) chat_prompts → answered (via answerPrompt, que também grava a mensagem
//         do cliente com o label + button_id);
//      2) debt_acknowledgements (append-only, button_id 0|1);
//      3) journey_events (debt.acknowledged | debt.not_recognized);
//      4) negotiation_sessions.debt_acknowledged_at (espelho do timestamp).
//  - getLatestAcknowledgement: última resposta por (session, debt) via view.
//  - assertAcknowledgedForPayment: invariante do payment.create.
//
// IDs: 1=Sim reconhece, 0=Não reconhece. show_handoff_button liga o [99].

import { createHash, randomUUID } from "node:crypto"
import { createServiceClient } from "@/lib/supabase/service"
import { recordEvent } from "./events"
import {
  BTN_CONSULT,
  BTN_HANDOFF,
  BTN_NEGOTIATE,
  BTN_NO,
  BTN_YES,
  type Button,
} from "./buttons"
import { createPrompt, answerPrompt, type PromptRow } from "./prompts"

const BRL = (v: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v || 0)

function formatDatePt(iso: string | null): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  return d.toLocaleDateString("pt-BR")
}

export interface AckContext {
  firstName: string // primeiro nome do cliente (vazio se indisponível)
  creditorName: string
  updatedValue: number // reais (a UI/n8n formata; cents só na borda n8n)
  invoiceCount: number
  oldestDueDate: string | null
}

/** Primeiro token do nome (ex.: "Fabio Mendes" → "Fabio"). Vazio se não houver. */
function firstNameOf(name: string | null | undefined): string {
  return (name ?? "").trim().split(/\s+/)[0] ?? ""
}

/** Resumo objetivo da dívida (cliente, credor, valor atualizado, vencimento). */
export async function buildAckContext(input: {
  companyId: string
  customerId: string
  debtIds: string[]
}): Promise<AckContext> {
  const supabase = createServiceClient()
  const { data: company } = await supabase
    .from("companies")
    .select("name")
    .eq("id", input.companyId)
    .maybeSingle()
  const { data: cfg } = await supabase
    .from("tenant_chat_config")
    .select("branding")
    .eq("company_id", input.companyId)
    .maybeSingle()
  const branding = (cfg?.branding ?? {}) as Record<string, unknown>
  const creditorName =
    (typeof branding.brand_name === "string" && branding.brand_name) || company?.name || "Credor"

  const { data: debts } = await supabase
    .from("debts")
    .select("id, amount, due_date")
    .eq("company_id", input.companyId)
    .in("id", input.debtIds)
  const updatedValue = (debts ?? []).reduce(
    (s, d) => s + Number(d.amount ?? 0),
    0,
  )

  const { data: customer } = await supabase
    .from("customers")
    .select("name, document")
    .eq("id", input.customerId)
    .maybeSingle()
  const firstName = firstNameOf(customer?.name)
  const doc = (customer?.document ?? "").replace(/\D/g, "")
  const { data: invoices } = await supabase
    .from("vmax_invoices")
    .select("vencimento")
    .eq("id_company", input.companyId)
    .eq("doc", doc)
    .order("vencimento", { ascending: true })
  const oldestInvoiceDue = invoices?.[0]?.vencimento ?? null
  const oldestDebtDue = (debts ?? []).map((d) => d.due_date).filter(Boolean).sort()[0] ?? null

  return {
    firstName,
    creditorName,
    updatedValue,
    invoiceCount: invoices?.length ?? (debts?.length ?? 0),
    oldestDueDate: oldestInvoiceDue ?? oldestDebtDue,
  }
}

/** Botões do reconhecimento: [1]=Sim, [0]=Não (+[99] se show_handoff_button). */
export function acknowledgementButtons(showHandoff: boolean): Button[] {
  const buttons: Button[] = [
    { id: BTN_YES, label: "Sim, reconheço" },
    { id: BTN_NO, label: "Não reconheço" },
  ]
  if (showHandoff) buttons.push({ id: BTN_HANDOFF, label: "Falar com atendente" })
  return buttons
}

/**
 * Texto do prompt de reconhecimento — mensagem ÚNICA (saudação + resumo +
 * pergunta). Sem contagem de faturas. Se firstName vazio, cai no genérico.
 */
export function acknowledgementQuestion(ctx: AckContext): string {
  const greeting = ctx.firstName ? `Olá, ${ctx.firstName}!` : "Olá!"
  return (
    `${greeting} Temos uma dívida em seu nome da empresa ${ctx.creditorName}. ` +
    `Valor atualizado ${BRL(ctx.updatedValue)}, ` +
    `vencimento mais antigo em ${formatDatePt(ctx.oldestDueDate)}. ` +
    `Você reconhece esta cobrança em seu nome?`
  )
}

// --- fluxo Consultar/Negociar (prompt inicial pedido pelo dono) -------------
//
// O 1º prompt da sessão deixa de ser Sim/Não isolado: passa a oferecer DOIS
// botões — "Consultar Dívida" [2] e "Negociar Dívida" [3]:
//   - Consultar → mostra o resumo da dívida como MENSAGEM e reabre o menu com
//     "Negociar Dívida" [3] + "Não reconheço a dívida" [0];
//   - Negociar  → mostra o resumo E inicia a negociação no n8n (reconhecimento
//     "Sim" + negotiation.start); fallback assistido se o n8n não responder;
//   - Não reconheço [0] → contestação (registra dispute), como antes.
// Ambos os prompts usam o kind 'debt_consult' (a rota /api/chat/button conduz).

/** Botões do prompt inicial: [2] Consultar, [3] Negociar (+[99] se handoff). */
export function consultNegotiateButtons(showHandoff: boolean): Button[] {
  const buttons: Button[] = [
    { id: BTN_CONSULT, label: "Consultar Dívida" },
    { id: BTN_NEGOTIATE, label: "Negociar Dívida" },
  ]
  if (showHandoff) buttons.push({ id: BTN_HANDOFF, label: "Falar com atendente" })
  return buttons
}

/**
 * Botões do menu APÓS consultar: [3] Negociar Dívida + [0] Não reconheço a
 * dívida (+[99] se handoff). É o passo que o dono pediu — depois de ver os
 * dados, o devedor pode negociar ou contestar.
 */
export function postConsultButtons(showHandoff: boolean): Button[] {
  const buttons: Button[] = [
    { id: BTN_NEGOTIATE, label: "Negociar Dívida" },
    { id: BTN_NO, label: "Não reconheço a dívida" },
  ]
  if (showHandoff) buttons.push({ id: BTN_HANDOFF, label: "Falar com atendente" })
  return buttons
}

/**
 * Saudação + convite (mensagem/pergunta do prompt inicial Consultar/Negociar).
 * Sem valor/vencimento aqui — o resumo detalhado sai só ao Consultar/Negociar
 * (na mensagem `debtInfoMessage`), evitando repetir os números duas vezes.
 */
export function consultNegotiateQuestion(ctx: AckContext): string {
  const greeting = ctx.firstName ? `Olá, ${ctx.firstName}!` : "Olá!"
  return (
    `${greeting} Temos uma dívida em seu nome da empresa ${ctx.creditorName}. ` +
    `O que você deseja fazer?`
  )
}

/** Pergunta do menu pós-consulta (após mostrar os dados da dívida). */
export function postConsultQuestion(): string {
  return "Como deseja seguir?"
}

/**
 * Resumo detalhado da dívida exibido como MENSAGEM do assistente ao Consultar/
 * Negociar: valor atualizado, vencimento mais antigo e nº de faturas. Sem PII
 * (nada de documento) — só os dados financeiros que o devedor pode ver.
 */
export function debtInfoMessage(ctx: AckContext): string {
  const invoiceLine =
    ctx.invoiceCount > 0
      ? ` em ${ctx.invoiceCount} fatura(s)`
      : ""
  return (
    `Aqui estão os dados da sua dívida com a ${ctx.creditorName}: ` +
    `valor atualizado ${BRL(ctx.updatedValue)}${invoiceLine}, ` +
    `vencimento mais antigo em ${formatDatePt(ctx.oldestDueDate)}.`
  )
}

// --- dívida quitada (cliente já pagou) --------------------------------------
//
// Quando o cliente autentica e NÃO tem dívida aberta, mas TEM dívida(s) paga(s),
// não há o que reconhecer/negociar. Em vez do prompt Sim/Não, empurramos uma
// MENSAGEM informativa (role='assistant') como 1ª mensagem do chat — o mesmo
// mecanismo (`chat_messages`) que a UI já renderiza, sem botões.

export interface SettledContext {
  firstName: string
  creditorName: string
  totalPaid: number // reais
  oldestDueDate: string | null // vencimento mais antigo entre as pagas
  paidAt: string | null // data de pagamento mais recente (ISO)
}

/**
 * Ação de LINK EXTERNO anexada à mensagem de quitação: abre o formulário de
 * contato da home (#contato) com o campo "Sou" já em "Recebi uma cobrança"
 * (a home lê ?tipo=recebi_cobranca e pré-seleciona). Só um botão-link (<a>),
 * sem POST — a UI (chat.tsx) renderiza abaixo da bolha. Segue a convenção da
 * home: query ANTES do hash (ex.: /?tipo=publico#contato).
 */
export interface MessageLinkAction {
  type: "external_link"
  label: string
  href: string
}

/** URL do form de contato da home com o "Sou" pré-preenchido "Recebi uma cobrança". */
export function debtSettledContactHref(): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? "https://alteapay.com").replace(/\/+$/, "")
  return `${base}/?tipo=recebi_cobranca#contato`
}

/** Ação de contato mostrada na mensagem de quitação (botão-link externo). */
export function debtSettledContactAction(): MessageLinkAction {
  return {
    type: "external_link",
    label: "Recebi uma cobrança — falar com atendimento",
    href: debtSettledContactHref(),
  }
}

/**
 * Texto informativo de quitação (pt-BR). Sem botões de reconhecimento. Se a data
 * de pagamento for desconhecida, omite o "em {data}" e mantém o "consta como paga".
 */
export function settledMessage(ctx: SettledContext): string {
  const greeting = ctx.firstName ? `Olá, ${ctx.firstName}!` : "Olá!"
  const paidWhen = ctx.paidAt ? ` em ${formatDatePt(ctx.paidAt)}` : ""
  const dueWhen = ctx.oldestDueDate ? ` (vencimento ${formatDatePt(ctx.oldestDueDate)})` : ""
  return (
    `${greeting} Verificamos aqui: sua dívida com a ${ctx.creditorName} ` +
    `no valor de ${BRL(ctx.totalPaid)}${dueWhen} consta como PAGA${paidWhen} e está quitada. ` +
    `Obrigado! Se precisar de algo, fale com o nosso atendimento.`
  )
}

/**
 * Monta o contexto de quitação: nome do cliente + credor (branding › company) +
 * total pago + vencimento mais antigo + data de pagamento. Reaproveita a mesma
 * fonte de credor do reconhecimento.
 */
export async function buildSettledContext(input: {
  companyId: string
  customerId: string
  totalPaid: number
  oldestDueDate: string | null
  paidAt: string | null
}): Promise<SettledContext> {
  const supabase = createServiceClient()
  const { data: company } = await supabase
    .from("companies")
    .select("name")
    .eq("id", input.companyId)
    .maybeSingle()
  const { data: cfg } = await supabase
    .from("tenant_chat_config")
    .select("branding")
    .eq("company_id", input.companyId)
    .maybeSingle()
  const branding = (cfg?.branding ?? {}) as Record<string, unknown>
  const creditorName =
    (typeof branding.brand_name === "string" && branding.brand_name) || company?.name || "Credor"
  const { data: customer } = await supabase
    .from("customers")
    .select("name")
    .eq("id", input.customerId)
    .maybeSingle()
  return {
    firstName: firstNameOf(customer?.name),
    creditorName,
    totalPaid: input.totalPaid,
    oldestDueDate: input.oldestDueDate,
    paidAt: input.paidAt,
  }
}

export type BootstrapSettledResult =
  | { ok: true; created: false; reason: "already_present" }
  | { ok: true; created: true; messageId: string }
  | { ok: false; error: string }

/**
 * Publica a mensagem informativa de quitação como 1ª mensagem da sessão. Grava
 * uma linha em `chat_messages` (role='assistant') — o mesmo caminho que a UI
 * (`components/journey/chat.tsx`) já lê via /api/chat/messages. Idempotente: não
 * duplica se já houver uma mensagem 'assistant' na sessão.
 */
export async function bootstrapSettledMessage(input: {
  companyId: string
  sessionId: string
  customerId: string
  totalPaid: number
  oldestDueDate: string | null
  paidAt: string | null
}): Promise<BootstrapSettledResult> {
  const supabase = createServiceClient()

  // idempotência: já existe mensagem do assistente na sessão? não recria.
  const { data: existing } = await supabase
    .from("chat_messages")
    .select("id")
    .eq("session_id", input.sessionId)
    .eq("role", "assistant")
    .limit(1)
    .maybeSingle()
  if (existing) return { ok: true, created: false, reason: "already_present" }

  const ctx = await buildSettledContext({
    companyId: input.companyId,
    customerId: input.customerId,
    totalPaid: input.totalPaid,
    oldestDueDate: input.oldestDueDate,
    paidAt: input.paidAt,
  })
  const { data: message, error } = await supabase
    .from("chat_messages")
    .insert({
      company_id: input.companyId,
      session_id: input.sessionId,
      role: "assistant",
      text: settledMessage(ctx),
      engine: "platform",
      // Botão-link externo (Recebi uma cobrança → #contato) anexado à bolha.
      // Reusa a coluna jsonb existente (offers_snapshot) — sem migração — e a
      // rota /api/chat/messages devolve como `action` para a UI renderizar.
      offers_snapshot: { message_action: debtSettledContactAction() },
    })
    .select("id")
    .single()
  if (error || !message) return { ok: false, error: error?.message ?? "settled_message_insert_failed" }

  await recordEvent({
    companyId: input.companyId,
    customerId: input.customerId,
    sessionId: input.sessionId,
    type: "chat.turn.assistant",
    actor: "system",
    payload: { message_id: message.id, kind: "debt_settled" },
  })
  return { ok: true, created: true, messageId: message.id }
}

/**
 * Bootstrap tolerante a falhas da mensagem de quitação (análogo a bootstrapAckSafe).
 * Só roda com CHAT_JOURNEY_ENABLED=true e NUNCA lança — uma falha aqui não pode
 * derrubar a autenticação (o cliente entra no chat de qualquer forma).
 */
export async function bootstrapSettledSafe(input: {
  companyId: string
  sessionId: string
  customerId: string
  totalPaid: number
  oldestDueDate: string | null
  paidAt: string | null
}): Promise<void> {
  if (process.env.CHAT_JOURNEY_ENABLED !== "true") return
  try {
    await bootstrapSettledMessage(input)
  } catch (err) {
    console.warn("[journey] bootstrap quitação falhou:", (err as Error).message)
  }
}

export type BootstrapAckResult =
  | { ok: true; created: false; reason: "disabled" | "already_active" }
  | { ok: true; created: true; prompt: PromptRow }
  | { ok: false; error: string }

/**
 * Cria o prompt INICIAL da sessão — Consultar/Negociar (fluxo pedido pelo dono).
 * Idempotente na RE-ENTRADA: só evita recriar quando já há um prompt ATIVO da
 * jornada (debt_consult/debt_acknowledgement) na sessão.
 *
 * BUG corrigido (histórico/dead-state): antes, bastar existir QUALQUER
 * reconhecimento anterior ('Sim, reconheço') para o bootstrap devolver
 * 'already_answered' e NÃO recriar prompt — a sessão reaberta ficava sem prompt
 * ativo (menu morto), o devedor via só o clique antigo e não conseguia
 * continuar. Agora, com um reconhecimento passado mas SEM prompt ativo, o
 * bootstrap reabre o menu Consultar/Negociar para o devedor seguir. O histórico
 * completo (persistido em chat_messages) continua carregando normalmente.
 *
 * Respeita acknowledgement_enabled (default true).
 */
export async function bootstrapAcknowledgementPrompt(input: {
  companyId: string
  sessionId: string
  customerId: string
  debtIds: string[]
  primaryDebtId: string
}): Promise<BootstrapAckResult> {
  const supabase = createServiceClient()
  const { data: cfg } = await supabase
    .from("tenant_chat_config")
    .select("acknowledgement_enabled, show_handoff_button")
    .eq("company_id", input.companyId)
    .maybeSingle()
  if (cfg?.acknowledgement_enabled === false) {
    return { ok: true, created: false, reason: "disabled" }
  }

  // idempotência: já existe um prompt ATIVO da jornada (Consultar/Negociar ou o
  // reconhecimento legado)? Não recria — devolve o ativo. NÃO barramos mais por
  // reconhecimento passado (esse era o bug do menu morto): sem prompt ativo, o
  // menu é reaberto ainda que já tenha havido um "Sim/Não" antes.
  const { data: existing } = await supabase
    .from("chat_prompts")
    .select("*")
    .eq("session_id", input.sessionId)
    .in("kind", ["debt_consult", "debt_acknowledgement"])
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (existing) {
    return { ok: true, created: true, prompt: existing as PromptRow }
  }

  const ackCtx = await buildAckContext({
    companyId: input.companyId,
    customerId: input.customerId,
    debtIds: input.debtIds,
  })
  const question = consultNegotiateQuestion(ackCtx)
  const created = await createPrompt({
    companyId: input.companyId,
    sessionId: input.sessionId,
    kind: "debt_consult",
    question,
    buttons: consultNegotiateButtons(cfg?.show_handoff_button === true),
    context: {
      creditor_name: ackCtx.creditorName,
      updated_value: ackCtx.updatedValue,
      invoice_count: ackCtx.invoiceCount,
      oldest_due_date: ackCtx.oldestDueDate,
      primary_debt_id: input.primaryDebtId,
      // debt_ids consolida o valor no Consultar/Negociar (buildAckContext soma
      // todos). Sem isso, a rota cai no debt primário só.
      debt_ids: input.debtIds,
    },
    createdBy: "platform",
  })
  if (!created.ok) return { ok: false, error: created.error }

  // Persiste a PERGUNTA (saudação + convite Consultar/Negociar) como
  // chat_messages(role='assistant'), ligada ao prompt via prompt_id. Enquanto o
  // prompt está 'active' a UI a mostra no bloco de botões; depois de respondido,
  // este registro mantém a pergunta no histórico — sem ele, uma sessão reaberta
  // só traria o clique do cliente.
  await persistAssistantMessage({
    companyId: input.companyId,
    sessionId: input.sessionId,
    text: question,
    promptId: created.prompt.id,
  })

  return { ok: true, created: true, prompt: created.prompt }
}

/**
 * Grava uma mensagem do assistente em chat_messages (engine='platform', fluxo
 * assistido). Reusa o mesmo caminho que /api/chat/messages lê. Idempotente por
 * `prompt_id` quando informado (a pergunta do reconhecimento é gravada uma única
 * vez, mesmo que o bootstrap rode de novo). O texto já é neutro/sem PII (o resumo
 * do reconhecimento não expõe documento). NUNCA lança — uma falha aqui não pode
 * derrubar a criação do prompt nem o processamento do clique.
 */
export async function persistAssistantMessage(input: {
  companyId: string
  sessionId: string
  text: string
  promptId?: string | null
}): Promise<string | null> {
  const text = (input.text ?? "").trim()
  if (!text) return null
  const supabase = createServiceClient()
  try {
    // idempotência: a pergunta de um prompt é gravada uma única vez.
    if (input.promptId) {
      const { data: existing } = await supabase
        .from("chat_messages")
        .select("id")
        .eq("session_id", input.sessionId)
        .eq("prompt_id", input.promptId)
        .eq("role", "assistant")
        .limit(1)
        .maybeSingle()
      if (existing) return (existing as { id: string }).id
    }
    const { data } = await supabase
      .from("chat_messages")
      .insert({
        company_id: input.companyId,
        session_id: input.sessionId,
        role: "assistant",
        text,
        engine: "platform",
        prompt_id: input.promptId ?? null,
      })
      .select("id")
      .single()
    return (data as { id: string } | null)?.id ?? null
  } catch (err) {
    console.warn("[journey] persistAssistantMessage falhou:", (err as Error).message)
    return null
  }
}

/**
 * Bootstrap tolerante a falhas para chamar na criação da sessão (auth). Só roda
 * com CHAT_JOURNEY_ENABLED=true (comportamento de prod idêntico com a flag OFF)
 * e NUNCA lança — uma falha no reconhecimento não pode derrubar a autenticação.
 */
export async function bootstrapAckSafe(input: {
  companyId: string
  sessionId: string
  customerId: string
  debtIds: string[]
  primaryDebtId: string | null
}): Promise<void> {
  if (process.env.CHAT_JOURNEY_ENABLED !== "true") return
  if (!input.primaryDebtId || input.debtIds.length === 0) return
  try {
    await bootstrapAcknowledgementPrompt({
      companyId: input.companyId,
      sessionId: input.sessionId,
      customerId: input.customerId,
      debtIds: input.debtIds,
      primaryDebtId: input.primaryDebtId,
    })
  } catch (err) {
    console.warn("[journey] bootstrap reconhecimento falhou:", (err as Error).message)
  }
}

export interface AckLatest {
  id: string
  session_id: string
  debt_id: string
  acknowledged: boolean
  button_id: number
  created_at: string
}

/** Última resposta de reconhecimento por (session, debt) via view. */
export async function getLatestAcknowledgement(
  sessionId: string,
  debtId: string,
): Promise<AckLatest | null> {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from("debt_acknowledgement_latest")
    .select("id, session_id, debt_id, acknowledged, button_id, created_at")
    .eq("session_id", sessionId)
    .eq("debt_id", debtId)
    .maybeSingle()
  return (data as AckLatest) ?? null
}

export type RecordAckResult =
  | { ok: true; acknowledged: boolean; buttonId: number; onNotRecognized?: "continue" | "dispute" | "human" }
  | { ok: false; status: number; code: string }

/**
 * Grava os 3 efeitos append-only do reconhecimento (append-log + journey_event +
 * espelho da sessão). Factored-out para ser reusado pelo reconhecimento legado
 * (recordAcknowledgement) E pelo fluxo Consultar/Negociar (o prompt já foi
 * respondido pela rota via answerPrompt). NÃO responde o prompt — quem chama
 * decide quando marcar answered. `source` distingue a origem no append-log.
 */
export async function persistDebtRecognition(input: {
  companyId: string
  sessionId: string
  customerId: string
  debtId: string
  promptId: string
  buttonId: number
  acknowledged: boolean
  source: string
  ip?: string | null
  userAgent?: string | null
}): Promise<void> {
  const supabase = createServiceClient()
  const ipHash = input.ip
    ? createHash("sha256").update(input.ip).digest("hex").slice(0, 32)
    : null

  // 1) append-only debt_acknowledgements. O supabase-js NÃO lança em violação de
  //    constraint (retorna {error}) — checamos explicitamente para NUNCA descartar
  //    o reconhecimento em silêncio. Bug histórico: o CHECK(button_id in (0,1))
  //    rejeitava o button_id=3 (Negociar) e a linha sumia sem trace, quebrando o
  //    debt_acknowledgement_latest/o guard de pagamento. A migration
  //    20260932_debt_ack_button_id_relax.sql relaxa o CHECK para (0,1,2,3); aqui
  //    lançamos o erro para o chamador (rota) resolver como 500 auditável em vez
  //    de seguir com um reconhecimento fantasma.
  const { error: ackInsertError } = await supabase.from("debt_acknowledgements").insert({
    company_id: input.companyId,
    session_id: input.sessionId,
    customer_id: input.customerId,
    debt_id: input.debtId,
    prompt_id: input.promptId,
    acknowledged: input.acknowledged,
    button_id: input.buttonId,
    source: input.source,
    ip_hash: ipHash,
    user_agent: input.userAgent ?? null,
  })
  if (ackInsertError) {
    throw new Error(`debt_acknowledgements insert falhou: ${ackInsertError.message}`)
  }

  // 2) journey_events (debt.acknowledged | debt.not_recognized)
  await recordEvent({
    companyId: input.companyId,
    customerId: input.customerId,
    debtId: input.debtId,
    sessionId: input.sessionId,
    type: input.acknowledged ? "debt.acknowledged" : "debt.not_recognized",
    actor: "customer",
    payload: { button_id: input.buttonId, prompt_id: input.promptId },
  })

  // 3) espelho do timestamp na sessão (só quando reconhece)
  if (input.acknowledged) {
    await supabase
      .from("negotiation_sessions")
      .update({ debt_acknowledged_at: new Date().toISOString() })
      .eq("id", input.sessionId)
  }
}

/** Comportamento do tenant no "Não reconheço" (default continue). */
async function onNotRecognizedBehavior(companyId: string): Promise<"continue" | "dispute" | "human"> {
  const supabase = createServiceClient()
  const { data: cfg } = await supabase
    .from("tenant_chat_config")
    .select("on_debt_not_recognized")
    .eq("company_id", companyId)
    .maybeSingle()
  return (cfg?.on_debt_not_recognized ?? "continue") as "continue" | "dispute" | "human"
}

/**
 * Registra a resposta de reconhecimento a partir de um clique num prompt
 * debt_acknowledgement. Grava os 4 efeitos numa transação lógica. Trata o
 * botão [99] (atendente) como handoff — não é 0 nem 1, então NÃO grava
 * debt_acknowledgements; devolve onNotRecognized='human'.
 */
export async function recordAcknowledgement(input: {
  companyId: string
  sessionId: string
  customerId: string
  debtId: string
  promptId: string
  buttonId: number
  ip?: string | null
  userAgent?: string | null
}): Promise<RecordAckResult> {
  // 1) responde o prompt (valida integridade + grava a mensagem do cliente)
  const answered = await answerPrompt({
    sessionId: input.sessionId,
    companyId: input.companyId,
    promptId: input.promptId,
    buttonId: input.buttonId,
  })
  if (!answered.ok) return { ok: false, status: answered.status, code: answered.code }

  // botão de handoff [99]: não é reconhecimento — o chamador conduz o transfer.
  if (input.buttonId === BTN_HANDOFF) {
    return { ok: true, acknowledged: false, buttonId: BTN_HANDOFF, onNotRecognized: "human" }
  }

  const acknowledged = input.buttonId === BTN_YES // 1 = reconhece; 0 = não
  await persistDebtRecognition({
    companyId: input.companyId,
    sessionId: input.sessionId,
    customerId: input.customerId,
    debtId: input.debtId,
    promptId: input.promptId,
    buttonId: input.buttonId,
    acknowledged,
    source: "chat_button",
    ip: input.ip,
    userAgent: input.userAgent,
  })

  if (!acknowledged) {
    const behavior = await onNotRecognizedBehavior(input.companyId)
    return { ok: true, acknowledged: false, buttonId: input.buttonId, onNotRecognized: behavior }
  }

  return { ok: true, acknowledged: true, buttonId: input.buttonId }
}

export type StartN8nResult =
  | { ok: true; owner: "n8n"; delivered: boolean }
  | { ok: true; owner: "platform"; delivered: false } // fallback assistido (H8)

/**
 * Dispara o negotiation.start ao n8n em BACKGROUND (best-effort, fora do caminho
 * crítico do clique) e grava a auditoria do desfecho quando ele resolver. NUNCA
 * é aguardado pelo caminho da resposta ao cliente: o fetch ao webhook n8n pode
 * levar até N8N_FLOW_TIMEOUT_MS (~60s) e a rota tem maxDuration=60 — aguardar aqui
 * estourava o budget e deixava o botão "..." pendurado (Netlify matava a função
 * antes de responder). Ao rodar solto, o clique responde em <2s e o handoff n8n
 * segue por trás; se ele entregar, o engine_owner vira 'n8n' e os PRÓXIMOS turnos
 * vão ao fluxo (a resposta DESTE clique já foi persistida localmente pelo
 * chamador — o histórico nunca depende do n8n). NUNCA lança.
 */
async function dispatchNegotiationStartInBackground(input: {
  companyId: string
  sessionId: string
  customerId: string
  debtId: string
  eventId: string
}): Promise<void> {
  try {
    const { emitNegotiationStart } = await import("@/lib/negotiation/engine")
    const emit = await emitNegotiationStart(input.sessionId, input.eventId)
    const delivered = emit.ok === true && "delivered" in emit && emit.delivered === true

    const supabase = createServiceClient()
    // Só promove o dono a n8n quando o disparo foi de fato ENTREGUE. Sem entrega
    // (n8n não plugado/timeout/5xx) a sessão permanece no assistido (platform).
    if (delivered) {
      await supabase
        .from("negotiation_sessions")
        .update({ engine_owner: "n8n", updated_at: new Date().toISOString() })
        .eq("id", input.sessionId)
    }

    await recordEvent({
      companyId: input.companyId,
      customerId: input.customerId,
      debtId: input.debtId,
      sessionId: input.sessionId,
      // O funil não tem estágio próprio para negotiation.start; usamos um evento de
      // timeline (chat.turn.assistant marca a transição de dono do engine na
      // auditoria, com um payload explícito). engine_unavailable idem, no fallback.
      type: "chat.turn.assistant",
      actor: delivered ? "n8n" : "system",
      eventId: delivered ? `neg_start:${input.eventId}` : `neg_start_unavailable:${input.eventId}`,
      payload: delivered
        ? { event: "negotiation.start", engine_owner: "n8n" }
        : { event: "engine_unavailable", engine_owner: "platform", reason: "reason" in emit ? emit.reason : "unknown" },
    })
  } catch (err) {
    // Best-effort: uma falha no handoff em background jamais afeta o clique já
    // respondido. Só loga um rótulo curto (sem URL/segredo/PII).
    console.warn("[journey] negotiation.start (background) falhou:", (err as Error).message)
  }
}

/**
 * H7: handoff ao n8n no reconhecimento "Sim"/Negociar. Efeitos:
 *   1) DISPARA negotiation.start ao n8n em BACKGROUND (best-effort — ver
 *      dispatchNegotiationStartInBackground). O fetch ao webhook n8n NÃO é
 *      aguardado: manter o clique instantâneo é a garantia de vivacidade do botão.
 *   2) a auditoria (engine_owner + journey_event) é gravada pelo background
 *      quando o disparo resolve.
 *
 * RESILIENTE (H8): SEMPRE retorna owner='platform' SÍNCRONO — a resposta DESTE
 * clique é persistida localmente pelo chamador (o histórico nunca depende do
 * n8n). Se o n8n entregar por trás, os PRÓXIMOS turnos vão ao fluxo. NUNCA lança.
 *
 * `waitForDispatch` (default false) permite ao teste aguardar o background de
 * forma determinística; em produção o caminho crítico nunca o aguarda.
 */
export async function startN8nNegotiation(input: {
  companyId: string
  sessionId: string
  customerId: string
  debtId: string
  waitForDispatch?: boolean
}): Promise<StartN8nResult> {
  const eventId = randomUUID()

  const dispatch = dispatchNegotiationStartInBackground({
    companyId: input.companyId,
    sessionId: input.sessionId,
    customerId: input.customerId,
    debtId: input.debtId,
    eventId,
  })
  // fire-and-forget: NÃO await no caminho crítico. `void` marca o descarte
  // proposital da Promise; o rejection já é engolido dentro do dispatch.
  if (input.waitForDispatch) {
    await dispatch
  } else {
    void dispatch
  }

  // Owner SÍNCRONO = platform: o clique responde já e o reply é sempre
  // persistido. A promoção a 'n8n' (se entregar) acontece no background.
  return { ok: true, owner: "platform", delivered: false }
}

// --- orquestração do fluxo Consultar/Negociar (rota /api/chat/button) --------
//
// As funções abaixo são chamadas pela rota DEPOIS de answerPrompt (que já marcou
// o prompt debt_consult como answered e gravou o clique do cliente). Elas
// publicam a MENSAGEM de dados da dívida e conduzem o próximo passo, sempre
// persistindo em chat_messages para o histórico da re-entrada.

/** Lê show_handoff_button do tenant (default false). */
async function showHandoff(companyId: string): Promise<boolean> {
  const supabase = createServiceClient()
  const { data: cfg } = await supabase
    .from("tenant_chat_config")
    .select("show_handoff_button")
    .eq("company_id", companyId)
    .maybeSingle()
  return cfg?.show_handoff_button === true
}

/**
 * "Consultar Dívida" [2]: publica os DADOS da dívida como mensagem do assistente
 * e reabre o menu (Negociar Dívida [3] + Não reconheço [0]). NÃO inicia o n8n
 * nem registra reconhecimento — só mostra e devolve o controle ao devedor.
 */
export async function handleDebtConsult(input: {
  companyId: string
  sessionId: string
  customerId: string
  debtId: string
  debtIds: string[]
  primaryDebtId: string
}): Promise<{ ok: true; reply: string }> {
  const ackCtx = await buildAckContext({
    companyId: input.companyId,
    customerId: input.customerId,
    debtIds: input.debtIds,
  })
  const info = debtInfoMessage(ackCtx)
  await persistAssistantMessage({
    companyId: input.companyId,
    sessionId: input.sessionId,
    text: info,
  })

  // reabre o menu pós-consulta (Negociar / Não reconheço). A pergunta também é
  // persistida como mensagem (ligada ao prompt) para o histórico da re-entrada.
  const handoff = await showHandoff(input.companyId)
  const question = postConsultQuestion()
  const created = await createPrompt({
    companyId: input.companyId,
    sessionId: input.sessionId,
    kind: "debt_consult",
    question,
    buttons: postConsultButtons(handoff),
    context: {
      creditor_name: ackCtx.creditorName,
      updated_value: ackCtx.updatedValue,
      invoice_count: ackCtx.invoiceCount,
      oldest_due_date: ackCtx.oldestDueDate,
      primary_debt_id: input.primaryDebtId,
      debt_ids: input.debtIds,
      stage: "post_consult",
    },
    createdBy: "platform",
  })
  if (created.ok) {
    await persistAssistantMessage({
      companyId: input.companyId,
      sessionId: input.sessionId,
      text: question,
      promptId: created.prompt.id,
    })
  }
  return { ok: true, reply: info }
}

/**
 * "Negociar Dívida" [3]: mostra os dados da dívida, registra o reconhecimento
 * ("Sim") a partir do prompt debt_consult e INICIA a negociação no n8n
 * (engine_owner='n8n' + negotiation.start). RESILIENTE (H8): se o n8n não
 * responder, mantém o assistido e persiste o reply — o cliente nunca vê erro.
 */
export async function handleDebtNegotiate(input: {
  companyId: string
  sessionId: string
  customerId: string
  debtId: string
  debtIds: string[]
  promptId: string
  buttonId: number
  ip?: string | null
  userAgent?: string | null
}): Promise<{ ok: true; engineOwner: "platform" | "n8n"; reply: string }> {
  const ackCtx = await buildAckContext({
    companyId: input.companyId,
    customerId: input.customerId,
    debtIds: input.debtIds,
  })
  await persistAssistantMessage({
    companyId: input.companyId,
    sessionId: input.sessionId,
    text: debtInfoMessage(ackCtx),
  })

  // Reconhecimento implícito ao Negociar: o devedor quer negociar → reconhece a
  // dívida. Grava os efeitos append-only (o prompt já foi respondido pela rota).
  await persistDebtRecognition({
    companyId: input.companyId,
    sessionId: input.sessionId,
    customerId: input.customerId,
    debtId: input.debtId,
    promptId: input.promptId,
    buttonId: input.buttonId,
    acknowledged: true,
    source: "chat_button_negotiate",
    ip: input.ip,
    userAgent: input.userAgent,
  })

  // Kickoff n8n (best-effort, fire-and-forget): dispara negotiation.start em
  // BACKGROUND — NÃO bloqueia a resposta ao clique (ver startN8nNegotiation). O
  // owner síncrono é sempre 'platform'; a promoção a 'n8n' (se entregar) acontece
  // por trás e vale para os PRÓXIMOS turnos.
  let engineOwner: "platform" | "n8n" = "platform"
  try {
    const start = await startN8nNegotiation({
      companyId: input.companyId,
      sessionId: input.sessionId,
      customerId: input.customerId,
      debtId: input.debtId,
    })
    engineOwner = start.owner
  } catch (err) {
    console.warn("[journey] negotiation.start falhou (fallback assistido):", (err as Error).message)
  }

  const reply = "Perfeito! Então vamos trabalhar juntos para sanar o seu débito."
  // SEMPRE persiste o reply localmente (bug histórico: condicionar a
  // engineOwner==='platform' deixava o lado do assistente VAZIO no banco quando o
  // n8n era assumido dono mas NÃO devolvia/empurrava nada — a sessão reaberta só
  // trazia a pergunta + o clique). Como o handoff n8n agora é best-effort/em
  // background e a entrega não é garantida (papel B não confirmado no clique), o
  // histórico não pode depender dele: gravamos o reply aqui, incondicionalmente.
  await persistAssistantMessage({
    companyId: input.companyId,
    sessionId: input.sessionId,
    text: reply,
  })
  return { ok: true, engineOwner, reply }
}

/**
 * "Não reconheço a dívida" [0]: registra o não-reconhecimento a partir do prompt
 * debt_consult, aplica on_debt_not_recognized (continue|dispute|human) e devolve
 * o reply direcionando ao credor. O prompt já foi respondido pela rota.
 */
export async function handleDebtNotRecognized(input: {
  companyId: string
  sessionId: string
  customerId: string
  debtId: string
  promptId: string
  buttonId: number
  ip?: string | null
  userAgent?: string | null
}): Promise<{ ok: true; onNotRecognized: "continue" | "dispute" | "human" }> {
  await persistDebtRecognition({
    companyId: input.companyId,
    sessionId: input.sessionId,
    customerId: input.customerId,
    debtId: input.debtId,
    promptId: input.promptId,
    buttonId: input.buttonId,
    acknowledged: false,
    source: "chat_button_consult",
    ip: input.ip,
    userAgent: input.userAgent,
  })
  const onNotRecognized = await onNotRecognizedBehavior(input.companyId)
  return { ok: true, onNotRecognized }
}

export type AckGuard =
  | { ok: true }
  | { ok: false; code: "debt_not_acknowledged" }

/**
 * Invariante do payment.create (§3): com acknowledged=false (ou sem resposta),
 * recusa a menos que allow_payment_without_acknowledgement=true.
 * Retorna ok quando pode cobrar.
 */
export async function assertAcknowledgedForPayment(input: {
  companyId: string
  sessionId: string
  debtId: string
}): Promise<AckGuard> {
  const supabase = createServiceClient()
  const { data: cfg } = await supabase
    .from("tenant_chat_config")
    .select("allow_payment_without_acknowledgement, acknowledgement_enabled")
    .eq("company_id", input.companyId)
    .maybeSingle()
  // exceção explícita por tenant
  if (cfg?.allow_payment_without_acknowledgement === true) return { ok: true }
  // reconhecimento desligado no tenant → não bloqueia (nada a reconhecer)
  if (cfg?.acknowledgement_enabled === false) return { ok: true }

  const latest = await getLatestAcknowledgement(input.sessionId, input.debtId)
  if (latest?.acknowledged === true) return { ok: true }
  return { ok: false, code: "debt_not_acknowledged" }
}
