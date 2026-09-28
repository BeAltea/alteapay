// N8N-15 (b) — PIX copia-e-cola/QR e linha digitável do boleto na resposta do
// payment.create/payment.status ao n8n. ASAAS sempre mockado.

import { describe, expect, it, vi } from "vitest"
import {
  enrichN8nPaymentObject,
  enrichN8nPaymentResponse,
  fetchPaymentInstructions,
  type InstructionFetchers,
} from "@/lib/journey/payment-instructions"

const PIX_PAYLOAD = "00020101021226820014br.gov.bcb.pix2560qr.asaas.com/test5204000053039865802BR6304ABCD"
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

function fetchers(over: Partial<InstructionFetchers> = {}): InstructionFetchers {
  return {
    pix: vi.fn(async () => ({ payload: PIX_PAYLOAD, encodedImage: PNG_B64, expirationDate: "2026-10-04 23:59:59" })),
    boleto: vi.fn(async () => ({
      identificationField: "00190000090281913600966281313172600000000017100",
      nossoNumero: "6281313",
      barCode: "00190000000000171000000002819136006628131317",
    })),
    ...over,
  }
}

const createdPix = {
  ok: true, idempotent: false, status: "created",
  agreement_id: "agr-1", asaas_payment_id: "pay_abc", billing_type: "PIX",
  total_value: 17100, installments: 1, due_date: "2026-10-04",
  invoice_url: "https://www.asaas.com/i/abc",
  pix_copy_paste: null, pix_qr_code_url: null, boleto_url: null, boleto_line: null,
}

describe("payment.create → PIX", () => {
  it("resposta PIX traz o copia-e-cola, o QR (data URI) e a expiração", async () => {
    const f = fetchers()
    const body = await enrichN8nPaymentResponse(createdPix, { fetchers: f })
    expect(f.pix).toHaveBeenCalledWith("pay_abc")
    expect(f.boleto).not.toHaveBeenCalled()
    expect(body).toMatchObject({
      ok: true, status: "created", asaas_payment_id: "pay_abc",
      pix_copy_paste: PIX_PAYLOAD,
      pix_qr_image: `data:image/png;base64,${PNG_B64}`,
      pix_expiration: "2026-10-04 23:59:59",
      pix_pending: false,
      pix_fallback_url: null,
      invoice_url: "https://www.asaas.com/i/abc",
    })
  })

  it("timeout do PIX → pix_pending:true + invoice_url como fallback (nunca null sem explicação)", async () => {
    const f = fetchers({ pix: () => new Promise(() => {}) }) // nunca responde
    const t0 = Date.now()
    const body = await enrichN8nPaymentResponse(createdPix, { fetchers: f, timeoutMs: 30 })
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(body).toMatchObject({
      pix_copy_paste: null,
      pix_qr_image: null,
      pix_pending: true,
      pix_fallback_url: "https://www.asaas.com/i/abc",
      invoice_url: "https://www.asaas.com/i/abc",
    })
  })

  it("erro do ASAAS → pix_pending:true, e o payload nunca vai para o log", async () => {
    const warn = vi.spyOn(console, "warn")
    const f = fetchers({ pix: async () => { throw new Error(`boom ${PIX_PAYLOAD}`) } })
    const body = await enrichN8nPaymentResponse(createdPix, { fetchers: f })
    expect(body.pix_pending).toBe(true)
    // sucesso também não loga o payload
    await enrichN8nPaymentResponse(createdPix, { fetchers: fetchers() })
    const logged = JSON.stringify(warn.mock.calls)
    expect(logged).not.toContain(PIX_PAYLOAD)
    expect(logged).not.toContain(PNG_B64)
  })

  it("already_charged (link existente) também é enriquecido; processing/erro passam intactos", async () => {
    const f = fetchers()
    const ac = await enrichN8nPaymentResponse({ ...createdPix, status: "already_charged", payment_status: "pending" }, { fetchers: f })
    expect(ac.pix_copy_paste).toBe(PIX_PAYLOAD)

    const proc = { ok: true, status: "processing", agreement_id: "agr-1", poll_after_ms: 3000 }
    expect(await enrichN8nPaymentResponse(proc, { fetchers: f })).toEqual(proc)
    const err = { ok: false, code: "debt_not_acknowledged" }
    expect(await enrichN8nPaymentResponse(err, { fetchers: f })).toEqual(err)
    expect(f.pix).toHaveBeenCalledTimes(1)
  })
})

describe("payment.create → BOLETO / cartão", () => {
  it("boleto traz linha digitável e código de barras; boleto_url preservado", async () => {
    const f = fetchers()
    const body = await enrichN8nPaymentResponse(
      { ...createdPix, billing_type: "BOLETO", boleto_url: "https://www.asaas.com/b/pdf/abc", installments: 3 },
      { fetchers: f },
    )
    expect(f.pix).not.toHaveBeenCalled()
    expect(body).toMatchObject({
      boleto_url: "https://www.asaas.com/b/pdf/abc",
      boleto_line: "00190000090281913600966281313172600000000017100",
      boleto_barcode: "00190000000000171000000002819136006628131317",
      boleto_pending: false,
    })
    expect(body).not.toHaveProperty("pix_pending")
  })

  it("timeout da linha digitável → boleto_pending:true, boleto_url continua", async () => {
    const f = fetchers({ boleto: () => new Promise(() => {}) })
    const body = await enrichN8nPaymentResponse(
      { ...createdPix, billing_type: "BOLETO", boleto_url: "https://www.asaas.com/b/pdf/abc" },
      { fetchers: f, timeoutMs: 20 },
    )
    expect(body).toMatchObject({ boleto_line: null, boleto_pending: true, boleto_url: "https://www.asaas.com/b/pdf/abc" })
  })

  it("cartão: nenhuma consulta extra (invoice_url é o caminho)", async () => {
    const f = fetchers()
    const r = await fetchPaymentInstructions({ paymentId: "pay_x", billingType: "CREDIT_CARD", invoiceUrl: "u", fetchers: f })
    expect(r).toEqual({})
    expect(f.pix).not.toHaveBeenCalled()
    expect(f.boleto).not.toHaveBeenCalled()
  })
})

describe("payment.status → objeto payment aninhado", () => {
  it("PIX pendente é enriquecido; pago não é consultado", async () => {
    const f = fetchers()
    const payment = { agreement_id: "agr-1", payment_id: "pay_abc", billing_type: "PIX", invoice_url: "https://i", pix_copy_paste: null }
    const pending = await enrichN8nPaymentObject(payment, "pending", { fetchers: f })
    expect(pending?.pix_copy_paste).toBe(PIX_PAYLOAD)
    const paid = await enrichN8nPaymentObject(payment, "received", { fetchers: f })
    expect(paid).toEqual(payment)
    expect(await enrichN8nPaymentObject(null, null, { fetchers: f })).toBeNull()
    expect(f.pix).toHaveBeenCalledTimes(1)
  })
})

describe("mock ASAAS (MOCK_MODE) expõe pixQrCode e identificationField", () => {
  it("endpoints respondem com a forma do ASAAS", async () => {
    const { mockAsaasRequest } = await import("@/lib/integrations/asaas-mock")
    const pix = mockAsaasRequest("/payments/pay_mock_1/pixQrCode", "GET")
    expect(typeof pix.payload).toBe("string")
    expect(typeof pix.encodedImage).toBe("string")
    expect(typeof pix.expirationDate).toBe("string")
    const bol = mockAsaasRequest("/payments/pay_mock_1/identificationField", "GET")
    expect(bol.identificationField).toHaveLength(47)
    expect(typeof bol.barCode).toBe("string")
  })
})
