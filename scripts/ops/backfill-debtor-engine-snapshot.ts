/**
 * backfill-debtor-engine-snapshot — popula/atualiza debtor_engine_snapshot
 * (Frente B, onda D1) chamando a função canônica recompute_debtor_engine_snapshot
 * por empresa. Idempotente (a função só reescreve linhas que MUDARAM).
 *
 * Imprime a contagem ANTES/DEPOIS por empresa e no total:
 *   - snapshots (linhas na tabela)
 *   - payload_ready (prontas para o session.start)
 *   - com valor aberto > 0
 * Rodar 2x → a 2ª passada escreve 0 linhas (idempotência).
 *
 * PII: NUNCA loga documento/nome — só company_id (uuid) e contagens.
 *
 * Conexão: POSTGRES_URL_NON_POOLING do .env.local (remove ?sslmode=..., usa
 * ssl.rejectUnauthorized=false — mesmo esquema dos demais scripts do repo).
 *
 * Uso:
 *   pnpm exec tsx scripts/ops/backfill-debtor-engine-snapshot.ts              # aplica
 *   pnpm exec tsx scripts/ops/backfill-debtor-engine-snapshot.ts --dry-run    # só conta
 *   pnpm exec tsx scripts/ops/backfill-debtor-engine-snapshot.ts --company=<uuid>
 *
 * NÃO aplicar em produção diretamente (G4 é gate) — o orquestrador roda após revisão.
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { Client } from "pg"

const DRY_RUN = process.argv.includes("--dry-run")
const COMPANY_ARG = process.argv.find((a) => a.startsWith("--company="))?.split("=")[1]

/** Lê POSTGRES_URL_NON_POOLING do .env.local sem depender de dotenv. */
function readDbUrl(): string {
  const envPath = resolve(process.cwd(), ".env.local")
  let raw: string
  try {
    raw = readFileSync(envPath, "utf8")
  } catch {
    console.error("[backfill-snapshot] .env.local não encontrado no cwd")
    process.exit(1)
  }
  const line = raw.split("\n").find((l) => l.startsWith("POSTGRES_URL_NON_POOLING="))
  if (!line) {
    console.error("[backfill-snapshot] POSTGRES_URL_NON_POOLING ausente no .env.local")
    process.exit(1)
  }
  return line
    .slice("POSTGRES_URL_NON_POOLING=".length)
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/[?&]sslmode=[^&]*/g, "")
}

interface Counts {
  snapshots: number
  payloadReady: number
  withOpenAmount: number
}

async function snapshot(client: Client, companyId?: string): Promise<Counts> {
  const where = companyId ? "where company_id = $1" : ""
  const params = companyId ? [companyId] : []
  const q = await client.query<{ snapshots: string; payload_ready: string; with_open_amount: string }>(
    `select
       count(*) as snapshots,
       count(*) filter (where payload_ready) as payload_ready,
       count(*) filter (where open_amount_cents > 0) as with_open_amount
     from public.debtor_engine_snapshot ${where}`,
    params,
  )
  const r = q.rows[0]
  return {
    snapshots: Number(r.snapshots),
    payloadReady: Number(r.payload_ready),
    withOpenAmount: Number(r.with_open_amount),
  }
}

function printCounts(label: string, c: Counts): void {
  console.log(
    `[backfill-snapshot] ${label}: snapshots=${c.snapshots} payload_ready=${c.payloadReady} com_valor_aberto=${c.withOpenAmount}`,
  )
}

async function main(): Promise<void> {
  const client = new Client({ connectionString: readDbUrl(), ssl: { rejectUnauthorized: false } })
  await client.connect()
  try {
    const companies = COMPANY_ARG
      ? [COMPANY_ARG]
      : (await client.query<{ id: string }>("select id from public.companies order by id")).rows.map((r) => r.id)

    const before = await snapshot(client, COMPANY_ARG)
    printCounts("ANTES", before)

    if (DRY_RUN) {
      console.log("[backfill-snapshot] --dry-run: nada aplicado.")
      return
    }

    let totalWritten = 0
    for (const companyId of companies) {
      const res = await client.query<{ recompute_debtor_engine_snapshot: number }>(
        "select public.recompute_debtor_engine_snapshot($1)",
        [companyId],
      )
      const written = Number(res.rows[0]?.recompute_debtor_engine_snapshot ?? 0)
      totalWritten += written
      console.log(`[backfill-snapshot] empresa=${companyId} linhas_escritas=${written}`)
    }

    const after = await snapshot(client, COMPANY_ARG)
    printCounts("DEPOIS", after)
    console.log(`[backfill-snapshot] total_linhas_escritas=${totalWritten}`)
  } finally {
    await client.end()
  }
}

main().catch((err) => {
  console.error("[backfill-snapshot] erro:", err instanceof Error ? err.message : "unknown")
  process.exit(1)
})
