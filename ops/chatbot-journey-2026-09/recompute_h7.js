// Backfill idempotente: popula customers.mobile_e164/email_valid/contact_profile
// dos clientes do VMAX (a migration só criou o trigger p/ linhas novas/alteradas).
// Retorna só CONTAGENS — nenhum dado de cliente é impresso.
const fs = require("fs")
const path = require("path")
const { Client } = require("pg")

const ROOT = path.resolve(__dirname, "../..")
const env = fs.readFileSync(path.join(ROOT, ".env.local"), "utf8")
const raw = env.split("\n").find((l) => l.startsWith("POSTGRES_URL_NON_POOLING=")).slice("POSTGRES_URL_NON_POOLING=".length).trim().replace(/^["']|["']$/g, "")
const u = new URL(raw); u.searchParams.delete("sslmode"); u.searchParams.delete("uselibpqcompat")
const VMAX = "1f7729ee-a537-43fc-a27f-5747c177988d"

;(async () => {
  const c = new Client({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } })
  await c.connect()
  const r = await c.query("select recompute_contact_profile($1) as updated", [VMAX])
  const dist = await c.query(
    "select contact_profile, count(*) from customers where company_id=$1 group by contact_profile order by 2 desc",
    [VMAX],
  )
  console.log("recompute_contact_profile updated:", JSON.stringify(r.rows[0]))
  console.log("distribuição contact_profile (VMAX):")
  console.table(dist.rows)
  await c.end()
})().catch((e) => { console.error("ERR", e.message); process.exit(1) })
