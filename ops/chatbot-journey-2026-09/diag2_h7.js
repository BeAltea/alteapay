// Diagnóstico do bug "nenhum CPF da VMAX retorna dívida". Causas candidatas:
//   (1) limite 1000 linhas no resolveByDocument (customers sem paginação)
//   (2) status da dívida fora de ('pending','in_negotiation')
//   (3) formato/normalização do documento
// Retorna só CONTAGENS e documento MASCARADO — sem nome/doc em claro.
const fs = require("fs"); const path = require("path"); const { Client } = require("pg")
const ROOT = path.resolve(__dirname, "../..")
const env = fs.readFileSync(path.join(ROOT, ".env.local"), "utf8")
const raw = env.split("\n").find((l) => l.startsWith("POSTGRES_URL_NON_POOLING=")).slice("POSTGRES_URL_NON_POOLING=".length).trim().replace(/^["']|["']$/g, "")
const u = new URL(raw); u.searchParams.delete("sslmode"); u.searchParams.delete("uselibpqcompat")
const VMAX = "1f7729ee-a537-43fc-a27f-5747c177988d"
const DOC = "33036695893"

;(async () => {
  const c = new Client({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } })
  await c.connect()
  const norm = `regexp_replace(document,'\\D','','g')`

  const q1 = await c.query(`select count(*) total, count(document) with_doc,
    count(*) filter (where length(regexp_replace(coalesce(document,''),'\\D','','g'))>=11) usable
    from customers where company_id=$1`, [VMAX])
  console.log("1) customers VMAX:", JSON.stringify(q1.rows[0]))

  const q2 = await c.query(`select ${norm}=$2 as doc_match, company_id, id as customer_id
    from customers where company_id=$1 and ${norm}=$2 limit 3`, [VMAX, DOC])
  console.log(`2) doc ${DOC.slice(0,3)}...${DOC.slice(-2)} em customers VMAX:`, q2.rowCount, JSON.stringify(q2.rows))

  const q2b = await c.query(`select company_id, count(*) from customers where ${norm}=$1 group by company_id`, [DOC])
  console.log("2b) esse doc em QUALQUER empresa:", JSON.stringify(q2b.rows))

  const q3 = await c.query(`select status, count(*) from debts where company_id=$1 group by status order by 2 desc`, [VMAX])
  console.log("3) debts VMAX por status (SQL group by, sem limite):")
  console.table(q3.rows)

  const q4 = await c.query(`select
    count(distinct cu.id) filter (where d.status in ('pending','in_negotiation')) as com_divida_aberta_atual,
    count(distinct cu.id) filter (where d.id is not null) as com_qualquer_divida
    from customers cu left join debts d on d.customer_id=cu.id and d.company_id=cu.company_id
    where cu.company_id=$1`, [VMAX])
  console.log("4) customers VMAX resolvíveis:", JSON.stringify(q4.rows[0]))

  // 5) o customer do DOC tem dívida? qual status?
  const q5 = await c.query(`select d.status, count(*) from customers cu
    join debts d on d.customer_id=cu.id and d.company_id=cu.company_id
    where cu.company_id=$1 and ${norm}=$2 group by d.status`, [VMAX, DOC])
  console.log(`5) dívidas do doc ${DOC.slice(0,3)}...${DOC.slice(-2)} por status:`, JSON.stringify(q5.rows))
  await c.end()
})().catch((e) => { console.error("ERR", e.message); process.exit(1) })
