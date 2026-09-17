// "Parar de contatar" (V3/V5). Sem endpoint de cancelamento na Voxuy (L4), o
// mecanismo é disparar uma transação para o evento `stop` (funil vazio ou 1
// mensagem de confirmação): a Voxuy cancela o funil anterior do mesmo número.
//
// Chamado SEMPRE que uma supressão por optout/block/paid é criada (V4.4) e
// pelas páginas de ação (V4). Falha aqui NÃO desfaz a supressão local: gera
// journey_events('contact.stop_failed') para a operação reprocessar.

import { createServiceClient } from "@/lib/supabase/service"
import { getWhatsAppProvider } from "@/lib/whatsapp"
import { recordEvent } from "./events"

export interface FireStopSignalInput {
  companyId: string
  phoneE164: string
  customerId: string
}

/**
 * Dispara o sinal de encerramento na Voxuy (se o tenant usa voxuy e tem evento
 * `stop` configurado). Retorna o resultado; nunca lança. Marca
 * whatsapp_messages.stop_signal_sent_at na última mensagem do telefone quando
 * possível e registra o evento de jornada.
 */
export async function fireStopSignal(
  input: FireStopSignalInput,
): Promise<{ ok: boolean; skipped?: string }> {
  const supabase = createServiceClient()
  const { data: cfg } = await supabase
    .from("tenant_chat_config")
    .select("whatsapp_provider, voxuy_plan_id, voxuy_events, branding")
    .eq("company_id", input.companyId)
    .maybeSingle()

  const providerName = cfg?.whatsapp_provider ?? process.env.WHATSAPP_PROVIDER ?? "mock"
  const events = (cfg?.voxuy_events ?? {}) as { stop?: number | null }
  const branding = (cfg?.branding ?? {}) as { brand_name?: string; creditor_name?: string }

  // Só a Voxuy tem funil a cancelar; no mock, nada a fazer (mas registramos).
  let provider
  try {
    provider = getWhatsAppProvider(providerName)
  } catch {
    // provider recusou na construção (credencial faltando): não bloqueia a supressão
    await recordEvent({
      companyId: input.companyId, customerId: input.customerId,
      type: "contact.stop_failed", actor: "system",
      payload: { reason: "provider_unavailable" },
    })
    return { ok: false, skipped: "provider_unavailable" }
  }

  if (!provider.sendStopSignal) {
    return { ok: true, skipped: "no_stop_signal_support" }
  }

  const result = await provider.sendStopSignal({
    companyId: input.companyId,
    phone: input.phoneE164,
    customerId: input.customerId,
    voxuyEvent: typeof events.stop === "number" ? events.stop : null,
    voxuyPlanId: cfg?.voxuy_plan_id ?? null,
    brandName: branding.brand_name ?? "AlteaPay",
    creditorName: branding.creditor_name ?? branding.brand_name ?? "AlteaPay",
  })

  const now = new Date().toISOString()
  if (result.accepted) {
    // carimba a última mensagem daquele telefone (rastro para o painel)
    const { data: lastMsg } = await supabase
      .from("whatsapp_messages")
      .select("id")
      .eq("company_id", input.companyId)
      .eq("phone_e164", input.phoneE164)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    if (lastMsg) {
      await supabase
        .from("whatsapp_messages")
        .update({ stop_signal_sent_at: now })
        .eq("id", lastMsg.id)
    }
    await recordEvent({
      companyId: input.companyId, customerId: input.customerId,
      type: "contact.stopped", actor: "system",
      payload: { provider: providerName },
    })
    return { ok: true }
  }

  await recordEvent({
    companyId: input.companyId, customerId: input.customerId,
    type: "contact.stop_failed", actor: "system",
    payload: { provider: providerName, error: result.error ?? "unknown", errorClass: result.errorClass },
  })
  return { ok: false }
}
