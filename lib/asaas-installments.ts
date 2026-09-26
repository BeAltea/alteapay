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

// ---------------------------------------------------------------------------
// Correção B10 (A1/M1/M4) — decisão ÚNICA de quitação/cancelamento de um acordo
// PARCELADO, usada pelo webhook, pelo "Sincronizar com ASAAS"
// (/api/asaas/sync-payments) e pelo worker asaas-sync. Um status de UMA parcela
// nunca decide sozinho: vale o PARCELAMENTO inteiro (`GET /installments/{id}/
// payments` no ASAAS, e/ou os eventos PAGOS já recebidos por id do parcelamento).
// ---------------------------------------------------------------------------

/** Status ASAAS de uma cobrança paga. */
export const PAID_ASAAS_PAYMENT_STATUSES: ReadonlySet<string> = new Set([
  "RECEIVED",
  "CONFIRMED",
  "RECEIVED_IN_CASH",
  "DUNNING_RECEIVED",
])

/** Status/evento que desfaz a cobrança (cancelamento/estorno). */
export const DESTRUCTIVE_ASAAS_STATUSES: ReadonlySet<string> = new Set([
  "DELETED",
  "REFUNDED",
  "PAYMENT_DELETED",
  "PAYMENT_REFUNDED",
])

export interface InstallmentPaymentStatus {
  id?: string | null
  status?: string | null
  deleted?: boolean | null
}

/** Parcelas pagas × total esperado de um parcelamento. Pura. */
export function installmentSettlement(
  payments: InstallmentPaymentStatus[],
  installments: number | null | undefined,
): { paidCount: number; total: number; allPaid: boolean } {
  const paidIds = new Set<string>()
  let anon = 0
  for (const p of payments) {
    if (!PAID_ASAAS_PAYMENT_STATUSES.has(p.status ?? "")) continue
    if (p.id) paidIds.add(p.id)
    else anon += 1
  }
  const paidCount = paidIds.size + anon
  const total = Math.max(1, Math.trunc(Number(installments ?? 0)) || 0, payments.filter((p) => !p.deleted).length)
  return { paidCount, total, allPaid: paidCount >= total }
}

/** O acordo é parcelado (N > 1 ou já tem id de parcelamento)? Pura. */
export function isInstallmentAgreement(agreement: { installments?: number | null; asaas_subscription_id?: string | null }): boolean {
  return Number(agreement.installments ?? 1) > 1
}

export type InstallmentHoldReason =
  | "installment_not_fully_paid"
  | "installment_partial_cancel"
  | "installment_unknown"

/**
 * Decide se o status de UMA parcela deve ser SEGURADO (não aplicado ao acordo):
 *  - PAGO: só passa quando TODAS as parcelas do parcelamento estão pagas;
 *    parcelamento desconhecido ou ASAAS indisponível → segura (nunca quita no
 *    escuro — o webhook/conciliação decide depois);
 *  - DELETED/REFUNDED com outra parcela já paga → segura (M4: uma baixa parcial
 *    não reabre o valor cheio sem conciliação);
 *  - demais status → não segura.
 * `listPayments` consulta o parcelamento no ASAAS (null = falhou).
 */
export async function checkInstallmentHold(input: {
  installments: number | null | undefined
  installmentId: string | null | undefined
  /** status ASAAS da parcela (ou evento de webhook). */
  status: string
  listPayments: (installmentId: string) => Promise<InstallmentPaymentStatus[] | null>
  /** ids de parcelas pagas já conhecidos localmente (eventos de webhook). */
  knownPaidPaymentIds?: Array<string | null | undefined>
}): Promise<{ hold: false } | { hold: true; reason: InstallmentHoldReason; paidCount?: number; total?: number }> {
  if (Number(input.installments ?? 1) <= 1) return { hold: false }
  const statusKey = input.status.replace(/^PAYMENT_/, "")
  const paid = PAID_ASAAS_PAYMENT_STATUSES.has(statusKey)
  const destructive = DESTRUCTIVE_ASAAS_STATUSES.has(input.status) || DESTRUCTIVE_ASAAS_STATUSES.has(statusKey)
  if (!paid && !destructive) return { hold: false }
  const known = new Set((input.knownPaidPaymentIds ?? []).filter((v): v is string => !!v))
  const total = Math.max(1, Math.trunc(Number(input.installments)))

  if (paid && known.size >= total) return { hold: false }

  let list: InstallmentPaymentStatus[] | null = null
  if (input.installmentId) {
    try {
      list = await input.listPayments(input.installmentId)
    } catch {
      list = null
    }
  }
  if (!list) {
    if (paid) return { hold: true, reason: "installment_unknown", paidCount: known.size, total }
    // cancelamento sem como consultar: segura só se já há parcela paga conhecida.
    return known.size > 0
      ? { hold: true, reason: "installment_partial_cancel", paidCount: known.size, total }
      : { hold: false }
  }
  const merged = [...list, ...[...known].filter((id) => !list!.some((p) => p.id === id)).map((id) => ({ id, status: "RECEIVED" }))]
  const s = installmentSettlement(merged, input.installments)
  if (paid) {
    return s.allPaid ? { hold: false } : { hold: true, reason: "installment_not_fully_paid", paidCount: s.paidCount, total: s.total }
  }
  return s.paidCount > 0
    ? { hold: true, reason: "installment_partial_cancel", paidCount: s.paidCount, total: s.total }
    : { hold: false }
}

/** Parcelas de um parcelamento no ASAAS (null = falha). Server-only. */
export async function fetchInstallmentPayments(installmentId: string): Promise<InstallmentPaymentStatus[] | null> {
  try {
    const asaas = await import("@/lib/asaas")
    return await asaas.getAsaasInstallmentPayments(installmentId)
  } catch {
    return null
  }
}
