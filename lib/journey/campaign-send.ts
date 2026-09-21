// Processamento de UMA mensagem de campanha (chamado pelo whatsapp.worker).
// REVERIFICA supressão/elegibilidade (o estado pode ter mudado desde o
// enfileiramento), cria o token do link NA HORA (valor em claro nunca
// persiste), envia via provider e registra jornada + contadores.

import { createServiceClient } from "@/lib/supabase/service"
import { findBlockingAgreement } from "@/lib/asaas-idempotency"
import { getWhatsAppProvider, resolveDispatchMode } from "@/lib/whatsapp"
import { loadVoxuyApiConfig, coerceFlowId } from "@/lib/whatsapp/voxuy/config"
import { whatsappQueue } from "@/lib/queue/queues"
import { recordEvent } from "./events"
import { isSuppressed } from "./suppressions"
import { issueActionTokens } from "./tokens"
import { dispatchEmailInvite } from "./email-dispatch"
import {
  loadTenantHubConfig,
  evaluateHubEligibility,
  type HubEligibilityResult,
  type NegotiationSendMode,
} from "./campaigns"

function appBaseUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"
}

/**
 * T3-2: monta o seletor do provider injetando o `voxuy_flow_id` do tenant.
 * - mock (default): devolve a string simples — nada carrega env/credencial.
 * - voxuy_api: carrega a base do env (loadVoxuyApiConfig) e sobrescreve o flowId
 *   com o do tenant (coerceFlowId), caindo no env só como fallback. Se a base
 *   estiver incompleta (VoxuyConfigError), devolve o seletor sem apiConfig: o
 *   construtor do VoxuyApiProvider valida e o erro vira `config` no envio (que
 *   pausa a campanha), em vez de estourar aqui.
 */
export function buildProviderSelector(
  providerRaw: string | null | undefined,
  tenantFlowId: unknown,
): string | { dispatchMode: string; apiConfig?: ReturnType<typeof loadVoxuyApiConfig> } {
  const mode = resolveDispatchMode(providerRaw)
  if (mode !== "voxuy_api") return providerRaw ?? "mock"
  try {
    const base = loadVoxuyApiConfig()
    return {
      dispatchMode: "voxuy_api",
      apiConfig: { ...base, flowId: coerceFlowId(tenantFlowId) ?? base.flowId },
    }
  } catch {
    // env base incompleta: deixa o VoxuyApiProvider validar e reportar como config.
    return { dispatchMode: "voxuy_api" }
  }
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
      .select("link_ttl_hours, whatsapp_sender_label, branding, voxuy_plan_id, voxuy_events, voxuy_flow_id")
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
  // T3-2: quando o disparo é por API (voxuy_api), injeta o flowId POR-TENANT
  // (tenant_chat_config.voxuy_flow_id) no apiConfig; só cai no env VOXUY_FLOW_ID
  // como fallback. No default (mock) nada disso é carregado — nada sai.
  const provider = getWhatsAppProvider(buildProviderSelector(msg.provider, cfg?.voxuy_flow_id))
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
      payload: { channel: "whatsapp" },
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
      payload: { channel: "whatsapp", transient: true, error: result.error ?? "retryable" },
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
    payload: { channel: "whatsapp", error: result.error ?? "send_failed", errorClass: result.errorClass, traceId: result.traceId },
  })
  return "failed"
}

// ===========================================================================
// HUB DE ENVIO (link único) — orquestra o disparo por devedor.
//
// Diferente do worker de campanha (processCampaignMessage), esta função roteia
// por CANAL (whatsapp → fila/inline; email → convite com o mesmo link) a partir
// do snapshot da campanha do hub. Grava 1 whatsapp_messages por devedor com
// `channel`, jobId determinístico SEM ':', journey_events e estágio.
// ===========================================================================

/** Resultado por devedor no hub. */
export interface HubSendItem {
  customerId: string
  channel?: "whatsapp" | "email"
  status: "sent" | "failed" | "suppressed" | "skipped"
  reason?: string
  messageId?: string
  jobId?: string
}

export interface HubSendResult {
  campaignId: string
  mode: NegotiationSendMode
  dispatchMode: "inline" | "queue"
  dryRun: boolean
  items: HubSendItem[]
  summary: { sent: number; failed: number; suppressed: number; skipped: number }
}

/** jobId determinístico SEM ':' (regra BullMQ). */
function hubJobId(campaignId: string, customerId: string): string {
  return `hub_${campaignId}_${customerId}`
}

/** Monta o link público único do cedente (/n/{code}). */
function publicLink(code: string | null): string | null {
  if (!code) return null
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"
  return `${base}/n/${code}`
}

/**
 * Executa o envio do hub a partir do snapshot da campanha (já criada por
 * createHubCampaign). REVERIFICA cada devedor no envio (estado pode ter mudado)
 * e roteia por canal. `dryRun` devolve o resultado completo sem escrever nem
 * enviar. `dispatchMode='inline'` dispara na request (com teto/rate-limit no
 * chamador); 'queue' enfileira o job de WhatsApp e envia e-mail direto.
 */
export async function runHubSend(input: {
  campaignId: string
  companyId: string
  dispatchMode: "inline" | "queue"
  dryRun: boolean
}): Promise<HubSendResult> {
  const supabase = createServiceClient()
  const { data: campaign, error } = await supabase
    .from("whatsapp_campaigns")
    .select("*")
    .eq("id", input.campaignId)
    .eq("company_id", input.companyId)
    .single()
  if (error || !campaign) throw new Error("campanha não encontrada")

  const snapshot = campaign.selection_snapshot as {
    evaluated: HubEligibilityResult[]
    send_mode?: NegotiationSendMode
  }
  const mode: NegotiationSendMode = snapshot?.send_mode ?? "whatsapp_chat"
  const hub = await loadTenantHubConfig(input.companyId)
  const link = publicLink(hub.publicLinkCode)

  const { data: company } = await supabase
    .from("companies")
    .select("name")
    .eq("id", input.companyId)
    .maybeSingle()
  const { data: cfg } = await supabase
    .from("tenant_chat_config")
    .select("branding, whatsapp_sender_label")
    .eq("company_id", input.companyId)
    .maybeSingle()
  const branding = (cfg?.branding ?? {}) as { brand_name?: string; creditor_name?: string }
  const brandName = branding.brand_name ?? "AlteaPay"
  const creditorName = branding.creditor_name ?? company?.name ?? brandName

  // Reverifica TODO o snapshot no envio (supressão/contato/dívida/cooldown/já
  // contatado). O snapshot é congelado, mas o mundo pode ter mudado.
  const snapshotIds = (snapshot?.evaluated ?? [])
    .filter((e) => e.eligible)
    .map((e) => e.customerId)
  const reverified = await evaluateHubEligibility({
    companyId: input.companyId,
    customerIds: snapshotIds,
    cooldownDays: hub.cooldownDays,
    minDebtValue: hub.minDebtValue,
    campaignId: input.campaignId,
  })

  const items: HubSendItem[] = []

  for (const r of reverified) {
    if (!r.eligible || !r.channel) {
      items.push({
        customerId: r.customerId,
        status: r.reason === "suprimido" ? "suppressed" : "skipped",
        reason: r.reason,
      })
      continue
    }

    if (input.dryRun) {
      items.push({ customerId: r.customerId, channel: r.channel, status: "sent", reason: "dry_run" })
      continue
    }

    // 1 registro por devedor. jobId determinístico SEM ':'.
    const jobId = hubJobId(input.campaignId, r.customerId)
    const { data: existing } = await supabase
      .from("whatsapp_messages")
      .select("id, status")
      .eq("campaign_id", input.campaignId)
      .eq("customer_id", r.customerId)
      .maybeSingle()
    if (existing) {
      items.push({ customerId: r.customerId, channel: r.channel, status: "skipped", reason: "ja_registrado", messageId: existing.id })
      continue
    }

    const { data: msg, error: msgErr } = await supabase
      .from("whatsapp_messages")
      .insert({
        company_id: input.companyId,
        campaign_id: input.campaignId,
        customer_id: r.customerId,
        debt_id: r.debtIds?.[0] ?? null,
        phone_e164: r.phoneE164 ?? "",
        provider: r.channel === "whatsapp" ? campaign.provider : "email",
        channel: r.channel,
        // espelho do canal no jsonb (queryável mesmo antes da coluna `channel`
        // ser aplicada; ver request T2-2). Sem PII.
        provider_payload: { channel: r.channel },
        status: "queued",
      })
      .select("id")
      .single()
    if (msgErr || !msg) {
      items.push({ customerId: r.customerId, channel: r.channel, status: "failed", reason: msgErr?.message ?? "insert_failed" })
      continue
    }

    await recordEvent({
      companyId: input.companyId,
      campaignId: input.campaignId,
      messageId: msg.id,
      customerId: r.customerId,
      type: "message.queued",
      actor: "system",
      payload: { channel: r.channel },
    })
    // A projeção negotiation_state é atualizada pelo gancho global em recordEvent
    // (o payload.channel já viaja acima) — sem chamada direta aqui.

    // ---- roteamento por canal
    if (r.channel === "whatsapp") {
      if (input.dispatchMode === "queue") {
        await whatsappQueue.add(
          "campaign-message",
          { kind: "campaign-message", messageId: msg.id },
          { jobId },
        )
        items.push({ customerId: r.customerId, channel: "whatsapp", status: "sent", reason: "queued", messageId: msg.id, jobId })
      } else {
        const outcome = await processCampaignMessage(msg.id)
        items.push({
          customerId: r.customerId,
          channel: "whatsapp",
          status: outcome === "sent" ? "sent" : outcome === "suppressed" ? "suppressed" : outcome === "skipped" ? "skipped" : "failed",
          messageId: msg.id,
        })
      }
      continue
    }

    // ---- e-mail: mesmo link /n/{code}, sem cobrança
    if (!link) {
      await supabase.from("whatsapp_messages").update({ status: "failed", error: "sem_link_publico" }).eq("id", msg.id)
      await recordEvent({
        companyId: input.companyId, campaignId: input.campaignId, messageId: msg.id, customerId: r.customerId,
        type: "message.failed", actor: "system", payload: { reason: "sem_link_publico" },
      })
      items.push({ customerId: r.customerId, channel: "email", status: "failed", reason: "sem_link_publico", messageId: msg.id })
      continue
    }
    const emailRes = await dispatchEmailInvite({
      to: r.email ?? "",
      customerName: "",
      brandName,
      creditorName,
      link,
      companyId: input.companyId,
      customerId: r.customerId,
    })
    const now = new Date().toISOString()
    if (emailRes.ok) {
      await supabase.from("whatsapp_messages").update({
        status: "sent", sent_at: now, provider_message_id: emailRes.jobId ?? null,
        status_history: [{ at: now, to: "sent", channel: "email" }],
      }).eq("id", msg.id)
      await recordEvent({
        companyId: input.companyId, campaignId: input.campaignId, messageId: msg.id, customerId: r.customerId,
        type: "message.sent", actor: "system", payload: { channel: "email" },
      })
      // projeção negotiation_state atualizada pelo gancho global em recordEvent.
      items.push({ customerId: r.customerId, channel: "email", status: "sent", messageId: msg.id, jobId: emailRes.jobId })
    } else {
      await supabase.from("whatsapp_messages").update({
        status: "failed", error: emailRes.error ?? "email_failed",
        status_history: [{ at: now, to: "failed", channel: "email", error: emailRes.error }],
      }).eq("id", msg.id)
      await recordEvent({
        companyId: input.companyId, campaignId: input.campaignId, messageId: msg.id, customerId: r.customerId,
        type: "message.failed", actor: "system", payload: { channel: "email", error: emailRes.error },
      })
      items.push({ customerId: r.customerId, channel: "email", status: "failed", reason: emailRes.error, messageId: msg.id })
    }
  }

  // status da campanha (não mexe se pausada por config-error do provider)
  if (!input.dryRun) {
    await supabase
      .from("whatsapp_campaigns")
      .update({ status: "running", started_at: campaign.started_at ?? new Date().toISOString() })
      .eq("id", input.campaignId)
      .in("status", ["draft", "scheduled", "running"])
  }

  const summary = {
    sent: items.filter((i) => i.status === "sent").length,
    failed: items.filter((i) => i.status === "failed").length,
    suppressed: items.filter((i) => i.status === "suppressed").length,
    skipped: items.filter((i) => i.status === "skipped").length,
  }
  return { campaignId: input.campaignId, mode, dispatchMode: input.dispatchMode, dryRun: input.dryRun, items, summary }
}
