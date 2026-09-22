// Sanitiza os contatos dos customers da VMAX: maximiza telefone + e-mail e
// NORMALIZA o telefone para E.164 (compatível com Voxuy e n8n).
//
// IMPORTANTE: a tabela customers tem um TRIGGER (trg_customers_contact_profile)
// que recomputa mobile_e164/email_valid/contact_profile a partir de `phone`/`email`
// a cada UPDATE. Logo, NÃO setamos os campos derivados — setamos o `phone` para o
// MELHOR número CELULAR disponível (entre phone atual, "Telefone 1", "Telefone 2")
// e o `email` para o melhor válido; o trigger deriva o resto corretamente.
//
// "Melhor celular" = o número cru cuja normalização altea_to_e164_mobile é válida.
// Se não houver celular em lugar nenhum, mantém o telefone atual (fixo). Idempotente.
const fs = require("fs")
const path = require("path")
const { Client } = require("pg")

const ROOT = path.resolve(__dirname, "../..")
const env = fs.readFileSync(path.join(ROOT, ".env.local"), "utf8")
const get = (k) => (env.split("\n").find((l) => l.startsWith(k + "=")) || "").slice(k.length + 1).trim().replace(/^["']|["']$/g, "")
const u = new URL(get("POSTGRES_URL_NON_POOLING")); u.searchParams.delete("sslmode"); u.searchParams.delete("uselibpqcompat")
const VMAX = process.argv.find((a) => a.startsWith("--company="))?.split("=")[1] || "1f7729ee-a537-43fc-a27f-5747c177988d"
const APPLY = process.argv.includes("--apply")

// por documento: melhor CELULAR cru (Tel1/Tel2 que normaliza p/ E.164 válido),
// qualquer telefone cru (fallback), e melhor e-mail válido. coalesce p/ '{}' evita
// o bug de NULL || array.
const VMAX_BEST = `
  vmax_best as (
    select regexp_replace(coalesce("CPF/CNPJ",''),'\\D','','g') as doc,
      (array_remove(
        coalesce(array_agg("Telefone 1") filter (where public.altea_to_e164_mobile("Telefone 1") is not null), '{}'::text[])
        || coalesce(array_agg("Telefone 2") filter (where public.altea_to_e164_mobile("Telefone 2") is not null), '{}'::text[]),
        null))[1] as mobile_raw,
      (array_remove(coalesce(array_agg(nullif(btrim(coalesce("Telefone 1","Telefone 2")),'')) filter (where btrim(coalesce("Telefone 1","Telefone 2",'')) <> ''), '{}'::text[]), null))[1] as phone_raw,
      (array_remove(coalesce(array_agg(nullif(btrim("Email"),'')) filter (where public.altea_is_email_valid("Email")), '{}'::text[]), null))[1] as email
    from "VMAX"
    where id_company = $1 and length(regexp_replace(coalesce("CPF/CNPJ",''),'\\D','','g')) in (11,14)
    group by 1
  )`

// phone final por customer: prioriza um número CELULAR (o atual se já for celular,
// senão o celular da VMAX), senão mantém o que houver; email final: o atual se
// válido, senão o da VMAX.
const NEWPHONE = `
    coalesce(
      case when public.altea_to_e164_mobile(cu.phone) is not null then cu.phone end,
      vb.mobile_raw,
      nullif(btrim(cu.phone),''),
      vb.phone_raw
    )`
const NEWEMAIL = `
    case when public.altea_is_email_valid(cu.email) then cu.email else coalesce(vb.email, cu.email) end`

;(async () => {
  const c = new Client({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } })
  await c.connect()

  const cov = async (label) => {
    const r = await c.query(`select count(*) n,
      count(*) filter (where mobile_e164 is not null) com_cel,
      count(*) filter (where email_valid) com_email,
      count(*) filter (where mobile_e164 is not null and email_valid) ambos,
      count(*) filter (where mobile_e164 is null and not coalesce(email_valid,false)) sem_nada
      from customers where company_id=$1`, [VMAX])
    console.log(`${label}: total=${r.rows[0].n} celular=${r.rows[0].com_cel} email=${r.rows[0].com_email} ambos=${r.rows[0].ambos} sem_nada=${r.rows[0].sem_nada}`)
  }
  await cov("ANTES  ")

  // previsão: com o phone final, quantos ficam com celular / e-mail
  const pred = await c.query(`with ${VMAX_BEST}
    select
      count(*) filter (where public.altea_to_e164_mobile(${NEWPHONE}) is not null) prev_cel,
      count(*) filter (where public.altea_is_email_valid(${NEWEMAIL})) prev_email,
      count(*) filter (where cu.mobile_e164 is null and public.altea_to_e164_mobile(${NEWPHONE}) is not null) ganha_cel
    from customers cu join vmax_best vb on vb.doc = regexp_replace(coalesce(cu.document,''),'\\D','','g')
    where cu.company_id=$1`, [VMAX])
  console.log("PREVISTO: celular=%s email=%s (ganha_celular=%s)", pred.rows[0].prev_cel, pred.rows[0].prev_email, pred.rows[0].ganha_cel)

  if (!APPLY) { console.log("\n[DRY-RUN] nada gravado. --apply para sanitizar."); await c.end(); return }

  // seta phone/email; o TRIGGER deriva mobile_e164/email_valid/contact_profile.
  const r = await c.query(`with ${VMAX_BEST}
    update customers cu set phone = ${NEWPHONE}, email = ${NEWEMAIL}
    from vmax_best vb
    where vb.doc = regexp_replace(coalesce(cu.document,''),'\\D','','g') and cu.company_id = $1`, [VMAX])
  console.log("\n[APLICADO] linhas:", r.rowCount)
  await cov("DEPOIS ")
  const cp = await c.query("select contact_profile,count(*) n from customers where company_id=$1 group by 1 order by 2 desc", [VMAX])
  console.log("contact_profile:", JSON.stringify(cp.rows))
  await c.end()
})().catch((e) => { console.error("ERR", e.message); process.exit(1) })
