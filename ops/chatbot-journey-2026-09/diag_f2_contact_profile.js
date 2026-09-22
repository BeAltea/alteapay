// F2.1 diagnóstico read-only: distribuição de customers.contact_profile para o
// cedente VMAX. Sem PII (só agrega contagens por valor do enum). Usa o mesmo
// caminho REST do app (SUPABASE_URL + service key). Não escreve nada.
const fs = require("fs")
const path = require("path")

const ROOT = path.resolve(__dirname, "..", "..")
const env = fs.readFileSync(path.join(ROOT, ".env.local"), "utf8")
const get = (k) =>
  (env.split("\n").find((l) => l.startsWith(k + "=")) || "")
    .slice(k.length + 1)
    .trim()
    .replace(/^["']|["']$/g, "")

const supaUrl = get("SUPABASE_URL") || get("NEXT_PUBLIC_SUPABASE_URL")
const svcKey = get("SUPABASE_SERVICE_ROLE_KEY")
const COMPANY = "1f7729ee-a537-43fc-a27f-5747c177988d"
const VALUES = ["mobile", "email_only", "both", "none", null]

async function countFor(value) {
  const filter =
    value === null ? "contact_profile=is.null" : `contact_profile=eq.${value}`
  const url = `${supaUrl}/rest/v1/customers?company_id=eq.${COMPANY}&${filter}&select=id`
  const r = await fetch(url, {
    headers: {
      apikey: svcKey,
      Authorization: `Bearer ${svcKey}`,
      Prefer: "count=exact",
      Range: "0-0",
    },
  })
  const cr = r.headers.get("content-range") || ""
  const total = cr.includes("/") ? cr.split("/").pop() : "?"
  return { value: value ?? "(NULL)", count: total, status: r.status }
}

async function totalFor() {
  const url = `${supaUrl}/rest/v1/customers?company_id=eq.${COMPANY}&select=id`
  const r = await fetch(url, {
    headers: {
      apikey: svcKey,
      Authorization: `Bearer ${svcKey}`,
      Prefer: "count=exact",
      Range: "0-0",
    },
  })
  const cr = r.headers.get("content-range") || ""
  return cr.includes("/") ? cr.split("/").pop() : "?"
}

;(async () => {
  console.log("SUPABASE_URL:", supaUrl)
  console.log("company_id:", COMPANY)
  const rows = []
  for (const v of VALUES) rows.push(await countFor(v))
  const total = await totalFor()
  console.log("\ncontact_profile | count")
  console.log("----------------+------")
  const enriched = rows
    .map((r) => ({ ...r, n: r.count === "?" ? -1 : Number(r.count) }))
    .sort((a, b) => b.n - a.n)
  let sum = 0
  for (const r of enriched) {
    console.log(String(r.value).padEnd(15), "|", r.count)
    if (r.n >= 0) sum += r.n
  }
  console.log("----------------+------")
  console.log("soma dos grupos :", sum)
  console.log("total customers :", total)
  console.log("fecha?          :", String(sum) === String(total))
})().catch((e) => console.error("ERR", e.message))
