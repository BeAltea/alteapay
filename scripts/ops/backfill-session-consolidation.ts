/**
 * backfill-session-consolidation — consolida sessões duplicadas do MESMO devedor
 * SEM apagar nada (A1.1, complemento do reuso da auth).
 *
 * O que faz, por (company_id, customer_id):
 *   1. Escolhe a sessão CANÔNICA = a mais recente por atividade
 *      (coalesce(last_activity_at, updated_at, created_at) desc).
 *   2. Marca TODAS as anteriores com merged_into_session_id = canônica
 *      (só onde ainda é NULL — idempotente; nunca aponta uma sessão pra si mesma).
 *   3. Preenche first_opened_at e last_activity_at onde faltarem:
 *        - first_opened_at   ← created_at da própria sessão, OU o menor
 *                              occurred_at em journey_events da sessão.
 *        - last_activity_at  ← maior occurred_at em journey_events da sessão,
 *                              OU updated_at, OU created_at.
 *   NUNCA faz DELETE/UPDATE destrutivo — só grava as colunas aditivas.
 *
 * Contagem ANTES/DEPOIS (sessões, duplicadas por devedor, já-consolidadas, buracos
 * de first_opened_at/last_activity_at). Read-then-write idempotente: rodar 2x não
 * muda nada na 2ª passada.
 *
 * PII: NUNCA loga documento/telefone/email — só ids (uuid) e contagens.
 *
 * Conexão: POSTGRES_URL_NON_POOLING do .env.local (remove ?sslmode=..., usa
 * ssl.rejectUnauthorized=false — mesmo esquema dos demais scripts do repo).
 *
 * Uso:
 *   pnpm exec tsx scripts/ops/backfill-session-consolidation.ts          # aplica
 *   pnpm exec tsx scripts/ops/backfill-session-consolidation.ts --dry-run # só conta
 *
 * NÃO aplicar em produção diretamente — o orquestrador roda após revisão.
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { Client } from "pg"

const DRY_RUN = process.argv.includes("--dry-run")

/** Lê POSTGRES_URL_NON_POOLING do .env.local sem depender de dotenv. */
function readDbUrl(): string {
  const envPath = resolve(process.cwd(), ".env.local")
  let raw: string
  try {
    raw = readFileSync(envPath, "utf8")
  } catch {
    console.error("[backfill] .env.local não encontrado no cwd")
    process.exit(1)
  }
  const line = raw.split("\n").find((l) => l.startsWith("POSTGRES_URL_NON_POOLING="))
  if (!line) {
    console.error("[backfill] POSTGRES_URL_NON_POOLING ausente no .env.local")
    process.exit(1)
  }
  const url = line
    .slice("POSTGRES_URL_NON_POOLING=".length)
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/[?&]sslmode=[^&]*/g, "") // remove sslmode; usamos ssl abaixo
  return url
}

interface Counts {
  sessions: number
  sessionsWithCustomer: number
  duplicatePairs: number // sessões que NÃO são a canônica do seu devedor
  alreadyMerged: number
  missingFirstOpened: number
  missingLastActivity: number
}

async function snapshot(client: Client): Promise<Counts> {
  const q = await client.query<{
    sessions: string
    sessions_with_customer: string
    duplicate_pairs: string
    already_merged: string
    missing_first_opened: string
    missing_last_activity: string
  }>(`
    with ranked as (
      select id, company_id, customer_id, merged_into_session_id,
             first_opened_at, last_activity_at,
             row_number() over (
               partition by company_id, customer_id
               order by coalesce(last_activity_at, updated_at, created_at) desc, created_at desc
             ) as rn
      from public.negotiation_sessions
      where customer_id is not null
    )
    select
      (select count(*) from public.negotiation_sessions) as sessions,
      (select count(*) from public.negotiation_sessions where customer_id is not null) as sessions_with_customer,
      (select count(*) from ranked where rn > 1) as duplicate_pairs,
      (select count(*) from public.negotiation_sessions where merged_into_session_id is not null) as already_merged,
      (select count(*) from public.negotiation_sessions where first_opened_at is null) as missing_first_opened,
      (select count(*) from public.negotiation_sessions where last_activity_at is null) as missing_last_activity
  `)
  const r = q.rows[0]
  return {
    sessions: Number(r.sessions),
    sessionsWithCustomer: Number(r.sessions_with_customer),
    duplicatePairs: Number(r.duplicate_pairs),
    alreadyMerged: Number(r.already_merged),
    missingFirstOpened: Number(r.missing_first_opened),
    missingLastActivity: Number(r.missing_last_activity),
  }
}

function printCounts(label: string, c: Counts): void {
  console.log(`\n[backfill] ${label}`)
  console.log(`  sessões (total)................ ${c.sessions}`)
  console.log(`  sessões com customer........... ${c.sessionsWithCustomer}`)
  console.log(`  duplicadas (não-canônicas)..... ${c.duplicatePairs}`)
  console.log(`  já marcadas merged_into........ ${c.alreadyMerged}`)
  console.log(`  sem first_opened_at............ ${c.missingFirstOpened}`)
  console.log(`  sem last_activity_at........... ${c.missingLastActivity}`)
}

/**
 * 1) Preenche first_opened_at/last_activity_at onde faltar (da própria sessão /
 *    de journey_events). 2) Marca as não-canônicas com merged_into a canônica.
 * Tudo em UMA transação; nada destrutivo. Retorna linhas afetadas por passo.
 */
async function consolidate(client: Client): Promise<{ filledFirst: number; filledLast: number; merged: number }> {
  await client.query("begin")
  try {
    // (a) first_opened_at ← created_at da própria sessão, senão menor evento.
    const filledFirst = await client.query(`
      update public.negotiation_sessions s
         set first_opened_at = coalesce(
               s.created_at,
               (select min(e.occurred_at) from public.journey_events e where e.session_id = s.id)
             )
       where s.first_opened_at is null
    `)

    // (b) last_activity_at ← maior evento, senão updated_at, senão created_at.
    const filledLast = await client.query(`
      update public.negotiation_sessions s
         set last_activity_at = coalesce(
               (select max(e.occurred_at) from public.journey_events e where e.session_id = s.id),
               s.updated_at,
               s.created_at
             )
       where s.last_activity_at is null
    `)

    // (c) merge das não-canônicas na canônica (mais recente por atividade).
    //     Só onde merged_into ainda é NULL e a canônica != a própria linha.
    const merged = await client.query(`
      with ranked as (
        select id, company_id, customer_id,
               first_value(id) over (
                 partition by company_id, customer_id
                 order by coalesce(last_activity_at, updated_at, created_at) desc, created_at desc
               ) as canonical_id,
               row_number() over (
                 partition by company_id, customer_id
                 order by coalesce(last_activity_at, updated_at, created_at) desc, created_at desc
               ) as rn
        from public.negotiation_sessions
        where customer_id is not null
      )
      update public.negotiation_sessions s
         set merged_into_session_id = r.canonical_id
        from ranked r
       where s.id = r.id
         and r.rn > 1
         and r.canonical_id <> s.id
         and s.merged_into_session_id is null
    `)

    await client.query("commit")
    return {
      filledFirst: filledFirst.rowCount ?? 0,
      filledLast: filledLast.rowCount ?? 0,
      merged: merged.rowCount ?? 0,
    }
  } catch (err) {
    await client.query("rollback")
    throw err
  }
}

async function main(): Promise<void> {
  const url = readDbUrl()
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
  await client.connect()
  console.log(`[backfill] conectado (${DRY_RUN ? "DRY-RUN — não escreve" : "APLICANDO"})`)

  try {
    const before = await snapshot(client)
    printCounts("ANTES", before)

    if (DRY_RUN) {
      console.log("\n[backfill] dry-run: nenhuma escrita. Fim.")
      return
    }

    const res = await consolidate(client)
    console.log(
      `\n[backfill] gravado: first_opened_at=${res.filledFirst}, last_activity_at=${res.filledLast}, merged_into=${res.merged}`,
    )

    const after = await snapshot(client)
    printCounts("DEPOIS", after)
    console.log(
      `\n[backfill] delta: duplicadas ${before.duplicatePairs}→${after.duplicatePairs}, ` +
        `merged ${before.alreadyMerged}→${after.alreadyMerged}, ` +
        `sem first_opened ${before.missingFirstOpened}→${after.missingFirstOpened}, ` +
        `sem last_activity ${before.missingLastActivity}→${after.missingLastActivity}`,
    )
    console.log("\n[backfill] concluído. NADA foi apagado — só colunas aditivas gravadas.")
  } finally {
    await client.end()
  }
}

void main().catch((err) => {
  console.error("[backfill] erro:", (err as Error).message)
  process.exit(1)
})
