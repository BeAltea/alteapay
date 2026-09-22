// Diagnóstico do reuso de sessão (S1≠S2). Sem PII: só ids/status/timestamps/flags.
// Prova se o problema é schema-cache do PostgREST (colunas de 20260924) comparando
// o que o pg CRU vê vs o que o REST (caminho do app) consegue selecionar.
const fs = require("fs")
const path = require("path")
const { Client } = require("pg")

const ROOT = path.resolve(__dirname, "../..")
const env = fs.readFileSync(path.join(ROOT, ".env.local"), "utf8")
const get = (k) => (env.split("\n").find((l) => l.startsWith(k + "=")) || "").slice(k.length + 1).trim().replace(/^["']|["']$/g, "")
const raw = get("POSTGRES_URL_NON_POOLING")
const u = new URL(raw); u.searchParams.delete("sslmode"); u.searchParams.delete("uselibpqcompat")
const supaUrl = get("SUPABASE_URL") || get("NEXT_PUBLIC_SUPABASE_URL")
const svcKey = get("SUPABASE_SERVICE_ROLE_KEY")

const S1 = "19189c20-2422-4617-8f65-0ac0ecab26c7"
const S2 = "043fa016-c9e2-412e-8c6c-6119b94e9ff7"

;(async () => {
  const c = new Client({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } })
  await c.connect()

  // 1) pg cru: as duas sessões — status, atividade e colunas de 20260924
  const q1 = await c.query(
    `select id, status, company_id, customer_id,
            last_activity_at, first_opened_at, reopen_count, previous_session_id, created_at
       from negotiation_sessions where id = any($1) order by created_at`, [[S1, S2]])
  console.log("1) pg CRU — as duas sessões:")
  for (const r of q1.rows) {
    console.log("  ", JSON.stringify({
      id: r.id.slice(0, 8), status: r.status,
      cust: (r.customer_id || "").slice(0, 8),
      last_activity_at: r.last_activity_at, first_opened_at: r.first_opened_at,
      reopen_count: r.reopen_count, prev: r.previous_session_id ? r.previous_session_id.slice(0, 8) : null,
    }))
  }
  const sameCust = q1.rows.length === 2 && q1.rows[0].customer_id === q1.rows[1].customer_id
  console.log("   mesmo customer_id?", sameCust)

  // 2) REST (caminho do app): consegue SELECT das colunas de 20260924?
  const restCols = "id,status,last_activity_at,first_opened_at,reopen_count,previous_session_id"
  const r2 = await fetch(`${supaUrl}/rest/v1/negotiation_sessions?id=eq.${S1}&select=${restCols}`,
    { headers: { apikey: svcKey, Authorization: `Bearer ${svcKey}` } })
  console.log("2) REST SELECT colunas 20260924 — status HTTP:", r2.status)
  console.log("   body:", (await r2.text()).slice(0, 400))

  // 3) REST: a query EXATA do findReusableOpenSession p/ o customer de S1
  if (q1.rows[0]) {
    const cust = q1.rows[0].customer_id
    const comp = q1.rows[0].company_id
    const cutoff = new Date(Date.now() - 30 * 60000).toISOString()
    const url = `${supaUrl}/rest/v1/negotiation_sessions?company_id=eq.${comp}&customer_id=eq.${cust}` +
      `&status=eq.open&last_activity_at=gte.${encodeURIComponent(cutoff)}` +
      `&select=id,status,last_activity_at,reopen_count&order=last_activity_at.desc&limit=5`
    const r3 = await fetch(url, { headers: { apikey: svcKey, Authorization: `Bearer ${svcKey}` } })
    console.log("3) REST query do reuso (status=open + dentro do TTL 30min) — HTTP:", r3.status)
    console.log("   body:", (await r3.text()).slice(0, 600))
  }
  await c.end()
})().catch((e) => { console.error("ERR", e.message); process.exit(1) })
