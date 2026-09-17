// Campanhas de WhatsApp (D-regra 8: SEMPRE lista explícita de customers.id).
// createCampaign valida elegibilidade por cliente e congela o snapshot;
// startCampaign cria tokens+mensagens e enfileira 1 job/mensagem com jobId
// determinístico (sem ':'). O worker REVERIFICA tudo antes de enviar.

import { createServiceClient } from "@/lib/supabase/service"
import { findBlockingAgreement } from "@/lib/asaas-idempotency"
import { whatsappQueue } from "@/lib/queue/queues"
import { recordEvent } from "./events"
import { isSuppressed } from "./suppressions"

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
    cooldownDays: cfg?.contact_cooldown_days ?? 7,
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
