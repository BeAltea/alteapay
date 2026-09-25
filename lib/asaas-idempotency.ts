/**
 * Idempotency guard for ASAAS charge creation.
 *
 * A customer with ANY payment that is not terminally closed (deleted/refunded)
 * must never receive a new charge from bulk flows. The allow-list is
 * intentionally strict: unknown or in-flight statuses (AWAITING_RISK_ANALYSIS,
 * DUNNING_*, CHARGEBACK_*, REFUND_REQUESTED, ...) block creation.
 */

export const NON_BLOCKING_ASAAS_STATUSES: ReadonlySet<string> = new Set([
  'DELETED',
  'REFUNDED',
]);

export interface AsaasPaymentLike {
  id?: string;
  status?: string | null;
  deleted?: boolean;
  value?: number;
}

export function isBlockingPayment(payment: AsaasPaymentLike): boolean {
  if (payment.deleted) return false;
  return !NON_BLOCKING_ASAAS_STATUSES.has(payment.status ?? '');
}

/** Returns the first payment that blocks a new charge, or null when clear. */
export function findBlockingPayment(
  payments: AsaasPaymentLike[] | null | undefined
): AsaasPaymentLike | null {
  if (!payments?.length) return null;
  return payments.find(isBlockingPayment) ?? null;
}

/**
 * ASAAS keeps `status: 'PENDING'` on a deleted payment and only flips
 * `deleted: true` (the PAYMENT_DELETED webhook carries that shape). Persisting
 * `payment.status` verbatim left agreements as `asaas_status='PENDING'` after a
 * cancellation, which kept the local guard blocking forever (N-D1-2). This maps
 * the webhook event to the status we actually want to store.
 */
export function effectiveAsaasStatusFromWebhook(
  event: string | null | undefined,
  payment: AsaasPaymentLike | null | undefined
): string | null {
  if (event === 'PAYMENT_DELETED' || payment?.deleted === true) return 'DELETED';
  if (event === 'PAYMENT_REFUNDED') return 'REFUNDED';
  return payment?.status ?? null;
}

/** Statuses that mean an agreement already carries a live or settled charge. */
export const BLOCKING_AGREEMENT_PAYMENT_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'overdue',
  'received',
  'confirmed',
]);

export const BLOCKING_AGREEMENT_ASAAS_STATUSES: ReadonlySet<string> = new Set([
  'PENDING',
  'OVERDUE',
  'RECEIVED',
  'CONFIRMED',
  'RECEIVED_IN_CASH',
]);

/**
 * Terminal local states: the charge behind the agreement is gone (deleted in
 * ASAAS, refunded) or the agreement itself was cancelled. They take PRECEDENCE
 * over `asaas_status` — a webhook may have left `asaas_status='PENDING'` on a
 * deleted payment (see effectiveAsaasStatusFromWebhook), and a cancelled
 * agreement must never be reported as "already charged" (N-D1-2).
 */
export const TERMINAL_AGREEMENT_PAYMENT_STATUSES: ReadonlySet<string> = new Set([
  'deleted',
  'refunded',
  'cancelled',
]);

export const TERMINAL_AGREEMENT_STATUSES: ReadonlySet<string> = new Set(['cancelled']);

export interface AgreementLike {
  asaas_payment_id?: string | null;
  payment_status?: string | null;
  asaas_status?: string | null;
  /** agreements.status ('active' | 'completed' | 'cancelled' | ...). */
  status?: string | null;
}

/** true when the agreement is terminally closed locally (never blocks). */
export function isTerminalAgreement(agreement: AgreementLike): boolean {
  return (
    TERMINAL_AGREEMENT_PAYMENT_STATUSES.has(agreement.payment_status ?? '') ||
    TERMINAL_AGREEMENT_STATUSES.has(agreement.status ?? '')
  );
}

export function isBlockingAgreement(agreement: AgreementLike): boolean {
  if (!agreement.asaas_payment_id) return false;
  if (isTerminalAgreement(agreement)) return false;
  return (
    BLOCKING_AGREEMENT_PAYMENT_STATUSES.has(agreement.payment_status ?? '') ||
    BLOCKING_AGREEMENT_ASAAS_STATUSES.has(agreement.asaas_status ?? '')
  );
}

export function findBlockingAgreement(
  agreements: AgreementLike[] | null | undefined
): AgreementLike | null {
  if (!agreements?.length) return null;
  return agreements.find(isBlockingAgreement) ?? null;
}
