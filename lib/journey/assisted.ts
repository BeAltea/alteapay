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
import { persistAssistantMessage } from "./acknowledgement"
import { payLinkMessageText } from "./pay"

/** Melhor URL de pagamento: invoice (checkout ASAAS) › boleto › PIX copia-e-cola. */
function linkOf(p: PaymentDetails | null): string | null {
  if (!p) return null
  return p.invoice_url ?? p.boleto_url ?? p.pix_copy_paste ?? null
}

/**
 * G5/R7 (trilha offer_choice) — persiste a mensagem do link no histórico da sessão
 * também no ACEITE de uma parcela da matriz (não só no PAGAR à vista). Reusa a MESMA
 * copy (payLinkMessageText) e o MESMO persistAssistantMessage (idempotente por
 * conteúdo) do payService, para o reload/reuso restaurar o link (M11) neste ramo.
 * Best-effort: uma falha aqui NÃO derruba o aceite (o link já volta no corpo do POST).
 * NUNCA declara pago (M15). Sem PII (só valor/vencimento/URL).
 */
async function persistOfferLinkMessage(
  ctx: SessionCtx,
  payment: PaymentDetails | null,
  alreadyCharged: boolean,
): Promise<void> {
  const link = linkOf(payment)
  if (!link) return
  try {
    await persistAssistantMessage({
      companyId: ctx.companyId,
      sessionId: ctx.sessionId,
      text: payLinkMessageText({
        link,
        valor: payment?.total_value ?? null,
        vencimentoLink: payment?.due_date ?? null,
        alreadyCharged,
      }),
    })
  } catch (err) {
    console.warn("[journey] persistOfferLinkMessage falhou (não fatal):", (err as Error).message)
  }
}

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
    // Sem link ainda (worker gerando): não persiste nada — nasce depois no poll.
    return { ok: true, status: "processing", agreementId: r.agreement_id, pollAfterMs: r.poll_after_ms }
  }
  if (r.status === "already_charged") {
    // G5/R7 — grava o link existente no histórico (idempotente): reload restaura.
    await persistOfferLinkMessage(ctx, r.payment, true)
    return { ok: true, status: "already_charged", payment: r.payment, paymentStatus: r.payment_status }
  }
  // G5/R7 — grava o link recém-gerado no histórico (idempotente): reload restaura.
  await persistOfferLinkMessage(ctx, r.payment, false)
  return { ok: true, status: "created", agreementId: r.payment.agreement_id, payment: r.payment }
}
