/**
 * BullMQ Queue Configuration
 */

export const QUEUE_CONFIG = {
  email: {
    name: 'alteapay-email',
    retries: {
      attempts: 3,
      backoff: {
        type: 'exponential' as const,
        delay: 2000,
      },
    },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 500 },
  },
  charge: {
    name: 'alteapay-charge',
    retries: {
      attempts: 5,
      backoff: {
        type: 'exponential' as const,
        delay: 3000,
      },
    },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 500 },
  },
  // ASAAS Batch Queues
  asaasChargeCreate: {
    name: 'alteapay-asaas-charge-create',
    retries: {
      attempts: 5,
      backoff: {
        type: 'exponential' as const,
        delay: 3000,
      },
    },
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 1000 },
    limiter: {
      max: 10,
      duration: 1000, // 10 requests/second
    },
  },
  asaasChargeUpdate: {
    name: 'alteapay-asaas-charge-update',
    retries: {
      attempts: 5,
      backoff: {
        type: 'exponential' as const,
        delay: 3000,
      },
    },
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 1000 },
    limiter: {
      max: 10,
      duration: 1000,
    },
  },
  asaasChargeCancel: {
    name: 'alteapay-asaas-charge-cancel',
    retries: {
      attempts: 5,
      backoff: {
        type: 'exponential' as const,
        delay: 3000,
      },
    },
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 1000 },
    limiter: {
      max: 10,
      duration: 1000,
    },
  },
  asaasNotification: {
    name: 'alteapay-asaas-notification',
    retries: {
      attempts: 3,
      backoff: {
        type: 'exponential' as const,
        delay: 2000,
      },
    },
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 1000 },
    limiter: {
      max: 10,
      duration: 1000,
    },
  },
  asaasSync: {
    name: 'alteapay-asaas-sync',
    retries: {
      attempts: 3,
      backoff: {
        type: 'exponential' as const,
        delay: 2000,
      },
    },
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 1000 },
    limiter: {
      max: 10,
      duration: 1000,
    },
  },
  // Assertiva Localize Queue - for enriching customer data
  assertivaLocalize: {
    name: 'alteapay-assertiva-localize',
    retries: {
      attempts: 3,
      backoff: {
        type: 'exponential' as const,
        delay: 5000,
      },
    },
    removeOnComplete: { age: 86400 }, // Keep for 24h
    removeOnFail: { age: 604800 }, // Keep failures for 7 days
  },
  // Bulk Email Queue - for sending emails to many recipients
  bulkEmail: {
    name: 'alteapay-bulk-email',
    retries: {
      attempts: 1, // No retries for bulk jobs - individual emails have their own retry
      backoff: {
        type: 'exponential' as const,
        delay: 1000,
      },
    },
    removeOnComplete: { age: 86400 }, // Keep for 24h for status polling
    removeOnFail: { age: 604800 }, // Keep failures for 7 days
  },
  // Bulk Negotiations Queue - for sending negotiations to ASAAS
  bulkNegotiations: {
    name: 'alteapay-bulk-negotiations',
    retries: {
      attempts: 1, // No retries for bulk jobs - individual negotiations handled internally
      backoff: {
        type: 'exponential' as const,
        delay: 1000,
      },
    },
    removeOnComplete: { age: 86400 }, // Keep for 24h for status polling
    removeOnFail: { age: 604800 }, // Keep failures for 7 days
  },
  whatsapp: {
    name: 'alteapay-whatsapp',
    retries: {
      attempts: 3,
      backoff: {
        type: 'exponential' as const,
        delay: 2000,
      },
    },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 500 },
  },
  // n8n async: executa turno do chatbot e entrega callback assinado ao fluxo.
  // O resultado do turno é cacheado — retries só re-tentam o callback.
  n8n: {
    name: 'alteapay-n8n',
    retries: {
      attempts: 3,
      backoff: {
        type: 'exponential' as const,
        delay: 5000,
      },
    },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 500 },
  },
} as const;

// ASAAS notification defaults - WhatsApp + SMS enabled, email disabled (we use SendGrid)
export const ASAAS_NOTIFICATION_DEFAULTS = {
  enabled: true,
  emailEnabledForProvider: false,
  smsEnabledForProvider: false,
  emailEnabledForCustomer: false,
  smsEnabledForCustomer: true,
  phoneCallEnabledForCustomer: false,
  whatsappEnabledForCustomer: true,
} as const;
