// Efeitos de um evento inbound normalizado (compartilhado pelas rotas de
// captura: a estática /voxuy da V5 e a dinâmica [provider]). Aplica status da
// mensagem (com procedência V7), cliques, supressões e jornada. A captura bruta
// e o dedupe por event_hash ficam na função captureRawInbound.

import { createHash } from "node:crypto"
import { createServiceClient } from "@/lib/supabase/service"
import { recordEvent } from "@/lib/journey/events"
import { addSuppression } from "@/lib/journey/suppressions"
import type { NormalizedWhatsAppEvent } from "./provider"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const inboundEventHash = (provider: string, rawBody: string) =>
  createHash("sha256").update(`${provider}:${rawBody}`).digest("hex")

export async function applyNormalizedEvent(
  ev: NormalizedWhatsAppEvent,
  provider: string,
): Promise<void> {
  const supabase = createServiceClient()
  if ("providerMessageId" in ev && ev.providerMessageId) {
    // provider message ids são strings do provider — só casamos por
    // whatsapp_messages.id quando de fato é UUID (senão o filtro estoura).
    const orClause = UUID_RE.test(ev.providerMessageId)
      ? `provider_message_id.eq.${ev.providerMessageId},id.eq.${ev.providerMessageId}`
      : `provider_message_id.eq.${ev.providerMessageId}`
    const { data: msg } = await supabase
      .from("whatsapp_messages")
      .select("id, company_id, campaign_id, customer_id, status, status_history, phone_e164")
      .or(orClause)
      .maybeSingle()
    if (!msg) return
    const now = ev.at
    if (ev.type === "sent" || ev.type === "delivered" || ev.type === "read" || ev.type === "failed") {
      const col = { sent: "sent_at", delivered: "delivered_at", read: "read_at", failed: null }[ev.type]
      const patch: Record<string, unknown> = {
        status: ev.type,
        status_history: [...(msg.status_history ?? []), { at: now, to: ev.type }],
      }
      if (col) patch[col] = now
      if (ev.type === "failed") patch.error = ev.error ?? "provider_failed"
      // V7: delivered/read só com FONTE real; registra procedência.
      if (ev.type === "delivered" || ev.type === "read") {
        patch.provider_status_source = provider === "voxuy" ? "voxuy_webhook" : "manual"
      }
      await supabase.from("whatsapp_messages").update(patch).eq("id", msg.id)
      await recordEvent({
        companyId: msg.company_id, campaignId: msg.campaign_id, messageId: msg.id,
        customerId: msg.customer_id,
        type: (`message.${ev.type}`) as "message.sent" | "message.delivered" | "message.read" | "message.failed",
        actor: "provider", occurredAt: now,
      })
      // W4 — invalidWhatsApp → SUPRESSÃO. O inbound Enterprise mapeia
      // contact.invalidWhatsApp=true → failed(error="invalid_whatsapp") (ver
      // lib/whatsapp/voxuy/inbound.ts). Aqui esse desfecho ATIVA a supressão do
      // NÚMERO (scope=phone, channel=whatsapp): o telefone não tem WhatsApp
      // válido, então não deve mais ser selecionado (evaluateEligibility /
      // recheck consultam isSuppressed). Idempotente (addSuppression não duplica).
      if (ev.type === "failed" && ev.error === "invalid_whatsapp" && msg.phone_e164) {
        await addSuppression({
          companyId: msg.company_id,
          scope: "phone",
          phoneE164: msg.phone_e164,
          customerId: msg.customer_id,
          channel: "whatsapp",
          reason: "manual", // sem WhatsApp válido: supressão técnica do número
          source: provider === "voxuy" ? "voxuy" : "webhook",
          metadata: { cause: "invalid_whatsapp" },
        })
      }
      return
    }
    if (ev.type === "clicked") {
      if (ev.button === "consult") {
        await supabase.from("whatsapp_messages").update({ clicked_at: now }).eq("id", msg.id)
        await recordEvent({
          companyId: msg.company_id, campaignId: msg.campaign_id, messageId: msg.id,
          customerId: msg.customer_id, type: "link.clicked", actor: "customer", occurredAt: now,
          payload: { via: "provider_button" },
        })
      } else {
        const reason = ev.button === "optout" ? "optout" : "blocked"
        await addSuppression({
          companyId: msg.company_id, scope: "phone", phoneE164: msg.phone_e164,
          customerId: msg.customer_id, channel: "whatsapp", reason,
          source: provider === "voxuy" ? "voxuy" : "webhook",
        })
        await recordEvent({
          companyId: msg.company_id, campaignId: msg.campaign_id, messageId: msg.id,
          customerId: msg.customer_id,
          type: ev.button === "optout" ? "optout.received" : "block.received",
          actor: "customer", occurredAt: now,
        })
      }
      return
    }
  }
  // eventos por telefone (optout/block sem message id)
  if (ev.type === "optout" || ev.type === "block") {
    await addSuppression({
      companyId: null, scope: "phone", phoneE164: ev.phone, channel: "whatsapp",
      reason: ev.type === "optout" ? "optout" : "blocked",
      source: provider === "voxuy" ? "voxuy" : "webhook",
    })
  }

  // Achado 7.2 — OPT-OUT do fluxo Voxuy ("Sair da lista"/"Cancelar Recebimento").
  // A Voxuy bloqueia do lado dela mas não tem blacklist consultável (L2): a
  // supressão autoritativa é a NOSSA. Registramos supressão do NÚMERO no canal
  // WhatsApp (o devedor pediu para parar de receber mensagens). Idempotente
  // (addSuppression não duplica). Correlacionamos por contactRef (provider
  // message id que a Voxuy nos devolve) e/ou por telefone (E.164) para recuperar
  // company_id/customer_id; sem correlação, suprimimos globalmente pelo telefone.
  //
  // E-MAIL: NÃO suprimimos automaticamente. O botão do funil Voxuy é do canal
  // WhatsApp — "Cancelar Recebimento" (de mensagens) não é sinal claro de que o
  // devedor também quer parar de receber e-mail (cobrança pode continuar por
  // e-mail). Suprimir e-mail é decisão de PRODUTO; deixamos como TODO explícito.
  // TODO(produto): se o opt-out deve também barrar e-mail, trocar channel para
  // "all" OU adicionar uma 2ª supressão channel="email" aqui (exige sinal claro
  // no payload, ex.: evento=descadastro_total).
  if (ev.type === "contactOptout") {
    // Tenta correlacionar por contactRef (provider_message_id) e/ou telefone para
    // recuperar company/customer. Sem correlação => supressão global pelo número.
    const ors: string[] = []
    if (ev.contactRef) ors.push(`provider_message_id.eq.${ev.contactRef}`)
    if (ev.phoneE164) ors.push(`phone_e164.eq.${ev.phoneE164}`)
    let companyId: string | null = null
    let customerId: string | null = null
    let phoneE164: string | null = ev.phoneE164
    if (ors.length > 0) {
      const { data: msg } = await supabase
        .from("whatsapp_messages")
        .select("company_id, customer_id, phone_e164")
        .or(ors.join(","))
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
      if (msg) {
        companyId = msg.company_id ?? null
        customerId = msg.customer_id ?? null
        phoneE164 = phoneE164 ?? msg.phone_e164 ?? null
      }
    }
    // Sem telefone (nem do payload nem da mensagem) não há alvo de supressão de
    // telefone — nada a fazer (o bruto já foi gravado para análise). Nunca 500.
    if (!phoneE164) return
    await addSuppression({
      companyId,
      scope: "phone",
      phoneE164,
      customerId,
      channel: "whatsapp",
      reason: "optout", // o devedor pediu para parar de receber mensagens
      source: provider === "voxuy" ? "voxuy" : "webhook",
      metadata: { cause: "voxuy_flow_optout" },
    })
    if (companyId) {
      await recordEvent({
        companyId, customerId, type: "optout.received", actor: "customer",
        payload: { via: "voxuy_flow" },
      })
    }
  }
}

export interface CaptureResult {
  duplicate: boolean
  applied: number
}

/**
 * Grava TUDO em whatsapp_provider_events (dedupe por event_hash) e aplica os
 * efeitos dos eventos normalizados. Formato desconhecido fica processed=false.
 * Nunca lança por causa de um applyEvent — só loga (a rota responde 200).
 */
export async function captureRawInbound(input: {
  provider: string
  rawBody: string
  events: NormalizedWhatsAppEvent[]
  companyId?: string | null
}): Promise<CaptureResult> {
  const supabase = createServiceClient()
  const { error: insErr } = await supabase.from("whatsapp_provider_events").insert({
    provider: input.provider,
    company_id: input.companyId ?? null,
    event_hash: inboundEventHash(input.provider, input.rawBody),
    raw: (() => {
      try {
        return JSON.parse(input.rawBody)
      } catch {
        return { text: input.rawBody.slice(0, 2000) }
      }
    })(),
    normalized: input.events.length ? input.events : null,
    processed: input.events.length > 0,
    error: input.events.length === 0 ? "formato_desconhecido" : null,
  })
  if (insErr?.code === "23505") return { duplicate: true, applied: 0 }

  let applied = 0
  for (const ev of input.events) {
    try {
      await applyNormalizedEvent(ev, input.provider)
      applied++
    } catch (err) {
      console.error("[whatsapp-webhook] applyEvent:", (err as Error).message)
    }
  }
  return { duplicate: false, applied }
}
