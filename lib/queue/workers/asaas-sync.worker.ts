import { Job } from 'bullmq';
import { WorkerManager } from '../worker-manager';
import { QUEUE_CONFIG } from '../config';
import {
  asaasRequest,
  incrementBatchCompleted,
  incrementBatchFailed,
  checkAndFinalizeBatch,
  startBatchProcessing,
  getSupabaseAdmin,
} from './asaas-api';
import { applyAsaasSyncResult } from './asaas-sync-apply';

export interface AsaasSyncJobData {
  batchId: string;
  jobIndex: number;
  // ASAAS payment ID
  asaasPaymentId: string;
  // Supabase tracking
  agreementId: string;
  debtId?: string;
  companyId?: string;
}

export const asaasSyncWorker = WorkerManager.registerWorker<AsaasSyncJobData>(
  QUEUE_CONFIG.asaasSync.name,
  async (job: Job<AsaasSyncJobData>) => {
    const { batchId, jobIndex, asaasPaymentId, agreementId, debtId } = job.data;

    console.log(`[ASAAS-SYNC] Processing job ${job.id} (batch: ${batchId}, index: ${jobIndex})`);
    console.log(`[ASAAS-SYNC] Syncing payment: ${asaasPaymentId}`);

    // Mark batch as processing on first job
    if (jobIndex === 0) {
      await startBatchProcessing(batchId);
    }

    try {
      // Fetch payment status from ASAAS
      const paymentResult = await asaasRequest(`/payments/${asaasPaymentId}`);

      if (!paymentResult.success) {
        throw new Error(`Payment not found: ${paymentResult.error}`);
      }

      const payment = paymentResult.data;
      console.log(`[ASAAS-SYNC] ASAAS status: ${payment.status}`);

      // Update Supabase records (Correção B10/A1: parcelado só quita com o
      // parcelamento inteiro pago — ver asaas-sync-apply.ts).
      const supabase = getSupabaseAdmin();
      const { agreementStatus, held } = await applyAsaasSyncResult(supabase, {
        agreementId,
        debtId,
        payment,
        listPayments: async (installmentId: string) => {
          const r = await asaasRequest(`/installments/${encodeURIComponent(installmentId)}/payments`);
          return r.success && Array.isArray(r.data?.data) ? r.data.data : null;
        },
      });
      if (held) console.log(`[ASAAS-SYNC] Agreement ${agreementId} parcelado mantido (${held})`);

      console.log(`[ASAAS-SYNC] Agreement ${agreementId} synced: ${agreementStatus}`);

      // Track batch completion
      const resultData = {
        jobIndex,
        paymentId: asaasPaymentId,
        agreementId,
        debtId,
        asaasStatus: payment.status,
        localStatus: agreementStatus,
        synced: true,
      };

      await incrementBatchCompleted(batchId, resultData);

      // Check if batch is complete
      const { isComplete, finalStatus } = await checkAndFinalizeBatch(batchId);
      if (isComplete) {
        console.log(`[ASAAS-SYNC] Batch ${batchId} completed with status: ${finalStatus}`);
      }

      return resultData;
    } catch (error: any) {
      console.error(`[ASAAS-SYNC] Job ${job.id} failed: ${error.message}`);

      // Track batch failure
      await incrementBatchFailed(batchId, {
        jobIndex,
        paymentId: asaasPaymentId,
        agreementId,
        debtId,
        error: error.message,
        timestamp: new Date().toISOString(),
      });

      // Check if batch is complete
      const { isComplete, finalStatus } = await checkAndFinalizeBatch(batchId);
      if (isComplete) {
        console.log(`[ASAAS-SYNC] Batch ${batchId} completed with status: ${finalStatus}`);
      }

      throw error;
    }
  },
  {
    concurrency: 5, // Higher concurrency for sync since it's mostly read operations
    limiter: QUEUE_CONFIG.asaasSync.limiter,
  }
);

asaasSyncWorker.on('completed', (job, result) => {
  console.log(`[ASAAS-SYNC] Job ${job.id} completed - Status: ${result.asaasStatus}`);
});

asaasSyncWorker.on('failed', (job, err) => {
  console.error(`[ASAAS-SYNC] Job ${job?.id} failed permanently: ${err.message}`);
});

asaasSyncWorker.on('error', (err) => {
  console.error('[ASAAS-SYNC] Worker error:', err.message);
});
