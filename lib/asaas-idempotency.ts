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

export interface AgreementLike {
  asaas_payment_id?: string | null;
  payment_status?: string | null;
  asaas_status?: string | null;
}

export function isBlockingAgreement(agreement: AgreementLike): boolean {
  if (!agreement.asaas_payment_id) return false;
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
