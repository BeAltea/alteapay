// Cobrança ASAAS INLINE (CHARGE_MODE=inline): createAsaasChargeInline cria
// customer + payment no ASAAS (mockado) e escreve as URLs de volta no agreement;
// e é idempotente — agreement com cobrança viva não recria.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

const CO = "eeeeeeee-0000-0000-0000-000000000005"
const AG = "ag-inline-1"

let db: FakeDb

// Espiões do ASAAS (mockado — NUNCA toca produção).
const createAsaasCustomer = vi.fn()
const updateAsaasCustomer = vi.fn()
const getAsaasCustomerByCpfCnpj = vi.fn()
const createAsaasPayment = vi.fn()

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/asaas", () => ({
  createAsaasCustomer: (...a: any[]) => createAsaasCustomer(...a),
  updateAsaasCustomer: (...a: any[]) => updateAsaasCustomer(...a),
  getAsaasCustomerByCpfCnpj: (...a: any[]) => getAsaasCustomerByCpfCnpj(...a),
  createAsaasPayment: (...a: any[]) => createAsaasPayment(...a),
}))

function jobData(overrides: Record<string, any> = {}) {
  return {
    customer: { name: "Fulano", cpfCnpj: "123.456.789-09", email: "x@y.com", mobilePhone: "11999998888" },
    payment: {
      billingType: "PIX" as const,
      value: 90,
      dueDate: "2026-10-01",
      description: "Acordo teste",
      externalReference: AG,
      ...overrides,
    },
    metadata: { companyId: CO, source: "test", agreementId: AG },
  }
}

beforeEach(() => {
  db = {
    agreements: [
      { id: AG, company_id: CO, asaas_payment_id: null, payment_status: "pending", asaas_status: null },
    ],
  }
  createAsaasCustomer.mockReset().mockResolvedValue({ id: "cus_new", cpfCnpj: "12345678909" })
  updateAsaasCustomer.mockReset().mockResolvedValue({ id: "cus_existing" })
  getAsaasCustomerByCpfCnpj.mockReset().mockResolvedValue(null)
  createAsaasPayment.mockReset().mockResolvedValue({
    id: "pay_1",
    status: "PENDING",
    billingType: "PIX",
    invoiceUrl: "https://asaas/inv/pay_1",
    bankSlipUrl: null,
    pixQrCodeUrl: "https://asaas/pix/pay_1",
    dueDate: "2026-10-01",
  })
})

describe("createAsaasChargeInline", () => {
  it("cria customer + payment e escreve URLs de volta no agreement", async () => {
    const { createAsaasChargeInline } = await import("@/lib/journey/charge-inline")
    const r = await createAsaasChargeInline(jobData())

    expect(r.ok).toBe(true)
    expect(r.paymentId).toBe("pay_1")
    expect(r.invoiceUrl).toBe("https://asaas/inv/pay_1")

    // customer criado (cpf normalizado, sem pontuação)
    expect(createAsaasCustomer).toHaveBeenCalledTimes(1)
    expect(createAsaasCustomer.mock.calls[0][0].cpfCnpj).toBe("12345678909")
    expect(updateAsaasCustomer).not.toHaveBeenCalled()

    // payment criado com o customer id retornado
    expect(createAsaasPayment).toHaveBeenCalledTimes(1)
    expect(createAsaasPayment.mock.calls[0][0]).toMatchObject({
      customer: "cus_new",
      billingType: "PIX",
      value: 90,
      dueDate: "2026-10-01",
      externalReference: AG,
    })

    // write-back no agreement
    const ag = db.agreements.find((a) => a.id === AG)
    expect(ag?.asaas_payment_id).toBe("pay_1")
    expect(ag?.asaas_customer_id).toBe("cus_new")
    expect(ag?.asaas_invoice_url).toBe("https://asaas/inv/pay_1")
    expect(ag?.asaas_pix_qrcode_url).toBe("https://asaas/pix/pay_1")
    expect(ag?.asaas_billing_type).toBe("PIX")
    expect(ag?.due_date).toBe("2026-10-01")
  })

  it("customer já existe no ASAAS → update (reforça notificationDisabled), não cria", async () => {
    getAsaasCustomerByCpfCnpj.mockResolvedValue({ id: "cus_existing", cpfCnpj: "12345678909" })
    const { createAsaasChargeInline } = await import("@/lib/journey/charge-inline")
    const r = await createAsaasChargeInline(jobData())

    expect(r.ok).toBe(true)
    expect(createAsaasCustomer).not.toHaveBeenCalled()
    expect(updateAsaasCustomer).toHaveBeenCalledTimes(1)
    expect(updateAsaasCustomer.mock.calls[0][0]).toBe("cus_existing")
    expect(createAsaasPayment.mock.calls[0][0].customer).toBe("cus_existing")
  })

  it("parcelado → envia installmentCount/installmentValue", async () => {
    const { createAsaasChargeInline } = await import("@/lib/journey/charge-inline")
    await createAsaasChargeInline(jobData({ installmentCount: 3, installmentValue: 30, value: 30 }))
    expect(createAsaasPayment.mock.calls[0][0]).toMatchObject({ installmentCount: 3, installmentValue: 30 })
  })

  it("idempotente: agreement com cobrança viva NÃO recria (devolve a existente)", async () => {
    db.agreements = [
      {
        id: AG,
        company_id: CO,
        asaas_payment_id: "pay_live",
        payment_status: "pending",
        asaas_status: "PENDING",
        asaas_invoice_url: "https://asaas/inv/pay_live",
      },
    ]
    const { createAsaasChargeInline } = await import("@/lib/journey/charge-inline")
    const r = await createAsaasChargeInline(jobData())

    expect(r.ok).toBe(true)
    expect(r.paymentId).toBe("pay_live")
    expect(r.invoiceUrl).toBe("https://asaas/inv/pay_live")
    // nenhuma criação no ASAAS
    expect(getAsaasCustomerByCpfCnpj).not.toHaveBeenCalled()
    expect(createAsaasCustomer).not.toHaveBeenCalled()
    expect(createAsaasPayment).not.toHaveBeenCalled()
  })

  it("falha no ASAAS não lança — retorna ok:false com error", async () => {
    createAsaasPayment.mockRejectedValue(new Error("asaas down"))
    const { createAsaasChargeInline } = await import("@/lib/journey/charge-inline")
    const r = await createAsaasChargeInline(jobData())
    expect(r.ok).toBe(false)
    expect(r.error).toContain("asaas down")
    expect(r.paymentId).toBeNull()
  })
})
