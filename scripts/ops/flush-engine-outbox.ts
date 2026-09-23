/**
 * flush-engine-outbox — reentrega manual dos eventos plataforma → n8n pendentes
 * na tabela engine_outbox (Frente A, onda D1).
 *
 * Reusa a MESMA lógica de produção (lib/negotiation/outbox.ts::flushOutbox):
 *   - pega as linhas status='pending' elegíveis (next_attempt_at no passado/nulo)
 *     na ORDEM de criação (session.start antes do 1º chat.turn);
 *   - POST assinado ao n8n (HMAC ${ts}.${body} + Basic Auth) com timeout curto;
 *   - persiste o desfecho (sent | pending com backoff | failed no teto).
 *
 * Gated ('skipped_engine_disabled') NÃO é elegível (o flush só toca 'pending').
 *
 * Imprime SOMENTE contagens (scanned/sent/failed/pending) — NUNCA payload, URL,
 * segredo ou PII.
 *
 * Uso:
 *   pnpm exec tsx scripts/ops/flush-engine-outbox.ts
 *   pnpm exec tsx scripts/ops/flush-engine-outbox.ts --limit=200
 *   pnpm exec tsx scripts/ops/flush-engine-outbox.ts --session=<uuid>
 *
 * Requer no ambiente (do .env.local): NEXT_PUBLIC_SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY, N8N_WEBHOOK_SECRET, N8N_CHAT_FLOW_URL (ou
 * N8N_EVENT_FLOW_URL), N8N_BASIC_AUTH_USER/PASSWORD.
 *
 * NÃO aplicar em produção diretamente — o orquestrador roda após revisão.
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"

/** Carrega .env.local no process.env sem depender de dotenv (só KEY=VALUE simples). */
function loadEnvLocal(): void {
  const envPath = resolve(process.cwd(), ".env.local")
  let raw: string
  try {
    raw = readFileSync(envPath, "utf8")
  } catch {
    console.error("[flush-outbox] .env.local não encontrado no cwd")
    process.exit(1)
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    if (process.env[key] !== undefined) continue
    process.env[key] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "")
  }
}

function parseArgs(): { limit: number; sessionId?: string } {
  let limit = 100
  let sessionId: string | undefined
  for (const arg of process.argv.slice(2)) {
    const m = /^--limit=(\d+)$/.exec(arg)
    if (m) limit = Number(m[1])
    const s = /^--session=(.+)$/.exec(arg)
    if (s) sessionId = s[1]
  }
  return { limit, sessionId }
}

async function main(): Promise<void> {
  loadEnvLocal()
  const { limit, sessionId } = parseArgs()

  // import dinâmico DEPOIS de carregar as envs (o módulo lê process.env na borda).
  const { flushOutbox } = await import("@/lib/negotiation/outbox")
  const result = await flushOutbox({ limit, sessionId })

  console.log(
    `[flush-outbox] scanned=${result.scanned} sent=${result.sent} failed=${result.failed} pending=${result.pending}`,
  )
}

main().catch((err) => {
  // rótulo curto — nunca segredo/PII.
  console.error("[flush-outbox] erro:", err instanceof Error ? err.message : "unknown")
  process.exit(1)
})
