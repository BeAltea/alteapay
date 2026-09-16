import { Job } from 'bullmq';
import { WorkerManager } from '../worker-manager';
import { QUEUE_CONFIG } from '../config';
import { createClient } from '@supabase/supabase-js';
import { getServerSupabaseUrl } from '../../supabase/url';
import { isMockMode, mockHex } from '../../integrations/mock-mode';

export interface BulkEmailRecipient {
  id: string;
  email: string;
  name?: string;
}

export interface BulkEmailJobData {
  companyId: string | null;
  recipients: BulkEmailRecipient[];
  subject: string;
  htmlBody: string;
  textBody: string;
  isTestMode: boolean;
  sentBy: string;
  createdAt: string;
}

export interface BulkEmailProgress {
  processed: number;
  total: number;
  percentage: number;
  sent: number;
  failed: number;
  currentEmail?: string;
}

export interface BulkEmailResult {
  totalSent: number;
  totalFailed: number;
  completedAt: string;
  results: Array<{
    email: string;
    recipientId: string;
    success: boolean;
    error?: string;
    messageId?: string;
  }>;
}

function getSupabaseAdmin() {
  return createClient(
    getServerSupabaseUrl(),
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

async function sendEmailViaSendGrid(params: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<{ success: boolean; messageId?: string; error?: string }> {
  if (isMockMode('sendgrid')) {
    const messageId = `mock-sg-${mockHex(`${params.to}:${params.subject}`)}`;
    console.log('[mock:sendgrid] send', `recipients=1 messageId=${messageId}`);
    return { success: true, messageId };
  }

  const apiKey = process.env.SENDGRID_API_KEY;
  const fromEmail = process.env.SENDGRID_FROM_EMAIL || 'cobranca@alteapay.com';
  const fromName = process.env.SENDGRID_FROM_NAME || 'AlteaPay';
  const replyTo = process.env.SENDGRID_REPLY_TO;

  if (!apiKey) {
    return { success: false, error: 'SENDGRID_API_KEY not configured' };
  }

  const requestBody: Record<string, unknown> = {
    personalizations: [{ to: [{ email: params.to }] }],
    from: { email: fromEmail, name: fromName },
    subject: params.subject,
    content: [
      { type: 'text/plain', value: params.text },
      { type: 'text/html', value: params.html },
    ],
  };

  if (replyTo) {
    requestBody.reply_to = { email: replyTo };
  }

  try {
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
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const bulkEmailWorker = WorkerManager.registerWorker<BulkEmailJobData>(
  QUEUE_CONFIG.bulkEmail.name,
  async (job: Job<BulkEmailJobData>) => {
    const { companyId, recipients, subject, htmlBody, textBody, isTestMode, sentBy } = job.data;
    const supabase = getSupabaseAdmin();

    console.log(`[BULK-EMAIL] Starting job ${job.id}`);
    console.log(`[BULK-EMAIL] Processing ${recipients.length} recipients, testMode: ${isTestMode}`);

    const progress: BulkEmailProgress = {
      processed: 0,
      total: recipients.length,
      percentage: 0,
      sent: 0,
      failed: 0,
    };

    const results: BulkEmailResult['results'] = [];
    const CHUNK_SIZE = 10;
    const DELAY_BETWEEN_REQUESTS = 50; // ms - small delay to avoid rate limits
    const DELAY_BETWEEN_CHUNKS = 200; // ms

    for (let i = 0; i < recipients.length; i += CHUNK_SIZE) {
      const chunk = recipients.slice(i, i + CHUNK_SIZE);

      // Process chunk in parallel
      const chunkPromises = chunk.map(async (recipient) => {
        progress.currentEmail = recipient.email;

        const result = await sendEmailViaSendGrid({
          to: recipient.email,
          subject,
          html: htmlBody,
          text: textBody,
        });

        // Log to tracking table (skip in test mode)
        if (!isTestMode && companyId) {
          try {
            await supabase.from('email_sent_tracking').insert({
              user_id: recipient.id,
              company_id: companyId,
              email_subject: subject,
              sent_at: new Date().toISOString(),
              sent_by: sentBy,
              status: result.success ? 'sent' : 'failed',
              error_message: result.error || null,
            });
          } catch (logError) {
            console.warn(`[BULK-EMAIL] Could not log email send for ${recipient.email}:`, logError);
          }
        }

        return {
          email: recipient.email,
          recipientId: recipient.id,
          success: result.success,
          error: result.error,
          messageId: result.messageId,
        };
      });

      const chunkResults = await Promise.all(chunkPromises);

      // Update progress
      for (const result of chunkResults) {
        results.push(result);
        progress.processed++;
        if (result.success) {
          progress.sent++;
        } else {
          progress.failed++;
          console.error(`[BULK-EMAIL] Failed to send to ${result.email}: ${result.error}`);
        }
      }

      progress.percentage = Math.round((progress.processed / progress.total) * 100);
      await job.updateProgress(progress);

      console.log(
        `[BULK-EMAIL] Progress: ${progress.processed}/${progress.total} (${progress.percentage}%) - Sent: ${progress.sent}, Failed: ${progress.failed}`
      );

      // Delay between chunks
      if (i + CHUNK_SIZE < recipients.length) {
        await sleep(DELAY_BETWEEN_CHUNKS);
      }
    }

    // Final progress update
    progress.percentage = 100;
    progress.currentEmail = undefined;
    await job.updateProgress(progress);

    const finalResult: BulkEmailResult = {
      totalSent: progress.sent,
      totalFailed: progress.failed,
      completedAt: new Date().toISOString(),
      results,
    };

    console.log(`[BULK-EMAIL] Job ${job.id} completed: ${progress.sent} sent, ${progress.failed} failed`);

    return finalResult;
  },
  {
    concurrency: 1, // Only 1 bulk job at a time
  }
);

bulkEmailWorker.on('completed', (job, result) => {
  console.log(
    `[BULK-EMAIL] Job ${job.id} completed - Sent: ${result.totalSent}, Failed: ${result.totalFailed}`
  );
});

bulkEmailWorker.on('failed', (job, err) => {
  console.error(`[BULK-EMAIL] Job ${job?.id} failed: ${err.message}`);
});

bulkEmailWorker.on('error', (err) => {
  console.error('[BULK-EMAIL] Worker error:', err.message);
});
