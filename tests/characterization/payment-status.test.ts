import { describe, it, expect } from "vitest"

/**
 * INV: paid-status constant sets (lib/constants/payment-status.ts).
 *   PAID_AGREEMENT_STATUSES = ["completed","paid","pago_ao_cliente"]
 *   PAID_PAYMENT_STATUSES   = ["received","confirmed"]
 *   PAID_ASAAS_STATUSES     = ["RECEIVED","CONFIRMED","RECEIVED_IN_CASH"]
 * These drive reconciliation everywhere; their exact membership is a contract.
 * Contract updated 2026-07-02 (alteapay-v2): production snapshot dfeceb2 already
 * carried "pago_ao_cliente" (see pago-ao-cliente.test.ts, which pins its
 * exclusion from ASAAS reconciliation); the original pin predated it.
 */
describe("characterization: payment status constants", () => {
  it("locks the paid-status sets", async () => {
    const mod: any = await import("@/lib/constants/payment-status").catch(() => null)
    if (!mod) return expect.fail("lib/constants/payment-status not resolvable — refactor must preserve this module path or update this contract via CTO+human approval")
    expect([...mod.PAID_AGREEMENT_STATUSES].sort()).toEqual(["completed", "pago_ao_cliente", "paid"])
    expect([...mod.PAID_PAYMENT_STATUSES].sort()).toEqual(["confirmed", "received"])
    expect([...mod.PAID_ASAAS_STATUSES].sort()).toEqual(["CONFIRMED", "RECEIVED", "RECEIVED_IN_CASH"])
  })

  it("treats RECEIVED / CONFIRMED / RECEIVED_IN_CASH as paid (ASAAS)", async () => {
    const mod: any = await import("@/lib/constants/payment-status").catch(() => null)
    if (!mod) return expect.fail("module not resolvable")
    for (const s of ["RECEIVED", "CONFIRMED", "RECEIVED_IN_CASH"]) {
      expect(mod.PAID_ASAAS_STATUSES).toContain(s)
    }
    // OVERDUE / PENDING are never paid
    expect(mod.PAID_ASAAS_STATUSES).not.toContain("OVERDUE")
    expect(mod.PAID_ASAAS_STATUSES).not.toContain("PENDING")
  })
})
