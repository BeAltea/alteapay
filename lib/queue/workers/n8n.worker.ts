/**
 * n8n async worker — consome alteapay-n8n. Executa o turno do chatbot
 * (lib/negotiation/turn.ts → engine, fluxo n8n por padrão) e entrega o
 * resultado no callback_url do fluxo, assinado com o MESMO esquema HMAC
 * do webhook inbound.
 *
 * O resultado do turno é cacheado por event_id/job antes do callback:
 * um retry (callback fora do ar) NUNCA re-executa o turno.
 */

import type { Job } from 'bullmq';

import {
  N8N_SIGNATURE_HEADER,
  N8N_TIMESTAMP_HEADER,
  cacheTurnResult,
  getCachedTurnResult,
  signN8nPayload,
} from '@/lib/negotiation/n8n';
import { runChatbotTurn, type EngineTurnResult } from '@/lib/negotiation/turn';
import { createServiceClient } from '@/lib/supabase/service';
import type { NegotiationSession } from '@/lib/negotiation/types';
import { QUEUE_CONFIG } from '../config';
import { WorkerManager } from '../worker-manager';

export interface N8nJobData {
  session_id: string;
  message: string;
  callback_url: string;
  event_id?: string;
  metadata?: Record<string, unknown>;
}

type StoredResult = (EngineTurnResult & { error?: never }) | { error: string };

const CALLBACK_TIMEOUT_MS = 15_000;

export const n8nWorker = WorkerManager.registerWorker<N8nJobData>(
  QUEUE_CONFIG.n8n.name,
  async (job: Job<N8nJobData>) => {
    const { session_id, message, callback_url, event_id, metadata } = job.data;
    const cacheKey = event_id ?? `job:${job.id}`;

    let result = await getCachedTurnResult<StoredResult>(cacheKey);
    if (!result) {
      const supabase = createServiceClient();
      const { data: session } = await supabase
        .from('negotiation_sessions')
        .select('*')
        .eq('id', session_id)
        .maybeSingle();

      if (!session) {
        result = { error: 'sessão não encontrada' };
      } else {
        try {
          result = await runChatbotTurn(session as NegotiationSession, message, 'n8n');
        } catch (err) {
          console.error('[N8N] turno falhou:', err instanceof Error ? err.message : err);
          result = { error: 'engine indisponível' };
        }
      }
      await cacheTurnResult(cacheKey, result);
    }

    const payload = JSON.stringify({
      success: !('error' in result && result.error),
      event_id: event_id ?? null,
      session_id,
      metadata: metadata ?? null,
      ...result,
    });
    const timestamp = String(Math.floor(Date.now() / 1000));

    const resp = await fetch(callback_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [N8N_SIGNATURE_HEADER]: signN8nPayload(payload, timestamp),
        [N8N_TIMESTAMP_HEADER]: timestamp,
      },
      body: payload,
      signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
    });
    if (!resp.ok) {
      // turno já cacheado — o retry do BullMQ só re-tenta esta entrega
      throw new Error(`callback ${callback_url} retornou ${resp.status}`);
    }

    return { delivered: true, cached: Boolean(event_id) };
  },
  { concurrency: 1 }, // GPU única no host — um turno por vez
);
