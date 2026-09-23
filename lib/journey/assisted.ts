// Aceite explícito de uma condição da matriz no caminho ASSISTIDO
// (NEGOTIATION_ENGINE=disabled) — a REDE DE SEGURANÇA da jornada.
//
// Quando o n8n não está plugado (GATE X0 pendente), o chat determinístico ainda
// tem que FECHAR: o cliente escolhe uma oferta da matriz e confirma. Este módulo
// converte esse aceite na MESMA cobrança interna do papel A (paymentCreate) —
// mesma validação de matriz (fora da matriz → 422), mesmo guard de
// reconhecimento (409), mesmo guard de idempotência/already_charged (reenvia o
// link existente, nunca recria) e o MESMO registro (closeAgreement → acceptances
// → eventos). Assim a jornada fecha com OU sem n8n, e o teste ponta-a-ponta não
// fica preso ao GATE do n8n.
//
// NÃO reimplementa charge: reusa paymentCreateOrExistingLink (charge-inline via
// closeAgreement quando CHARGE_MODE=inline). NÃO decide desconto/parcela — só
// aceita o que a matriz gerou (D8).

import {
  paymentCreateOrExistingLink,
  type PaymentCreateOrLink,
  type PaymentDetails,
} from "./payment-actions"
import type { SessionCtx } from "./actions"

export type AssistedAcceptResult =
  | { ok: true; status: "created"; agreementId: string; payment: PaymentDetails }
  | { ok: true; status: "processing"; agreementId: string; pollAfterMs: number }
  // já cobrada: reenvia o LINK EXISTENTE (nunca recria a cobrança).
  | { ok: true; status: "already_charged"; payment: PaymentDetails | null; paymentStatus: string | null }
  | { ok: false; status: number; code: string; message: string }

/**
 * Aceite assistido de uma oferta apresentada (negotiation_offers.id) → cobrança
 * pela plataforma, pelo MESMO caminho interno do n8n (payment.create). Devolve o
 * link quando pronto (inline), 'processing' quando o worker ainda não gravou as
 * URLs, ou 'already_charged' com o link existente.
 */
export async function acceptMatrixCondition(
  ctx: SessionCtx,
  offerId: string,
  eventId?: string,
): Promise<AssistedAcceptResult> {
  const r: PaymentCreateOrLink = await paymentCreateOrExistingLink(ctx, offerId, eventId)
  if (!r.ok) return r
  if (r.status === "processing") {
    return { ok: true, status: "processing", agreementId: r.agreement_id, pollAfterMs: r.poll_after_ms }
  }
  if (r.status === "already_charged") {
    return { ok: true, status: "already_charged", payment: r.payment, paymentStatus: r.payment_status }
  }
  return { ok: true, status: "created", agreementId: r.payment.agreement_id, payment: r.payment }
}
