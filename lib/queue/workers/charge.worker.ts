import { Job } from 'bullmq';
import { WorkerManager } from '../worker-manager';
import { QUEUE_CONFIG, ASAAS_NOTIFICATION_DEFAULTS } from '../config';
import { emailQueue } from '../queues';
import { isMockMode } from '../../integrations/mock-mode';
import { mockAsaasRequest } from '../../integrations/asaas-mock';
import { createServiceClient } from '../../supabase/service';

const ASAAS_BASE_URL = 'https://api.asaas.com/v3';

export interface ChargeJobData {
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
  };
  // Email notification
  sendEmail?: boolean;
  emailTemplate?: {
    subject: string;
    html: string;
  };
  // Metadata for tracking
  metadata?: {
    companyId?: string;
    userId?: string;
    source?: string;
  };
}

interface AsaasResponse {
  success: boolean;
  data?: any;
  error?: string;
}

async function asaasRequest(
  endpoint: string,
  method: string = 'GET',
  body?: unknown
): Promise<AsaasResponse> {
  if (isMockMode('asaas')) {
    return { success: true, data: mockAsaasRequest(endpoint, method, body) };
  }

  const apiKey = process.env.ASAAS_API_KEY;

  if (!apiKey) {
    return { success: false, error: 'ASAAS_API_KEY not configured' };
  }

  const url = `${ASAAS_BASE_URL}${endpoint}`;

  const options: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      access_token: apiKey.trim(),
    },
  };

  if (body && method !== 'GET') {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const text = await response.text();
    return { success: false, error: `ASAAS returned non-JSON: ${text.substring(0, 100)}` };
  }

  const data = await response.json();

  if (!response.ok) {
    const errorMsg = data.errors?.[0]?.description || data.error || `HTTP ${response.status}`;
    return { success: false, error: errorMsg };
  }

  return { success: true, data };
}

async function findOrCreateCustomer(
  customerData: ChargeJobData['customer']
): Promise<AsaasResponse> {
  // First, try to find existing customer by CPF/CNPJ
  const searchResult = await asaasRequest(`/customers?cpfCnpj=${customerData.cpfCnpj}`);

  if (searchResult.success && searchResult.data?.data?.[0]) {
    console.log(`[CHARGE] Found existing customer: ${searchResult.data.data[0].id}`);
    return { success: true, data: searchResult.data.data[0] };
  }

  // Create new customer
  console.log(`[CHARGE] Creating new customer for CPF/CNPJ: ${customerData.cpfCnpj}`);

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
    // Get current notifications
    const result = await asaasRequest(`/customers/${customerId}/notifications`);

    if (!result.success || !result.data?.data) {
      console.warn(`[CHARGE] Could not fetch notifications for customer ${customerId}`);
      return;
    }

    const notifications = result.data.data;

    // Find PAYMENT_CREATED notification and configure it
    const paymentCreated = notifications.find(
      (n: any) => n.event === 'PAYMENT_CREATED' && (n.scheduleOffset === 0 || !n.scheduleOffset)
    );

    if (paymentCreated) {
      await asaasRequest(`/notifications/${paymentCreated.id}`, 'PUT', ASAAS_NOTIFICATION_DEFAULTS);
      console.log(`[CHARGE] Configured ASAAS notifications (WhatsApp + SMS, no email)`);
    }
  } catch (error: any) {
    console.warn(`[CHARGE] Failed to configure notifications: ${error.message}`);
  }
}

export const chargeWorker = WorkerManager.registerWorker<ChargeJobData>(
  QUEUE_CONFIG.charge.name,
  async (job: Job<ChargeJobData>) => {
    const { customer, payment, sendEmail, emailTemplate, metadata } = job.data;

    console.log(`[CHARGE] Processing job ${job.id}`);
    console.log(`[CHARGE] Customer: ${customer.name} (${customer.cpfCnpj})`);
    console.log(`[CHARGE] Payment: R$ ${payment.value.toFixed(2)} - ${payment.billingType} - Due: ${payment.dueDate}`);
    if (metadata) {
      console.log(`[CHARGE] Metadata:`, JSON.stringify(metadata));
    }

    // Step 1: Find or create customer
    const customerResult = await findOrCreateCustomer(customer);

    if (!customerResult.success) {
      console.error(`[CHARGE] Failed to create/find customer: ${customerResult.error}`);
      throw new Error(`Customer error: ${customerResult.error}`);
    }

    const asaasCustomerId = customerResult.data.id;
    console.log(`[CHARGE] Customer ID: ${asaasCustomerId}`);

    // Step 2: Configure notifications (WhatsApp + SMS, email disabled)
    await configureNotifications(asaasCustomerId);

    // Step 3: Create payment
    const paymentData = {
      customer: asaasCustomerId,
      billingType: payment.billingType,
      value: payment.value,
      dueDate: payment.dueDate,
      description: payment.description,
      externalReference: payment.externalReference,
    };

    const paymentResult = await asaasRequest('/payments', 'POST', paymentData);

    if (!paymentResult.success) {
      console.error(`[CHARGE] Failed to create payment: ${paymentResult.error}`);
      throw new Error(`Payment error: ${paymentResult.error}`);
    }

    const asaasPayment = paymentResult.data;
    console.log(`[CHARGE] Payment created: ${asaasPayment.id}`);
    console.log(`[CHARGE] Invoice URL: ${asaasPayment.invoiceUrl}`);

    // Write-back no acordo: quando o externalReference é um agreement (fluxo
    // negociação-primeiro/chatbot), grava ids e URLs do ASAAS para a UI do chat
    // exibir os links (antes disso, agreements.asaas_* ficava sempre nulo).
    const agreementRef = payment.externalReference;
    if (agreementRef && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agreementRef)) {
      const supabase = createServiceClient();
      const { data: updatedAgreement, error: agreementUpdateError } = await supabase
        .from('agreements')
        .update({
          asaas_customer_id: asaasCustomerId,
          asaas_payment_id: asaasPayment.id,
          asaas_status: asaasPayment.status ?? 'PENDING',
          asaas_billing_type: asaasPayment.billingType ?? payment.billingType,
          asaas_payment_url: asaasPayment.invoiceUrl ?? null,
          asaas_invoice_url: asaasPayment.invoiceUrl ?? null,
          asaas_boleto_url: asaasPayment.bankSlipUrl ?? null,
          asaas_pix_qrcode_url: asaasPayment.pixQrCodeUrl ?? null,
        })
        .eq('id', agreementRef)
        .select('id');
      if (agreementUpdateError || !updatedAgreement?.length) {
        console.warn(`[CHARGE] Agreement write-back skipped (${agreementRef}):`, agreementUpdateError?.message ?? '0 rows');
      } else {
        console.log(`[CHARGE] Agreement ${agreementRef} updated with ASAAS links`);
      }
    }

    // Step 4: Queue email notification if requested
    if (sendEmail && emailTemplate && customer.email) {
      console.log(`[CHARGE] Queueing email notification to ${customer.email}`);

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

    return {
      customerId: asaasCustomerId,
      paymentId: asaasPayment.id,
      invoiceUrl: asaasPayment.invoiceUrl,
      bankSlipUrl: asaasPayment.bankSlipUrl,
      pixQrCodeUrl: asaasPayment.pixQrCodeUrl,
      status: asaasPayment.status,
    };
  },
  {
    concurrency: 3,
    limiter: {
      max: 10,
      duration: 1000, // 10 charges per second max
    },
  }
);

chargeWorker.on('completed', (job, result) => {
  console.log(`[CHARGE] Job ${job.id} completed - Payment: ${result.paymentId}`);
});

chargeWorker.on('failed', (job, err) => {
  console.error(`[CHARGE] Job ${job?.id} failed: ${err.message}`);
});

chargeWorker.on('error', (err) => {
  console.error('[CHARGE] Worker error:', err.message);
});
