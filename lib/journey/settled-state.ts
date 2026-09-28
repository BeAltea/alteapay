// F8-02 — estado de QUITADO numa sessão JÁ ABERTA (retomada, reload, poll e
// cliques de uma página que ficou para trás).
//
// A mensagem de quitação só era montada na AUTENTICAÇÃO (establishSession →
// bootstrapSettledSafe). Quem já estava com o chat aberto quando o webhook
// quitou a dívida continuava vendo o card do valor, o link da parcela, o "Já
// paguei" e o menu de pagar/negociar — e o bootstrap do login também não ajudava
// na sessão REUSADA dentro do TTL (idempotente por "já há mensagem do
// assistente"). Este módulo leva a MESMA experiência do login para esses
// caminhos, reusando as MESMAS peças (buildSettledContext / settledMessage /
// debtSettledContactAction e consolidateSettled do resolver) — nenhuma copy nova.
//
// Critério de quitado (o MESMO do login, resolveByDocument): o cliente não tem
// dívida aberta (pending|in_negotiation) na empresa e tem ao menos uma paga.
// Além do status da dívida, o acordo DESTA sessão quitado (status pago e
// pagamento não estornado/cancelado) conta a sua dívida como paga — o webhook
// grava os dois juntos; isto só cobre a janela entre as duas escritas.
//
// Invariantes: company_id em TODA leitura/escrita; falha de leitura → "não
// quitado" (comportamento de hoje; nunca declara pago por erro); nunca cria
// cobrança; histórico preservado (nada é apagado nem arquivado).

import { createServiceClient } from "@/lib/supabase/service"
import { PAID_AGREEMENT_STATUSES } from "@/lib/constants/payment-status"
import {
  buildSettledContext,
  debtSettledContactAction,
  debtSettledContactHref,
  getCurrentThreadEpoch,
  settledMessage,
} from "./acknowledgement"
import { BTN_HANDOFF, BTN_PAY, findButton } from "./buttons"
import { recordEvent } from "./events"
import type { PromptRow } from "./prompts"
import { consolidateSettled, OPEN_DEBT_STATUSES, PAID_DEBT_STATUSES, type SettledDebtor } from "./resolver"

type Supabase = ReturnType<typeof createServiceClient>

interface DebtRow {
  id: string
  status: string
  amount: number | null
  due_date: string | null
  updated_at: string | null
}

/** payment_status que desfazem a quitação de um acordo (estorno/cancelamento). */
const UNSETTLING_PAYMENT_STATUSES = new Set(["refunded", "deleted", "cancelled"])

/** Acordo quitado: status pago (completed/paid/…) e pagamento não desfeito. */
export function isSettledAgreement(ag: { status?: string | null; payment_status?: string | null }): boolean {
  return (
    (PAID_AGREEMENT_STATUSES as readonly string[]).includes(ag.status ?? "") &&
    !UNSETTLING_PAYMENT_STATUSES.has(ag.payment_status ?? "")
  )
}

/**
 * Quitação do cliente (critério do login). `sessionId` inclui o acordo da sessão
 * quitado. Retorna o MESMO `SettledDebtor` do resolver, ou null (há dívida aberta,
 * nenhuma paga, ou falha de leitura). Nunca lança.
 */
export async function detectCustomerSettlement(input: {
  companyId: string
  customerId: string
  sessionId?: string | null
}): Promise<SettledDebtor | null> {
  try {
    const supabase = createServiceClient()
    const [debtsRes, agRes] = await Promise.all([
      supabase
        .from("debts")
        .select("id, status, amount, due_date, updated_at")
        .eq("company_id", input.companyId)
        .eq("customer_id", input.customerId)
        .in("status", [...OPEN_DEBT_STATUSES, ...PAID_DEBT_STATUSES] as unknown as string[])
        .order("due_date", { ascending: true }),
      input.sessionId
        ? supabase
            .from("agreements")
            .select("debt_id, status, payment_status")
            .eq("company_id", input.companyId)
            .eq("negotiation_session_id", input.sessionId)
            .in("status", PAID_AGREEMENT_STATUSES as unknown as string[])
        : Promise.resolve({ data: [], error: null }),
    ])
    if (debtsRes.error || agRes.error) return null
    const settledDebtIds = new Set(
      ((agRes.data ?? []) as Array<{ debt_id: string | null; status: string | null; payment_status: string | null }>)
        .filter(isSettledAgreement)
        .map((a) => a.debt_id)
        .filter((id): id is string => typeof id === "string"),
    )
    const rows = (debtsRes.data ?? []) as DebtRow[]
    const isPaid = (d: DebtRow) => (PAID_DEBT_STATUSES as readonly string[]).includes(d.status) || settledDebtIds.has(d.id)
    const paid = rows.filter(isPaid)
    if (paid.length === 0 || paid.length !== rows.length) return null
    return await consolidateSettled(supabase, input.companyId, { id: input.customerId, name: null }, "", paid)
  } catch {
    return null
  }
}

/** Quitação a partir da sessão (sem ctx carregado): lê o customer_id da sessão. */
export async function detectSessionSettlement(input: {
  sessionId: string
  companyId: string
}): Promise<SettledDebtor | null> {
  try {
    const supabase = createServiceClient()
    const { data } = await supabase
      .from("negotiation_sessions")
      .select("customer_id")
      .eq("id", input.sessionId)
      .eq("company_id", input.companyId)
      .maybeSingle()
    const customerId = (data as { customer_id?: string | null } | null)?.customer_id
    if (!customerId) return null
    return await detectCustomerSettlement({ companyId: input.companyId, customerId, sessionId: input.sessionId })
  } catch {
    return null
  }
}

/** A dívida da cobrança já está paga (status, ou o acordo da sessão quitado). Nunca lança. */
export async function isDebtSettled(input: { companyId: string; debtId: string; sessionId: string }): Promise<boolean> {
  try {
    const supabase = createServiceClient()
    const [debtRes, agRes] = await Promise.all([
      supabase.from("debts").select("status").eq("id", input.debtId).eq("company_id", input.companyId).maybeSingle(),
      supabase
        .from("agreements")
        .select("debt_id, status, payment_status")
        .eq("company_id", input.companyId)
        .eq("negotiation_session_id", input.sessionId)
        .eq("debt_id", input.debtId)
        .in("status", PAID_AGREEMENT_STATUSES as unknown as string[]),
    ])
    const status = (debtRes.data as { status?: string | null } | null)?.status ?? ""
    if ((PAID_DEBT_STATUSES as readonly string[]).includes(status)) return true
    return ((agRes.data ?? []) as Array<{ status: string | null; payment_status: string | null }>).some(isSettledAgreement)
  } catch {
    return false
  }
}

/** Linha da mensagem de quitação no shape do GET /api/chat/messages. */
export interface SettledMessageRow {
  id: string
  role: "assistant"
  text: string
  button_id: null
  prompt_id: null
  engine: "platform"
  created_at: string
  action: ReturnType<typeof debtSettledContactAction>
}

interface AssistantRow {
  id: string
  offers_snapshot?: unknown
  thread_epoch?: number | null
  archived_at?: string | null
}

/** A mensagem de quitação é a ÚNICA com o botão-link de contato (#contato). */
function isSettledMessage(row: AssistantRow): boolean {
  const action = (row.offers_snapshot as { message_action?: { type?: unknown; href?: unknown } } | null)?.message_action
  return !!action && action.type === "external_link" && action.href === debtSettledContactHref()
}

/**
 * Aplica o estado de quitado na sessão: aposenta o menu ativo (sem pagar/
 * negociar), limpa a espera persistida e garante a mensagem de quitação do
 * login na thread corrente. Sem `answerKey` (poll/retomada) a mensagem só é
 * gravada se a thread ainda não a tem; com `answerKey` (clique numa página
 * defasada) o clique é auditado (`chat.click_ignored`, 1x por chave) e respondido
 * com a mensagem, salvo se ela já é a última do assistente. Devolve a linha
 * gravada (ou null). Nunca lança.
 */
export async function applySettledView(input: {
  companyId: string
  sessionId: string
  customerId: string
  settlement: SettledDebtor
  answerKey?: string
  buttonId?: number | null
}): Promise<SettledMessageRow | null> {
  try {
    const supabase: Supabase = createServiceClient()
    await Promise.all([
      supabase
        .from("chat_prompts")
        .update({ status: "superseded" })
        .eq("session_id", input.sessionId)
        .eq("company_id", input.companyId)
        .eq("status", "active"),
      supabase
        .from("negotiation_sessions")
        .update({ wait_state: null, wait_started_at: null })
        .eq("id", input.sessionId)
        .eq("company_id", input.companyId)
        .not("wait_state", "is", null),
    ])

    const epoch = await getCurrentThreadEpoch(input.sessionId)
    const { data: recent } = await supabase
      .from("chat_messages")
      .select("id, offers_snapshot, thread_epoch, archived_at, created_at")
      .eq("session_id", input.sessionId)
      .eq("company_id", input.companyId)
      .eq("role", "assistant")
      .order("created_at", { ascending: false })
      .limit(50)
    const inThread = ((recent ?? []) as AssistantRow[]).filter(
      (m) => m.archived_at == null && Number(m.thread_epoch ?? 0) === epoch,
    )

    if (input.answerKey) {
      const claim = await recordEvent({
        companyId: input.companyId,
        customerId: input.customerId,
        sessionId: input.sessionId,
        type: "chat.click_ignored",
        actor: "customer",
        eventId: `journey-settled-click-${input.sessionId}-${input.answerKey}`,
        payload: { reason: "debt_settled", button_id: input.buttonId ?? null },
      })
      if (claim.duplicate) return null
      if (inThread[0] && isSettledMessage(inThread[0])) return null
    } else if (inThread.some(isSettledMessage)) {
      return null
    }

    const ctx = await buildSettledContext({
      companyId: input.companyId,
      customerId: input.customerId,
      totalPaid: input.settlement.totalPaid,
      oldestDueDate: input.settlement.oldestDueDate,
      paidAt: input.settlement.paidAt,
    })
    const text = settledMessage(ctx)
    const action = debtSettledContactAction()
    const row: Record<string, unknown> = {
      company_id: input.companyId,
      session_id: input.sessionId,
      role: "assistant",
      text,
      engine: "platform",
      offers_snapshot: { message_action: action },
    }
    if (epoch > 0) row.thread_epoch = epoch
    const { data: inserted, error } = await supabase.from("chat_messages").insert(row).select("id, created_at").single()
    const ins = inserted as { id?: string; created_at?: string } | null
    if (error || !ins?.id) return null
    await recordEvent({
      companyId: input.companyId,
      customerId: input.customerId,
      sessionId: input.sessionId,
      type: "chat.turn.assistant",
      actor: "system",
      payload: { message_id: ins.id, kind: "debt_settled", resumed: true },
    }).catch(() => ({ ok: false, duplicate: false }))
    return {
      id: ins.id,
      role: "assistant",
      text,
      button_id: null,
      prompt_id: null,
      engine: "platform",
      created_at: ins.created_at ?? new Date().toISOString(),
      action,
    }
  } catch (err) {
    console.warn("[journey] applySettledView (não-fatal):", (err as Error).message)
    return null
  }
}

/** URLs de cobrança de TODOS os acordos do cliente nesta empresa (quitado → nenhuma é viva). */
async function customerChargeHrefs(companyId: string, customerId: string): Promise<string[]> {
  try {
    const supabase = createServiceClient()
    const { data } = await supabase
      .from("agreements")
      .select("asaas_invoice_url, asaas_payment_url, asaas_boleto_url, asaas_pix_qrcode_url")
      .eq("company_id", companyId)
      .eq("customer_id", customerId)
    const hrefs = new Set<string>()
    for (const ag of (data ?? []) as Array<Record<string, unknown>>) {
      for (const k of ["asaas_invoice_url", "asaas_payment_url", "asaas_boleto_url", "asaas_pix_qrcode_url"]) {
        const v = ag[k]
        if (typeof v === "string" && /^https?:\/\//i.test(v)) hrefs.add(v)
      }
    }
    return [...hrefs]
  } catch {
    return []
  }
}

/**
 * Corpo do GET /api/chat/messages numa sessão quitada: a mensagem de quitação
 * (gravada se faltar), nenhum prompt/espera/card do valor/recap de retomada,
 * todos os links de cobrança mortos (histórico fica, sem Abrir/Copiar) e
 * `settled:true` (o client descarta qualquer estado local de pagamento).
 */
export async function settledPollBody<T extends { messages?: unknown; dead_payment_links?: unknown }>(
  body: T,
  input: { companyId: string; sessionId: string; settlement: SettledDebtor },
): Promise<T & Record<string, unknown>> {
  const customerId = input.settlement.customerId
  const [inserted, hrefs] = await Promise.all([
    applySettledView({ companyId: input.companyId, sessionId: input.sessionId, customerId, settlement: input.settlement }),
    customerChargeHrefs(input.companyId, customerId),
  ])
  const messages = (Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : []).map((m) => {
    const action = m.action as { type?: unknown } | undefined
    return action && typeof action === "object" && action.type === "open_payment_link"
      ? { ...m, action: { ...(action as Record<string, unknown>), live: false } }
      : m
  })
  if (inserted && !messages.some((m) => m.id === inserted.id)) messages.push({ ...inserted })
  const dead = new Set<string>(Array.isArray(body.dead_payment_links) ? (body.dead_payment_links as string[]) : [])
  for (const h of hrefs) dead.add(h)
  return {
    ...body,
    messages,
    active_prompt: null,
    prompt_pending: false,
    wait_state: null,
    wait_started_at: null,
    pinned_debt: null,
    recap: null,
    dead_payment_links: [...dead],
    settled: true,
  }
}

/** Mesmo critério de PAGAR do client (chat.tsx): id 4, parcela da matriz ou rótulo "Pagar…". */
function isPayClick(prompt: Pick<PromptRow, "kind" | "buttons">, buttonId: number): boolean {
  if (buttonId === BTN_PAY) return true
  if (prompt.kind === "offer_choice" && buttonId >= 2 && buttonId <= 97) return true
  const label = findButton(prompt.buttons ?? [], buttonId)?.label ?? ""
  return /^\s*(quero pagar|pagar)\b/i.test(label)
}

interface SettledCtx {
  sessionId: string
  companyId: string
  customerId: string
}

/**
 * /api/chat/button: clique de uma página defasada numa sessão quitada. Pagar,
 * Negociar, Não reconheço, Voltar etc. NÃO executam (nunca cobrança nova): o
 * servidor responde com o estado de quitado. Pagar volta no shape `action:'pay'`
 * sem link (o client sai do "gerando" para idle). O handoff [99] segue o fluxo
 * normal. null = sessão não quitada (segue o fluxo de sempre).
 */
export async function settledButtonBody(
  ctx: SettledCtx,
  prompt: Pick<PromptRow, "id" | "kind" | "buttons">,
  buttonId: number,
): Promise<Record<string, unknown> | null> {
  if (buttonId === BTN_HANDOFF) return null
  const settlement = await detectCustomerSettlement(ctx)
  if (!settlement) return null
  await applySettledView({ ...ctx, settlement, answerKey: `${prompt.id}-${buttonId}`, buttonId })
  const base = { ok: true, button_id: buttonId, settled: true, prompt: null, state_time: new Date().toISOString() }
  return isPayClick(prompt, buttonId)
    ? { ...base, action: "pay", link: null, processing: false, already_charged: true }
    : { ...base, action: "debt_settled" }
}

/**
 * /api/chat/reopen: "Já paguei" e "Voltar às opções" numa sessão quitada não
 * registram caso nem reabrem o menu — respondem com o estado de quitado. O
 * handoff segue o fluxo normal. null = sessão não quitada.
 */
export async function settledReopenBody(ctx: SettledCtx, action: string): Promise<Record<string, unknown> | null> {
  if (action === "handoff") return null
  const settlement = await detectCustomerSettlement(ctx)
  if (!settlement) return null
  // Chave por janela de 5 s: o toque múltiplo do mesmo atalho vira uma resposta só.
  await applySettledView({ ...ctx, settlement, answerKey: `${action}-${Math.floor(Date.now() / 5000)}` })
  return { ok: true, action, settled: true, claim_registered: false, prompt: null, state_time: new Date().toISOString() }
}
