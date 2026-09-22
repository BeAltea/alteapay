const fs=require("fs"),path=require("path"),{Client}=require("pg")
const ROOT=path.resolve(__dirname,"../..")
const raw=fs.readFileSync(ROOT+"/.env.local","utf8").split("\n").find(l=>l.startsWith("POSTGRES_URL_NON_POOLING=")).slice(25).trim().replace(/^["']|["']$/g,"")
const u=new URL(raw);u.searchParams.delete("sslmode");u.searchParams.delete("uselibpqcompat")
;(async()=>{const c=new Client({connectionString:u.toString(),ssl:{rejectUnauthorized:false}});await c.connect()
// simula a NOVA busca: document IN (candidatos) — sem carregar 3196
const r=await c.query(`select id from customers where company_id='1f7729ee-a537-43fc-a27f-5747c177988d' and document = any($1) limit 5`,[['33036695893','330.366.958-93']])
console.log("NOVA query acha o customer 73cbb280?:", r.rows.map(x=>x.id).includes('73cbb280-9b84-42bb-b8fb-84486e332ce3'), "(rows:",r.rowCount+")")
await c.end()})().catch(e=>{console.error(e.message);process.exit(1)})
