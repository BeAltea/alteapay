// R3 — resolução do PAGAR em `processing` (pay-poll.ts). A UI faz polling de
// GET /api/chat/payment; este módulo interpreta a resposta (só resolve p/ 'ready'
// com link REAL) e decide QUANDO oferecer a saída acionável (nunca espera muda
// infinita). NUNCA declara pago (M15): 'ready' = link existe, não "pago".
import { describe, expect, it } from "vitest"
import {
  interpretPaymentPoll,
  shouldOfferProcessingExit,
  PAY_POLL_MAX_ATTEMPTS,
} from "@/lib/journey/pay-poll"

describe("pay-poll — resolução do processing (R3)", () => {
  it("status 'ready' com invoiceUrl → resolve com link/valor/vencimento", () => {
    const out = interpretPaymentPoll({
      ok: true,
      status: "ready",
      payment: { invoiceUrl: "https://asaas/checkout/pay_1", total: 250, dueDate: "2026-09-27" },
    })
    expect(out.status).toBe("ready")
    if (out.status === "ready") {
      expect(out.link).toBe("https://asaas/checkout/pay_1")
      expect(out.valor).toBe(250)
      expect(out.vencimentoLink).toBe("2026-09-27")
    }
  })

  it("precedência do link: invoice › boleto › pix", () => {
    const boleto = interpretPaymentPoll({
      status: "ready",
      payment: { invoiceUrl: null, boletoUrl: "https://asaas/b/1", pixQrCodeUrl: "pixcopy", total: 100 },
    })
    expect(boleto.status === "ready" && boleto.link).toBe("https://asaas/b/1")
    const pix = interpretPaymentPoll({
      status: "ready",
      payment: { invoiceUrl: null, boletoUrl: null, pixQrCodeUrl: "pixcopy", total: 100 },
    })
    expect(pix.status === "ready" && pix.link).toBe("pixcopy")
  })

  it("status 'generating' → continua no poll (não resolve)", () => {
    expect(interpretPaymentPoll({ ok: true, status: "generating" }).status).toBe("generating")
  })

  it("status 'ready' mas SEM link real → continua 'generating' (não expõe bolha vazia)", () => {
    const out = interpretPaymentPoll({
      status: "ready",
      payment: { invoiceUrl: null, boletoUrl: null, pixQrCodeUrl: null, total: 250 },
    })
    expect(out.status).toBe("generating")
  })

  it("corpo malformado / ok:false / null → 'generating' (defensivo)", () => {
    expect(interpretPaymentPoll(null).status).toBe("generating")
    expect(interpretPaymentPoll(undefined).status).toBe("generating")
    expect(interpretPaymentPoll({ ok: false }).status).toBe("generating")
    expect(interpretPaymentPoll({ status: "ready", payment: null }).status).toBe("generating")
    expect(interpretPaymentPoll({} as never).status).toBe("generating")
  })

  it("valor/vencimento ausentes ainda resolvem se houver link (null-safe)", () => {
    const out = interpretPaymentPoll({ status: "ready", payment: { invoiceUrl: "https://x/1" } })
    expect(out.status).toBe("ready")
    if (out.status === "ready") {
      expect(out.valor).toBeNull()
      expect(out.vencimentoLink).toBeNull()
    }
  })

  it("saída acionável só passado o teto de tentativas (nunca espera muda infinita)", () => {
    expect(shouldOfferProcessingExit(0)).toBe(false)
    expect(shouldOfferProcessingExit(PAY_POLL_MAX_ATTEMPTS - 1)).toBe(false)
    expect(shouldOfferProcessingExit(PAY_POLL_MAX_ATTEMPTS)).toBe(true)
    expect(shouldOfferProcessingExit(PAY_POLL_MAX_ATTEMPTS + 5)).toBe(true)
  })
})
