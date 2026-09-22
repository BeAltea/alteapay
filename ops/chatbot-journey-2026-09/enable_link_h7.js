// Liga o link único público do VMAX (public_link_enabled=true) com janela de 30d.
// Passo FINAL do go-live — expõe /n/{code} à autenticação por CPF/CNPJ.
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
  await c.query(
    `update tenant_chat_config
       set public_link_enabled = true,
           public_link_valid_until = now() + interval '30 days'
     where company_id = $1`, [VMAX],
  )
  const r = await c.query(
    `select public_link_code, public_link_enabled, public_link_valid_until
       from tenant_chat_config where company_id = $1`, [VMAX],
  )
  console.log("LINK LIGADO:", JSON.stringify(r.rows[0]))
  await c.end()
})().catch((e) => { console.error("ERR", e.message); process.exit(1) })
