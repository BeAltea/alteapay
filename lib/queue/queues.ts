import { Queue } from 'bullmq';
import { QUEUE_CONFIG } from './config';
import IORedis from 'ioredis';

let _connection: IORedis | null = null;

function getConnection(): IORedis {
  if (!_connection) {
    const url = process.env.REDIS_URL || 'redis://localhost:6379';
    _connection = new IORedis(url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true,
      connectTimeout: 10000,
      ...(url.startsWith('rediss://') ? { tls: { rejectUnauthorized: false } } : {}),
      retryStrategy: (times: number) => {
        if (times > 3) return null;
        return Math.min(times * 500, 2000);
      },
    });
    _connection.on('error', (err) => console.error('[REDIS] Queue error:', err.message));
  }
  return _connection;
}

export const emailQueue = new Queue(QUEUE_CONFIG.email.name, {
  connection: getConnection(),
  defaultJobOptions: {
    attempts: QUEUE_CONFIG.email.retries.attempts,
    backoff: QUEUE_CONFIG.email.retries.backoff,
    removeOnComplete: QUEUE_CONFIG.email.removeOnComplete,
    removeOnFail: QUEUE_CONFIG.email.removeOnFail,
  },
});

export const chargeQueue = new Queue(QUEUE_CONFIG.charge.name, {
  connection: getConnection(),
  defaultJobOptions: {
    attempts: QUEUE_CONFIG.charge.retries.attempts,
    backoff: QUEUE_CONFIG.charge.retries.backoff,
    removeOnComplete: QUEUE_CONFIG.charge.removeOnComplete,
    removeOnFail: QUEUE_CONFIG.charge.removeOnFail,
  },
});

// ASAAS Batch Queues
export const asaasChargeCreateQueue = new Queue(QUEUE_CONFIG.asaasChargeCreate.name, {
  connection: getConnection(),
  defaultJobOptions: {
    attempts: QUEUE_CONFIG.asaasChargeCreate.retries.attempts,
    backoff: QUEUE_CONFIG.asaasChargeCreate.retries.backoff,
    removeOnComplete: QUEUE_CONFIG.asaasChargeCreate.removeOnComplete,
    removeOnFail: QUEUE_CONFIG.asaasChargeCreate.removeOnFail,
  },
});

export const asaasChargeUpdateQueue = new Queue(QUEUE_CONFIG.asaasChargeUpdate.name, {
  connection: getConnection(),
  defaultJobOptions: {
    attempts: QUEUE_CONFIG.asaasChargeUpdate.retries.attempts,
    backoff: QUEUE_CONFIG.asaasChargeUpdate.retries.backoff,
    removeOnComplete: QUEUE_CONFIG.asaasChargeUpdate.removeOnComplete,
    removeOnFail: QUEUE_CONFIG.asaasChargeUpdate.removeOnFail,
  },
});

export const asaasChargeCancelQueue = new Queue(QUEUE_CONFIG.asaasChargeCancel.name, {
  connection: getConnection(),
  defaultJobOptions: {
    attempts: QUEUE_CONFIG.asaasChargeCancel.retries.attempts,
    backoff: QUEUE_CONFIG.asaasChargeCancel.retries.backoff,
    removeOnComplete: QUEUE_CONFIG.asaasChargeCancel.removeOnComplete,
    removeOnFail: QUEUE_CONFIG.asaasChargeCancel.removeOnFail,
  },
});

export const asaasNotificationQueue = new Queue(QUEUE_CONFIG.asaasNotification.name, {
  connection: getConnection(),
  defaultJobOptions: {
    attempts: QUEUE_CONFIG.asaasNotification.retries.attempts,
    backoff: QUEUE_CONFIG.asaasNotification.retries.backoff,
    removeOnComplete: QUEUE_CONFIG.asaasNotification.removeOnComplete,
    removeOnFail: QUEUE_CONFIG.asaasNotification.removeOnFail,
  },
});

export const asaasSyncQueue = new Queue(QUEUE_CONFIG.asaasSync.name, {
  connection: getConnection(),
  defaultJobOptions: {
    attempts: QUEUE_CONFIG.asaasSync.retries.attempts,
    backoff: QUEUE_CONFIG.asaasSync.retries.backoff,
    removeOnComplete: QUEUE_CONFIG.asaasSync.removeOnComplete,
    removeOnFail: QUEUE_CONFIG.asaasSync.removeOnFail,
  },
});

// Assertiva Localize Queue
export const assertivaLocalizeQueue = new Queue(QUEUE_CONFIG.assertivaLocalize.name, {
  connection: getConnection(),
  defaultJobOptions: {
    attempts: QUEUE_CONFIG.assertivaLocalize.retries.attempts,
    backoff: QUEUE_CONFIG.assertivaLocalize.retries.backoff,
    removeOnComplete: QUEUE_CONFIG.assertivaLocalize.removeOnComplete,
    removeOnFail: QUEUE_CONFIG.assertivaLocalize.removeOnFail,
  },
});

// Bulk Email Queue - for sending emails to many recipients
export const bulkEmailQueue = new Queue(QUEUE_CONFIG.bulkEmail.name, {
  connection: getConnection(),
  defaultJobOptions: {
    attempts: QUEUE_CONFIG.bulkEmail.retries.attempts,
    backoff: QUEUE_CONFIG.bulkEmail.retries.backoff,
    removeOnComplete: QUEUE_CONFIG.bulkEmail.removeOnComplete,
    removeOnFail: QUEUE_CONFIG.bulkEmail.removeOnFail,
  },
});

// Bulk Negotiations Queue - for sending negotiations to ASAAS
export const bulkNegotiationsQueue = new Queue(QUEUE_CONFIG.bulkNegotiations.name, {
  connection: getConnection(),
  defaultJobOptions: {
    attempts: QUEUE_CONFIG.bulkNegotiations.retries.attempts,
    backoff: QUEUE_CONFIG.bulkNegotiations.retries.backoff,
    removeOnComplete: QUEUE_CONFIG.bulkNegotiations.removeOnComplete,
    removeOnFail: QUEUE_CONFIG.bulkNegotiations.removeOnFail,
  },
});

// WhatsApp inbound processing (webhook -> state machine; dormant behind
// WHATSAPP_CHANNEL_ENABLED)
export const whatsappQueue = new Queue(QUEUE_CONFIG.whatsapp.name, {
  connection: getConnection(),
  defaultJobOptions: {
    attempts: QUEUE_CONFIG.whatsapp.retries.attempts,
    backoff: QUEUE_CONFIG.whatsapp.retries.backoff,
    removeOnComplete: QUEUE_CONFIG.whatsapp.removeOnComplete,
    removeOnFail: QUEUE_CONFIG.whatsapp.removeOnFail,
  },
});

// n8n async turns (webhook -> agent turn -> signed callback to the flow)
export const n8nQueue = new Queue(QUEUE_CONFIG.n8n.name, {
  connection: getConnection(),
  defaultJobOptions: {
    attempts: QUEUE_CONFIG.n8n.retries.attempts,
    backoff: QUEUE_CONFIG.n8n.retries.backoff,
    removeOnComplete: QUEUE_CONFIG.n8n.removeOnComplete,
    removeOnFail: QUEUE_CONFIG.n8n.removeOnFail,
  },
});
