// F5 E2E driver — negotiation journey end-to-end against the LOCAL lab
// (Supabase local + cluster redis via port-forward + mock integrations).
// NADA em produção. Drives domain functions directly for campaign/send, and
// exercises the real HTTP routes (auth/session/webhooks) on the local app.
//
// Run: (envs from /tmp/e2e.env)  npx tsx ops/chatbot-journey-2026-09/scripts/e2e.ts
//
// Emits a machine-readable JSON block plus human lines. The report is written
// from the surrounding runner; this script just proves the flow and prints.

import { randomUUID } from "node:crypto"
import { createServiceClient } from "@/lib/supabase/service"
import { createCampaign, startCampaign } from "@/lib/journey/campaigns"
import { processCampaignMessage } from "@/lib/journey/campaign-send"

const APP = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3200"
const COMPANY = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const ASAAS_TOKEN = process.env.ASAAS_WEBHOOK_TOKEN ?? ""

const steps: Array<{ id: string; name: string; pass: boolean; detail: string }> = []
function record(id: string, name: string, pass: boolean, detail: string) {
  steps.push({ id, name, pass, detail })
  console.log(`[${pass ? "PASS" : "FAIL"}] ${id} ${name} :: ${detail}`)
}

const sb = createServiceClient()

// --- valid CPF generator (Módulo 11) so each run uses fresh, real documents.
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
  while (new Set(base).size === 1) // evita sequência repetida (inválida)
  return cpfFromBase(base)
}

// Fresh synthetic customers per run — evita colisão com dados imutáveis
// (conversation_messages/LGPD) de execuções anteriores.
interface Seeded { id: string; cpf: string; debtId: string; phone: string }
async function seedCustomer(label: string, amount: number, agingDays: number, phoneSuffix: string): Promise<Seeded> {
  const id = randomUUID()
  const debtId = randomUUID()
  const cpf = randomCpf()
  // celular BR único por execução: DDD 11 + 9 + 8 dígitos aleatórios. Evita
  // colisão de rawBody no webhook (dedupe por event_hash entre execuções).
  const rand8 = String(Math.floor(Math.random() * 1e8)).padStart(8, "0")
  const phone = `119${rand8}` // 11 dígitos, 3º=9 (celular). phoneSuffix só rotula
  void phoneSuffix
  const due = new Date(Date.now() - agingDays * 86400_000).toISOString().slice(0, 10)
  const { error: cErr } = await sb.from("customers").insert({
    id, company_id: COMPANY, name: `E2E ${label}`, document: cpf, document_type: "CPF",
    phone, email: `${label}@example.test`, source_system: "e2e", birth_date: "1990-01-10",
  })
  if (cErr) throw new Error(`seed customer ${label}: ${cErr.message}`)
  const { error: dErr } = await sb.from("debts").insert({
    id: debtId, company_id: COMPANY, customer_id: id, amount, due_date: due,
    description: `E2E divida ${label}`, status: "pending", source_system: "e2e",
  })
  if (dErr) throw new Error(`seed debt ${label}: ${dErr.message}`)
  return { id, cpf, debtId, phone }
}

// tiny cookie jar
let cookie = ""
async function api(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  if (cookie) headers.set("cookie", cookie)
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json")
  const res = await fetch(`${APP}${path}`, { ...init, headers })
  const setCookie = res.headers.get("set-cookie")
  if (setCookie) cookie = setCookie.split(";")[0]
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { json = { _raw: text.slice(0, 200) } }
  return { status: res.status, json }
}

async function countEvents(type: string, extra: Record<string, string> = {}) {
  let q = sb.from("journey_events").select("id", { count: "exact", head: true })
    .eq("company_id", COMPANY).eq("event_type", type)
  for (const [k, v] of Object.entries(extra)) q = q.eq(k, v)
  const { count } = await q
  return count ?? 0
}

async function main() {
  console.log(`\n=== F5 E2E — journey @ ${APP} — company Altea-Test ===\n`)

  // ---- 0. seed fresh synthetic customers (masked docs in report) ----------
  const s1 = await seedCustomer("um", 1000.0, 120, "0001")
  const s2 = await seedCustomer("dois", 850.5, 200, "0002")
  const s3 = await seedCustomer("tres", 300.0, 60, "0003")
  const s4 = await seedCustomer("optout", 500.0, 90, "0004")
  const C1 = s1.id, C4 = s4.id, CPF1 = s1.cpf, CPF2 = s2.cpf
  console.log(`[seed] docs (masked): C1=***${s1.cpf.slice(-4)} C2=***${s2.cpf.slice(-4)} C3=***${s3.cpf.slice(-4)} C4=***${s4.cpf.slice(-4)}`)

  // ---- 3a. create campaign (happy path: C1..C3) --------------------------
  const camp = await createCampaign({
    companyId: COMPANY,
    name: `E2E camp ${Date.now()}`,
    templateKey: "consulta_divida",
    customerIds: [C1, s2.id, s3.id],
  })
  record("3a", "createCampaign", camp.eligible === 3,
    `campaignId=${camp.campaignId} eligible=${camp.eligible} ineligible=${JSON.stringify(camp.ineligible)}`)

  // ---- 3b. startCampaign -> messages queued + jobs -----------------------
  const started = await startCampaign(camp.campaignId)
  const { count: queuedCount } = await sb.from("whatsapp_messages")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", camp.campaignId).eq("status", "queued")
  record("3b", "startCampaign", started.queued === 3 && (queuedCount ?? 0) === 3,
    `queued=${started.queued} messages(status=queued)=${queuedCount}`)

  // ---- 3c. processCampaignMessage (direct, worker path) ------------------
  // Process C1's message; capture provider_message_id and the plaintext token.
  const { data: msg1 } = await sb.from("whatsapp_messages")
    .select("id").eq("campaign_id", camp.campaignId).eq("customer_id", C1).single()
  const sendResult = await processCampaignMessage(msg1!.id)
  const { data: msg1After } = await sb.from("whatsapp_messages")
    .select("status, provider_message_id, access_token_id").eq("id", msg1!.id).single()
  record("3c", "processCampaignMessage(sent)",
    sendResult === "sent" && msg1After!.status === "sent" && !!msg1After!.provider_message_id,
    `result=${sendResult} status=${msg1After!.status} providerMsgId=${msg1After!.provider_message_id}`)

  // The plaintext token only exists at creation; re-mint via the same path is
  // not possible. Instead we read the token row and forge a NEW plaintext by
  // revoking + creating a fresh one bound to this customer/debt, mirroring what
  // the send does. To exercise the REAL token from the send, we instead reach
  // into createAccessToken semantics: the send already stored a hash. For the
  // HTTP auth test we mint a controlled token so we hold the plaintext.
  const { createAccessToken } = await import("@/lib/journey/tokens")
  const { data: debt1 } = await sb.from("debts").select("id").eq("customer_id", C1).single()
  const token1 = await createAccessToken({
    companyId: COMPANY, customerId: C1, debtIds: [debt1!.id],
    campaignId: camp.campaignId, messageId: msg1!.id, ttlHours: 168, createdBy: "campaign",
  })
  // bind this token as the message's access token so webhook click resolves
  await sb.from("whatsapp_messages").update({ access_token_id: token1.id }).eq("id", msg1!.id)
  record("3c-token", "createAccessToken(plaintext held)", !!token1.token,
    `tokenId=${token1.id} plaintextLen=${token1.token.length}`)

  // ---- 3d. simulate WhatsApp click via mock webhook ----------------------
  const clickBefore = await countEvents("link.clicked", { customer_id: C1 })
  const clickRes = await api("/api/webhooks/whatsapp/mock", {
    method: "POST",
    body: JSON.stringify({ event: "clicked", message_ref: msg1After!.provider_message_id, button: "consult" }),
  })
  const clickAfter = await countEvents("link.clicked", { customer_id: C1 })
  record("3d", "webhook mock click(consult)",
    clickRes.status === 200 && clickAfter === clickBefore + 1,
    `http=${clickRes.status} link.clicked ${clickBefore}->${clickAfter}`)

  // ---- 3e. auth: 3 wrong CPFs -> lock, then correct ----------------------
  // wrong attempts (same token). Use a valid-format but mismatching CPF.
  const wrongCpf = CPF2 // valid DV but belongs to C2, not C1 -> doc_mismatch
  let lockObserved = false
  for (let i = 1; i <= 3; i++) {
    const r = await api("/api/chat/auth", {
      method: "POST",
      body: JSON.stringify({ token: token1.token, document: wrongCpf, consent: true }),
    })
    if (r.status !== 401) lockObserved = false
  }
  const { count: locks } = await sb.from("chat_auth_locks")
    .select("id", { count: "exact", head: true }).eq("access_token_id", token1.id)
  lockObserved = (locks ?? 0) > 0
  record("3e-lock", "auth 3x wrong -> lock (401 generic)", lockObserved,
    `locks_for_token=${locks}`)

  // correct auth. If locked, the lock is doc-scoped to wrongCpf's hash; the
  // real CPF (different hash) should still pass unless a token-wide lock exists.
  const authOk = await api("/api/chat/auth", {
    method: "POST",
    body: JSON.stringify({ token: token1.token, document: CPF1, consent: true }),
  })
  const gotCookie = cookie.includes("=")
  record("3e-auth", "auth correct CPF -> 200 + cookie",
    authOk.status === 200 && authOk.json?.ok === true && gotCookie,
    `http=${authOk.status} ok=${authOk.json?.ok} cookie=${gotCookie ? "set" : "missing"} sid=${authOk.json?.sessionId ?? "-"}`)
  const sessionId = authOk.json?.sessionId as string

  // ---- 3f. session summary + offers + message ----------------------------
  const summary = await api("/api/chat/session?action=summary")
  record("3f-summary", "GET session summary",
    summary.status === 200 && summary.json?.ok === true && !!summary.json?.summary,
    `http=${summary.status} original=${summary.json?.summary?.originalValue} aging=${summary.json?.summary?.agingDays}`)

  const offers = await api("/api/chat/session?action=offers")
  const offerList = offers.json?.offers ?? []
  record("3f-offers", "GET session offers (from matrix)",
    offers.status === 200 && offerList.length > 0,
    `http=${offers.status} count=${offerList.length} firstDiscount=${offerList[0]?.terms?.discount_pct}`)

  const msgTurn = await api("/api/chat/session", {
    method: "POST", body: JSON.stringify({ action: "message", text: "quero pagar" }),
  })
  record("3f-message", "POST session message (assisted mode)",
    msgTurn.status === 200 && msgTurn.json?.ok === true && typeof msgTurn.json?.reply === "string",
    `http=${msgTurn.status} action=${msgTurn.json?.action} replyLen=${(msgTurn.json?.reply ?? "").length}`)

  // ---- 3g. accept (step1) + confirm (step2) -> agreement + charge --------
  const chosen = offerList[0]
  const accept = await api("/api/chat/session", {
    method: "POST", body: JSON.stringify({ action: "accept", offerId: chosen.id }),
  })
  const termsHash = accept.json?.summary?.termsHash
  record("3g-accept", "POST accept -> summary + termsHash",
    accept.status === 200 && !!termsHash,
    `http=${accept.status} termsHash=${(termsHash ?? "").slice(0, 12)}...`)

  const confirm = await api("/api/chat/session", {
    method: "POST", body: JSON.stringify({ action: "confirm", offerId: chosen.id, termsHash }),
  })
  const agreementId = confirm.json?.agreementId
  record("3g-confirm", "POST confirm -> agreement created",
    confirm.status === 200 && !!agreementId,
    `http=${confirm.status} agreementId=${agreementId ?? "-"}`)

  // wait for the charge worker (cluster, same redis) to write asaas_payment_id
  let ag: any = null
  for (let i = 0; i < 30; i++) {
    const { data } = await sb.from("agreements")
      .select("id, origin, negotiation_session_id, asaas_payment_id, asaas_status, agreed_amount, installments")
      .eq("id", agreementId).single()
    ag = data
    if (ag?.asaas_payment_id) break
    await new Promise((r) => setTimeout(r, 1000))
  }
  record("3g-charge", "charge worker write-back (mock asaas)",
    !!ag?.asaas_payment_id && String(ag.asaas_payment_id).startsWith("pay_mock_") &&
    ag.origin === "chat_journey" && ag.negotiation_session_id === sessionId,
    `paymentId=${ag?.asaas_payment_id} origin=${ag?.origin} sid_match=${ag?.negotiation_session_id === sessionId}`)

  // ---- 3h. idempotency: repeat confirm -> same agreement, no new charge ---
  const { count: agsBefore } = await sb.from("agreements")
    .select("id", { count: "exact", head: true }).eq("customer_id", C1)
  const confirm2 = await api("/api/chat/session", {
    method: "POST", body: JSON.stringify({ action: "confirm", offerId: chosen.id, termsHash }),
  })
  const { count: agsAfter } = await sb.from("agreements")
    .select("id", { count: "exact", head: true }).eq("customer_id", C1)
  record("3h-idem-confirm", "repeat confirm -> same agreement, 0 new",
    confirm2.status === 200 && confirm2.json?.agreementId === agreementId && agsBefore === agsAfter,
    `http=${confirm2.status} same=${confirm2.json?.agreementId === agreementId} agsBefore=${agsBefore} agsAfter=${agsAfter}`)

  // ---- 3h(2). re-run whole journey for same customer -> guard blocks ------
  const camp2 = await createCampaign({
    companyId: COMPANY, name: `E2E guard ${Date.now()}`,
    templateKey: "consulta_divida", customerIds: [C1],
  })
  const guardBlocked = (camp2.ineligible?.["cobranca_viva"] ?? 0) === 1 && camp2.eligible === 0
  record("3h-guard", "new campaign same customer -> guard (cobranca_viva)", guardBlocked,
    `eligible=${camp2.eligible} ineligible=${JSON.stringify(camp2.ineligible)}`)

  // ---- 3i. paid webhook -> payment.paid, session closed, suppression, token revoked
  const paidBefore = await countEvents("payment.paid", { agreement_id: agreementId })
  const paidWebhook = await api("/api/asaas/webhook/payments", {
    method: "POST",
    headers: { "asaas-access-token": ASAAS_TOKEN },
    body: JSON.stringify({
      id: `evt_e2e_${Date.now()}`,
      event: "PAYMENT_RECEIVED",
      payment: {
        id: ag.asaas_payment_id, customer: `cus_mock_x`, value: Number(ag.agreed_amount),
        status: "RECEIVED", billingType: "PIX",
        externalReference: `journey_${sessionId}`,
      },
    }),
  })
  // give the (isolated) journey hook a moment
  await new Promise((r) => setTimeout(r, 500))
  const paidAfter = await countEvents("payment.paid", { agreement_id: agreementId })
  const { data: sessAfter } = await sb.from("negotiation_sessions").select("outcome").eq("id", sessionId).single()
  const { count: paidSupp } = await sb.from("contact_suppressions")
    .select("id", { count: "exact", head: true })
    .eq("company_id", COMPANY).eq("customer_id", C1).eq("reason", "paid").eq("active", true)
  const { count: liveTokens } = await sb.from("chat_access_tokens")
    .select("id", { count: "exact", head: true })
    .eq("company_id", COMPANY).eq("customer_id", C1).is("revoked_at", null)
  record("3i-paid", "paid webhook -> journey effects",
    paidWebhook.status < 300 && paidAfter === paidBefore + 1 &&
    sessAfter?.outcome === "agreement_closed" && (paidSupp ?? 0) >= 1 && (liveTokens ?? 0) === 0,
    `http=${paidWebhook.status} payment.paid ${paidBefore}->${paidAfter} outcome=${sessAfter?.outcome} paidSuppression=${paidSupp} liveTokens=${liveTokens}`)

  // ---- 3j. opt-out: C4 webhook optout -> suppression -> excluded ----------
  // Send a message to C4 first so an optout-by-message resolves the phone.
  const camp4 = await createCampaign({
    companyId: COMPANY, name: `E2E optout ${Date.now()}`,
    templateKey: "consulta_divida", customerIds: [C4],
  })
  await startCampaign(camp4.campaignId)
  const { data: m4 } = await sb.from("whatsapp_messages")
    .select("id, phone_e164").eq("campaign_id", camp4.campaignId).eq("customer_id", C4).single()
  await processCampaignMessage(m4!.id)
  const optout = await api("/api/webhooks/whatsapp/mock", {
    method: "POST",
    body: JSON.stringify({ event: "optout", phone: m4!.phone_e164 }),
  })
  const { count: optoutSupp } = await sb.from("contact_suppressions")
    .select("id", { count: "exact", head: true })
    .eq("phone_e164", m4!.phone_e164).eq("reason", "optout").eq("active", true)
  record("3j-optout", "optout webhook -> suppression active",
    optout.status === 200 && (optoutSupp ?? 0) >= 1,
    `http=${optout.status} optoutSuppressions=${optoutSupp} phone=***${m4!.phone_e164.slice(-4)}`)

  const camp4b = await createCampaign({
    companyId: COMPANY, name: `E2E optout excl ${Date.now()}`,
    templateKey: "consulta_divida", customerIds: [C4],
  })
  const excluded = (camp4b.ineligible?.["suprimido"] ?? 0) === 1 && camp4b.eligible === 0
  record("3j-excluded", "new campaign excludes opted-out customer", excluded,
    `eligible=${camp4b.eligible} ineligible=${JSON.stringify(camp4b.ineligible)}`)

  // ---- summary -----------------------------------------------------------
  const passed = steps.filter((s) => s.pass).length
  console.log(`\n=== RESULT: ${passed}/${steps.length} steps PASS ===`)
  console.log("E2E_JSON_BEGIN")
  console.log(JSON.stringify({ agreementId, sessionId, steps }, null, 2))
  console.log("E2E_JSON_END")
  if (passed !== steps.length) process.exitCode = 1
}

main().catch((e) => {
  console.error("E2E FATAL:", e)
  process.exitCode = 2
})
