import { describe, expect, it } from "vitest"
import {
  ALLOWED_METADATA_KEYS,
  buildMetadata,
  buildTransactionPayload,
  classifyVoxuyResponse,
} from "@/lib/whatsapp/voxuy/provider"
import { ALTEAPAY_ORDER_STATUS, ALTEAPAY_PAYMENT_TYPE } from "@/lib/whatsapp/voxuy/enums"

const baseMeta = {
  consult_url: "https://alteapay.com/c/AbC123",
  brand_name: "AlteaPay",
  creditor_name: "VMAX",
  first_name: "Fabio",
}

describe("buildMetadata (V2.2 — rejeita chave não prevista)", () => {
  it("aceita exatamente as chaves do Apêndice B.2", () => {
    const m = buildMetadata({ ...baseMeta, optout_url: "https://x/c/a/cancelar", block_url: "https://x/c/a/bloquear" })
    expect(Object.keys(m).sort()).toEqual([...ALLOWED_METADATA_KEYS].sort())
  })

  it("REJEITA qualquer chave não prevista (defesa contra PII acidental)", () => {
    expect(() => buildMetadata({ ...baseMeta, cpf: "12345678901" })).toThrow(/chave não permitida/)
    expect(() => buildMetadata({ ...baseMeta, valor: "6990" })).toThrow(/chave não permitida/)
    expect(() => buildMetadata({ ...baseMeta, clientDocument: "x" })).toThrow(/não permitida/)
  })

  it("exige consult_url e brand_name", () => {
    expect(() => buildMetadata({ brand_name: "X" })).toThrow(/consult_url/)
    expect(() => buildMetadata({ consult_url: "https://x" })).toThrow(/brand_name/)
  })

  it("rejeita valor não-string", () => {
    expect(() => buildMetadata({ ...baseMeta, consult_url: 1 as unknown as string })).toThrow()
  })
})

describe("buildTransactionPayload (A.4 — payload canônico)", () => {
  const payload = buildTransactionPayload({
    apiToken: "tok",
    id: "11111111-2222-3333-4444-555555555555",
    planId: "plan_x",
    customEvent: 63,
    clientName: "Fabio",
    clientPhoneNumber: "+5511912341234",
    metadata: baseMeta,
  })

  it("fixa paymentType=99 e status=99", () => {
    expect(payload.paymentType).toBe(ALTEAPAY_PAYMENT_TYPE)
    expect(payload.status).toBe(ALTEAPAY_ORDER_STATUS)
    expect(payload.paymentType).toBe(99)
    expect(payload.status).toBe(99)
  })

  it("date=null e value/totalValue/freight=null (mensagem sem valor)", () => {
    expect(payload.date).toBeNull()
    expect(payload.value).toBeNull()
    expect(payload.totalValue).toBeNull()
    expect(payload.freight).toBeNull()
  })

  it("clientDocument e clientEmail são null (V6 — zero PII)", () => {
    expect(payload.clientDocument).toBeNull()
    expect(payload.clientEmail).toBeNull()
  })

  it("campos nativos de pagamento null nesta onda (V9)", () => {
    expect(payload.checkoutUrl).toBeNull()
    expect(payload.paymentLine).toBeNull()
    expect(payload.boletoUrl).toBeNull()
    expect(payload.pixQrCode).toBeNull()
    expect(payload.pixUrl).toBeNull()
  })

  it("id é estável = whatsapp_messages.id (idempotência de envio)", () => {
    expect(payload.id).toBe("11111111-2222-3333-4444-555555555555")
  })

  it("rejeita telefone fora de E.164", () => {
    expect(() =>
      buildTransactionPayload({
        apiToken: "tok",
        id: "x",
        planId: "p",
        customEvent: 1,
        clientName: "Fabio",
        clientPhoneNumber: "11912341234",
        metadata: baseMeta,
      }),
    ).toThrow()
  })

  it("nunca serializa clientDocument no JSON de saída", () => {
    const json = JSON.stringify(payload)
    // clientDocument existe como null (contrato), mas nunca com um valor
    expect(json).toContain('"clientDocument":null')
    expect(json).not.toMatch(/"clientDocument":"[^"]/)
  })
})

describe("classifyVoxuyResponse (§1.5)", () => {
  it("200 { Success: true } => aceito", () => {
    expect(classifyVoxuyResponse(200, { Success: true }, true)).toMatchObject({ accepted: true })
  })

  it("200 case-insensitive (success minúsculo) => aceito", () => {
    expect(classifyVoxuyResponse(200, { success: true }, true).accepted).toBe(true)
  })

  it("200 com corpo inesperado => aceito + note unexpected_body", () => {
    const r = classifyVoxuyResponse(200, { message: "queued" }, true)
    expect(r.accepted).toBe(true)
    expect(r.note).toBe("unexpected_body")
  })

  it("400 => validação, guarda traceId e nomes dos campos (não valores)", () => {
    const body = {
      errors: { clientPhoneNumber: ["The clientPhoneNumber field is required."] },
      traceId: "0HM8U2U27H831:00000001",
      status: 400,
    }
    const r = classifyVoxuyResponse(400, body, true)
    expect(r.accepted).toBe(false)
    expect(r.errorClass).toBe("validation")
    expect(r.traceId).toBe("0HM8U2U27H831:00000001")
    expect(r.errorFields).toEqual(["clientPhoneNumber"])
  })

  it("401/403 => config (pausa a campanha)", () => {
    expect(classifyVoxuyResponse(401, {}, true).errorClass).toBe("config")
    expect(classifyVoxuyResponse(403, {}, true).errorClass).toBe("config")
  })

  it("429/5xx => retryable (backoff do BullMQ)", () => {
    expect(classifyVoxuyResponse(429, {}, true).errorClass).toBe("retryable")
    expect(classifyVoxuyResponse(500, {}, false).errorClass).toBe("retryable")
    expect(classifyVoxuyResponse(503, {}, false).errorClass).toBe("retryable")
  })
})
