// Campanhas de WhatsApp (D-regra 8: SEMPRE lista explícita de customers.id).
// createCampaign valida elegibilidade por cliente e congela o snapshot;
// startCampaign cria tokens+mensagens e enfileira 1 job/mensagem com jobId
// determinístico (sem ':'). O worker REVERIFICA tudo antes de enviar.

import { createServiceClient } from "@/lib/supabase/service"
import { findBlockingAgreement } from "@/lib/asaas-idempotency"
import { whatsappQueue } from "@/lib/queue/queues"
import { recordEvent } from "./events"
import { isSuppressed } from "./suppressions"
import { isEmailValid } from "./contact-profile"

const OPEN_DEBT_STATUSES = ["pending", "in_negotiation"] // CHECK real de debts

export type IneligibilityReason =
  | "sem_celular_valido"
  | "suprimido"
  | "sem_divida_aberta"
  | "cobranca_viva"
  | "caso_aberto"
  | "cooldown"
  | "valor_minimo"
  | "telefone_duplicado" // V10: mesmo telefone em >1 cliente da seleção

export interface EligibilityResult {
  customerId: string
  eligible: boolean
  reason?: IneligibilityReason
  phoneE164?: string
  debtIds?: string[]
  totalValue?: number
}

/** Celular BR válido: 13 dígitos E.164 +55 DD 9XXXXXXXX. */
export function toE164Mobile(phoneRaw: string | null | undefined): string | null {
  let d = (phoneRaw ?? "").replace(/\D/g, "")
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) d = d.slice(2)
  if (d.length === 10 && "6789".includes(d[2])) d = d.slice(0, 2) + "9" + d.slice(2)
  if (d.length !== 11 || d[2] !== "9") return null
  const ddd = Number(d.slice(0, 2))
  if (ddd < 11 || ddd > 99) return null
  return `+55${d}`
}

export async function evaluateEligibility(input: {
  companyId: string
  customerIds: string[]
  cooldownDays: number
  minDebtValue: number
}): Promise<EligibilityResult[]> {
  const supabase = createServiceClient()
  const results: EligibilityResult[] = []
  for (const customerId of input.customerIds) {
    const { data: customer } = await supabase
      .from("customers")
      .select("id, phone, company_id")
      .eq("id", customerId)
      .eq("company_id", input.companyId)
      .maybeSingle()
    if (!customer) {
      results.push({ customerId, eligible: false, reason: "sem_divida_aberta" })
      continue
    }
    const phone = toE164Mobile(customer.phone)
    if (!phone) {
      results.push({ customerId, eligible: false, reason: "sem_celular_valido" })
      continue
    }
    if (await isSuppressed({ companyId: input.companyId, channel: "whatsapp", phoneE164: phone, customerId })) {
      results.push({ customerId, eligible: false, reason: "suprimido" })
      continue
    }
    const { data: debts } = await supabase
      .from("debts")
      .select("id, amount, status")
      .eq("customer_id", customerId)
      .eq("company_id", input.companyId)
      .in("status", OPEN_DEBT_STATUSES)
    const openDebts = debts ?? []
    if (openDebts.length === 0) {
      results.push({ customerId, eligible: false, reason: "sem_divida_aberta" })
      continue
    }
    const total = openDebts.reduce((s, d) => s + Number(d.amount ?? 0), 0)
    if (total < input.minDebtValue) {
      results.push({ customerId, eligible: false, reason: "valor_minimo" })
      continue
    }
    const { data: agreements } = await supabase
      .from("agreements")
      .select("id, asaas_payment_id, payment_status, asaas_status")
      .eq("customer_id", customerId)
      .eq("company_id", input.companyId)
      .not("asaas_payment_id", "is", null)
    if (findBlockingAgreement(agreements ?? [])) {
      results.push({ customerId, eligible: false, reason: "cobranca_viva" })
      continue
    }
    const { data: cases } = await supabase
      .from("negotiation_cases")
      .select("id")
      .eq("customer_id", customerId)
      .eq("company_id", input.companyId)
      .in("status", ["open", "in_review"])
      .limit(1)
    if (cases && cases.length > 0) {
      results.push({ customerId, eligible: false, reason: "caso_aberto" })
      continue
    }
    // V10: cooldown avaliado POR CLIENTE **e** POR TELEFONE. Uma segunda
    // transação para o mesmo número cancelaria o funil anterior (V3/L4), então
    // um contato recente naquele telefone (mesmo de outro cliente) barra.
    const since = new Date(Date.now() - input.cooldownDays * 86400_000).toISOString()
    const { data: recent } = await supabase
      .from("whatsapp_messages")
      .select("id")
      .eq("company_id", input.companyId)
      .or(`customer_id.eq.${customerId},phone_e164.eq.${phone}`)
      .gte("queued_at", since)
      .limit(1)
    if (recent && recent.length > 0) {
      results.push({ customerId, eligible: false, reason: "cooldown" })
      continue
    }
    results.push({
      customerId, eligible: true, phoneE164: phone,
      debtIds: openDebts.map((d) => d.id), totalValue: total,
    })
  }

  // V10: dedupe POR TELEFONE dentro da própria seleção.
  return dedupeByPhone(results)
}

/**
 * V10 (puro/testável): uma campanha nunca tem dois destinos com o mesmo
 * clientPhoneNumber — senão o funil de um cancelaria o do outro (V3/L4). O
 * PRIMEIRO fica elegível; os demais viram `telefone_duplicado`.
 */
export function dedupeByPhone(results: EligibilityResult[]): EligibilityResult[] {
  const seenPhones = new Set<string>()
  for (const r of results) {
    if (!r.eligible || !r.phoneE164) continue
    if (seenPhones.has(r.phoneE164)) {
      r.eligible = false
      r.reason = "telefone_duplicado"
      r.phoneE164 = undefined
    } else {
      seenPhones.add(r.phoneE164)
    }
  }
  return results
}

export async function createCampaign(input: {
  companyId: string
  name: string
  templateKey: string
  customerIds: string[]
  scheduledAt?: string | null
  createdBy?: string | null
}): Promise<{ campaignId: string; eligible: number; ineligible: Record<string, number> }> {
  const supabase = createServiceClient()
  const { data: cfg } = await supabase
    .from("tenant_chat_config")
    .select("contact_cooldown_days, whatsapp_provider")
    .eq("company_id", input.companyId)
    .maybeSingle()
  const { data: matrix } = await supabase
    .from("negotiation_condition_matrix")
    .select("min_debt_value")
    .eq("company_id", input.companyId)
    .eq("active", true)
    .order("min_debt_value", { ascending: true })
    .limit(1)
  const minDebt = Number(matrix?.[0]?.min_debt_value ?? 0)
  const evaluated = await evaluateEligibility({
    companyId: input.companyId,
    customerIds: input.customerIds,
    // piso de 1 dia: cooldownDays=0 desarmaria o ÚNICO gate cross-campanha
    // (dois envios da mesma seleção passariam a duplicar de forma determinística).
    cooldownDays: Math.max(1, cfg?.contact_cooldown_days ?? 7),
    minDebtValue: minDebt,
  })
  const eligible = evaluated.filter((e) => e.eligible)
  const byReason: Record<string, number> = {}
  for (const e of evaluated) if (!e.eligible && e.reason) byReason[e.reason] = (byReason[e.reason] ?? 0) + 1

  const { data, error } = await supabase
    .from("whatsapp_campaigns")
    .insert({
      company_id: input.companyId,
      name: input.name,
      provider: cfg?.whatsapp_provider ?? "mock",
      template_key: input.templateKey,
      status: input.scheduledAt ? "scheduled" : "draft",
      scheduled_at: input.scheduledAt ?? null,
      selection_snapshot: { customer_ids: input.customerIds, evaluated },
      counts: { eligible: eligible.length, ineligible: byReason },
      created_by: input.createdBy ?? null,
    })
    .select("id")
    .single()
  if (error) throw new Error(`createCampaign: ${error.message}`)
  await recordEvent({
    companyId: input.companyId, campaignId: data.id,
    type: "campaign.created", actor: "admin",
    payload: { name: input.name, eligible: eligible.length, ineligible: byReason },
  })
  return { campaignId: data.id, eligible: eligible.length, ineligible: byReason }
}

export async function startCampaign(campaignId: string): Promise<{ queued: number; suppressedNow: number }> {
  const supabase = createServiceClient()
  const { data: campaign, error } = await supabase
    .from("whatsapp_campaigns")
    .select("*")
    .eq("id", campaignId)
    .single()
  if (error || !campaign) throw new Error("campanha não encontrada")
  if (!["draft", "scheduled", "paused"].includes(campaign.status))
    throw new Error(`campanha em status ${campaign.status}`)

  const snapshot = campaign.selection_snapshot as { evaluated: EligibilityResult[] }
  const eligible = (snapshot?.evaluated ?? []).filter((e) => e.eligible)

  let queued = 0
  let suppressedNow = 0
  for (const e of eligible) {
    // idempotência: UNIQUE(campaign_id, customer_id) — reexecutar não duplica
    const { data: existing } = await supabase
      .from("whatsapp_messages")
      .select("id, status")
      .eq("campaign_id", campaignId)
      .eq("customer_id", e.customerId)
      .maybeSingle()
    if (existing) continue

    // O token do link é criado NO WORKER, na hora do envio (o valor em claro
    // nunca descansa no Redis nem no banco).
    const { data: msg, error: msgErr } = await supabase
      .from("whatsapp_messages")
      .insert({
        company_id: campaign.company_id,
        campaign_id: campaignId,
        customer_id: e.customerId,
        debt_id: e.debtIds?.[0] ?? null,
        phone_e164: e.phoneE164!,
        provider: campaign.provider,
        status: "queued",
      })
      .select("id")
      .single()
    if (msgErr || !msg) continue
    await whatsappQueue.add(
      "campaign-message",
      { kind: "campaign-message", messageId: msg.id },
      { jobId: `wa_${campaignId}_${e.customerId}` },
    )
    await recordEvent({
      companyId: campaign.company_id, campaignId, messageId: msg.id,
      customerId: e.customerId, type: "message.queued", actor: "system",
    })
    queued++
  }

  await supabase
    .from("whatsapp_campaigns")
    .update({
      status: "running",
      started_at: campaign.started_at ?? new Date().toISOString(),
      counts: { ...(campaign.counts as object), queued },
    })
    .eq("id", campaignId)
  await recordEvent({
    companyId: campaign.company_id, campaignId,
    type: "campaign.started", actor: "admin", payload: { queued },
  })
  return { queued, suppressedNow }
}

// ===========================================================================
// HUB DE ENVIO (link único) — seleção multi-canal com precedência WhatsApp→e-mail
//
// Diferente de evaluateEligibility (só WhatsApp), a jornada do link único também
// aceita e-mail: se o devedor não tem celular válido mas tem e-mail válido, o
// MESMO link /n/{code} vai por e-mail (channel='email'). Precedência (E2/H10):
//   celular E.164 válido → WhatsApp
//   senão e-mail válido  → e-mail
//   senão                → no_contact (fora, listado com motivo)
// A cobrança (charge_email antigo) NÃO passa por aqui — o roteamento por `mode`
// fica na rota /send; o modo whatsapp_chat só dispara o link do chat.
// ===========================================================================

/** Modo de envio da negociação (tenant_chat_config.negotiation_send_mode). */
export type NegotiationSendMode = "whatsapp_chat" | "charge_email" | "both"

/** Canal resolvido para o devedor no hub. */
export type HubChannel = "whatsapp" | "email"

/** Motivos de exclusão legíveis no preview/send do hub. */
export type HubExclusionReason =
  | "sem_contato"
  | "suprimido"
  | "sem_divida_aberta"
  | "cooldown"
  | "ja_contatado_campanha"
  | "valor_minimo"
  | "caso_aberto"
  | "telefone_duplicado"

export interface HubEligibilityResult {
  customerId: string
  eligible: boolean
  channel?: HubChannel
  reason?: HubExclusionReason
  phoneE164?: string
  email?: string
  debtIds?: string[]
  totalValue?: number
  /** Cobrança viva ASAAS (informativo — NÃO exclui do link do chat). */
  hasLiveCharge?: boolean
}

interface EvaluateHubInput {
  companyId: string
  customerIds: string[]
  cooldownDays: number
  minDebtValue: number
  /** id da campanha em curso (exclui quem já tem mensagem nela). */
  campaignId?: string | null
}

/**
 * Avalia elegibilidade multi-canal para o hub do link único. Um registro por
 * devedor; canal resolvido por precedência (celular→WhatsApp, senão e-mail).
 * `hasLiveCharge` é INFORMATIVO (o link do chat não cria cobrança, então uma
 * cobrança viva não barra o convite — só é reportada).
 */
export async function evaluateHubEligibility(
  input: EvaluateHubInput,
): Promise<HubEligibilityResult[]> {
  const supabase = createServiceClient()
  const results: HubEligibilityResult[] = []
  const since = new Date(Date.now() - input.cooldownDays * 86400_000).toISOString()

  for (const customerId of input.customerIds) {
    const { data: customer } = await supabase
      .from("customers")
      .select("id, phone, email, company_id")
      .eq("id", customerId)
      .eq("company_id", input.companyId)
      .maybeSingle()
    if (!customer) {
      results.push({ customerId, eligible: false, reason: "sem_divida_aberta" })
      continue
    }

    // ---- precedência de canal (E2/H10)
    const phone = toE164Mobile(customer.phone)
    const emailOk = isEmailValid(customer.email)
    let channel: HubChannel | null = null
    if (phone) channel = "whatsapp"
    else if (emailOk) channel = "email"
    if (!channel) {
      results.push({ customerId, eligible: false, reason: "sem_contato" })
      continue
    }

    // ---- supressão (fail-closed no canal escolhido)
    if (
      await isSuppressed({
        companyId: input.companyId,
        channel,
        phoneE164: phone,
        customerId,
      })
    ) {
      results.push({ customerId, eligible: false, reason: "suprimido" })
      continue
    }

    // ---- dívida aberta
    const { data: debts } = await supabase
      .from("debts")
      .select("id, amount, status")
      .eq("customer_id", customerId)
      .eq("company_id", input.companyId)
      .in("status", OPEN_DEBT_STATUSES)
    const openDebts = debts ?? []
    if (openDebts.length === 0) {
      results.push({ customerId, eligible: false, reason: "sem_divida_aberta" })
      continue
    }
    const total = openDebts.reduce((s, d) => s + Number(d.amount ?? 0), 0)
    if (total < input.minDebtValue) {
      results.push({ customerId, eligible: false, reason: "valor_minimo" })
      continue
    }

    // ---- cobrança viva (INFORMATIVO — não exclui do link do chat)
    const { data: agreements } = await supabase
      .from("agreements")
      .select("id, asaas_payment_id, payment_status, asaas_status")
      .eq("customer_id", customerId)
      .eq("company_id", input.companyId)
      .not("asaas_payment_id", "is", null)
    const hasLiveCharge = !!findBlockingAgreement(agreements ?? [])

    // ---- caso humano aberto barra
    const { data: cases } = await supabase
      .from("negotiation_cases")
      .select("id")
      .eq("customer_id", customerId)
      .eq("company_id", input.companyId)
      .in("status", ["open", "in_review"])
      .limit(1)
    if (cases && cases.length > 0) {
      results.push({ customerId, eligible: false, reason: "caso_aberto" })
      continue
    }

    // ---- já contatado NESTA campanha (idempotência da onda)
    if (input.campaignId) {
      const { data: already } = await supabase
        .from("whatsapp_messages")
        .select("id")
        .eq("campaign_id", input.campaignId)
        .eq("customer_id", customerId)
        .limit(1)
      if (already && already.length > 0) {
        results.push({ customerId, eligible: false, reason: "ja_contatado_campanha" })
        continue
      }
    }

    // ---- cooldown POR CLIENTE e POR TELEFONE (contato recente barra)
    const cdOrs: string[] = [`customer_id.eq.${customerId}`]
    if (phone) cdOrs.push(`phone_e164.eq.${phone}`)
    const { data: recent } = await supabase
      .from("whatsapp_messages")
      .select("id")
      .eq("company_id", input.companyId)
      .or(cdOrs.join(","))
      .gte("queued_at", since)
      .limit(1)
    if (recent && recent.length > 0) {
      results.push({ customerId, eligible: false, reason: "cooldown" })
      continue
    }

    results.push({
      customerId,
      eligible: true,
      channel,
      phoneE164: phone ?? undefined,
      email: channel === "email" ? (customer.email ?? undefined) : undefined,
      debtIds: openDebts.map((d) => d.id),
      totalValue: total,
      hasLiveCharge,
    })
  }

  return dedupeHubByPhone(results)
}

/**
 * V10 para o hub: dois destinos WhatsApp com o mesmo número cancelariam o funil
 * um do outro. O PRIMEIRO permanece; os demais viram telefone_duplicado. E-mail
 * não sofre dedupe por telefone (canal independente).
 */
export function dedupeHubByPhone(results: HubEligibilityResult[]): HubEligibilityResult[] {
  const seen = new Set<string>()
  for (const r of results) {
    if (!r.eligible || r.channel !== "whatsapp" || !r.phoneE164) continue
    if (seen.has(r.phoneE164)) {
      r.eligible = false
      r.reason = "telefone_duplicado"
      r.channel = undefined
      r.phoneE164 = undefined
    } else {
      seen.add(r.phoneE164)
    }
  }
  return results
}

export interface TenantHubConfig {
  cooldownDays: number
  minDebtValue: number
  sendMode: NegotiationSendMode
  dispatchMode: string
  provider: string
  publicLinkCode: string | null
  publicLinkEnabled: boolean
  linkTtlHours: number
  voxuyFlowId: number | null
  voxuyPlanId: string | null
}

/** Carrega a config do tenant relevante ao hub (send mode, link, cooldown, matriz). */
export async function loadTenantHubConfig(companyId: string): Promise<TenantHubConfig> {
  const supabase = createServiceClient()
  const { data: cfg } = await supabase
    .from("tenant_chat_config")
    .select(
      "contact_cooldown_days, whatsapp_provider, whatsapp_dispatch_mode, negotiation_send_mode, public_link_code, public_link_enabled, link_ttl_hours, voxuy_flow_id, voxuy_plan_id",
    )
    .eq("company_id", companyId)
    .maybeSingle()
  const { data: matrix } = await supabase
    .from("negotiation_condition_matrix")
    .select("min_debt_value")
    .eq("company_id", companyId)
    .eq("active", true)
    .order("min_debt_value", { ascending: true })
    .limit(1)
  const rawMode = (cfg?.negotiation_send_mode ?? "whatsapp_chat") as string
  const sendMode: NegotiationSendMode =
    rawMode === "charge_email" || rawMode === "both" ? rawMode : "whatsapp_chat"
  return {
    // piso de 1 dia: cooldownDays=0 desarmaria o ÚNICO gate cross-campanha
    // (dois envios da mesma seleção passariam a duplicar de forma determinística).
    cooldownDays: Math.max(1, cfg?.contact_cooldown_days ?? 7),
    minDebtValue: Number(matrix?.[0]?.min_debt_value ?? 0),
    sendMode,
    dispatchMode: cfg?.whatsapp_dispatch_mode ?? "mock",
    provider: cfg?.whatsapp_provider ?? "mock",
    publicLinkCode: cfg?.public_link_code ?? null,
    publicLinkEnabled: cfg?.public_link_enabled ?? false,
    linkTtlHours: cfg?.link_ttl_hours ?? 168,
    voxuyFlowId:
      typeof cfg?.voxuy_flow_id === "number" ? cfg.voxuy_flow_id : null,
    voxuyPlanId: cfg?.voxuy_plan_id ?? null,
  }
}

export interface HubPreviewCounts {
  byChannel: { whatsapp: number; email: number }
  excluded: Record<string, number>
  liveChargeCount: number
  eligibleTotal: number
}

/** Agrega os resultados de elegibilidade nas contagens do preview. */
export function summarizeHubEligibility(results: HubEligibilityResult[]): HubPreviewCounts {
  const counts: HubPreviewCounts = {
    byChannel: { whatsapp: 0, email: 0 },
    excluded: {},
    liveChargeCount: 0,
    eligibleTotal: 0,
  }
  for (const r of results) {
    if (r.eligible && r.channel) {
      counts.byChannel[r.channel]++
      counts.eligibleTotal++
      if (r.hasLiveCharge) counts.liveChargeCount++
    } else if (r.reason) {
      counts.excluded[r.reason] = (counts.excluded[r.reason] ?? 0) + 1
    }
  }
  return counts
}

/**
 * Cria (ou reaproveita) a campanha do hub com o snapshot imutável (ids+critérios
 * +autor+avaliação). Diferente de createCampaign, guarda o canal por devedor e o
 * modo de envio. Retorna o id e as contagens do preview.
 */
export async function createHubCampaign(input: {
  companyId: string
  name: string
  templateKey: string
  customerIds: string[]
  createdBy?: string | null
  sendMode: NegotiationSendMode
  provider: string
  /** F1: canais marcados (default: ambos). Quando informado, o snapshot guarda
   * as decisões MULTI-CANAL (channel_decisions) que runHubSend consome. */
  channels?: HubChannel[]
  /** F1: "não duplicar" — quem tem os dois contatos vai só por WhatsApp. */
  dedupe?: boolean
  /** A1: chave de idempotência por submissão (gerada 1x na abertura do diálogo).
   * Double-click/retry com a MESMA chave reusam a MESMA campanha (nunca duplicam
   * o envio, incl. e-mail SendGrid real). Corrida resolvida pela UNIQUE no banco. */
  idempotencyKey?: string | null
}): Promise<{
  campaignId: string
  evaluated: HubEligibilityResult[]
  counts: HubPreviewCounts
  channelDecisions: HubMultiChannelResult[]
  /** true quando a campanha já existia para esta chave (envio deduplicado). */
  deduped?: boolean
}> {
  const supabase = createServiceClient()
  const hub = await loadTenantHubConfig(input.companyId)
  const channels: HubChannel[] = input.channels && input.channels.length > 0 ? input.channels : ["whatsapp", "email"]
  const dedupe = input.dedupe ?? false
  const idempotencyKey = input.idempotencyKey?.trim() || null

  // Multi-canal (F1) — fonte da verdade do envio por canal.
  const channelDecisions = await evaluateHubChannels({
    companyId: input.companyId,
    customerIds: input.customerIds,
    cooldownDays: hub.cooldownDays,
    minDebtValue: hub.minDebtValue,
    channels,
    dedupe,
  })
  const channelCounts = summarizeHubChannels(channelDecisions, channels)

  // Legacy single-channel (mantido para retrocompat de leitores antigos do snapshot).
  const evaluated = await evaluateHubEligibility({
    companyId: input.companyId,
    customerIds: input.customerIds,
    cooldownDays: hub.cooldownDays,
    minDebtValue: hub.minDebtValue,
  })
  const counts = summarizeHubEligibility(evaluated)

  // A1 — idempotência (fast-path): se já existe campanha para esta chave, devolve-a
  // sem criar outra. Cobre o double-click comum antes mesmo da corrida no banco.
  if (idempotencyKey) {
    const { data: existing } = await supabase
      .from("whatsapp_campaigns")
      .select("id")
      .eq("company_id", input.companyId)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle()
    if (existing?.id) {
      return { campaignId: existing.id, evaluated, counts, channelDecisions, deduped: true }
    }
  }

  const { data, error } = await supabase
    .from("whatsapp_campaigns")
    .insert({
      company_id: input.companyId,
      name: input.name,
      provider: input.provider,
      template_key: input.templateKey,
      idempotency_key: idempotencyKey,
      status: "draft",
      selection_snapshot: {
        customer_ids: input.customerIds,
        send_mode: input.sendMode,
        channels,
        dedupe,
        created_by: input.createdBy ?? null,
        created_at: new Date().toISOString(),
        evaluated,
        channel_decisions: channelDecisions,
      },
      counts: {
        eligible: channelCounts.total,
        by_channel: { whatsapp: channelCounts.perChannel.whatsapp.eligible, email: channelCounts.perChannel.email.eligible },
        both: channelCounts.bothCount,
        excluded: counts.excluded,
        live_charge: channelCounts.liveChargeCount,
      },
      created_by: input.createdBy ?? null,
    })
    .select("id")
    .single()
  if (error) {
    // A1 — corrida: outro request criou a campanha com a MESMA chave entre o
    // fast-path e este insert. A UNIQUE parcial (company_id, idempotency_key) faz
    // este INSERT falhar com 23505; recupera a campanha vencedora em vez de duplicar.
    if (idempotencyKey && (error.code === "23505" || /duplicate key|unique/i.test(error.message))) {
      const { data: winner } = await supabase
        .from("whatsapp_campaigns")
        .select("id")
        .eq("company_id", input.companyId)
        .eq("idempotency_key", idempotencyKey)
        .maybeSingle()
      if (winner?.id) {
        return { campaignId: winner.id, evaluated, counts, channelDecisions, deduped: true }
      }
    }
    throw new Error(`createHubCampaign: ${error.message}`)
  }
  await recordEvent({
    companyId: input.companyId,
    campaignId: data.id,
    type: "campaign.created",
    actor: "admin",
    payload: {
      name: input.name,
      mode: input.sendMode,
      channels,
      dedupe,
      whatsapp: channelCounts.perChannel.whatsapp.eligible,
      email: channelCounts.perChannel.email.eligible,
      both: channelCounts.bothCount,
    },
  })
  return { campaignId: data.id, evaluated, counts, channelDecisions }
}

// ===========================================================================
// F1 — SELEÇÃO DE CANAL (multi-canal): cada devedor pode receber por TODOS os
// canais que possuir. Diferente de evaluateHubEligibility (precedência: um único
// canal por devedor), este avaliador devolve UMA decisão por (devedor, canal
// marcado). Com os dois canais marcados, quem tem os dois contatos recebe pelos
// dois; com "não duplicar" (dedupe), quem tem os dois vai só por WhatsApp.
//
// Motivos de exclusão que valem nos 2 canais (barram o devedor inteiro):
//   suprimido, sem_divida_aberta, valor_minimo, caso_aberto, cooldown,
//   ja_contatado_campanha. Cobrança viva = INFORMATIVA (não barra).
// Motivo por-canal (nunca troca silenciosa): sem_contato_para_o_canal quando o
// devedor não tem o contato daquele canal específico.
// ===========================================================================

/** Motivos de exclusão POR CANAL (superset de HubExclusionReason). */
export type HubChannelExclusionReason =
  | HubExclusionReason
  | "sem_contato_para_o_canal"
  | "priorizado_whatsapp" // dedupe: tem os dois, priorizado no WhatsApp

/** Decisão de UM (devedor, canal). */
export interface HubChannelDecision {
  customerId: string
  channel: HubChannel
  eligible: boolean
  reason?: HubChannelExclusionReason
  phoneE164?: string
  email?: string
  debtIds?: string[]
  totalValue?: number
  hasLiveCharge?: boolean
  /** o devedor possui os DOIS contatos válidos (independe de dedupe). */
  hasBothContacts?: boolean
}

/** Resultado por DEVEDOR: as decisões de cada canal marcado. */
export interface HubMultiChannelResult {
  customerId: string
  decisions: HubChannelDecision[]
  /** o devedor tem os dois contatos válidos. */
  hasBothContacts: boolean
  hasLiveCharge?: boolean
}

interface EvaluateHubChannelsInput extends EvaluateHubInput {
  /** canais marcados no diálogo (default: ambos). */
  channels: HubChannel[]
  /** "não duplicar": quem tem os dois contatos vai só por WhatsApp. */
  dedupe: boolean
}

/**
 * Avalia elegibilidade MULTI-CANAL. Para cada devedor roda os gates comuns
 * (existência, supressão do canal, dívida aberta, valor mínimo, caso aberto,
 * cooldown, já-contatado) e então decide, por canal marcado, se recebe. A
 * supressão é avaliada POR CANAL (fail-closed) — pode barrar só um canal.
 */
export async function evaluateHubChannels(
  input: EvaluateHubChannelsInput,
): Promise<HubMultiChannelResult[]> {
  const supabase = createServiceClient()
  const channels = input.channels.length > 0 ? input.channels : (["whatsapp", "email"] as HubChannel[])
  const results: HubMultiChannelResult[] = []
  const since = new Date(Date.now() - input.cooldownDays * 86400_000).toISOString()

  for (const customerId of input.customerIds) {
    const emit = (reason: HubChannelExclusionReason, phone?: string | null, email?: string | null, extra?: Partial<HubChannelDecision>) =>
      results.push({
        customerId,
        hasBothContacts: false,
        decisions: channels.map((channel) => ({ customerId, channel, eligible: false, reason, ...extra })),
      })

    const { data: customer } = await supabase
      .from("customers")
      .select("id, phone, email, company_id")
      .eq("id", customerId)
      .eq("company_id", input.companyId)
      .maybeSingle()
    if (!customer) {
      emit("sem_divida_aberta")
      continue
    }

    const phone = toE164Mobile(customer.phone)
    const emailOk = isEmailValid(customer.email)
    const hasBothContacts = !!phone && emailOk

    // ---- dívida aberta (barra os dois canais)
    const { data: debts } = await supabase
      .from("debts")
      .select("id, amount, status")
      .eq("customer_id", customerId)
      .eq("company_id", input.companyId)
      .in("status", OPEN_DEBT_STATUSES)
    const openDebts = debts ?? []
    if (openDebts.length === 0) {
      emit("sem_divida_aberta")
      continue
    }
    const total = openDebts.reduce((s, d) => s + Number(d.amount ?? 0), 0)
    if (total < input.minDebtValue) {
      emit("valor_minimo")
      continue
    }

    // ---- caso humano aberto (barra os dois)
    const { data: cases } = await supabase
      .from("negotiation_cases")
      .select("id")
      .eq("customer_id", customerId)
      .eq("company_id", input.companyId)
      .in("status", ["open", "in_review"])
      .limit(1)
    if (cases && cases.length > 0) {
      emit("caso_aberto")
      continue
    }

    // ---- já contatado NESTA campanha (idempotência da onda; barra os dois)
    if (input.campaignId) {
      const { data: already } = await supabase
        .from("whatsapp_messages")
        .select("id")
        .eq("campaign_id", input.campaignId)
        .eq("customer_id", customerId)
        .limit(1)
      if (already && already.length > 0) {
        emit("ja_contatado_campanha")
        continue
      }
    }

    // ---- cooldown POR CLIENTE e POR TELEFONE (barra os dois)
    const cdOrs: string[] = [`customer_id.eq.${customerId}`]
    if (phone) cdOrs.push(`phone_e164.eq.${phone}`)
    const { data: recent } = await supabase
      .from("whatsapp_messages")
      .select("id")
      .eq("company_id", input.companyId)
      .or(cdOrs.join(","))
      .gte("queued_at", since)
      .limit(1)
    if (recent && recent.length > 0) {
      emit("cooldown")
      continue
    }

    // ---- cobrança viva (INFORMATIVO)
    const { data: agreements } = await supabase
      .from("agreements")
      .select("id, asaas_payment_id, payment_status, asaas_status")
      .eq("customer_id", customerId)
      .eq("company_id", input.companyId)
      .not("asaas_payment_id", "is", null)
    const hasLiveCharge = !!findBlockingAgreement(agreements ?? [])

    // ---- decisões por canal marcado
    const decisions: HubChannelDecision[] = []
    for (const channel of channels) {
      const hasContact = channel === "whatsapp" ? !!phone : emailOk
      if (!hasContact) {
        decisions.push({ customerId, channel, eligible: false, reason: "sem_contato_para_o_canal", hasBothContacts })
        continue
      }
      // supressão fail-closed no canal
      const suppressed = await isSuppressed({
        companyId: input.companyId,
        channel,
        phoneE164: channel === "whatsapp" ? phone : null,
        customerId,
      })
      if (suppressed) {
        decisions.push({ customerId, channel, eligible: false, reason: "suprimido", hasBothContacts })
        continue
      }
      // "não duplicar": quem tem os DOIS contatos e ambos os canais marcados vai
      // só por WhatsApp — o e-mail é priorizado fora.
      if (
        input.dedupe &&
        channel === "email" &&
        hasBothContacts &&
        channels.includes("whatsapp")
      ) {
        decisions.push({ customerId, channel, eligible: false, reason: "priorizado_whatsapp", hasBothContacts })
        continue
      }
      decisions.push({
        customerId,
        channel,
        eligible: true,
        phoneE164: channel === "whatsapp" ? (phone ?? undefined) : undefined,
        email: channel === "email" ? (customer.email ?? undefined) : undefined,
        debtIds: openDebts.map((d) => d.id),
        totalValue: total,
        hasLiveCharge,
        hasBothContacts,
      })
    }

    results.push({ customerId, decisions, hasBothContacts, hasLiveCharge })
  }

  return dedupeChannelsByPhone(results)
}

/**
 * Dedupe POR TELEFONE no canal WhatsApp dentro da própria seleção (dois destinos
 * WhatsApp com o mesmo número cancelariam o funil um do outro). O PRIMEIRO
 * permanece; os demais viram telefone_duplicado. E-mail não sofre dedupe.
 */
export function dedupeChannelsByPhone(results: HubMultiChannelResult[]): HubMultiChannelResult[] {
  const seen = new Set<string>()
  for (const r of results) {
    for (const d of r.decisions) {
      if (!d.eligible || d.channel !== "whatsapp" || !d.phoneE164) continue
      if (seen.has(d.phoneE164)) {
        d.eligible = false
        d.reason = "telefone_duplicado"
        d.phoneE164 = undefined
      } else {
        seen.add(d.phoneE164)
      }
    }
  }
  return results
}

/** Contagens por canal do preview multi-canal. */
export interface HubMultiChannelCounts {
  perChannel: Record<HubChannel, { eligible: number; excluded: HubChannelDecision[] }>
  /** devedores que receberão pelos DOIS canais. */
  bothCount: number
  /** total de DEVEDORES distintos que recebem por ao menos um canal. */
  total: number
  /** devedores com os dois contatos válidos (independe de dedupe). */
  hasBothContacts: number
  liveChargeCount: number
}

/** Agrega as decisões multi-canal nas contagens do preview. */
export function summarizeHubChannels(
  results: HubMultiChannelResult[],
  channels: HubChannel[],
): HubMultiChannelCounts {
  const perChannel = {
    whatsapp: { eligible: 0, excluded: [] as HubChannelDecision[] },
    email: { eligible: 0, excluded: [] as HubChannelDecision[] },
  }
  let bothCount = 0
  let total = 0
  let hasBothContacts = 0
  let liveChargeCount = 0
  for (const r of results) {
    if (r.hasBothContacts) hasBothContacts++
    const eligibleChannels = r.decisions.filter((d) => d.eligible)
    for (const d of r.decisions) {
      if (d.eligible) perChannel[d.channel].eligible++
      else perChannel[d.channel].excluded.push(d)
    }
    if (eligibleChannels.length > 0) {
      total++
      if (r.hasLiveCharge) liveChargeCount++
    }
    if (eligibleChannels.length >= 2) bothCount++
  }
  return {
    perChannel: {
      whatsapp: channels.includes("whatsapp") ? perChannel.whatsapp : { eligible: 0, excluded: [] },
      email: channels.includes("email") ? perChannel.email : { eligible: 0, excluded: [] },
    },
    bothCount,
    total,
    hasBothContacts,
    liveChargeCount,
  }
}
