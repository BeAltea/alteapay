// Aplica a migration 20260922_hub_link_status.sql no Supabase PROD dentro de uma
// transação, e verifica o schema (só information_schema — sem PII). Aditiva/idempotente.
const fs = require("fs")
const path = require("path")
const { Client } = require("pg")

const ROOT = path.resolve(__dirname, "../..")
const env = fs.readFileSync(path.join(ROOT, ".env.local"), "utf8")
const line = env.split("\n").find((l) => l.startsWith("POSTGRES_URL_NON_POOLING="))
if (!line) throw new Error("POSTGRES_URL_NON_POOLING ausente no .env.local")
const rawUrl = line.slice("POSTGRES_URL_NON_POOLING=".length).trim().replace(/^["']|["']$/g, "")
// Remove sslmode/uselibpqcompat da URL: com pg novo eles viram verify-full e
// rejeitam o cert self-signed do Supabase. O ssl:{rejectUnauthorized:false}
// escopado abaixo é o TLS correto (sem NODE_TLS_REJECT_UNAUTHORIZED global).
const u = new URL(rawUrl)
u.searchParams.delete("sslmode")
u.searchParams.delete("uselibpqcompat")
const url = u.toString()
const sql = fs.readFileSync(path.join(ROOT, "supabase/migrations/20260922_hub_link_status.sql"), "utf8")

;(async () => {
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
  await c.connect()
  try {
    await c.query("begin")
    await c.query(sql)
    await c.query("commit")
    console.log("MIGRATION APLICADA (commit ok)")
  } catch (e) {
    await c.query("rollback").catch(() => {})
    console.error("FALHOU (rollback):", e.message)
    process.exit(1)
  }
  // verificação de schema (metadados; nenhum dado de cliente)
  const checks = await c.query(`
    select
      (select count(*) from information_schema.columns where table_name='tenant_chat_config' and column_name='public_link_code') as tcc_public_link_code,
      (select count(*) from information_schema.columns where table_name='tenant_chat_config' and column_name='voxuy_flow_id') as tcc_voxuy_flow_id,
      (select count(*) from information_schema.columns where table_name='customers' and column_name='contact_profile') as cust_contact_profile,
      (select count(*) from information_schema.columns where table_name='negotiation_sessions' and column_name='engine_owner') as sess_engine_owner,
      (select count(*) from information_schema.columns where table_name='whatsapp_messages' and column_name='channel') as wa_channel,
      (select count(*) from information_schema.tables where table_name='negotiation_state') as tbl_negotiation_state,
      (select public_link_code from tenant_chat_config where company_id='1f7729ee-a537-43fc-a27f-5747c177988d') as vmax_code,
      (select public_link_enabled from tenant_chat_config where company_id='1f7729ee-a537-43fc-a27f-5747c177988d') as vmax_enabled
  `)
  console.log("VERIFICAÇÃO:", JSON.stringify(checks.rows[0], null, 2))
  await c.end()
})().catch((e) => { console.error("ERR", e.message); process.exit(1) })
