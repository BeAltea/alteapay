/**
 * Payment Status Constants
 *
 * Centralized definitions for payment status values used across the application.
 * IMPORTANT: Keep these in sync with ASAAS webhook mappings.
 */

// Agreement statuses that indicate the debt is PAID
// NOTE: "pago_ao_cliente" = customer paid directly to provider (not via AlteaPay/ASAAS)
export const PAID_AGREEMENT_STATUSES = ["paid", "completed", "pago_ao_cliente"] as const

// Payment statuses that indicate the payment was CONFIRMED/RECEIVED
// NOTE: In ASAAS, CONFIRMED means payment confirmed (shows as "Pago" in UI)
export const PAID_PAYMENT_STATUSES = ["received", "confirmed"] as const

// ASAAS statuses that indicate the payment was CONFIRMED/RECEIVED
export const PAID_ASAAS_STATUSES = ["RECEIVED", "RECEIVED_IN_CASH", "CONFIRMED"] as const

// VMAX negotiation statuses that indicate PAID
export const PAID_VMAX_STATUSES = ["PAGO"] as const

/**
 * Order of payment progress (payment_status or raw ASAAS status, any case).
 * RECEIVED/RECEIVED_IN_CASH/DUNNING_RECEIVED > CONFIRMED > PENDING/OVERDUE.
 * Statuses outside this ladder (REFUNDED, DELETED, chargeback, ...) have no rank
 * and are never treated as a regression — refund/deletion paths always apply.
 */
const PAYMENT_STATUS_RANK: Record<string, number> = {
  RECEIVED: 3,
  RECEIVED_IN_CASH: 3,
  DUNNING_RECEIVED: 3,
  CONFIRMED: 2,
  PENDING: 1,
  AWAITING_RISK_ANALYSIS: 1,
  OVERDUE: 1,
}

/**
 * True when moving from `current` to `next` would step DOWN the payment ladder
 * (e.g. received → confirmed after a late PAYMENT_CONFIRMED). Such a write must
 * be skipped: a payment status never regresses.
 */
export function isPaymentStatusRegression(current?: string | null, next?: string | null): boolean {
  if (!current || !next) return false
  const from = PAYMENT_STATUS_RANK[current.toUpperCase()]
  const to = PAYMENT_STATUS_RANK[next.toUpperCase()]
  return from !== undefined && to !== undefined && to < from
}

// All possible "paid" status values (for SQL IN clauses)
export const ALL_PAID_STATUSES = [
  ...PAID_AGREEMENT_STATUSES,
  ...PAID_PAYMENT_STATUSES,
  ...PAID_ASAAS_STATUSES,
  ...PAID_VMAX_STATUSES,
] as const

/**
 * Check if a combination of status values indicates the debt is PAID
 *
 * @param agreementStatus - Agreement status (paid, completed, active, etc.)
 * @param paymentStatus - Payment status from ASAAS webhook (received, confirmed, pending, etc.)
 * @param asaasStatus - Raw ASAAS status (RECEIVED, CONFIRMED, PENDING, etc.)
 * @param vmaxNegotiationStatus - VMAX negotiation_status field (PAGO, etc.)
 */
export function isPaidStatus(
  agreementStatus?: string | null,
  paymentStatus?: string | null,
  asaasStatus?: string | null,
  vmaxNegotiationStatus?: string | null
): boolean {
  // Check agreement status
  if (agreementStatus && PAID_AGREEMENT_STATUSES.includes(agreementStatus as any)) {
    return true
  }

  // Check payment status (from webhook)
  if (paymentStatus && PAID_PAYMENT_STATUSES.includes(paymentStatus as any)) {
    return true
  }

  // Check raw ASAAS status
  if (asaasStatus && PAID_ASAAS_STATUSES.includes(asaasStatus as any)) {
    return true
  }

  // Check VMAX negotiation status
  if (vmaxNegotiationStatus && PAID_VMAX_STATUSES.includes(vmaxNegotiationStatus as any)) {
    return true
  }

  return false
}

/**
 * Check if a single status string indicates PAID
 * Useful for simple checks against any status field
 */
export function isAnyPaidStatus(status?: string | null): boolean {
  if (!status) return false
  const normalizedStatus = status.toUpperCase()
  return (
    normalizedStatus === "PAID" ||
    normalizedStatus === "COMPLETED" ||
    normalizedStatus === "RECEIVED" ||
    normalizedStatus === "RECEIVED_IN_CASH" ||
    normalizedStatus === "CONFIRMED" ||
    normalizedStatus === "PAGO" ||
    normalizedStatus === "PAGO_AO_CLIENTE"
  )
}
