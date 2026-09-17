// Processamento de UMA mensagem de campanha (chamado pelo whatsapp.worker).
// REVERIFICA supressão/elegibilidade (o estado pode ter mudado desde o
// enfileiramento), cria o token do link NA HORA (valor em claro nunca
// persiste), envia via provider e registra jornada + contadores.

import { createServiceClient } from "@/lib/supabase/service"
import { findBlockingAgreement } from "@/lib/asaas-idempotency"
import { getWhatsAppProvider } from "@/lib/whatsapp"
import { recordEvent } from "./events"
import { isSuppressed } from "./suppressions"
import { issueActionTokens } from "./tokens"

function appBaseUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"
}

export async function processCampaignMessage(messageId: string): Promise<"sent" | "suppressed" | "failed" | "skipped"> {
  const supabase = createServiceClient()
  const { data: msg } = await supabase
    .from("whatsapp_messages")
    .select("*, whatsapp_campaigns!inner(id, company_id, template_key, provider, status)")
    .eq("id", messageId)
    .maybeSingle()
  if (!msg) return "skipped"
  if (msg.status !== "queued") return "skipped" // idempotência de reprocesso
  const campaign = msg.whatsapp_campaigns as {
    id: string; company_id: string; template_key: string; provider: string; status: string
  }
  if (!["running", "scheduled"].includes(campaign.status)) return "skipped" // pausada/cancelada

  const companyId = campaign.company_id

  // ---- reverificação (estado pode ter mudado)
  const suppressed = await isSuppressed({
    companyId, channel: "whatsapp", phoneE164: msg.phone_e164, customerId: msg.customer_id,
  })
  let blockReason: string | null = suppressed ? "suprimido" : null
  if (!blockReason) {
    const { data: agreements } = await supabase
      .from("agreements")
      .select("id, asaas_payment_id, payment_status, asaas_status")
      .eq("customer_id", msg.customer_id)
      .eq("company_id", companyId)
      .not("asaas_payment_id", "is", null)
    if (findBlockingAgreement(agreements ?? [])) blockReason = "cobranca_viva"
  }
  if (blockReason) {
    await supabase.from("whatsapp_messages").update({
      status: "suppressed", error: blockReason,
      status_history: [...(msg.status_history ?? []), { at: new Date().toISOString(), to: "suppressed", reason: blockReason }],
    }).eq("id", messageId)
    await recordEvent({
      companyId, campaignId: campaign.id, messageId, customerId: msg.customer_id,
      type: "message.suppressed", actor: "system", payload: { reason: blockReason },
    })
    return "suppressed"
  }

  // ---- dados do cliente + config do tenant
  const [{ data: customer }, { data: cfg }, { data: company }] = await Promise.all([
    supabase.from("customers").select("name, document").eq("id", msg.customer_id).single(),
    supabase
      .from("tenant_chat_config")
      .select("link_ttl_hours, whatsapp_sender_label, branding, voxuy_plan_id, voxuy_events")
      .eq("company_id", companyId)
      .maybeSingle(),
    supabase.from("companies").select("name").eq("id", companyId).maybeSingle(),
  ])
  const branding = (cfg?.branding ?? {}) as { brand_name?: string; creditor_name?: string }
  const voxuyEvents = (cfg?.voxuy_events ?? {}) as { approach?: number | null; stop?: number | null; receipt?: number | null }
  const firstName = (customer?.name ?? "").trim().split(/\s+/)[0] ?? ""
  const brandName = branding.brand_name ?? "AlteaPay"
  const creditorName = branding.creditor_name ?? company?.name ?? brandName

  // ---- tokens de ação na hora do envio (V4: consult + optout + block)
  const { data: tokensExisting } = await supabase
    .from("chat_access_tokens")
    .select("id")
    .eq("message_id", messageId)
    .is("revoked_at", null)
  // reprocesso após falha de envio: revoga tokens anteriores e emite novos
  if (tokensExisting && tokensExisting.length > 0) {
    await supabase.from("chat_access_tokens")
      .update({ revoked_at: new Date().toISOString(), revoke_reason: "resend" })
      .in("id", tokensExisting.map((t) => t.id))
  }
  const tokens = await issueActionTokens({
    companyId,
    customerId: msg.customer_id,
    debtIds: msg.debt_id ? [msg.debt_id] : [],
    campaignId: campaign.id,
    messageId,
    ttlHours: cfg?.link_ttl_hours ?? 168,
  })
  // A mensagem aponta para o token de CONSULTA (V1: um único link).
  await supabase.from("whatsapp_messages").update({ access_token_id: tokens.consult.id }).eq("id", messageId)

  const base = appBaseUrl()
  // ---- envio
  const provider = getWhatsAppProvider(msg.provider)
  const result = await provider.sendCampaignMessage({
    companyId,
    messageId,
    to: msg.phone_e164,
    customerName: customer?.name ?? "",
    document: (customer?.document ?? "").replace(/\D/g, ""),
    templateKey: campaign.template_key,
    variables: {
      // V1: a mensagem carrega o link único de consulta. optout_url/block_url
      // vão no metadata para o caso (V2) de a operação usar botões de URL.
      consult_url: `${base}/c/${tokens.consult.token}`,
      optout_url: `${base}/c/${tokens.optout.token}/cancelar`,
      block_url: `${base}/c/${tokens.block.token}/bloquear`,
      brand_name: brandName,
      sender_label: cfg?.whatsapp_sender_label ?? "AlteaPay",
      creditor_name: creditorName,
      first_name: firstName,
    },
    voxuyPlanId: cfg?.voxuy_plan_id ?? null,
    voxuyEvent: typeof voxuyEvents.approach === "number" ? voxuyEvents.approach : null,
  })

  const now = new Date().toISOString()
  if (result.accepted) {
    // V7: status HONESTO. A Voxuy responde 200 = "aceito para agendamento",
    // NÃO entregue. Só o mock (ciclo simulado) usa 'sent'. delivered/read
    // dependem de fonte real (provider_status_source != 'none').
    const isVoxuy = campaign.provider === "voxuy"
    const acceptedStatus = isVoxuy ? "accepted" : "sent"
    await supabase.from("whatsapp_messages").update({
      status: acceptedStatus,
      sent_at: now,
      ...(isVoxuy ? { accepted_at: now } : {}),
      provider_message_id: result.providerMessageId ?? null,
      provider_transaction_id: messageId,
      status_history: [...(msg.status_history ?? []), { at: now, to: acceptedStatus }],
    }).eq("id", messageId)
    await recordEvent({
      companyId, campaignId: campaign.id, messageId, customerId: msg.customer_id,
      type: isVoxuy ? "message.accepted" : "message.sent", actor: "system",
    })
    return "sent"
  }

  // 429/5xx/timeout = retryável (§1.5): NÃO marca a mensagem como failed (ela
  // fica 'queued' para o BullMQ reprocessar com backoff); apenas propaga o erro.
  // O guard `msg.status !== "queued"` no topo garante idempotência do reprocesso.
  if (result.errorClass === "retryable") {
    await recordEvent({
      companyId, campaignId: campaign.id, messageId, customerId: msg.customer_id,
      type: "message.failed", actor: "system",
      payload: { transient: true, error: result.error ?? "retryable" },
    })
    throw new Error(`voxuy_retryable:${result.error ?? "unknown"}`)
  }

  // 401/403 = erro de configuração (§1.5): falha a mensagem E PAUSA a campanha
  // (não fica batendo com token errado). 400/validation/unexpected: falha final.
  if (result.errorClass === "config") {
    await supabase.from("whatsapp_campaigns")
      .update({ status: "paused" })
      .eq("id", campaign.id)
      .in("status", ["running", "scheduled"])
  }
  await supabase.from("whatsapp_messages").update({
    status: "failed",
    error: result.error ?? "send_failed",
    provider_transaction_id: messageId,
    provider_trace_id: result.traceId ?? null,
    status_history: [...(msg.status_history ?? []), { at: now, to: "failed", error: result.error }],
  }).eq("id", messageId)
  await recordEvent({
    companyId, campaignId: campaign.id, messageId, customerId: msg.customer_id,
    type: "message.failed", actor: "system",
    payload: { error: result.error ?? "send_failed", errorClass: result.errorClass, traceId: result.traceId },
  })
  return "failed"
}
