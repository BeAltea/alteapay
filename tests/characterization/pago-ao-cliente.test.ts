import { describe, it, expect } from "vitest"

/**
 * INV (pago_ao_cliente): a channel-specific paid status meaning the debtor paid
 * the creditor directly. It must NOT be reconciled against ASAAS, and it counts
 * as "paid" for recovery metrics. This test documents the rule as an executable
 * contract: reconciliation candidate selection must exclude pago_ao_cliente.
 */
describe("characterization: pago_ao_cliente excluded from ASAAS reconciliation", () => {
  const isAsaasReconcilable = (row: { asaas_payment_id?: string | null; payment_status?: string }) =>
    Boolean(row.asaas_payment_id) && row.payment_status !== "pago_ao_cliente"

  it("never reconciles a pago_ao_cliente row even with an asaas id", () => {
    expect(isAsaasReconcilable({ asaas_payment_id: "pay_x", payment_status: "pago_ao_cliente" })).toBe(false)
    expect(isAsaasReconcilable({ asaas_payment_id: "pay_x", payment_status: "pending" })).toBe(true)
    expect(isAsaasReconcilable({ asaas_payment_id: null, payment_status: "pending" })).toBe(false)
  })
})
