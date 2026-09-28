/**
 * N8N-10: dreno do engine_outbox no worker Fargate (processo de longa duração).
 *
 * Não é um worker BullMQ: a fila `alteapay-n8n` é do sentido n8n → app (turno
 * assíncrono) e o outbox já é a fila durável (Postgres). Aqui só um laço com
 * intervalo que chama o MESMO flushOutbox da rota de cron — os dois podem rodar
 * juntos: a reivindicação por compare-and-set impede POST duplicado simultâneo.
 *
 * Liga só com o motor n8n configurado NESTE processo (NEGOTIATION_ENGINE=n8n e
 * N8N_CHAT_FLOW_URL; o HMAC/Basic usam N8N_WEBHOOK_SECRET/N8N_BASIC_AUTH_*).
 * ENGINE_OUTBOX_DRAIN_INTERVAL_MS (default 15000; 0 desliga). Tabela ausente →
 * no-op explícito (revisto a cada ENGINE_OUTBOX_RECHECK_MS). Nunca lança.
 */

import { engineName } from '@/lib/negotiation/engine';
import { flushOutbox } from '@/lib/negotiation/outbox';

export function drainIntervalMs(): number {
  const n = Number(process.env.ENGINE_OUTBOX_DRAIN_INTERVAL_MS);
  return Number.isFinite(n) && n >= 0 ? n : 15_000;
}

export interface OutboxDrainer {
  stop(): void;
  /** Uma rodada (exposta para testes/diagnóstico). */
  tick(): Promise<void>;
}

export function startEngineOutboxDrainer(): OutboxDrainer | null {
  const interval = drainIntervalMs();
  if (interval === 0) {
    console.log('[engine-outbox] dreno desligado (ENGINE_OUTBOX_DRAIN_INTERVAL_MS=0)');
    return null;
  }
  if (engineName() !== 'n8n') {
    console.log('[engine-outbox] dreno desligado (motor n8n não configurado neste processo)');
    return null;
  }

  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return; // uma rodada por vez
    running = true;
    try {
      const r = await flushOutbox({ limit: 50 });
      if (r.scanned > 0) {
        console.log(
          `[engine-outbox] scanned=${r.scanned} sent=${r.sent} failed=${r.failed} pending=${r.pending}`,
        );
      }
    } catch (err) {
      console.warn('[engine-outbox] rodada falhou (não-fatal):', err instanceof Error ? err.name : 'error');
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), interval);
  timer.unref?.();
  console.log(`[engine-outbox] dreno ligado (a cada ${interval} ms)`);
  return { stop: () => clearInterval(timer), tick };
}
