import { Job } from 'bullmq';
import { WorkerManager } from '../worker-manager';
import { QUEUE_CONFIG, ASAAS_NOTIFICATION_DEFAULTS } from '../config';
import { emailQueue } from '../queues';
import {
  asaasRequest,
  incrementBatchCompleted,
  incrementBatchFailed,
  checkAndFinalizeBatch,
  startBatchProcessing,
  getSupabaseAdmin,
} from './asaas-api';

export interface AsaasChargeCreateJobData {
  batchId: string;
  jobIndex: number;
  // Customer info
  customer: {
    name: string;
    cpfCnpj: string;
    email?: string;
    phone?: string;
    mobilePhone?: string;
    postalCode?: string;
    address?: string;
    addressNumber?: string;
    province?: string;
  };
  // Payment info
  payment: {
    billingType: 'BOLETO' | 'PIX' | 'CREDIT_CARD' | 'UNDEFINED';
    value: number;
    dueDate: string; // YYYY-MM-DD
    description?: string;
    externalReference?: string;
    installmentCount?: number;
    installmentValue?: number;
  };
  // Supabase tracking
  agreementId?: string;
  debtId?: string;
  companyId?: string;
  // Email notification
  sendEmail?: boolean;
  emailTemplate?: {
    subject: string;
    html: string;
  };
}

async function findOrCreateCustomer(
  customerData: AsaasChargeCreateJobData['customer']
): Promise<{ success: boolean; data?: any; error?: string }> {
  // First, try to find existing customer by CPF/CNPJ
  const searchResult = await asaasRequest(`/customers?cpfCnpj=${customerData.cpfCnpj}`);

  if (searchResult.success && searchResult.data?.data?.[0]) {
    console.log(`[ASAAS-CREATE] Found existing customer: ${searchResult.data.data[0].id}`);
    return { success: true, data: searchResult.data.data[0] };
  }

  // Create new customer
  console.log(`[ASAAS-CREATE] Creating new customer for CPF/CNPJ: ${customerData.cpfCnpj}`);

  const cleanData = Object.fromEntries(
    Object.entries({
      ...customerData,
      notificationDisabled: false,
    }).filter(([_, v]) => v !== undefined && v !== '')
  );

  return asaasRequest('/customers', 'POST', cleanData);
}

async function configureNotifications(customerId: string): Promise<void> {
  try {
    const result = await asaasRequest(`/customers/${customerId}/notifications`);

    if (!result.success || !result.data?.data) {
      console.warn(`[ASAAS-CREATE] Could not fetch notifications for customer ${customerId}`);
      return;
    }

    const notifications = result.data.data;

    const paymentCreated = notifications.find(
      (n: any) => n.event === 'PAYMENT_CREATED' && (n.scheduleOffset === 0 || !n.scheduleOffset)
    );

    if (paymentCreated) {
      await asaasRequest(`/notifications/${paymentCreated.id}`, 'PUT', ASAAS_NOTIFICATION_DEFAULTS);
      console.log(`[ASAAS-CREATE] Configured ASAAS notifications (WhatsApp + SMS, no email)`);
    }
  } catch (error: any) {
    console.warn(`[ASAAS-CREATE] Failed to configure notifications: ${error.message}`);
  }
}

async function updateSupabaseRecords(
  jobData: AsaasChargeCreateJobData,
  asaasPayment: any,
  asaasCustomerId: string
) {
  const supabase = getSupabaseAdmin();

  // Update agreement if exists
  // IMPORTANT: Also save the due_date from ASAAS response to ensure it's persisted
  if (jobData.agreementId) {
    await (supabase as any)
      .from('agreements')
      .update({
        asaas_payment_id: asaasPayment.id,
        asaas_customer_id: asaasCustomerId,
        asaas_invoice_url: asaasPayment.invoiceUrl,
        asaas_boleto_url: asaasPayment.bankSlipUrl,
        asaas_pix_qrcode_url: asaasPayment.pixQrCodeUrl,
        due_date: asaasPayment.dueDate || null,
        // QA rodada 6 (Q4r2-03): id do parcelamento (webhook das parcelas 2..N).
        ...(asaasPayment.installment ? { asaas_subscription_id: asaasPayment.installment } : {}),
        status: 'pending',
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobData.agreementId);
  }

  // Update debt if exists
  if (jobData.debtId) {
    await (supabase as any)
      .from('debts')
      .update({
        status: 'in_agreement',
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobData.debtId);
  }
}

export const asaasChargeCreateWorker = WorkerManager.registerWorker<AsaasChargeCreateJobData>(
  QUEUE_CONFIG.asaasChargeCreate.name,
  async (job: Job<AsaasChargeCreateJobData>) => {
    const { batchId, jobIndex, customer, payment, agreementId, debtId, sendEmail, emailTemplate } = job.data;

    console.log(`[ASAAS-CREATE] Processing job ${job.id} (batch: ${batchId}, index: ${jobIndex})`);
    console.log(`[ASAAS-CREATE] Customer: ${customer.name} (${customer.cpfCnpj})`);
    console.log(`[ASAAS-CREATE] Payment: R$ ${payment.value.toFixed(2)} - ${payment.billingType} - Due: ${payment.dueDate}`);

    // Mark batch as processing on first job
    if (jobIndex === 0) {
      await startBatchProcessing(batchId);
    }

    try {
      // Step 1: Find or create customer
      const customerResult = await findOrCreateCustomer(customer);

      if (!customerResult.success) {
        throw new Error(`Customer error: ${customerResult.error}`);
      }

      const asaasCustomerId = customerResult.data.id;
      console.log(`[ASAAS-CREATE] Customer ID: ${asaasCustomerId}`);

      // Step 2: Configure notifications
      await configureNotifications(asaasCustomerId);

      // Step 3: Create payment
      const paymentData: Record<string, any> = {
        customer: asaasCustomerId,
        billingType: payment.billingType,
        value: payment.value,
        dueDate: payment.dueDate,
        description: payment.description,
        externalReference: payment.externalReference || agreementId,
      };

      // Add installment info if present
      if (payment.installmentCount && payment.installmentCount > 1) {
        paymentData.installmentCount = payment.installmentCount;
        paymentData.installmentValue = payment.installmentValue;
      }

      const paymentResult = await asaasRequest('/payments', 'POST', paymentData);

      if (!paymentResult.success) {
        throw new Error(`Payment error: ${paymentResult.error}`);
      }

      const asaasPayment = paymentResult.data;
      console.log(`[ASAAS-CREATE] Payment created: ${asaasPayment.id}`);

      // Step 4: Update Supabase records
      await updateSupabaseRecords(job.data, asaasPayment, asaasCustomerId);

      // Step 5: Queue email notification if requested
      if (sendEmail && emailTemplate && customer.email) {
        // Ensure email worker is running before adding job
        await WorkerManager.ensureWorkerRunning(QUEUE_CONFIG.email.name);

        await emailQueue.add(
          `charge-email-${asaasPayment.id}`,
          {
            to: customer.email,
            subject: emailTemplate.subject,
            html: emailTemplate.html,
            metadata: {
              chargeId: asaasPayment.id,
              customerId: asaasCustomerId,
              type: 'charge_created',
            },
          },
          { priority: 2 }
        );
      }

      // Step 6: Track batch completion
      const resultData = {
        jobIndex,
        paymentId: asaasPayment.id,
        customerId: asaasCustomerId,
        invoiceUrl: asaasPayment.invoiceUrl,
        agreementId,
        debtId,
      };

      await incrementBatchCompleted(batchId, resultData);

      // Check if batch is complete
      const { isComplete, finalStatus } = await checkAndFinalizeBatch(batchId);
      if (isComplete) {
        console.log(`[ASAAS-CREATE] Batch ${batchId} completed with status: ${finalStatus}`);
      }

      return resultData;
    } catch (error: any) {
      console.error(`[ASAAS-CREATE] Job ${job.id} failed: ${error.message}`);

      // Track batch failure
      await incrementBatchFailed(batchId, {
        jobIndex,
        agreementId,
        debtId,
        customerCpfCnpj: customer.cpfCnpj,
        error: error.message,
        timestamp: new Date().toISOString(),
      });

      // Check if batch is complete
      const { isComplete, finalStatus } = await checkAndFinalizeBatch(batchId);
      if (isComplete) {
        console.log(`[ASAAS-CREATE] Batch ${batchId} completed with status: ${finalStatus}`);
      }

      throw error;
    }
  },
  {
    concurrency: 3,
    limiter: QUEUE_CONFIG.asaasChargeCreate.limiter,
  }
);

asaasChargeCreateWorker.on('completed', (job, result) => {
  console.log(`[ASAAS-CREATE] Job ${job.id} completed - Payment: ${result.paymentId}`);
});

asaasChargeCreateWorker.on('failed', (job, err) => {
  console.error(`[ASAAS-CREATE] Job ${job?.id} failed permanently: ${err.message}`);
});

asaasChargeCreateWorker.on('error', (err) => {
  console.error('[ASAAS-CREATE] Worker error:', err.message);
});
