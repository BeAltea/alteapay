// Backfill: cria em `customers` os devedores da VMAX que ainda NÃO têm cadastro
// (documento sem correspondência). Sem isso, o envio de negociação (F1, customers-
// keyed) recusa com "documento sem correspondência na base de clientes".
//
// Reusa as funções do banco (migration 20260922) para mobile_e164/email_valid/
// contact_profile — mesma lógica do resto da base. Idempotente (só insere os que
// faltam). Documento gravado em DÍGITOS (como os customers existentes). DISTINCT ON
// por documento evita duplicar quando a VMAX repete o mesmo doc. Dry-run por padrão;
// --apply grava.
const fs = require("fs")
const path = require("path")
const { Client } = require("pg")

const ROOT = path.resolve(__dirname, "../..")
const env = fs.readFileSync(path.join(ROOT, ".env.local"), "utf8")
const get = (k) => (env.split("\n").find((l) => l.startsWith(k + "=")) || "").slice(k.length + 1).trim().replace(/^["']|["']$/g, "")
const u = new URL(get("POSTGRES_URL_NON_POOLING")); u.searchParams.delete("sslmode"); u.searchParams.delete("uselibpqcompat")
const VMAX = process.argv.find((a) => a.startsWith("--company="))?.split("=")[1] || "1f7729ee-a537-43fc-a27f-5747c177988d"
const APPLY = process.argv.includes("--apply")

const norm = `regexp_replace(coalesce("CPF/CNPJ",''),'\\D','','g')`
// fonte: VMAX com doc válido (11/14 díg), 1 por documento, sem customer ainda
const SOURCE = `
  select v.* from (
    select distinct on (regexp_replace("CPF/CNPJ",'\\D','','g')) *
    from "VMAX"
    where id_company = $1 and length(${norm}) in (11,14)
    order by regexp_replace("CPF/CNPJ",'\\D','','g'), id
  ) v
  where not exists (
    select 1 from customers cu
    where cu.company_id = v.id_company
      and regexp_replace(coalesce(cu.document,''),'\\D','','g') = regexp_replace(coalesce(v."CPF/CNPJ",''),'\\D','','g')
  )`

;(async () => {
  const c = new Client({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } })
  await c.connect()

  const cnt = await c.query(`select count(*) n,
     count(*) filter (where public.altea_to_e164_mobile(coalesce("Telefone 1","Telefone 2")) is not null) com_cel,
     count(*) filter (where public.altea_is_email_valid("Email")) com_email
     from (${SOURCE}) s`, [VMAX])
  console.log("A INSERIR:", cnt.rows[0].n, "| com celular válido:", cnt.rows[0].com_cel, "| com e-mail válido:", cnt.rows[0].com_email, APPLY ? "(APLICANDO)" : "(DRY-RUN)")

  if (!APPLY) { console.log("nada gravado. --apply para inserir."); await c.end(); return }

  const before = await c.query("select count(*) n from customers where company_id=$1", [VMAX])
  const ins = await c.query(`
    insert into customers (company_id, name, document, document_type, email, phone, mobile_e164, email_valid, contact_profile, source_system, created_at, updated_at)
    select
      s.id_company,
      coalesce(nullif(btrim(s."Cliente"), ''), 'Cliente'),
      regexp_replace(coalesce(s."CPF/CNPJ",''),'\\D','','g'),
      case when length(regexp_replace(coalesce(s."CPF/CNPJ",''),'\\D','','g'))=14 then 'cnpj' else 'cpf' end,
      nullif(btrim(s."Email"), ''),
      coalesce(nullif(btrim(s."Telefone 1"), ''), nullif(btrim(s."Telefone 2"), '')),
      public.altea_to_e164_mobile(coalesce(s."Telefone 1", s."Telefone 2")),
      public.altea_is_email_valid(s."Email"),
      public.altea_derive_contact_profile(public.altea_to_e164_mobile(coalesce(s."Telefone 1", s."Telefone 2")) is not null, public.altea_is_email_valid(s."Email")),
      'vmax', now(), now()
    from (${SOURCE}) s
    returning id`, [VMAX])
  const after = await c.query("select count(*) n from customers where company_id=$1", [VMAX])
  console.log("INSERIDOS:", ins.rowCount, "| customers antes:", before.rows[0].n, "→ depois:", after.rows[0].n)

  // conferência: agora quantos VMAX ainda ficam sem correspondência?
  const rem = await c.query(`select count(*) n from (${SOURCE}) s`, [VMAX])
  console.log("VMAX ainda SEM customer (doc inválido, não-inseríveis):", rem.rows[0].n)
  await c.end()
})().catch((e) => { console.error("ERR", e.message); process.exit(1) })
