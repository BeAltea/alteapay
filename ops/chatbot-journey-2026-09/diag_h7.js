// Diagnóstico: o POSTGRES_URL_NON_POOLING (onde escrevi) é o MESMO projeto que o
// app lê via SUPABASE_URL/REST? Lê a config via REST (caminho do app). Sem PII.
const fs = require("fs")
const path = require("path")

const ROOT = path.resolve(__dirname, "../..")
const env = fs.readFileSync(path.join(ROOT, ".env.local"), "utf8")
const get = (k) => (env.split("\n").find((l) => l.startsWith(k + "=")) || "").slice(k.length + 1).trim().replace(/^["']|["']$/g, "")

const pgUrl = get("POSTGRES_URL_NON_POOLING")
const pgUser = (() => { try { return new URL(pgUrl).username } catch { return "?" } })()
const pgHost = (() => { try { return new URL(pgUrl).host } catch { return "?" } })()
const supaUrl = get("SUPABASE_URL") || get("NEXT_PUBLIC_SUPABASE_URL")
const svcKey = get("SUPABASE_SERVICE_ROLE_KEY")

console.log("PG username (ref esperado postgres.<ref>):", pgUser)
console.log("PG host:", pgHost)
console.log("SUPABASE_URL:", supaUrl)

;(async () => {
  const r = await fetch(
    `${supaUrl}/rest/v1/tenant_chat_config?public_link_code=eq.k7Qm3Xb9Rt&select=company_id,public_link_enabled,public_link_valid_until`,
    { headers: { apikey: svcKey, Authorization: `Bearer ${svcKey}` } },
  )
  console.log("REST status:", r.status)
  console.log("REST body (config, sem PII):", await r.text())
})().catch((e) => console.error("ERR", e.message))
