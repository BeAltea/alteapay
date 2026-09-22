// Cria um usuário de TESTE (Fabio) na VMAX com uma dívida fictícia, para testar os
// fluxos de negociação e cobrança com dados reais do Fabio. FLAGADO para remoção e
// para NÃO interferir nos valores reais da VMAX:
//   - source_system = 'test' e external_id = 'TEST_FABIO' no customer e na dívida;
//   - NÃO entra na tabela "VMAX" (que alimenta os totais do portfólio) — só em
//     customers + debts, que é o que o chat/journey usa (resolveByDocument).
// Idempotente: se já existir (por documento + company), reutiliza; não duplica a
// dívida de teste. `--remove` apaga o usuário e a dívida de teste.
const fs = require("fs")
const path = require("path")
const { Client } = require("pg")

const ROOT = path.resolve(__dirname, "../..")
const env = fs.readFileSync(path.join(ROOT, ".env.local"), "utf8")
const get = (k) => (env.split("\n").find((l) => l.startsWith(k + "=")) || "").slice(k.length + 1).trim().replace(/^["']|["']$/g, "")
const u = new URL(get("POSTGRES_URL_NON_POOLING")); u.searchParams.delete("sslmode"); u.searchParams.delete("uselibpqcompat")

const VMAX = "1f7729ee-a537-43fc-a27f-5747c177988d"
const DOC = "41719010811"           // 417.190.108-11 (DV válido)
const NAME = "Fabio Moura Barros"
const EMAIL = "fabiofmb71@gmail.com"
const PHONE = "11974602123"
const TAG = "TEST_FABIO"
const AMOUNT = 250.0
const DUE = "2026-08-15"            // vencida (para simular cobrança em aberto)
const REMOVE = process.argv.includes("--remove")

;(async () => {
  const c = new Client({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } })
  await c.connect()

  if (REMOVE) {
    const dd = await c.query("delete from debts where company_id=$1 and external_id=$2 returning id", [VMAX, TAG])
    const cd = await c.query("delete from customers where company_id=$1 and external_id=$2 returning id", [VMAX, TAG])
    console.log("REMOVIDO: dívidas", dd.rowCount, "| customers", cd.rowCount)
    await c.end(); return
  }

  // customer (upsert por company + documento)
  let cust = await c.query(
    "select id from customers where company_id=$1 and regexp_replace(coalesce(document,''),'\\D','','g')=$2 limit 1",
    [VMAX, DOC],
  )
  let customerId
  if (cust.rowCount) {
    customerId = cust.rows[0].id
    await c.query(
      "update customers set name=$2, email=$3, phone=$4, document_type='cpf', source_system='test', external_id=$5, updated_at=now() where id=$1",
      [customerId, NAME, EMAIL, PHONE, TAG],
    )
    console.log("customer JÁ EXISTIA, atualizado + flagado:", customerId.slice(0, 8))
  } else {
    const ins = await c.query(
      `insert into customers (company_id, name, document, document_type, email, phone, source_system, external_id, created_at, updated_at)
       values ($1,$2,$3,'cpf',$4,$5,'test',$6,now(),now()) returning id`,
      [VMAX, NAME, DOC, EMAIL, PHONE, TAG],
    )
    customerId = ins.rows[0].id
    console.log("customer CRIADO:", customerId.slice(0, 8))
  }

  // dívida fictícia (só cria se ainda não houver a de teste)
  const existing = await c.query("select id, status, amount from debts where company_id=$1 and customer_id=$2 and external_id=$3", [VMAX, customerId, TAG])
  let debtId
  if (existing.rowCount) {
    debtId = existing.rows[0].id
    await c.query("update debts set amount=$2, due_date=$3, status='pending', description=$4, source_system='test', external_id=$5, updated_at=now() where id=$1",
      [debtId, AMOUNT, DUE, "[TESTE - Fabio Moura Barros - REMOVER]", TAG])
    console.log("dívida de teste JÁ EXISTIA, atualizada:", debtId.slice(0, 8))
  } else {
    const ins = await c.query(
      `insert into debts (company_id, customer_id, amount, due_date, status, description, source_system, external_id, created_at, updated_at)
       values ($1,$2,$3,$4,'pending',$5,'test',$6,now(),now()) returning id`,
      [VMAX, customerId, AMOUNT, DUE, "[TESTE - Fabio Moura Barros - REMOVER]", TAG],
    )
    debtId = ins.rows[0].id
    console.log("dívida CRIADA:", debtId.slice(0, 8))
  }

  // conferência: contato derivado + o que o chat verá
  const chk = await c.query("select mobile_e164, email_valid, contact_profile from customers where id=$1", [customerId])
  console.log("contato derivado (trigger):", JSON.stringify(chk.rows[0]))
  const open = await c.query("select count(*) n, coalesce(sum(amount),0) total from debts where customer_id=$1 and status in ('pending','in_negotiation')", [customerId])
  console.log("dívidas ABERTAS do teste:", open.rows[0].n, "| total R$", Number(open.rows[0].total).toFixed(2))
  console.log("→ testar no chat: https://alteapay.com/n/k7Qm3Xb9Rt  (CPF 417.190.108-11)")
  console.log("→ remover depois: node ops/chatbot-journey-2026-09/seed_test_user_fabio.js --remove")
  await c.end()
})().catch((e) => { console.error("ERR", e.message); process.exit(1) })
