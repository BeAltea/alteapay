// J-F8 / G4 — Canário admin-only da jornada EM PRODUÇÃO, restrito ao tenant de
// teste. Dry-run por padrão; --run executa. Cria UMA cobrança ASAAS real de
// valor mínimo e a CANCELA logo após o write-back (nenhum valor é recebido).
//
// Pré-requisitos (ver CANARY_G4.md): gate de fila = 0, flags no Netlify ligadas,
// worker Fargate em desired=1. Este script NÃO mexe em flags nem em ECS — só
// dirige o fluxo e coleta evidências.
//
// Run seco:  npx tsx ops/chatbot-journey-2026-09/scripts/canary_g4.ts
// Run real:  npx tsx ops/chatbot-journey-2026-09/scripts/canary_g4.ts --run

import { randomUUID } from "node:crypto"
import { createServiceClient } from "@/lib/supabase/service"
import { createCampaign, startCampaign } from "@/lib/journey/campaigns"
import { processCampaignMessage } from "@/lib/journey/campaign-send"
import { createAccessToken } from "@/lib/journey/tokens"

const TEST_COMPANY = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const PROD_APP = "https://alteapay.com"
const APP = process.env.NEXT_PUBLIC_APP_URL ?? PROD_APP
const AMOUNT = 5.0 // valor mínimo — cobrança real, cancelada ao final
const RUN = process.argv.includes("--run")

// ---- trilhos de segurança: recusa rodar fora do tenant de teste / fora de prod
function assertRails() {
  const errs: string[] = []
  if (TEST_COMPANY !== "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa") errs.push("company != tenant de teste")
  if (!/alteapay\.com/.test(APP)) errs.push(`APP inesperado: ${APP}`)
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) errs.push("sem SUPABASE_SERVICE_ROLE_KEY")
  if (!process.env.ASAAS_API_KEY) errs.push("sem ASAAS_API_KEY (necessário p/ cancelar a cobrança)")
  if (errs.length) { console.error("TRILHOS DE SEGURANÇA FALHARAM:\n - " + errs.join("\n - ")); process.exit(3) }
}

const steps: Array<{ id: string; name: string; pass: boolean; detail: string }> = []
const record = (id: string, name: string, pass: boolean, detail: string) => {
  steps.push({ id, name, pass, detail })
  console.log(`[${pass ? "PASS" : "FAIL"}] ${id} ${name} :: ${detail}`)
}

const sb = createServiceClient()

// CPF válido (Módulo 11) montado de blocos — nenhum documento real no código.
function cpfFromBase(base: number[]): string {
  const dv = (digs: number[], startW: number) => {
    let s = 0, w = startW
    for (const d of digs) { s += d * w; w-- }
    const r = s % 11
    return r < 2 ? 0 : 11 - r
  }
  const d1 = dv(base, base.length + 1)
  const d2 = dv([...base, d1], base.length + 2)
  return base.join("") + d1 + "" + d2
}
function randomCpf(): string {
  let base: number[]
  do { base = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10)) }
  while (new Set(base).size === 1)
  return cpfFromBase(base)
}

let cookie = ""
async function api(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  if (cookie) headers.set("cookie", cookie)
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json")
  // timeout duro: sem isso, um fetch preso trava o canário inteiro (bug do 1º run)
  const res = await fetch(`${APP}${path}`, { ...init, headers, signal: AbortSignal.timeout(20000) })
  const setCookie = res.headers.get("set-cookie")
  if (setCookie) cookie = setCookie.split(";")[0]
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { json = { _raw: text.slice(0, 200) } }
  return { status: res.status, json }
}

async function cancelAsaasPayment(paymentId: string): Promise<{ ok: boolean; detail: string }> {
  const base = process.env.ASAAS_BASE_URL || process.env.ASAAS_API_URL || "https://api.asaas.com/v3"
  const key = (process.env.ASAAS_API_KEY || "").replace(/^'+|'+$/g, "")
  try {
    const res = await fetch(`${base}/payments/${paymentId}`, {
      method: "DELETE",
      headers: { access_token: key, "content-type": "application/json" },
    })
    const j = await res.json().catch(() => ({}))
    return { ok: res.ok && (j?.deleted === true || res.status < 300), detail: `http=${res.status} deleted=${j?.deleted}` }
  } catch (e) {
    return { ok: false, detail: (e as Error).message }
  }
}

async function main() {
  console.log(`\n=== G4 CANÁRIO — jornada @ ${APP} — tenant Altea-Testes — ${RUN ? "RUN REAL" : "DRY-RUN"} ===\n`)
  assertRails()

  // sanidade: tenant existe e está em modo admin-only
  const { data: cfg } = await sb.from("tenant_chat_config")
    .select("journey_public_enabled, creditor_notification_emails")
    .eq("company_id", TEST_COMPANY).maybeSingle()
  console.log(`[cfg] journey_public_enabled=${cfg?.journey_public_enabled} creditorEmails=${JSON.stringify(cfg?.creditor_notification_emails ?? [])}`)
  if (cfg?.journey_public_enabled === true) {
    console.error("ABORT: tenant está em modo público — o canário exige admin-only (journey_public_enabled=false).")
    process.exit(4)
  }

  if (!RUN) {
    console.log("\nDRY-RUN: nada foi criado. Confira o gate de fila, as flags do Netlify e o worker=1, e rode com --run.")
    console.log("Plano: seed 1 cliente (CPF gerado, R$ 5,00) → campanha → send(mock) → token → auth → oferta → aceite/confirm → cobrança ASAAS REAL → cancelar → conciliação.")
    process.exit(0)
  }

  // ---- 1. seed cliente sintético (CPF gerado) + dívida R$ 5,00 -------------
  const id = randomUUID(), debtId = randomUUID(), cpf = randomCpf()
  const rand8 = String(Math.floor(Math.random() * 1e8)).padStart(8, "0")
  const phone = `119${rand8}`
  const due = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10)
  await sb.from("customers").insert({
    id, company_id: TEST_COMPANY, name: "G4 Canário", document: cpf, document_type: "CPF",
    phone, email: "canary-g4@example.test", source_system: "canary-g4", birth_date: "1990-01-10",
  })
  await sb.from("debts").insert({
    id: debtId, company_id: TEST_COMPANY, customer_id: id, amount: AMOUNT, due_date: due,
    description: "G4 canário divida", status: "pending", source_system: "canary-g4",
  })
  record("1", "seed cliente+dívida", true, `cpf=***${cpf.slice(-4)} amount=${AMOUNT}`)

  // ---- 2. campanha → send(mock) → token ------------------------------------
  const camp = await createCampaign({
    companyId: TEST_COMPANY, name: `G4 canary ${Date.now()}`,
    templateKey: "consulta_divida", customerIds: [id],
  })
  await startCampaign(camp.campaignId)
  const { data: msg } = await sb.from("whatsapp_messages")
    .select("id").eq("campaign_id", camp.campaignId).eq("customer_id", id).single()
  const sendResult = await processCampaignMessage(msg!.id)
  record("2", "campanha+send(mock)", camp.eligible === 1 && sendResult === "sent",
    `eligible=${camp.eligible} send=${sendResult}`)

  const token = await createAccessToken({
    companyId: TEST_COMPANY, customerId: id, debtIds: [debtId],
    campaignId: camp.campaignId, messageId: msg!.id, ttlHours: 24, createdBy: "campaign",
  })
  await sb.from("whatsapp_messages").update({ access_token_id: token.id }).eq("id", msg!.id)

  // ---- 3. auth: 3 CPFs errados → lock; correto → 200 -----------------------
  const wrong = randomCpf()
  for (let i = 0; i < 3; i++) {
    await api("/api/chat/auth", { method: "POST", body: JSON.stringify({ token: token.token, document: wrong, consent: true }) })
  }
  const { count: locks } = await sb.from("chat_auth_locks")
    .select("id", { count: "exact", head: true }).eq("access_token_id", token.id)
  record("3-lock", "3 CPFs errados → lock", (locks ?? 0) > 0, `locks=${locks}`)

  const authOk = await api("/api/chat/auth", { method: "POST", body: JSON.stringify({ token: token.token, document: cpf, consent: true }) })
  const sessionId = authOk.json?.sessionId as string
  record("3-auth", "CPF correto → 200 + sessão", authOk.status === 200 && !!sessionId, `http=${authOk.status} sid=${sessionId ?? "-"}`)

  // ---- 4. oferta → aceite → confirm ----------------------------------------
  const offers = await api("/api/chat/session?action=offers")
  const list = offers.json?.offers ?? []
  const avista = list.find((o: any) => o?.terms?.installments === 1) ?? list[0]
  record("4-offers", "ofertas da matriz", list.length > 0 && !!avista, `count=${list.length} avistaId=${avista?.id ?? "-"}`)

  const accept = await api("/api/chat/session", { method: "POST", body: JSON.stringify({ action: "accept", offerId: avista.id }) })
  const termsHash = accept.json?.summary?.termsHash
  const confirm = await api("/api/chat/session", { method: "POST", body: JSON.stringify({ action: "confirm", offerId: avista.id, termsHash }) })
  const agreementId = confirm.json?.agreementId
  record("4-confirm", "aceite+confirm → agreement", confirm.status === 200 && !!agreementId, `http=${confirm.status} agreement=${agreementId ?? "-"}`)

  // ---- 5. worker novo grava asaas_payment_id REAL (pay_, não pay_mock_) -----
  let ag: any = null
  for (let i = 0; i < 60; i++) {
    const { data } = await sb.from("agreements")
      .select("id, origin, negotiation_session_id, asaas_payment_id, asaas_pix_qrcode_url, agreed_amount")
      .eq("id", agreementId).single()
    ag = data
    if (ag?.asaas_payment_id) break
    await new Promise((r) => setTimeout(r, 2000))
  }
  const realCharge = !!ag?.asaas_payment_id && !String(ag.asaas_payment_id).startsWith("pay_mock_")
  record("5-charge", "worker novo → cobrança ASAAS REAL", realCharge && ag?.origin === "chat_journey" && ag?.negotiation_session_id === sessionId,
    `paymentId=${ag?.asaas_payment_id} origin=${ag?.origin} pixUrl=${ag?.asaas_pix_qrcode_url ? "set" : "null"}`)

  // ---- 6. idempotência: reenviar confirm → mesmo agreement, 0 novo ----------
  const { count: before } = await sb.from("agreements").select("id", { count: "exact", head: true }).eq("customer_id", id)
  const confirm2 = await api("/api/chat/session", { method: "POST", body: JSON.stringify({ action: "confirm", offerId: avista.id, termsHash }) })
  const { count: after } = await sb.from("agreements").select("id", { count: "exact", head: true }).eq("customer_id", id)
  record("6-idem", "reenvio confirm → mesmo agreement, 0 novo", confirm2.json?.agreementId === agreementId && before === after, `same=${confirm2.json?.agreementId === agreementId} ${before}->${after}`)

  // ---- 7. CANCELAR a cobrança real (nenhum valor recebido) ------------------
  if (ag?.asaas_payment_id && realCharge) {
    const cancel = await cancelAsaasPayment(ag.asaas_payment_id)
    record("7-cancel", "cancelar cobrança ASAAS real", cancel.ok, cancel.detail)
  } else {
    record("7-cancel", "cancelar cobrança ASAAS real", false, "sem paymentId real para cancelar")
  }

  // ---- resumo ---------------------------------------------------------------
  const passed = steps.filter((s) => s.pass).length
  console.log(`\n=== RESULT: ${passed}/${steps.length} PASS ===`)
  console.log("CANARY_JSON_BEGIN")
  console.log(JSON.stringify({ agreementId, sessionId, asaasPaymentId: ag?.asaas_payment_id, steps }, null, 2))
  console.log("CANARY_JSON_END")
  console.log("\nLEMBRETE: confirmar PAYMENT_DELETED reconciliado nos journey_events e desmontar (worker=0, flag OFF).")
  if (passed !== steps.length) process.exitCode = 1
}

main().catch((e) => { console.error("CANARY FATAL:", e); process.exitCode = 2 })
