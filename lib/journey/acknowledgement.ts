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
import { BTN_HANDOFF, BTN_NO, BTN_YES, type Button } from "./buttons"
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
  creditorName: string
  updatedValue: number // reais (a UI/n8n formata; cents só na borda n8n)
  invoiceCount: number
  oldestDueDate: string | null
}

/** Resumo objetivo da dívida (credor, valor atualizado, N faturas, vencimento). */
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
    .select("id, amount, current_amount, due_date")
    .eq("company_id", input.companyId)
    .in("id", input.debtIds)
  const updatedValue = (debts ?? []).reduce(
    (s, d) => s + Number(d.current_amount ?? d.amount ?? 0),
    0,
  )

  const { data: customer } = await supabase
    .from("customers")
    .select("document")
    .eq("id", input.customerId)
    .maybeSingle()
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

/** Texto aprovado (GATE R0) do prompt de reconhecimento. */
export function acknowledgementQuestion(ctx: AckContext): string {
  return (
    `${ctx.creditorName} · valor atualizado ${BRL(ctx.updatedValue)}, ` +
    `${ctx.invoiceCount} fatura(s), vencimento mais antigo em ${formatDatePt(ctx.oldestDueDate)}. ` +
    `Antes de começarmos: você reconhece esta cobrança em seu nome?`
  )
}

export type BootstrapAckResult =
  | { ok: true; created: false; reason: "disabled" | "already_answered" }
  | { ok: true; created: true; prompt: PromptRow }
  | { ok: false; error: string }

/**
 * Cria o prompt de reconhecimento como PRIMEIRA interação da sessão. Idempotente:
 * se já houver reconhecimento registrado ou um prompt de reconhecimento aberto,
 * não recria. Respeita acknowledgement_enabled (default true).
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

  // idempotência: já respondeu ou já existe um prompt de reconhecimento ativo?
  const latest = await getLatestAcknowledgement(input.sessionId, input.primaryDebtId)
  if (latest) return { ok: true, created: false, reason: "already_answered" }
  const { data: existing } = await supabase
    .from("chat_prompts")
    .select("id")
    .eq("session_id", input.sessionId)
    .eq("kind", "debt_acknowledgement")
    .eq("status", "active")
    .limit(1)
    .maybeSingle()
  if (existing) {
    const prompt = await supabase
      .from("chat_prompts")
      .select("*")
      .eq("id", existing.id)
      .maybeSingle()
    return { ok: true, created: true, prompt: prompt.data as PromptRow }
  }

  const ackCtx = await buildAckContext({
    companyId: input.companyId,
    customerId: input.customerId,
    debtIds: input.debtIds,
  })
  const created = await createPrompt({
    companyId: input.companyId,
    sessionId: input.sessionId,
    kind: "debt_acknowledgement",
    question: acknowledgementQuestion(ackCtx),
    buttons: acknowledgementButtons(cfg?.show_handoff_button === true),
    context: {
      creditor_name: ackCtx.creditorName,
      updated_value: ackCtx.updatedValue,
      invoice_count: ackCtx.invoiceCount,
      oldest_due_date: ackCtx.oldestDueDate,
      primary_debt_id: input.primaryDebtId,
    },
    createdBy: "platform",
  })
  if (!created.ok) return { ok: false, error: created.error }
  return { ok: true, created: true, prompt: created.prompt }
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
  const supabase = createServiceClient()

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
  const ipHash = input.ip
    ? createHash("sha256").update(input.ip).digest("hex").slice(0, 32)
    : null

  // 2) append-only debt_acknowledgements
  await supabase.from("debt_acknowledgements").insert({
    company_id: input.companyId,
    session_id: input.sessionId,
    customer_id: input.customerId,
    debt_id: input.debtId,
    prompt_id: input.promptId,
    acknowledged,
    button_id: input.buttonId,
    source: "chat_button",
    ip_hash: ipHash,
    user_agent: input.userAgent ?? null,
  })

  // 3) journey_events (debt.acknowledged | debt.not_recognized)
  await recordEvent({
    companyId: input.companyId,
    customerId: input.customerId,
    debtId: input.debtId,
    sessionId: input.sessionId,
    type: acknowledged ? "debt.acknowledged" : "debt.not_recognized",
    actor: "customer",
    payload: { button_id: input.buttonId, prompt_id: input.promptId },
  })

  // 4) espelho do timestamp na sessão (só quando reconhece)
  if (acknowledged) {
    await supabase
      .from("negotiation_sessions")
      .update({ debt_acknowledged_at: new Date().toISOString() })
      .eq("id", input.sessionId)
  }

  if (!acknowledged) {
    const { data: cfg } = await supabase
      .from("tenant_chat_config")
      .select("on_debt_not_recognized")
      .eq("company_id", input.companyId)
      .maybeSingle()
    const behavior = (cfg?.on_debt_not_recognized ?? "continue") as "continue" | "dispute" | "human"
    return { ok: true, acknowledged: false, buttonId: input.buttonId, onNotRecognized: behavior }
  }

  return { ok: true, acknowledged: true, buttonId: input.buttonId }
}

export type StartN8nResult =
  | { ok: true; owner: "n8n"; delivered: boolean }
  | { ok: true; owner: "platform"; delivered: false } // fallback assistido (H8)

/**
 * H7: handoff ao n8n no reconhecimento "Sim" (button_id=1). Efeitos:
 *   1) marca negotiation_sessions.engine_owner='n8n' (a partir daí, os turnos
 *      vão ao fluxo);
 *   2) emite negotiation.start ao n8n (Apêndice B, assinado; centavos, doc
 *      mascarado);
 *   3) journey_events: negotiation.start (entregue) OU engine_unavailable
 *      (fallback assistido, H8) — auditoria.
 *
 * RESILIENTE (H8): se o n8n não estiver plugado/o disparo falhar, mantém
 * engine_owner='platform' (assistido) e NUNCA lança — o cliente segue sem ver
 * erro. O contrato negotiation.start é o MESMO nos dois casos.
 */
export async function startN8nNegotiation(input: {
  companyId: string
  sessionId: string
  customerId: string
  debtId: string
}): Promise<StartN8nResult> {
  const supabase = createServiceClient()
  const eventId = randomUUID()

  const { emitNegotiationStart } = await import("@/lib/negotiation/engine")
  const emit = await emitNegotiationStart(input.sessionId, eventId)

  const delivered = emit.ok === true && "delivered" in emit && emit.delivered === true
  const owner: "n8n" | "platform" = delivered ? "n8n" : "platform"

  // Só assume o dono n8n quando o disparo foi entregue. Sem entrega → assistido.
  await supabase
    .from("negotiation_sessions")
    .update({ engine_owner: owner, updated_at: new Date().toISOString() })
    .eq("id", input.sessionId)

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
    eventId: delivered ? `neg_start:${eventId}` : `neg_start_unavailable:${eventId}`,
    payload: delivered
      ? { event: "negotiation.start", engine_owner: "n8n" }
      : { event: "engine_unavailable", engine_owner: "platform", reason: "reason" in emit ? emit.reason : "unknown" },
  })

  return delivered
    ? { ok: true, owner: "n8n", delivered: true }
    : { ok: true, owner: "platform", delivered: false }
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
