// QA rodada 6 (Q4r2-03, ALTO) — PARCELAMENTO ASAAS ↔ ACORDO.
//
// Um acordo parcelado da jornada gera UM parcelamento no ASAAS (POST /payments
// com installmentCount): N cobranças que compartilham `payment.installment` (id
// do parcelamento) e a `externalReference` (`journey_{sessão}_{oferta}`). O
// acordo local guardava só o `asaas_payment_id` da parcela 1, então:
//   - os webhooks das parcelas 2..N não achavam o acordo ("Agreement not found");
//   - pagar SÓ a parcela 1 marcava o acordo `completed`, a dívida `paid` e a VMAX
//     `PAGO` (baixa indevida).
//
// Correção sem migration: o id do parcelamento é gravado na coluna EXISTENTE
// `agreements.asaas_subscription_id` (não há `asaas_installment_id`; o webhook já
// casava por essa coluna para assinaturas). Os webhooks casam por ela e, para
// acordos criados antes desta correção, pela `externalReference` da jornada
// (sessão + oferta). Um evento de PAGO numa parcela só fecha o acordo quando
// TODAS as parcelas estão pagas; antes disso nada é declarado pago.

/** Eventos ASAAS que significam PAGO (D13). */
export const PAID_ASAAS_EVENTS: ReadonlySet<string> = new Set([
  "PAYMENT_RECEIVED",
  "PAYMENT_CONFIRMED",
  "PAYMENT_RECEIVED_IN_CASH",
  "PAYMENT_DUNNING_RECEIVED",
])

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
const JOURNEY_REF = new RegExp(`^journey_(${UUID})_(${UUID})$`, "i")

/** `journey_{sessão}_{oferta}` → ids; qualquer outro formato → null. Pura. */
export function parseJourneyExternalReference(
  ref: string | null | undefined,
): { sessionId: string; offerId: string } | null {
  if (typeof ref !== "string") return null
  const m = JOURNEY_REF.exec(ref.trim())
  return m ? { sessionId: m[1].toLowerCase(), offerId: m[2].toLowerCase() } : null
}

export interface InstallmentPaymentLike {
  id: string
  installment?: string | null
  installmentNumber?: number | null
}

export interface InstallmentAgreementLike {
  id: string
  installments?: number | null
  asaas_payment_id?: string | null
}

/** A cobrança é uma PARCELA de um acordo parcelado (N > 1)? Pura. */
export function isInstallmentCharge(
  payment: InstallmentPaymentLike,
  agreement: InstallmentAgreementLike,
): boolean {
  return !!payment.installment && Number(agreement.installments ?? 1) > 1
}

/**
 * Esta parcela paga QUITA o acordo? Só quando o nº de parcelas distintas pagas
 * (as já processadas para o acordo + a atual) alcança o total. Pagamento fora de
 * ordem também conta certo. Pura.
 */
export function isFinalInstallmentPaid(input: {
  installments: number
  priorPaidPaymentIds: Array<string | null | undefined>
  currentPaymentId: string
}): boolean {
  const paid = new Set(input.priorPaidPaymentIds.filter((v): v is string => !!v))
  paid.add(input.currentPaymentId)
  return paid.size >= Math.max(1, Math.trunc(input.installments))
}

/**
 * Campos do espelho que pertencem à PARCELA 1 (a cobrança que o acordo exibe:
 * link, vencimento). Eventos de outras parcelas não os sobrescrevem. Pura.
 */
export function isFirstInstallmentOf(
  payment: InstallmentPaymentLike,
  agreement: InstallmentAgreementLike,
): boolean {
  if (agreement.asaas_payment_id && agreement.asaas_payment_id === payment.id) return true
  return payment.installmentNumber === 1
}
