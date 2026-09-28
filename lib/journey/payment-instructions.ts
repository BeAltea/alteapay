// N8N-15 (b) — instruções de pagamento (PIX copia-e-cola / QR, linha digitável
// do boleto) para a borda n8n.
//
// Causa do `pix_copy_paste: null`: o objeto de pagamento do ASAAS (POST/GET
// /payments) NÃO tem copia-e-cola nem QR. A coluna `asaas_pix_qrcode_url` era
// preenchida com `asaasPayment.pixQrCodeUrl`, campo que só o mock devolve —
// em produção é sempre null. O PIX só vem de `GET /payments/{id}/pixQrCode`
// ({payload, encodedImage, expirationDate}); a linha digitável do boleto só vem
// de `GET /payments/{id}/identificationField`.
//
// O web chat não precisa disso (manda o devedor ao `invoice_url`, cujo checkout
// ASAAS mostra PIX e boleto). Só a borda n8n busca, sob demanda, com prazo curto:
// estourou/falhou → `pix_pending: true` + `pix_fallback_url` (= invoice_url),
// nunca null sem explicação. Nada é persistido (o payload não vai para a base).
//
// PII/segurança: NUNCA logar o payload PIX, a imagem ou a linha digitável.

import { getAsaasIdentificationField, getAsaasPixQrCode } from "@/lib/asaas"

export const PAYMENT_INSTRUCTIONS_TIMEOUT_MS = 2500

export interface PixInstructions {
  pix_copy_paste: string | null
  /** PNG do QR como data URI (`data:image/png;base64,...`). */
  pix_qr_image: string | null
  pix_expiration: string | null
  /** true quando o PIX não pôde ser obtido agora (prazo/erro): use o fallback. */
  pix_pending: boolean
  /** Link do checkout ASAAS (mostra o PIX) — use quando `pix_pending`. */
  pix_fallback_url: string | null
}

export interface BoletoInstructions {
  /** Linha digitável (identificationField). */
  boleto_line: string | null
  boleto_barcode: string | null
  /** true quando a linha digitável não pôde ser obtida agora (prazo/erro). */
  boleto_pending: boolean
}

export type PaymentInstructions = Partial<PixInstructions & BoletoInstructions>

export interface InstructionFetchers {
  pix: (paymentId: string) => Promise<{ payload?: string | null; encodedImage?: string | null; expirationDate?: string | null }>
  boleto: (paymentId: string) => Promise<{ identificationField?: string | null; barCode?: string | null }>
}

const defaultFetchers: InstructionFetchers = {
  pix: getAsaasPixQrCode,
  boleto: getAsaasIdentificationField,
}

class InstructionsTimeout extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new InstructionsTimeout("timeout")), ms)
  })
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)

function toDataUri(encodedImage: string | null): string | null {
  if (!encodedImage) return null
  return encodedImage.startsWith("data:") ? encodedImage : `data:image/png;base64,${encodedImage}`
}

/**
 * Busca as instruções da cobrança conforme o billing type. PIX → copia-e-cola,
 * QR e expiração; BOLETO → linha digitável e código de barras; outros (cartão)
 * → nada (o `invoice_url` já é o caminho). Nunca lança.
 */
export async function fetchPaymentInstructions(input: {
  paymentId: string | null | undefined
  billingType: string | null | undefined
  invoiceUrl: string | null | undefined
  timeoutMs?: number
  fetchers?: InstructionFetchers
}): Promise<PaymentInstructions> {
  const paymentId = input.paymentId
  const billing = (input.billingType ?? "").toUpperCase()
  if (!paymentId) return {}
  const fetchers = input.fetchers ?? defaultFetchers
  const ms = input.timeoutMs ?? PAYMENT_INSTRUCTIONS_TIMEOUT_MS

  if (billing === "PIX") {
    try {
      const r = await withTimeout(fetchers.pix(paymentId), ms)
      const payload = str(r?.payload)
      return {
        pix_copy_paste: payload,
        pix_qr_image: toDataUri(str(r?.encodedImage)),
        pix_expiration: str(r?.expirationDate),
        pix_pending: !payload,
        pix_fallback_url: payload ? null : input.invoiceUrl ?? null,
      }
    } catch (err) {
      // só o motivo curto — nunca o conteúdo PIX.
      console.warn(
        `[payment-instructions] PIX indisponível para ${paymentId}:`,
        err instanceof InstructionsTimeout ? "timeout" : "erro ASAAS",
      )
      return {
        pix_copy_paste: null,
        pix_qr_image: null,
        pix_expiration: null,
        pix_pending: true,
        pix_fallback_url: input.invoiceUrl ?? null,
      }
    }
  }

  if (billing === "BOLETO") {
    try {
      const r = await withTimeout(fetchers.boleto(paymentId), ms)
      const line = str(r?.identificationField)
      return { boleto_line: line, boleto_barcode: str(r?.barCode), boleto_pending: !line }
    } catch (err) {
      console.warn(
        `[payment-instructions] linha digitável indisponível para ${paymentId}:`,
        err instanceof InstructionsTimeout ? "timeout" : "erro ASAAS",
      )
      return { boleto_line: null, boleto_barcode: null, boleto_pending: true }
    }
  }

  return {}
}

const PAID_OR_DEAD = new Set([
  "received", "confirmed", "paid", "refunded", "cancelled",
  "RECEIVED", "CONFIRMED", "RECEIVED_IN_CASH", "REFUNDED", "DELETED",
])

/**
 * Enriquece o corpo PLANO de resposta do `payment.create` ao n8n
 * (`asaas_payment_id`, `billing_type`, `invoice_url` no topo) com as instruções.
 * Só para respostas `ok` com cobrança (`created` / `already_charged`); `processing`
 * e erros passam intactos. Pagamento já pago/morto não é consultado.
 */
export async function enrichN8nPaymentResponse(
  body: Record<string, unknown>,
  opts: { timeoutMs?: number; fetchers?: InstructionFetchers } = {},
): Promise<Record<string, unknown>> {
  if (body.ok !== true) return body
  if (body.status !== "created" && body.status !== "already_charged") return body
  if (typeof body.payment_status === "string" && PAID_OR_DEAD.has(body.payment_status)) return body
  const extra = await fetchPaymentInstructions({
    paymentId: body.asaas_payment_id as string | null | undefined,
    billingType: body.billing_type as string | null | undefined,
    invoiceUrl: body.invoice_url as string | null | undefined,
    ...opts,
  })
  return mergeInstructions(body, extra)
}

/**
 * Mesmo enriquecimento para o objeto `payment` (aninhado) do `payment.status`
 * (chaves `payment_id` / `billing_type` / `invoice_url`).
 */
export async function enrichN8nPaymentObject(
  payment: Record<string, unknown> | null,
  paymentStatus: string | null | undefined,
  opts: { timeoutMs?: number; fetchers?: InstructionFetchers } = {},
): Promise<Record<string, unknown> | null> {
  if (!payment) return payment
  if (paymentStatus && PAID_OR_DEAD.has(paymentStatus)) return payment
  const extra = await fetchPaymentInstructions({
    paymentId: payment.payment_id as string | null | undefined,
    billingType: payment.billing_type as string | null | undefined,
    invoiceUrl: payment.invoice_url as string | null | undefined,
    ...opts,
  })
  return mergeInstructions(payment, extra)
}

/** As instruções obtidas do ASAAS são a fonte: substituem o `pix_copy_paste`
 *  herdado da coluna `asaas_pix_qrcode_url` (null em produção — ver topo) e o
 *  `boleto_line` (nunca persistido). `boleto_url`/`invoice_url` não são tocados. */
function mergeInstructions(
  base: Record<string, unknown>,
  extra: PaymentInstructions,
): Record<string, unknown> {
  return { ...base, ...extra }
}
