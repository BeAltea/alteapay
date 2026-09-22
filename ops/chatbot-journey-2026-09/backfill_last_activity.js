// Backfill A1.1: sessões 'open' com last_activity_at NULL nunca são reaproveitadas
// (findReusableOpenSession filtra last_activity_at >= cutoff, e NULL é excluído).
// Preenche com coalesce(updated_at, created_at) para torná-las reutilizáveis dentro
// do TTL. Idempotente (só toca linhas ainda NULL). Sem PII — só contagens/ids curtos.
// Rodar junto com o deploy que leva o fix do INSERT (createHandoffSession).
const fs = require("fs")
const path = require("path")
const { Client } = require("pg")

const ROOT = path.resolve(__dirname, "../..")
const env = fs.readFileSync(path.join(ROOT, ".env.local"), "utf8")
const get = (k) => (env.split("\n").find((l) => l.startsWith(k + "=")) || "").slice(k.length + 1).trim().replace(/^["']|["']$/g, "")
const u = new URL(get("POSTGRES_URL_NON_POOLING")); u.searchParams.delete("sslmode"); u.searchParams.delete("uselibpqcompat")
const DRY = process.argv.includes("--apply") ? false : true

;(async () => {
  const c = new Client({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } })
  await c.connect()

  const before = await c.query(
    `select count(*) filter (where last_activity_at is null) as null_open
       from negotiation_sessions where status = 'open'`)
  console.log("sessões open com last_activity_at NULL:", before.rows[0].null_open, DRY ? "(DRY-RUN)" : "(APLICANDO)")

  if (!DRY) {
    const r = await c.query(
      `update negotiation_sessions
          set last_activity_at = coalesce(updated_at, created_at)
        where status = 'open' and last_activity_at is null
          and coalesce(updated_at, created_at) is not null
        returning id`)
    console.log("linhas preenchidas:", r.rowCount)
    const after = await c.query(
      `select count(*) filter (where last_activity_at is null) as null_open
         from negotiation_sessions where status = 'open'`)
    console.log("restantes NULL (sem updated_at/created_at):", after.rows[0].null_open)
  } else {
    console.log("nada alterado. Re-rode com --apply para gravar.")
  }
  await c.end()
})().catch((e) => { console.error("ERR", e.message); process.exit(1) })
