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
//
// A1: o link é persistido como OUTCOME (bolha com ação open_payment_link +
// stage 'payment_link') e, logo após, o servidor persiste o prompt pós-link —
// a MESMA peça do PAGAR à vista (deliverPaymentOutcome em pay.ts), para o
// reload restaurar link + ações. QA round 1 (QAA1-02): sem link resolvível
// (acordo parcelado sem URL, guard nível-ASAAS), a MESMA peça persiste o
// outcome humano + menu curto — nunca `ok:true` sem outcome e sem prompt.

import {
  paymentCreateOrExistingLink,
  type PaymentCreateOrLink,
  type PaymentDetails,
} from "./payment-actions"
import type { SessionCtx } from "./actions"
import { deliverPaymentOutcome, type DeliveredPaymentOutcome } from "./pay"
import type { PromptView } from "./prompts"

/** Campos entregues junto do resultado (link resolvido + prompt ativo). */
interface DeliveredFields {
  link: string | null
  vencimento_link: string | null
  post_prompt_id: string | null
  prompt: PromptView | null
  link_message_id: string | null
}

export type AssistedAcceptResult =
  | ({ ok: true; status: "created"; agreementId: string; payment: PaymentDetails } & DeliveredFields)
  | { ok: true; status: "processing"; agreementId: string; pollAfterMs: number }
  // já cobrada: reenvia o LINK EXISTENTE (nunca recria a cobrança).
  | ({ ok: true; status: "already_charged"; payment: PaymentDetails | null; paymentStatus: string | null } & DeliveredFields)
  | { ok: false; status: number; code: string; message: string }

function fields(d: DeliveredPaymentOutcome): DeliveredFields {
  return { link: d.link, vencimento_link: d.vencimentoLink, post_prompt_id: d.postPromptId, prompt: d.prompt, link_message_id: d.linkMessageId ?? null }
}

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
    // Sem link ainda (worker gerando): não persiste nada — nasce depois no poll.
    return { ok: true, status: "processing", agreementId: r.agreement_id, pollAfterMs: r.poll_after_ms }
  }
  const alreadyCharged = r.status === "already_charged" || r.idempotent === true
  // G5/R7 — grava o link (existente ou recém-gerado) no histórico (idempotente):
  // reload restaura. QAA1-02: sem link, outcome humano + menu curto.
  const delivered = await deliverPaymentOutcome(ctx, {
    payment: r.payment,
    alreadyCharged,
    valor: r.payment?.total_value ?? null,
    debtIds: [ctx.debtId],
    primaryDebtId: ctx.debtId,
  })
  if (r.status === "already_charged") {
    return { ok: true, status: "already_charged", payment: r.payment, paymentStatus: r.payment_status, ...fields(delivered) }
  }
  return { ok: true, status: "created", agreementId: r.payment.agreement_id, payment: r.payment, ...fields(delivered) }
}
