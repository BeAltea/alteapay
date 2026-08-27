/**
 * WhatsApp inbound worker — consome alteapay-whatsapp (canal DORMANTE).
 * Cada job referencia um whatsapp_inbound_events; o worker faz o parse do
 * envelope Cloud API (via provider) e roda a máquina de estados do fluxo
 * inicial (lib/negotiation/whatsapp-flow.ts). Nunca chama rede pública em
 * modo mock (NetworkPolicy bloqueia de qualquer forma).
 */

import type { Job } from 'bullmq';

import { parseCloudApiEnvelope, processInboundMessage } from '@/lib/negotiation/whatsapp-flow';
import { createServiceClient } from '@/lib/supabase/service';
import { QUEUE_CONFIG } from '../config';
import { WorkerManager } from '../worker-manager';

export interface WhatsAppJobData {
  event_id: string;
}

export const whatsappWorker = WorkerManager.registerWorker<WhatsAppJobData>(
  QUEUE_CONFIG.whatsapp.name,
  async (job: Job<WhatsAppJobData>) => {
    const supabase = createServiceClient();
    const { data: event } = await supabase
      .from('whatsapp_inbound_events')
      .select('id, payload, processed_at')
      .eq('id', job.data.event_id)
      .maybeSingle();

    if (!event) {
      console.warn(`[WHATSAPP] evento ${job.data.event_id} não encontrado`);
      return { skipped: true };
    }
    if (event.processed_at) {
      return { skipped: true, reason: 'já processado' };
    }

    const inbound = parseCloudApiEnvelope(event.payload);
    console.log(`[WHATSAPP] evento ${event.id}: ${inbound.length} mensagem(ns)`);

    for (const msg of inbound) {
      await processInboundMessage(msg.from, msg.text, msg.messageId);
    }

    const { data: updated, error } = await supabase
      .from('whatsapp_inbound_events')
      .update({ processed_at: new Date().toISOString() })
      .eq('id', event.id)
      .select('id');
    if (error || !updated?.length) {
      console.error('[WHATSAPP] falha ao marcar processed_at:', error?.message ?? '0 rows');
    }

    return { processed: inbound.length };
  },
  { concurrency: 2 },
);
