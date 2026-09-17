import { WorkerManager } from './worker-manager';

// Import workers to register them with WorkerManager
import './workers/email.worker';
import './workers/charge.worker';
import './workers/asaas-charge-create.worker';
import './workers/asaas-charge-update.worker';
import './workers/asaas-charge-cancel.worker';
import './workers/asaas-notification.worker';
import './workers/asaas-sync.worker';
import './workers/assertiva-localize.worker';
import './workers/bulk-email.worker';
import './workers/bulk-negotiations.worker';
import './workers/whatsapp.worker';
import './workers/n8n.worker';

import {
  emailQueue,
  chargeQueue,
  asaasChargeCreateQueue,
  asaasChargeUpdateQueue,
  asaasChargeCancelQueue,
  asaasNotificationQueue,
  asaasSyncQueue,
  assertivaLocalizeQueue,
  bulkEmailQueue,
  bulkNegotiationsQueue,
} from './queues';
import { startHealthCheck } from './health';

console.log('==========================================');
console.log('AlteaPay BullMQ Workers Starting...');
console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
console.log(`   Redis: ${(process.env.REDIS_URL || 'localhost').replace(/\/\/.*@/, '//***@')}`);
console.log('==========================================');

startHealthCheck({
  emailQueue,
  chargeQueue,
  asaasChargeCreateQueue,
  asaasChargeUpdateQueue,
  asaasChargeCancelQueue,
  asaasNotificationQueue,
  asaasSyncQueue,
  assertivaLocalizeQueue,
  bulkEmailQueue,
  bulkNegotiationsQueue,
});

// Log worker status
const workerStatus = WorkerManager.getAllWorkerStatus();
console.log('   Workers registered (on-demand activation):');
Object.entries(workerStatus).forEach(([name, status]) => {
  console.log(`      - ${name}: ${status.running ? 'running' : 'idle'}`);
});

console.log('   Rate Limit: 10 req/s per ASAAS queue');
console.log('   DrainDelay: 30 seconds');
console.log('   Workers will start when jobs are added');
console.log('==========================================');

// Start all workers immediately (warm start for dedicated worker process)
// This is appropriate for ECS Fargate where we want workers ready
WorkerManager.startAllWorkers().then(() => {
  console.log('[WORKERS] All workers started and ready');
}).catch((err) => {
  console.error('[WORKERS] Failed to start workers:', err);
  process.exit(1);
});

// Handle uncaught errors
process.on('uncaughtException', (err) => console.error('[WORKERS] Uncaught:', err));
process.on('unhandledRejection', (reason) => console.error('[WORKERS] Unhandled:', reason));
