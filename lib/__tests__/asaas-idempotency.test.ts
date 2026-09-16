import { describe, expect, it } from 'vitest';
import {
  findBlockingAgreement,
  findBlockingPayment,
  isBlockingAgreement,
  isBlockingPayment,
} from '../asaas-idempotency';

describe('isBlockingPayment', () => {
  it.each(['PENDING', 'OVERDUE', 'RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'])(
    'blocks open/settled status %s',
    (status) => {
      expect(isBlockingPayment({ status })).toBe(true);
    }
  );

  it.each([
    'AWAITING_RISK_ANALYSIS',
    'DUNNING_REQUESTED',
    'CHARGEBACK_REQUESTED',
    'REFUND_REQUESTED',
    'REFUND_IN_PROGRESS',
    'PARTIALLY_REFUNDED',
    'STATUS_DESCONHECIDO_FUTURO',
  ])('blocks in-flight/unknown status %s (never allow by default)', (status) => {
    expect(isBlockingPayment({ status })).toBe(true);
  });

  it('does not block DELETED or REFUNDED', () => {
    expect(isBlockingPayment({ status: 'DELETED' })).toBe(false);
    expect(isBlockingPayment({ status: 'REFUNDED' })).toBe(false);
  });

  it('does not block soft-deleted payments regardless of status', () => {
    expect(isBlockingPayment({ status: 'PENDING', deleted: true })).toBe(false);
    expect(isBlockingPayment({ status: 'OVERDUE', deleted: true })).toBe(false);
  });

  it('blocks missing status (defensive default)', () => {
    expect(isBlockingPayment({})).toBe(true);
    expect(isBlockingPayment({ status: null })).toBe(true);
  });
});

describe('findBlockingPayment', () => {
  it('returns null for empty or nullish lists', () => {
    expect(findBlockingPayment([])).toBeNull();
    expect(findBlockingPayment(null)).toBeNull();
    expect(findBlockingPayment(undefined)).toBeNull();
  });

  it('returns null when every payment is closed', () => {
    expect(
      findBlockingPayment([
        { id: 'a', status: 'DELETED' },
        { id: 'b', status: 'REFUNDED' },
        { id: 'c', status: 'PENDING', deleted: true },
      ])
    ).toBeNull();
  });

  it('returns the first blocking payment', () => {
    const blocking = findBlockingPayment([
      { id: 'a', status: 'DELETED' },
      { id: 'b', status: 'OVERDUE' },
      { id: 'c', status: 'PENDING' },
    ]);
    expect(blocking?.id).toBe('b');
  });
});

describe('isBlockingAgreement', () => {
  it('ignores agreements without an ASAAS payment id', () => {
    expect(isBlockingAgreement({ payment_status: 'pending' })).toBe(false);
    expect(isBlockingAgreement({ asaas_payment_id: null, asaas_status: 'OVERDUE' })).toBe(false);
  });

  it.each([
    { asaas_payment_id: 'pay_1', payment_status: 'pending' },
    { asaas_payment_id: 'pay_2', payment_status: 'overdue' },
    { asaas_payment_id: 'pay_3', payment_status: 'received' },
    { asaas_payment_id: 'pay_4', asaas_status: 'PENDING' },
    { asaas_payment_id: 'pay_5', asaas_status: 'RECEIVED_IN_CASH' },
  ])('blocks live/settled local agreement %#', (agreement) => {
    expect(isBlockingAgreement(agreement)).toBe(true);
  });

  it('does not block cancelled/deleted local state', () => {
    expect(
      isBlockingAgreement({ asaas_payment_id: 'pay_6', payment_status: 'deleted', asaas_status: 'DELETED' })
    ).toBe(false);
    expect(
      isBlockingAgreement({ asaas_payment_id: 'pay_7', payment_status: 'cancelled', asaas_status: null })
    ).toBe(false);
  });
});

describe('findBlockingAgreement', () => {
  it('returns the first blocking agreement or null', () => {
    expect(findBlockingAgreement([])).toBeNull();
    const hit = findBlockingAgreement([
      { asaas_payment_id: 'pay_a', payment_status: 'deleted', asaas_status: 'DELETED' },
      { asaas_payment_id: 'pay_b', payment_status: 'overdue' },
    ]);
    expect(hit?.asaas_payment_id).toBe('pay_b');
  });
});
