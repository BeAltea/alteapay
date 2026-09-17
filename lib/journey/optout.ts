// Opt-out e bloqueio pela PLATAFORMA (V5). A Voxuy não tem blacklist (L2), então
// a supressão autoritativa é a nossa. Os tokens de ação (V4) chegam aqui:
// - "Cancelar inscrição" (optout): suprime o CLIENTE no canal WhatsApp.
// - "Bloquear número" (block): suprime o TELEFONE em todos os canais.
// Em ambos: revoga os tokens de acesso do cliente e dispara o stop na Voxuy
// (via addSuppression, que já chama fireStopSignal para optout/block/paid).

import { createHmac, timingSafeEqual } from "node:crypto"
import { createServiceClient } from "@/lib/supabase/service"
import { recordEvent } from "./events"
import { addSuppression } from "./suppressions"
import { consumeActionToken, revokeTokens, validateActionToken, type TokenPurpose } from "./tokens"

// CSRF de sessão curta para as ações destrutivas (V4.3): o GET de confirmação
// emite um nonce assinado (cookie + campo); o POST só age se ambos casarem.
// Prefetch de link (WhatsApp/antivírus) faz GET, nunca POST — logo não dispara.
const CSRF_TTL_MS = 15 * 60 * 1000
function csrfSecret(): string {
  return (
    process.env.CHAT_SESSION_SECRET ||
    process.env.NEGOTIATION_JWT_SECRET ||
    process.env.SUPABASE_JWT_SECRET ||
    "insecure-dev-csrf-secret"
  )
}
export function issueActionCsrf(token: string, purpose: TokenPurpose): string {
  const ts = Date.now().toString()
  const mac = createHmac("sha256", csrfSecret()).update(`${token}|${purpose}|${ts}`).digest("base64url")
  return `${ts}.${mac}`
}
export function verifyActionCsrf(value: string, token: string, purpose: TokenPurpose): boolean {
  const [ts, mac] = (value ?? "").split(".")
  if (!ts || !mac) return false
  if (Date.now() - Number(ts) > CSRF_TTL_MS) return false
  const expected = createHmac("sha256", csrfSecret()).update(`${token}|${purpose}|${ts}`).digest("base64url")
  const a = Buffer.from(mac)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export type OptoutOutcome =
  | { ok: true; kind: "optout" | "block" }
  | { ok: false; reason: "invalid" | "already_done" }

async function resolvePhone(companyId: string, customerId: string): Promise<string | null> {
  const supabase = createServiceClient()
  // Preferir o telefone que já foi normalizado numa mensagem enviada.
  const { data: msg } = await supabase
    .from("whatsapp_messages")
    .select("phone_e164")
    .eq("company_id", companyId)
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (msg?.phone_e164) return msg.phone_e164
  const { toE164Mobile } = await import("./campaigns")
  const { data: customer } = await supabase
    .from("customers")
    .select("phone")
    .eq("id", customerId)
    .maybeSingle()
  return toE164Mobile(customer?.phone ?? null)
}

async function apply(token: string, purpose: "optout" | "block"): Promise<OptoutOutcome> {
  const tv = await validateActionToken(token, purpose)
  if (!tv.ok) return { ok: false, reason: tv.reason === "exhausted" ? "already_done" : "invalid" }

  // uso único, atômico: se já foi consumido por uma corrida/prefetch, sai.
  const consumed = await consumeActionToken(tv.tokenRow.id)
  if (!consumed) return { ok: false, reason: "already_done" }

  const { company_id: companyId, customer_id: customerId } = tv.tokenRow
  const phone = await resolvePhone(companyId, customerId)

  if (purpose === "optout") {
    // Cancelar inscrição: cliente no canal WhatsApp.
    await addSuppression({
      companyId, scope: "customer", customerId, phoneE164: phone,
      channel: "whatsapp", reason: "optout", source: "chat",
    })
    await recordEvent({
      companyId, customerId, type: "optout.received", actor: "customer",
      payload: { via: "action_link" },
    })
  } else {
    // Bloquear número: telefone em todos os canais.
    await addSuppression({
      companyId, scope: "phone", phoneE164: phone, customerId,
      channel: "all", reason: "blocked", source: "chat",
    })
    await recordEvent({
      companyId, customerId, type: "block.received", actor: "customer",
      payload: { via: "action_link" },
    })
  }

  // Revoga TODOS os tokens de acesso ativos do cliente (não recebe mais links).
  await revokeTokens({ companyId, customerId, reason: purpose })

  return { ok: true, kind: purpose }
}

export const applyOptout = (token: string) => apply(token, "optout")
export const applyBlock = (token: string) => apply(token, "block")
