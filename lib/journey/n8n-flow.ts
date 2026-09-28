// N8N-13 — fonte de dados do fluxo n8n: a PLATAFORMA, nunca um banco paralelo.
//
// Os fluxos `1. Main` / `1.x` / `6. DB Data Fetch` liam devedor, dívida, régua e
// "conversa" (estado do roteador) direto de OUTRO projeto Supabase, com schema
// próprio (`n8n_conversation_messages`, `debts.original_amount`,
// `collection_rules.conditions`…). Resultado: devedor não espelhado caía em
// "não conseguimos encontrar histórico" e o fluxo raciocinava sobre vencimento
// e faixa de desconto errados. Dar ao n8n a service-role de produção não é
// opção (N8N-4: execuções guardam dados em claro).
//
// Duas ações HMAC (via /api/webhooks/n8n), escopadas por session_id → company_id
// DA SESSÃO (nunca do fluxo):
//   flow.context    — leitura única com tudo que o fluxo lia do banco paralelo:
//                     dívida (centavos, status, aberta?), primeiro nome + doc
//                     mascarado, cedente, matriz da faixa, ofertas vigentes,
//                     reconhecimento, prompt ativo e o ESTADO do roteador.
//   flow.state.set  — o fluxo registra o passo do roteador (step/status/active/
//                     ongoing_agreement). Substitui as escritas em
//                     `n8n_conversation_messages`. Grava em journey_events
//                     (append-only, actor n8n) — sem migration.
//
// Sem histórico de mensagens: o roteador só precisa do ÚLTIMO passo do agente
// (Last Agent Interaction.step) e do `ongoing_agreement` dele; o texto das
// mensagens já está em conversation_messages e não volta ao fluxo.
// O `ongoing_agreement` é rascunho do fluxo: o servidor NUNCA cobra a partir
// dele (payment.create exige offer_id da matriz).

import { createHash, randomUUID } from "node:crypto"
import { z } from "zod"
import { createServiceClient } from "@/lib/supabase/service"
import { buildSessionContext, type SessionContext } from "./context"
import { recordEvent } from "./events"
import { OPEN_DEBT_STATUSES } from "./resolver"
import type { SessionCtx } from "./actions"

/** Passos do roteador do `1. Main` (Switch "Router"). */
export const N8N_FLOW_STEPS = [
  "identity_verification",
  "debt_recognition",
  "negotiation_l1",
  "negotiation_l2",
  "payment_method",
  "payment_terms",
  "agreement_confirmation",
] as const
export type N8nFlowStep = (typeof N8N_FLOW_STEPS)[number]

export const FLOW_STEP_EVENT = "n8n.flow_step" as const

/** Teto do rascunho do fluxo (JSON serializado). */
export const MAX_ONGOING_AGREEMENT_CHARS = 4096

export interface FlowState {
  step: N8nFlowStep
  status: string | null
  active: boolean
  ongoing_agreement: Record<string, unknown> | null
  updated_at: string
}

export interface FlowContext {
  session: {
    id: string
    company_id: string
    status: string | null
    outcome: string | null
    verified: boolean
    consent: boolean
    engine: string
    channel: string
  }
  creditor: { name: string }
  customer: {
    id: string
    first_name: string
    document_type: "cpf" | "cnpj"
    document_masked: string
  }
  debt: {
    id: string
    ids: string[]
    status: string | null
    /** true quando a dívida principal está em aberto (pending/in_negotiation). */
    open: boolean
    original_value: number // centavos
    updated_value: number // centavos
    due_date: string | null // vencimento da dívida principal
    oldest_due_date: string | null // base do aging (fatura mais antiga)
    aging_days: number
    invoice_count: number
  }
  matrix: {
    id: string
    max_discount_pct: number
    min_entry_pct: number
    max_installments: number
    allowed_billing_types: string[]
    proposal_validity_days: number
  } | null
  offers: SessionContext["offers"] // termos em centavos
  debt_acknowledgement: {
    answered: boolean
    acknowledged: boolean | null
    answered_at: string | null
  }
  active_prompt: { id: string; kind: string } | null
  flow_state: FlowState | null
  /** Sem flow_state: passo em que o fluxo deve entrar. Com a dívida já
   *  reconhecida na plataforma → "debt_recognition" (o próximo passo é a
   *  oferta L1); sem reconhecimento → null (a plataforma conduz o reconhecimento). */
  bootstrap_step: N8nFlowStep | null
}

/** Último passo do roteador gravado pelo fluxo nesta sessão (ou null). */
export async function getFlowState(ctx: SessionCtx): Promise<FlowState | null> {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from("journey_events")
    .select("payload, occurred_at")
    .eq("company_id", ctx.companyId)
    .eq("session_id", ctx.sessionId)
    .eq("event_type", FLOW_STEP_EVENT)
    .order("occurred_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!data) return null
  const p = (data.payload ?? {}) as Record<string, unknown>
  if (!(N8N_FLOW_STEPS as readonly string[]).includes(String(p.step))) return null
  return {
    step: p.step as N8nFlowStep,
    status: typeof p.status === "string" ? p.status : null,
    active: p.active !== false,
    ongoing_agreement:
      p.ongoing_agreement && typeof p.ongoing_agreement === "object"
        ? (p.ongoing_agreement as Record<string, unknown>)
        : null,
    updated_at: String(data.occurred_at),
  }
}

/** Leitura única para o fluxo (substitui `6. DB Data Fetch` e os
 *  "Get Customer Interaction"/"Get latest offer from agent" dos 1.x). */
export async function flowContext(ctx: SessionCtx): Promise<FlowContext | null> {
  const supabase = createServiceClient()
  const [base, { data: session }, { data: debt }, flowState] = await Promise.all([
    buildSessionContext(ctx.sessionId),
    supabase
      .from("negotiation_sessions")
      .select("status, outcome")
      .eq("id", ctx.sessionId)
      .eq("company_id", ctx.companyId)
      .maybeSingle(),
    supabase
      .from("debts")
      .select("id, status, due_date")
      .eq("id", ctx.debtId)
      .eq("company_id", ctx.companyId)
      .maybeSingle(),
    getFlowState(ctx),
  ])
  // Contexto de OUTRA empresa nunca volta (defesa em profundidade: o
  // buildSessionContext já lê pela sessão).
  if (!base || base.tenant.id !== ctx.companyId) return null

  const debtStatus = (debt?.status as string | undefined) ?? null
  const acknowledged = base.debt_acknowledgement.acknowledged
  return {
    session: {
      id: ctx.sessionId,
      company_id: ctx.companyId,
      status: (session?.status as string | undefined) ?? null,
      outcome: (session?.outcome as string | undefined) ?? null,
      verified: base.session.verified,
      consent: base.session.consent,
      engine: base.session.engine,
      channel: base.session.channel,
    },
    creditor: { name: base.tenant.creditor_name },
    // PII mínima: primeiro nome + documento mascarado. Nunca o doc em claro,
    // nem o hash, telefone ou e-mail (mesmo com as flags do tenant).
    customer: {
      id: base.customer.id,
      first_name: base.customer.first_name,
      document_type: base.customer.document_type,
      document_masked: base.customer.document_masked,
    },
    debt: {
      id: base.debt.id,
      ids: base.debt.ids,
      status: debtStatus,
      open: debtStatus != null && (OPEN_DEBT_STATUSES as readonly string[]).includes(debtStatus),
      original_value: base.debt.original_value,
      updated_value: base.debt.updated_value,
      due_date: (debt?.due_date as string | undefined) ?? null,
      oldest_due_date: base.debt.oldest_due_date,
      aging_days: base.debt.aging_days,
      invoice_count: base.debt.invoice_count,
    },
    matrix: base.matrix,
    offers: base.offers,
    debt_acknowledgement: {
      answered: base.debt_acknowledgement.answered,
      acknowledged,
      answered_at: base.debt_acknowledgement.answered_at,
    },
    active_prompt: base.active_prompt ? { id: base.active_prompt.id, kind: base.active_prompt.kind } : null,
    flow_state: flowState,
    bootstrap_step: flowState ? null : acknowledged === true ? "debt_recognition" : null,
  }
}

const DOC_LIKE = /\d{11}/ // CPF/CNPJ (ou telefone) em claro — nunca no rascunho

const flowStateArgsSchema = z.object({
  step: z.enum(N8N_FLOW_STEPS),
  status: z
    .string()
    .regex(/^[a-z_]{1,32}$/)
    .nullish(),
  active: z.boolean().optional(),
  ongoing_agreement: z.record(z.unknown()).nullish(),
})

export type FlowStateSetResult =
  | { ok: true; state: FlowState; duplicate: boolean }
  | { ok: false; status: number; code: string; message: string }

/**
 * Registra o passo do roteador (substitui "DB: Persist Agent Message" do
 * `4. Send Msg & Update` e os "Update Customer Row*" dos 1.x). Idempotente por
 * (sessão, event_id, step, status): o reenvio do mesmo evento não duplica.
 */
export async function setFlowState(
  ctx: SessionCtx,
  rawArgs: unknown,
  eventId?: string,
): Promise<FlowStateSetResult> {
  const parsed = flowStateArgsSchema.safeParse(rawArgs ?? {})
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return {
      ok: false,
      status: 422,
      code: "FLOW_STATE_INVALID",
      message: `${issue?.path.join(".") || "args"}: ${issue?.message ?? "inválido"}`,
    }
  }
  const args = parsed.data
  let ongoing: Record<string, unknown> | null = args.ongoing_agreement ?? null
  if (ongoing) {
    const serialized = JSON.stringify(ongoing)
    if (serialized.length > MAX_ONGOING_AGREEMENT_CHARS) {
      return { ok: false, status: 422, code: "FLOW_STATE_TOO_LARGE", message: "ongoing_agreement acima de 4 KB" }
    }
    if (DOC_LIKE.test(serialized.replace(/\d+\.\d+/g, ""))) {
      return { ok: false, status: 422, code: "PII_NOT_ALLOWED", message: "ongoing_agreement não pode conter documento/telefone" }
    }
    ongoing = JSON.parse(serialized) as Record<string, unknown>
  }

  const occurredAt = new Date().toISOString()
  const key = [FLOW_STEP_EVENT, ctx.sessionId, eventId ?? randomUUID(), args.step, args.status ?? ""].join("|")
  const state: FlowState = {
    step: args.step,
    status: args.status ?? null,
    active: args.active ?? true,
    ongoing_agreement: ongoing,
    updated_at: occurredAt,
  }
  const r = await recordEvent({
    companyId: ctx.companyId,
    // customerId de propósito ausente: o passo do fluxo é estado interno do
    // n8n e não deve mover a projeção negotiation_state do devedor.
    customerId: null,
    debtId: ctx.debtId,
    sessionId: ctx.sessionId,
    type: FLOW_STEP_EVENT,
    actor: "n8n",
    eventId: createHash("sha256").update(key).digest("hex"),
    occurredAt,
    payload: {
      step: state.step,
      status: state.status,
      active: state.active,
      ongoing_agreement: state.ongoing_agreement,
    },
  })
  if (!r.ok) return { ok: false, status: 500, code: "FLOW_STATE_WRITE_FAILED", message: "falha ao registrar o passo" }
  return { ok: true, state, duplicate: r.duplicate }
}
