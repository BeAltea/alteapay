import { Job } from 'bullmq';
import { WorkerManager } from '../worker-manager';
import { QUEUE_CONFIG } from '../config';
import { createClient } from '@supabase/supabase-js';
import {
  getAsaasCustomerByCpfCnpj,
  createAsaasCustomer,
  updateAsaasCustomer,
  getAsaasCustomerNotifications,
  updateAsaasNotification,
  createAsaasPayment,
  resendAsaasPaymentNotification,
  getAsaasPaymentsForCustomer,
} from '@/lib/asaas';
import { findBlockingAgreement, findBlockingPayment } from '@/lib/asaas-idempotency';

export interface BulkNegotiationsJobData {
  companyId: string;
  customerIds: string[];
  discountType: 'none' | 'percentage' | 'fixed';
  discountValue: number;
  paymentMethods: string[];
  notificationChannels: string[];
  userId: string;
  attendantName: string;
  createdAt: string;
  /** Dias até o vencimento da cobrança (default 30). */
  dueDateDays?: number;
}

type NegotiationStep =
  | 'validate_data'
  | 'create_customer_db'
  | 'create_debt_db'
  | 'create_asaas_customer'
  | 'check_existing_charge'
  | 'create_asaas_payment'
  | 'create_agreement_db'
  | 'update_agreement_db'
  | 'update_vmax_status'
  | 'completed';

interface ErrorDetails {
  message: string;
  step: NegotiationStep;
  httpStatus?: number;
  asaasErrors?: any[];
  recoverable?: boolean;
}

interface NegotiationResult {
  vmaxId: string;
  customerName: string;
  cpfCnpj: string;
  status: 'success' | 'failed' | 'recovered' | 'skipped';
  skipReason?: string;
  failedAtStep?: NegotiationStep;
  error?: ErrorDetails;
  asaasCustomerCreated?: boolean;
  asaasPaymentCreated?: boolean;
  asaasCustomerId?: string;
  asaasPaymentId?: string;
  paymentUrl?: string;
  notificationChannel?: 'whatsapp' | 'email' | 'none';
  phoneValidation?: {
    original: string;
    isValid: boolean;
    reason?: string;
  };
}

export interface BulkNegotiationsProgress {
  processed: number;
  total: number;
  percentage: number;
  sent: number;
  failed: number;
  skipped: number;
  currentCustomer?: string;
}

export interface BulkNegotiationsResult {
  success: boolean;
  sent: number;
  failed: number;
  skipped: number;
  total: number;
  results: NegotiationResult[];
  errors?: string[];
  errorSummary?: Record<string, number>;
  stepLabels: Record<NegotiationStep, string>;
  completedAt: string;
}

const STEP_LABELS: Record<NegotiationStep, string> = {
  validate_data: 'Validar dados do cliente',
  create_customer_db: 'Criar cliente no banco',
  create_debt_db: 'Criar dívida no banco',
  create_asaas_customer: 'Criar cliente no ASAAS',
  check_existing_charge: 'Verificar cobrança existente (idempotência)',
  create_asaas_payment: 'Criar cobrança no ASAAS',
  create_agreement_db: 'Criar acordo no banco',
  update_agreement_db: 'Atualizar acordo no banco',
  update_vmax_status: 'Atualizar status VMAX',
  completed: 'Concluído',
};

// Rate limiting configuration
// ASAAS allows 25,000 requests per 12-hour window
// Safe throughput: 5 requests/second (well within limits)
const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 1000; // 1 second between batches = ~5 req/s

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getSupabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

function extractErrorDetails(error: any, step: NegotiationStep): ErrorDetails {
  const details: ErrorDetails = {
    message: error.message || 'Erro desconhecido',
    step,
    recoverable: step === 'update_agreement_db' || step === 'update_vmax_status',
  };

  if (error.response) {
    details.httpStatus = error.response.status;
    if (error.response.data?.errors) {
      details.asaasErrors = error.response.data.errors;
      const firstError = error.response.data.errors[0];
      if (firstError?.description) {
        details.message = firstError.description;
      }
    }
  }

  if (error.message?.includes('ASAAS')) {
    const match = error.message.match(/(\d{3})/);
    if (match) {
      details.httpStatus = parseInt(match[1]);
    }
  }

  return details;
}

function validateBrazilianPhone(phone: string | null | undefined): {
  isValid: boolean;
  cleaned: string;
  reason?: string;
} {
  if (!phone) {
    return { isValid: false, cleaned: '', reason: 'Telefone não informado' };
  }

  let cleaned = phone.replace(/\D/g, '');

  if (cleaned.startsWith('55') && cleaned.length >= 12) {
    cleaned = cleaned.substring(2);
  }

  if (cleaned.length < 10 || cleaned.length > 11) {
    return {
      isValid: false,
      cleaned,
      reason: `Telefone com ${cleaned.length} dígitos (esperado 10-11)`,
    };
  }

  const ddd = parseInt(cleaned.substring(0, 2));
  if (ddd < 11 || ddd > 99) {
    return { isValid: false, cleaned, reason: `DDD inválido: ${ddd}` };
  }

  if (cleaned.length === 11) {
    const thirdDigit = cleaned.charAt(2);
    if (thirdDigit !== '9') {
      return {
        isValid: false,
        cleaned,
        reason: `Celular deve começar com 9 após DDD (encontrado: ${thirdDigit})`,
      };
    }
  }

  if (cleaned.length === 10) {
    const thirdDigit = parseInt(cleaned.charAt(2));
    if (thirdDigit < 2 || thirdDigit > 5) {
      return {
        isValid: false,
        cleaned,
        reason: `Fixo deve começar com 2-5 após DDD (encontrado: ${thirdDigit})`,
      };
    }
    return {
      isValid: false,
      cleaned,
      reason: 'Telefone fixo não recebe WhatsApp/SMS',
    };
  }

  return { isValid: true, cleaned };
}

// Validate and sanitize email for ASAAS
function validateEmail(email: string | null | undefined): {
  isValid: boolean;
  cleaned: string;
  reason?: string;
} {
  if (!email) {
    return { isValid: false, cleaned: '', reason: 'Email não informado' };
  }

  // Trim whitespace and convert to lowercase
  const cleaned = email.trim().toLowerCase();

  if (!cleaned) {
    return { isValid: false, cleaned: '', reason: 'Email vazio após limpeza' };
  }

  // Basic email regex validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(cleaned)) {
    return { isValid: false, cleaned, reason: 'Formato de email inválido' };
  }

  // Check for common invalid patterns
  if (cleaned.includes('..') || cleaned.startsWith('.') || cleaned.endsWith('.')) {
    return { isValid: false, cleaned, reason: 'Email com pontos inválidos' };
  }

  // Check minimum length (a@b.co = 6 chars minimum)
  if (cleaned.length < 6) {
    return { isValid: false, cleaned, reason: 'Email muito curto' };
  }

  return { isValid: true, cleaned };
}

async function processSingleNegotiation(
  vmaxId: string,
  params: BulkNegotiationsJobData,
  supabase: any
): Promise<NegotiationResult> {
  let currentStep: NegotiationStep = 'validate_data';
  let asaasCustomerCreated = false;
  let asaasPaymentCreated = false;
  let asaasCustomerId: string | null = null;
  let asaasPaymentId: string | null = null;
  let paymentUrl: string | null = null;
  let customerId: string | null = null;
  let debtId: string | null = null;
  let agreementId: string | null = null;

  const { data: vmax, error: vmaxError } = await supabase
    .from('VMAX')
    .select('*')
    .eq('id', vmaxId)
    .single();

  if (vmaxError || !vmax) {
    return {
      vmaxId,
      customerName: 'Desconhecido',
      cpfCnpj: '',
      status: 'failed',
      failedAtStep: 'validate_data',
      error: { message: 'Registro VMAX não encontrado', step: 'validate_data' },
    };
  }

  const cpfCnpj = (vmax['CPF/CNPJ'] || '').replace(/\D/g, '');
  const customerName = vmax.Cliente || 'Cliente';

  if (!cpfCnpj) {
    return {
      vmaxId,
      customerName,
      cpfCnpj: '',
      status: 'failed',
      failedAtStep: 'validate_data',
      error: { message: 'CPF/CNPJ não cadastrado', step: 'validate_data' },
    };
  }

  if (cpfCnpj.length !== 11 && cpfCnpj.length !== 14) {
    return {
      vmaxId,
      customerName,
      cpfCnpj,
      status: 'failed',
      failedAtStep: 'validate_data',
      error: {
        message: `CPF/CNPJ inválido (${cpfCnpj.length} dígitos, esperado 11 ou 14)`,
        step: 'validate_data',
      },
    };
  }

  let customerPhone = (vmax['Telefone 1'] || vmax['Telefone 2'] || vmax['Telefone'] || '').replace(/\D/g, '');
  let rawEmail = vmax.Email || '';

  const { data: existingCustomerData } = await supabase
    .from('customers')
    .select('phone, email')
    .eq('document', cpfCnpj)
    .eq('company_id', params.companyId)
    .maybeSingle();

  if (existingCustomerData) {
    if (existingCustomerData.phone) customerPhone = existingCustomerData.phone.replace(/\D/g, '');
    if (existingCustomerData.email) rawEmail = existingCustomerData.email;
  }

  const phoneValidation = validateBrazilianPhone(customerPhone);
  const emailValidation = validateEmail(rawEmail);

  // Use validated/cleaned email for ASAAS, raw email for DB storage
  const customerEmail = rawEmail.trim(); // For DB storage (preserve original casing)
  const asaasEmail = emailValidation.isValid ? emailValidation.cleaned : undefined; // For ASAAS API

  let notificationChannel: 'whatsapp' | 'email' | 'none' = 'none';
  if (phoneValidation.isValid && params.notificationChannels.includes('whatsapp')) {
    notificationChannel = 'whatsapp';
  } else if (emailValidation.isValid && params.notificationChannels.includes('email')) {
    notificationChannel = 'email';
    console.log(`[BULK-NEGOTIATIONS] ${customerName}: Phone invalid (${phoneValidation.reason}), using email fallback`);
  } else if (!phoneValidation.isValid && !emailValidation.isValid) {
    console.log(`[BULK-NEGOTIATIONS] ${customerName}: No valid contact - Phone: ${phoneValidation.reason}, Email: ${emailValidation.reason}`);
  }

  const asaasPhone = phoneValidation.isValid ? phoneValidation.cleaned : undefined;

  const vencidoStr = String(vmax.Vencido || '0');
  const originalAmount =
    Number(
      vencidoStr
        .replace(/R\$/g, '')
        .replace(/\s/g, '')
        .replace(/\./g, '')
        .replace(',', '.')
    ) || 0;

  if (originalAmount <= 0) {
    return {
      vmaxId,
      customerName,
      cpfCnpj,
      status: 'failed',
      failedAtStep: 'validate_data',
      error: { message: 'Dívida com valor zero ou inválido', step: 'validate_data' },
    };
  }

  let discountAmount = 0;
  if (params.discountType === 'percentage' && params.discountValue > 0) {
    discountAmount = (originalAmount * params.discountValue) / 100;
  } else if (params.discountType === 'fixed' && params.discountValue > 0) {
    discountAmount = Math.min(params.discountValue, originalAmount);
  }

  const agreedAmount = originalAmount - discountAmount;
  const discountPercentage = originalAmount > 0 ? (discountAmount / originalAmount) * 100 : 0;

  try {
    // Create or get customer in DB
    currentStep = 'create_customer_db';

    const { data: existingCustomers } = await supabase
      .from('customers')
      .select('id')
      .eq('document', cpfCnpj)
      .eq('company_id', params.companyId)
      .limit(1);

    const existingCustomer = existingCustomers?.[0] || null;

    if (existingCustomer) {
      customerId = existingCustomer.id;
      await supabase
        .from('customers')
        .update({ name: customerName, phone: customerPhone, email: customerEmail })
        .eq('id', existingCustomer.id);
    } else {
      const { data: newCustomer, error: customerError } = await supabase
        .from('customers')
        .insert({
          name: customerName,
          document: cpfCnpj,
          document_type: cpfCnpj.length === 11 ? 'CPF' : 'CNPJ',
          phone: customerPhone,
          email: customerEmail,
          company_id: params.companyId,
          source_system: 'VMAX',
          external_id: vmaxId,
        })
        .select('id')
        .single();

      if (customerError || !newCustomer) {
        throw { message: customerError?.message || 'Erro ao criar cliente', step: currentStep };
      }
      customerId = newCustomer.id;
    }

    // Guard de idempotência (local): acordo vivo/pago para este cliente bloqueia nova cobrança
    currentStep = 'check_existing_charge';
    const { data: liveAgreements } = await supabase
      .from('agreements')
      .select('id, asaas_payment_id, payment_status, asaas_status')
      .eq('customer_id', customerId)
      .eq('company_id', params.companyId)
      .not('asaas_payment_id', 'is', null);
    const blockingAgreement = findBlockingAgreement(liveAgreements || []);
    if (blockingAgreement) {
      const skipReason = `SKIP_JA_COBRADO_LOCAL: payment ${blockingAgreement.asaas_payment_id} (${blockingAgreement.payment_status ?? ''}/${blockingAgreement.asaas_status ?? ''})`;
      console.log(`[BULK-NEGOTIATIONS] ${skipReason} - ${customerName}`);
      return {
        vmaxId,
        customerName,
        cpfCnpj,
        status: 'skipped',
        skipReason,
        notificationChannel,
        phoneValidation: { original: customerPhone, isValid: phoneValidation.isValid, reason: phoneValidation.reason },
      };
    }

    // Create or get debt
    currentStep = 'create_debt_db';

    const { data: existingDebts } = await supabase
      .from('debts')
      .select('id')
      .eq('customer_id', customerId)
      .eq('company_id', params.companyId)
      .order('created_at', { ascending: false })
      .limit(1);

    const existingDebt = existingDebts?.[0] || null;

    if (existingDebt) {
      debtId = existingDebt.id;
      await supabase.from('debts').update({ amount: originalAmount, status: 'in_negotiation' }).eq('id', existingDebt.id);
    } else {
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + (params.dueDateDays ?? 30));

      const { data: newDebt, error: debtError } = await supabase
        .from('debts')
        .insert({
          customer_id: customerId,
          company_id: params.companyId,
          amount: originalAmount,
          due_date: dueDate.toISOString().split('T')[0],
          description: `Dívida de ${customerName}`,
          status: 'in_negotiation',
          source_system: 'VMAX',
          external_id: vmaxId,
        })
        .select('id')
        .single();

      if (debtError || !newDebt) {
        throw { message: debtError?.message || 'Erro ao criar dívida', step: currentStep };
      }
      debtId = newDebt.id;
    }

    // ASAAS Customer Integration
    currentStep = 'create_asaas_customer';

    try {
      const existingAsaas = await getAsaasCustomerByCpfCnpj(cpfCnpj);
      if (existingAsaas) {
        asaasCustomerId = existingAsaas.id;
        asaasCustomerCreated = true;
        await updateAsaasCustomer(asaasCustomerId, {
          mobilePhone: asaasPhone,
          email: asaasEmail, // Use validated email for ASAAS
          notificationDisabled: false,
        });
      } else {
        const newAsaas = await createAsaasCustomer({
          name: customerName,
          cpfCnpj,
          mobilePhone: asaasPhone,
          email: asaasEmail, // Use validated email for ASAAS
          notificationDisabled: false,
        });
        asaasCustomerId = newAsaas.id;
        asaasCustomerCreated = true;
      }

      // Configure notifications
      try {
        const allNotifs = await getAsaasCustomerNotifications(asaasCustomerId);
        const paymentCreatedNotif = allNotifs.find((n: any) => n.event === 'PAYMENT_CREATED');
        if (paymentCreatedNotif) {
          const useWhatsApp = notificationChannel === 'whatsapp';
          const useEmail = notificationChannel === 'email';

          await updateAsaasNotification(paymentCreatedNotif.id, {
            enabled: useWhatsApp || useEmail,
            emailEnabledForCustomer: useEmail,
            smsEnabledForCustomer: false,
            whatsappEnabledForCustomer: useWhatsApp,
          });
        }
      } catch (notifErr: any) {
        console.warn(`[BULK-NEGOTIATIONS] Notification config failed for ${customerName}:`, notifErr.message);
      }
    } catch (asaasErr: any) {
      return {
        vmaxId,
        customerName,
        cpfCnpj,
        status: 'failed',
        failedAtStep: 'create_asaas_customer',
        error: extractErrorDetails(asaasErr, 'create_asaas_customer'),
        asaasCustomerCreated: false,
        notificationChannel,
        phoneValidation: { original: customerPhone, isValid: phoneValidation.isValid, reason: phoneValidation.reason },
      };
    }

    // Guard de idempotência (ASAAS, fonte da verdade): qualquer cobrança não-encerrada bloqueia
    currentStep = 'check_existing_charge';
    const existingPayments = await getAsaasPaymentsForCustomer(asaasCustomerId!);
    const blockingPayment = findBlockingPayment(existingPayments);
    if (blockingPayment) {
      const skipReason = `SKIP_JA_COBRADO_ASAAS: payment ${blockingPayment.id} status ${blockingPayment.status}`;
      console.log(`[BULK-NEGOTIATIONS] ${skipReason} - ${customerName}`);
      return {
        vmaxId,
        customerName,
        cpfCnpj,
        status: 'skipped',
        skipReason,
        asaasCustomerCreated: true,
        asaasCustomerId: asaasCustomerId || undefined,
        notificationChannel,
        phoneValidation: { original: customerPhone, isValid: phoneValidation.isValid, reason: phoneValidation.reason },
      };
    }

    // Create agreement in DB
    currentStep = 'create_agreement_db';
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + (params.dueDateDays ?? 30));
    const dueDateStr = dueDate.toISOString().split('T')[0];

    const { data: agreement, error: agreementError } = await supabase
      .from('agreements')
      .insert({
        debt_id: debtId,
        customer_id: customerId,
        user_id: params.userId,
        company_id: params.companyId,
        original_amount: originalAmount,
        agreed_amount: agreedAmount,
        discount_amount: discountAmount,
        discount_percentage: discountPercentage,
        installments: 1,
        installment_amount: agreedAmount,
        due_date: dueDateStr,
        status: 'draft',
        payment_status: 'pending',
        attendant_name: params.attendantName,
        asaas_customer_id: asaasCustomerId,
        terms: JSON.stringify({
          payment_methods: params.paymentMethods,
          notification_channels: params.notificationChannels,
          discount_type: params.discountType,
          discount_value: params.discountValue,
        }),
      })
      .select()
      .single();

    if (agreementError || !agreement) {
      return {
        vmaxId,
        customerName,
        cpfCnpj,
        status: 'failed',
        failedAtStep: 'create_agreement_db',
        error: extractErrorDetails({ message: agreementError?.message || 'Erro ao criar acordo' }, 'create_agreement_db'),
        asaasCustomerCreated,
        asaasCustomerId: asaasCustomerId || undefined,
      };
    }
    agreementId = agreement.id;

    // Create ASAAS payment
    currentStep = 'create_asaas_payment';

    try {
      let billingType: 'BOLETO' | 'CREDIT_CARD' | 'PIX' | 'UNDEFINED' = 'UNDEFINED';
      const methodMapping: Record<string, 'BOLETO' | 'CREDIT_CARD' | 'PIX'> = {
        boleto: 'BOLETO',
        pix: 'PIX',
        credit_card: 'CREDIT_CARD',
      };
      if (params.paymentMethods.length === 1 && methodMapping[params.paymentMethods[0]]) {
        billingType = methodMapping[params.paymentMethods[0]];
      }

      const asaasPayment = await createAsaasPayment({
        customer: asaasCustomerId,
        billingType,
        value: agreedAmount,
        dueDate: dueDateStr,
        description: `Acordo de negociação - ${customerName}`,
        externalReference: `agreement_${agreement.id}`,
        postalService: false,
      });

      asaasPaymentId = asaasPayment.id;
      asaasPaymentCreated = true;
      paymentUrl = asaasPayment.invoiceUrl || null;

      // Update agreement with ASAAS payment info
      // IMPORTANT: Also save the due_date from ASAAS response to ensure it's persisted
      currentStep = 'update_agreement_db';
      const { error: updateError } = await supabase
        .from('agreements')
        .update({
          asaas_payment_id: asaasPayment.id,
          asaas_payment_url: asaasPayment.invoiceUrl || null,
          asaas_pix_qrcode_url: asaasPayment.pixQrCodeUrl || null,
          asaas_boleto_url: asaasPayment.bankSlipUrl || null,
          due_date: asaasPayment.dueDate || dueDateStr || null,
          status: 'active',
        })
        .eq('id', agreement.id);

      if (updateError) {
        // Attempt auto-recovery
        const { error: retryError } = await supabase
          .from('agreements')
          .update({
            asaas_payment_id: asaasPayment.id,
            asaas_payment_url: asaasPayment.invoiceUrl || null,
            asaas_pix_qrcode_url: asaasPayment.pixQrCodeUrl || null,
            asaas_boleto_url: asaasPayment.bankSlipUrl || null,
            due_date: asaasPayment.dueDate || dueDateStr || null,
            status: 'active',
          })
          .eq('id', agreement.id);

        if (retryError) {
          return {
            vmaxId,
            customerName,
            cpfCnpj,
            status: 'failed',
            failedAtStep: 'update_agreement_db',
            error: { ...extractErrorDetails({ message: updateError.message }, 'update_agreement_db'), recoverable: true },
            asaasCustomerCreated: true,
            asaasPaymentCreated: true,
            asaasCustomerId: asaasCustomerId || undefined,
            asaasPaymentId: asaasPaymentId || undefined,
            paymentUrl: paymentUrl || undefined,
          };
        }
      }
    } catch (asaasPaymentErr: any) {
      await supabase.from('agreements').delete().eq('id', agreement.id);
      return {
        vmaxId,
        customerName,
        cpfCnpj,
        status: 'failed',
        failedAtStep: 'create_asaas_payment',
        error: extractErrorDetails(asaasPaymentErr, 'create_asaas_payment'),
        asaasCustomerCreated: true,
        asaasPaymentCreated: false,
        asaasCustomerId: asaasCustomerId || undefined,
      };
    }

    // Update VMAX negotiation status
    currentStep = 'update_vmax_status';
    await supabase.from('VMAX').update({ negotiation_status: 'sent' }).eq('id', vmaxId);

    // Record collection action
    if (notificationChannel !== 'none') {
      try {
        await supabase.from('collection_actions').insert({
          company_id: params.companyId,
          customer_id: customerId,
          debt_id: debtId,
          action_type: notificationChannel,
          status: 'sent',
          sent_by: params.userId,
          sent_at: new Date().toISOString(),
          message: `Negociação enviada via ${notificationChannel}. Valor: R$ ${agreedAmount.toFixed(2)}`,
          metadata: {
            payment_methods: params.paymentMethods,
            notification_channels: params.notificationChannels,
            actual_channel: notificationChannel,
            phone_valid: phoneValidation.isValid,
            discount_type: params.discountType,
            discount_value: params.discountValue,
            original_amount: originalAmount,
            agreed_amount: agreedAmount,
          },
        });
      } catch (actionErr) {
        console.warn(`[BULK-NEGOTIATIONS] Failed to record collection action for ${vmaxId}`);
      }
    }

    // Send notifications in background
    if (agreementId) {
      sendNotificationsInBackground(params, customerName, customerEmail, agreedAmount, agreementId, asaasCustomerId, supabase, notificationChannel);
    }

    return {
      vmaxId,
      customerName,
      cpfCnpj,
      status: 'success',
      asaasCustomerCreated: true,
      asaasPaymentCreated: true,
      asaasCustomerId: asaasCustomerId || undefined,
      asaasPaymentId: asaasPaymentId || undefined,
      paymentUrl: paymentUrl || undefined,
      notificationChannel,
      phoneValidation: { original: customerPhone, isValid: phoneValidation.isValid, reason: phoneValidation.reason },
    };
  } catch (error: any) {
    return {
      vmaxId,
      customerName,
      cpfCnpj,
      status: 'failed',
      failedAtStep: currentStep,
      error: extractErrorDetails(error, currentStep),
      asaasCustomerCreated,
      asaasPaymentCreated,
      asaasCustomerId: asaasCustomerId || undefined,
      asaasPaymentId: asaasPaymentId || undefined,
      notificationChannel,
      phoneValidation: { original: customerPhone, isValid: phoneValidation.isValid, reason: phoneValidation.reason },
    };
  }
}

async function sendNotificationsInBackground(
  params: BulkNegotiationsJobData,
  customerName: string,
  customerEmail: string,
  agreedAmount: number,
  agreementId: string,
  asaasCustomerId: string | null,
  supabase: any,
  notificationChannel: 'whatsapp' | 'email' | 'none'
) {
  try {
    const { data: agreementData } = await supabase
      .from('agreements')
      .select('asaas_payment_url, asaas_payment_id, due_date')
      .eq('id', agreementId)
      .single();

    const paymentUrl = agreementData?.asaas_payment_url || '';
    const dueDate = agreementData?.due_date
      ? new Date(agreementData.due_date).toLocaleDateString('pt-BR')
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toLocaleDateString('pt-BR');

    const { data: companyData } = await supabase.from('companies').select('name').eq('id', params.companyId).single();
    const companyName = companyData?.name || 'Empresa';

    // Trigger WhatsApp via ASAAS
    if (notificationChannel === 'whatsapp' && asaasCustomerId && agreementData?.asaas_payment_id) {
      try {
        await resendAsaasPaymentNotification(agreementData.asaas_payment_id);
        console.log(`[BULK-NEGOTIATIONS] ${customerName}: WhatsApp notification triggered`);
      } catch (whatsappErr: any) {
        console.error(`[BULK-NEGOTIATIONS] ASAAS WhatsApp failed for ${customerName}:`, whatsappErr.message);
      }
    }

    // Send email via SendGrid queue
    if (customerEmail) {
      try {
        const { sendEmail, generateDebtCollectionEmail } = await import('@/lib/notifications/email');
        const emailHtml = await generateDebtCollectionEmail({
          customerName,
          debtAmount: agreedAmount,
          dueDate,
          companyName,
          paymentLink: paymentUrl,
        });
        await sendEmail({
          to: customerEmail,
          subject: `Proposta de Negociação - ${companyName}`,
          html: emailHtml,
        });
        console.log(`[BULK-NEGOTIATIONS] ${customerName}: Email queued`);
      } catch (emailErr: any) {
        console.error(`[BULK-NEGOTIATIONS] Email failed for ${customerName}:`, emailErr.message);
      }
    }
  } catch (err: any) {
    console.error(`[BULK-NEGOTIATIONS] Background notifications failed:`, err.message);
  }
}

export const bulkNegotiationsWorker = WorkerManager.registerWorker<BulkNegotiationsJobData>(
  QUEUE_CONFIG.bulkNegotiations.name,
  async (job: Job<BulkNegotiationsJobData>) => {
    const params = job.data;
    const supabase = getSupabaseAdmin();

    console.log(`[BULK-NEGOTIATIONS] Starting job ${job.id}`);
    console.log(`[BULK-NEGOTIATIONS] Processing ${params.customerIds.length} negotiations`);

    const progress: BulkNegotiationsProgress = {
      processed: 0,
      total: params.customerIds.length,
      percentage: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
    };

    const allResults: NegotiationResult[] = [];
    const totalChunks = Math.ceil(params.customerIds.length / BATCH_SIZE);

    console.log(`[BULK-NEGOTIATIONS] Processing ${params.customerIds.length} negotiations in ${totalChunks} batches of ${BATCH_SIZE} (rate: ~${BATCH_SIZE} req/s)`);

    for (let i = 0; i < params.customerIds.length; i += BATCH_SIZE) {
      const chunk = params.customerIds.slice(i, i + BATCH_SIZE);
      const chunkNumber = Math.floor(i / BATCH_SIZE) + 1;

      // Process chunk in parallel
      const chunkResults = await Promise.allSettled(
        chunk.map((vmaxId) => processSingleNegotiation(vmaxId, params, supabase))
      );

      for (let j = 0; j < chunkResults.length; j++) {
        const result = chunkResults[j];
        if (result.status === 'fulfilled') {
          allResults.push(result.value);
          if (result.value.status === 'success') {
            progress.sent++;
          } else if (result.value.status === 'skipped') {
            progress.skipped++;
          } else {
            progress.failed++;
          }
        } else {
          allResults.push({
            vmaxId: chunk[j],
            customerName: 'Erro',
            cpfCnpj: '',
            status: 'failed',
            error: { message: result.reason?.message || 'Erro inesperado', step: 'validate_data' },
          });
          progress.failed++;
        }
        progress.processed++;
      }

      progress.percentage = Math.round((progress.processed / progress.total) * 100);
      progress.currentCustomer = undefined;
      await job.updateProgress(progress);

      console.log(
        `[BULK-NEGOTIATIONS] Batch ${chunkNumber}/${totalChunks} complete: ${progress.processed}/${progress.total} (${progress.percentage}%) - Sent: ${progress.sent}, Failed: ${progress.failed}`
      );

      // Rate limiting: pause between batches to stay within ASAAS limits (~5 req/s)
      // Skip delay on last batch
      if (i + BATCH_SIZE < params.customerIds.length) {
        await sleep(BATCH_DELAY_MS);
      }
    }

    // Final progress
    progress.percentage = 100;
    await job.updateProgress(progress);

    const errors = allResults.filter((r) => r.status === 'failed').map((r) => `${r.customerName}: ${r.error?.message || 'Erro'}`);

    const errorSummary: Record<string, number> = {};
    for (const result of allResults) {
      if (result.status === 'failed' && result.error) {
        const errorType = result.error.message.split(':')[0] || result.error.message;
        errorSummary[errorType] = (errorSummary[errorType] || 0) + 1;
      }
    }

    const finalResult: BulkNegotiationsResult = {
      success: progress.sent > 0,
      sent: progress.sent,
      failed: progress.failed,
      skipped: progress.skipped,
      total: params.customerIds.length,
      results: allResults,
      errors: errors.length > 0 ? errors : undefined,
      errorSummary: Object.keys(errorSummary).length > 0 ? errorSummary : undefined,
      stepLabels: STEP_LABELS,
      completedAt: new Date().toISOString(),
    };

    console.log(`[BULK-NEGOTIATIONS] Job ${job.id} completed: ${progress.sent} sent, ${progress.skipped} skipped, ${progress.failed} failed`);

    return finalResult;
  },
  {
    concurrency: 1, // Only 1 bulk job at a time
  }
);

bulkNegotiationsWorker.on('completed', (job, result) => {
  console.log(`[BULK-NEGOTIATIONS] Job ${job.id} completed - Sent: ${result.sent}, Failed: ${result.failed}`);
});

bulkNegotiationsWorker.on('failed', (job, err) => {
  console.error(`[BULK-NEGOTIATIONS] Job ${job?.id} failed: ${err.message}`);
});

bulkNegotiationsWorker.on('error', (err) => {
  console.error('[BULK-NEGOTIATIONS] Worker error:', err.message);
});
