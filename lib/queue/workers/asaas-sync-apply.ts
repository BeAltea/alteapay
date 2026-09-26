// Aplicação do resultado do sync ASAAS → Supabase (worker asaas-sync), extraída
// do worker para ser testável sem registrar o BullMQ.
//
// Correção B10 (A1): num acordo PARCELADO (installments > 1) o status de UMA
// parcela nunca quita nem cancela o acordo sozinho. Vale o parcelamento inteiro
// (GET /installments/{id}/payments): quita só com TODAS as parcelas pagas;
// cancelamento/estorno de uma parcela com outra já paga fica para conciliação.
// Nesses casos o acordo e a dívida NÃO são tocados (só o carimbo do sync).
import { checkInstallmentHold, type InstallmentPaymentStatus } from '../../asaas-installments';

// Map ASAAS status to Supabase agreement status
function mapAsaasStatusToAgreement(asaasStatus: string): string {
  const statusMap: Record<string, string> = {
    PENDING: 'pending',
    RECEIVED: 'paid',
    CONFIRMED: 'paid',
    RECEIVED_IN_CASH: 'paid',
    OVERDUE: 'overdue',
    REFUND_REQUESTED: 'refund_requested',
    REFUNDED: 'refunded',
    CHARGEBACK_REQUESTED: 'chargeback_requested',
    CHARGEBACK_DISPUTE: 'chargeback_dispute',
    AWAITING_CHARGEBACK_REVERSAL: 'chargeback_dispute',
    DUNNING_REQUESTED: 'dunning',
    DUNNING_RECEIVED: 'dunning',
    AWAITING_RISK_ANALYSIS: 'pending',
  };

  return statusMap[asaasStatus] || 'unknown';
}

// Map ASAAS status to Supabase debt status
function mapAsaasStatusToDebt(asaasStatus: string): string {
  const statusMap: Record<string, string> = {
    PENDING: 'in_agreement',
    RECEIVED: 'paid',
    CONFIRMED: 'paid',
    RECEIVED_IN_CASH: 'paid',
    OVERDUE: 'in_agreement',
    REFUND_REQUESTED: 'open',
    REFUNDED: 'open',
    CHARGEBACK_REQUESTED: 'open',
    CHARGEBACK_DISPUTE: 'open',
    AWAITING_CHARGEBACK_REVERSAL: 'open',
    DUNNING_REQUESTED: 'in_agreement',
    DUNNING_RECEIVED: 'in_agreement',
    AWAITING_RISK_ANALYSIS: 'in_agreement',
  };

  return statusMap[asaasStatus] || 'open';
}

export interface ApplyAsaasSyncInput {
  agreementId: string;
  debtId?: string;
  payment: any;
  listPayments: (installmentId: string) => Promise<InstallmentPaymentStatus[] | null>;
}

export async function applyAsaasSyncResult(
  supabase: any,
  input: ApplyAsaasSyncInput
): Promise<{ agreementStatus: string; held: string | null }> {
  const { agreementId, debtId, payment } = input;

  const { data: agreement } = await supabase
    .from('agreements')
    .select('id, installments, asaas_subscription_id, status')
    .eq('id', agreementId)
    .maybeSingle();

  if (agreement && Number(agreement.installments ?? 1) > 1) {
    const installmentId = agreement.asaas_subscription_id ?? payment?.installment ?? null;
    const hold = await checkInstallmentHold({
      installments: agreement.installments,
      installmentId,
      status: payment?.deleted === true ? 'DELETED' : String(payment?.status ?? ''),
      listPayments: input.listPayments,
    });
    if (hold.hold) {
      await supabase
        .from('agreements')
        .update({
          last_synced_at: new Date().toISOString(),
          ...(!agreement.asaas_subscription_id && installmentId ? { asaas_subscription_id: installmentId } : {}),
        })
        .eq('id', agreementId);
      return { agreementStatus: agreement.status ?? 'unknown', held: hold.reason };
    }
  }

  const agreementStatus = mapAsaasStatusToAgreement(payment.status);
  const agreementUpdate: Record<string, any> = {
    status: agreementStatus,
    asaas_status: payment.status,
    updated_at: new Date().toISOString(),
    last_synced_at: new Date().toISOString(),
  };

  // Add payment-specific data if available
  if (payment.confirmedDate) {
    agreementUpdate.paid_at = payment.confirmedDate;
  }
  if (payment.paymentDate) {
    agreementUpdate.payment_date = payment.paymentDate;
  }
  if (payment.netValue !== undefined) {
    agreementUpdate.net_value = payment.netValue;
  }

  await supabase
    .from('agreements')
    .update(agreementUpdate)
    .eq('id', agreementId);

  // Update debt if exists
  if (debtId) {
    const debtStatus = mapAsaasStatusToDebt(payment.status);
    const debtUpdate: Record<string, any> = {
      status: debtStatus,
      updated_at: new Date().toISOString(),
    };

    if (payment.status === 'RECEIVED' || payment.status === 'CONFIRMED') {
      debtUpdate.paid_at = payment.confirmedDate || new Date().toISOString();
    }

    await supabase
      .from('debts')
      .update(debtUpdate)
      .eq('id', debtId);
  }

  return { agreementStatus, held: null };
}
