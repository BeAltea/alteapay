import { Job } from 'bullmq';
import { WorkerManager } from '../worker-manager';
import { QUEUE_CONFIG } from '../config';
import { isMockMode, mockHex } from '../../integrations/mock-mode';

export interface EmailJobData {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  metadata?: {
    chargeId?: string;
    customerId?: string;
    type?: string;
  };
}

interface SendGridResponse {
  success: boolean;
  messageId?: string;
  error?: string;
}

async function sendEmailViaSendGrid(params: EmailJobData): Promise<SendGridResponse> {
  if (isMockMode('sendgrid')) {
    const mockRecipients = Array.isArray(params.to) ? params.to : [params.to];
    const messageId = `mock-sg-${mockHex(`${mockRecipients.join(',')}:${params.subject}`)}`;
    console.log('[mock:sendgrid] send', `recipients=${mockRecipients.length} messageId=${messageId}`);
    return { success: true, messageId };
  }

  const apiKey = process.env.SENDGRID_API_KEY;
  const fromEmail = process.env.SENDGRID_FROM_EMAIL || 'cobranca@alteapay.com';
  const fromName = process.env.SENDGRID_FROM_NAME || 'AlteaPay';

  if (!apiKey) {
    return { success: false, error: 'SENDGRID_API_KEY not configured' };
  }

  const recipients = Array.isArray(params.to) ? params.to : [params.to];

  const personalizations = recipients.map((email) => ({
    to: [{ email }],
  }));

  const requestBody: Record<string, unknown> = {
    personalizations,
    from: { email: fromEmail, name: fromName },
    subject: params.subject,
    content: [
      ...(params.text ? [{ type: 'text/plain', value: params.text }] : []),
      { type: 'text/html', value: params.html },
    ],
  };

  if (params.replyTo) {
    requestBody.reply_to = { email: params.replyTo };
  }

  const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const errorMessage = errorData.errors?.[0]?.message || `HTTP ${response.status}`;
    return { success: false, error: errorMessage };
  }

  const messageId = response.headers.get('x-message-id') || `sg-${Date.now()}`;
  return { success: true, messageId };
}

export const emailWorker = WorkerManager.registerWorker<EmailJobData>(
  QUEUE_CONFIG.email.name,
  async (job: Job<EmailJobData>) => {
    const { to, subject, metadata } = job.data;
    const recipients = Array.isArray(to) ? to.join(', ') : to;

    console.log(`[EMAIL] Processing job ${job.id}`);
    console.log(`[EMAIL] To: ${recipients}, Subject: ${subject}`);
    if (metadata) {
      console.log(`[EMAIL] Metadata:`, JSON.stringify(metadata));
    }

    const result = await sendEmailViaSendGrid(job.data);

    if (!result.success) {
      console.error(`[EMAIL] Failed: ${result.error}`);
      throw new Error(result.error);
    }

    console.log(`[EMAIL] Sent successfully. MessageId: ${result.messageId}`);
    return { messageId: result.messageId };
  },
  {
    concurrency: 5,
    limiter: {
      max: 100,
      duration: 1000, // 100 emails per second max
    },
  }
);

emailWorker.on('completed', (job) => {
  console.log(`[EMAIL] Job ${job.id} completed`);
});

emailWorker.on('failed', (job, err) => {
  console.error(`[EMAIL] Job ${job?.id} failed: ${err.message}`);
});

emailWorker.on('error', (err) => {
  console.error('[EMAIL] Worker error:', err.message);
});
