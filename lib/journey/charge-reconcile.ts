// QA rodada 5 (Q2-01) — acordo "pending_charge" e reconciliação idempotente.
//
// Desde a rodada 5 o fechamento da jornada grava o espelho local ANTES de chamar
// o ASAAS: acordo (status 'active', payment_status 'pending', SEM
// asaas_payment_id) + prova do aceite (offer → agreement) + vínculo
// sessão → acordo. Esse acordo sem cobrança é o estado "pending_charge" (sem
// coluna nova: é derivado das colunas existentes). Se a função morrer entre o
// POST /payments no ASAAS e o write-back, sobra um acordo pending_charge e
// (talvez) uma cobrança viva no ASAAS com
// externalReference = `journey_{session}_{offer}`.
//
// reconcilePendingCharge resolve esse estado de forma IDEMPOTENTE:
//   - cobrança achada no ASAAS pela externalReference → write-back das URLs
//     (só se asaas_payment_id ainda é null) → 'linked' (o poll entrega o link);
//   - nada no ASAAS e o acordo passou da janela de graça (maior que o teto da
//     função: a request que criaria já morreu com certeza) → cancela o acordo
//     órfão e devolve a dívida para 'pending' → 'cancelled' (novo Pagar cria
//     cobrança nova pelo caminho normal, com o guard duplo);
//   - ainda na janela (a request original pode estar viva) → 'pending'.
// NUNCA cria cobrança. Só cancela no CHARGE_MODE=inline (na fila o worker pode
// criar mais tarde e não tem prazo). PII: nada de nome/documento em log.

import { createServiceClient } from "@/lib/supabase/service"
import { isTerminalAgreement } from "@/lib/asaas-idempotency"

/** Janela de graça do acordo pending_charge (ms). Maior que o teto observado da
 *  função (504 em ~30 s) + o maior POST do ASAAS: depois dela, a request que
 *  criaria a cobrança já não existe. */
export function orphanGraceMs(): number {
  const raw = Number.parseInt(process.env.PAY_ORPHAN_GRACE_MS ?? "", 10)
  return Number.isFinite(raw) && raw >= 35_000 ? raw : 45_000
}

/** Idade mínima para consultar o ASAAS (evita 1 GET por poll enquanto a
 *  request original ainda deve estar criando/espelhando a cobrança). */
export const RECONCILE_MIN_AGE_MS = 20_000

export interface PendingChargeRow {
  id: string
  company_id?: string | null
  asaas_payment_id?: string | null
  payment_status?: string | null
  asaas_status?: string | null
  status?: string | null
  origin?: string | null
  offer_id?: string | null
  negotiation_session_id?: string | null
  debt_id?: string | null
  created_at?: string | null
}

/** externalReference que o fechamento da jornada usa na cobrança ASAAS. */
export function journeyExternalReference(sessionId: string, offerId: string): string {
  return `journey_${sessionId}_${offerId}`
}

/** true = acordo da jornada à espera da cobrança (sem asaas_payment_id, vivo). */
export function isPendingCharge(ag: PendingChargeRow | null | undefined): boolean {
  if (!ag || ag.asaas_payment_id) return false
  if (isTerminalAgreement(ag)) return false
  if (ag.origin !== "chat_journey") return false
  if (!ag.offer_id || !ag.negotiation_session_id) return false
  return (ag.payment_status ?? "pending") === "pending"
}

export type ReconcileOutcome = "skip" | "pending" | "linked" | "cancelled"

interface AsaasPaymentLike {
  id?: string
  status?: string | null
  deleted?: boolean
  billingType?: string | null
  invoiceUrl?: string | null
  bankSlipUrl?: string | null
  pixQrCodeUrl?: string | null
  dueDate?: string | null
  customer?: string | null
  installment?: string | null
}

const inlineMode = () => (process.env.CHARGE_MODE || "queue").toLowerCase() === "inline"

/**
 * Reconcilia UM acordo pending_charge (ver cabeçalho). Nunca lança; nunca cria
 * cobrança. `now` é injetável para teste.
 */
export async function reconcilePendingCharge(
  ag: PendingChargeRow,
  opts: { now?: number; force?: boolean } = {},
): Promise<ReconcileOutcome> {
  if (!isPendingCharge(ag)) return "skip"
  const now = opts.now ?? Date.now()
  const created = ag.created_at ? Date.parse(ag.created_at) : NaN
  const age = Number.isFinite(created) ? now - created : Number.POSITIVE_INFINITY
  if (!opts.force && age < RECONCILE_MIN_AGE_MS) return "pending"

  const supabase = createServiceClient()
  let found: AsaasPaymentLike | null = null
  try {
    const asaas = await import("@/lib/asaas")
    found = (await asaas.getAsaasPaymentByExternalReference(
      journeyExternalReference(ag.negotiation_session_id as string, ag.offer_id as string),
    )) as AsaasPaymentLike | null
  } catch (err) {
    // ASAAS indisponível: não decide nada (nunca cancela no escuro).
    console.warn("[journey] reconcilePendingCharge: consulta ASAAS falhou:", (err as Error).message)
    return "pending"
  }

  if (found?.id && !found.deleted) {
    const { data } = await supabase
      .from("agreements")
      .update({
        asaas_customer_id: found.customer ?? null,
        asaas_payment_id: found.id,
        asaas_status: found.status ?? "PENDING",
        asaas_billing_type: found.billingType ?? null,
        asaas_payment_url: found.invoiceUrl ?? null,
        asaas_invoice_url: found.invoiceUrl ?? null,
        asaas_boleto_url: found.bankSlipUrl ?? null,
        asaas_pix_qrcode_url: found.pixQrCodeUrl ?? null,
        ...(found.dueDate ? { due_date: found.dueDate } : {}),
        // QA rodada 6 (Q4r2-03): id do parcelamento (webhook das parcelas 2..N).
        ...(found.installment ? { asaas_subscription_id: found.installment } : {}),
      })
      .eq("id", ag.id)
      .is("asaas_payment_id", null)
      .select("id")
    console.info(`[journey] reconcilePendingCharge: acordo ${ag.id} espelhado pela externalReference (${(data ?? []).length} linha)`)
    return "linked"
  }

  // Nada no ASAAS. Só cancela passada a janela de graça e no modo inline.
  if (!inlineMode() || age < orphanGraceMs()) return "pending"
  await cancelChargelessAgreement(ag, "charge_not_created")
  return "cancelled"
}

/**
 * Cancela um acordo SEM cobrança (nenhuma cobrança existe no ASAAS para ele) e
 * devolve a dívida para 'pending' (mesmo efeito do PAYMENT_DELETED). Condicional
 * a asaas_payment_id null (nunca cancela acordo que ganhou cobrança no meio).
 */
export async function cancelChargelessAgreement(ag: PendingChargeRow, reason: string): Promise<void> {
  const supabase = createServiceClient()
  try {
    const { data: rows } = await supabase
      .from("agreements")
      .update({ status: "cancelled", payment_status: "cancelled", updated_at: new Date().toISOString() })
      .eq("id", ag.id)
      .is("asaas_payment_id", null)
      .select("id")
    if ((rows ?? []).length > 0 && ag.debt_id) {
      await supabase
        .from("debts")
        .update({ status: "pending", updated_at: new Date().toISOString() })
        .eq("id", ag.debt_id)
        .eq("status", "in_negotiation")
    }
    console.info(`[journey] acordo ${ag.id} sem cobrança cancelado (${reason})`)
  } catch (err) {
    console.warn("[journey] cancelChargelessAgreement falhou:", (err as Error).message)
  }
}
