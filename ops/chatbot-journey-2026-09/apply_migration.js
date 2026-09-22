// Aplica uma migration (argv[2] = caminho relativo do .sql) no Supabase PROD
// dentro de transação. Aditiva/idempotente. Sem PII (só nomes de coluna).
const fs = require("fs")
const path = require("path")
const { Client } = require("pg")

const ROOT = path.resolve(__dirname, "../..")
const rel = process.argv[2]
if (!rel) { console.error("uso: node apply_migration.js <caminho .sql>"); process.exit(1) }
const env = fs.readFileSync(path.join(ROOT, ".env.local"), "utf8")
const raw = env.split("\n").find((l) => l.startsWith("POSTGRES_URL_NON_POOLING=")).slice("POSTGRES_URL_NON_POOLING=".length).trim().replace(/^["']|["']$/g, "")
const u = new URL(raw); u.searchParams.delete("sslmode"); u.searchParams.delete("uselibpqcompat")
const sql = fs.readFileSync(path.join(ROOT, rel), "utf8")

;(async () => {
  const c = new Client({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } })
  await c.connect()
  try {
    await c.query("begin"); await c.query(sql); await c.query("commit")
    console.log("MIGRATION APLICADA:", rel)
  } catch (e) {
    await c.query("rollback").catch(() => {})
    console.error("FALHOU (rollback):", e.message); process.exit(1)
  }
  const check = await c.query(`
    select column_name from information_schema.columns
    where table_name='negotiation_sessions'
      and column_name in ('reopen_count','first_opened_at','previous_session_id','merged_into_session_id','last_activity_at')
    order by column_name`)
  console.log("colunas de sessão presentes:", check.rows.map(r => r.column_name).join(", "))
  await c.end()
})().catch((e) => { console.error("ERR", e.message); process.exit(1) })
