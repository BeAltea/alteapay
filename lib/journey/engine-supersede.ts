// N87-07 — o devedor abandonou a conversa com o motor (reabriu o menu, pediu
// "Já paguei" ou foi pagar a partir da espera). Um prompt do n8n que responde a
// um evento enviado ANTES disso é de uma negociação abandonada: não pode tomar o
// lugar do menu que a plataforma acabou de reabrir.
//
// Marca: uma linha `chat.engine_superseded` em journey_events (sem tabela nova,
// sem customer_id — não alimenta a projeção negotiation_state, sem PII).
// Leitura: a correlação N8N-16 sabe QUANDO a plataforma enviou o evento que o
// callback responde (`origin sent_at`); se existe marca da sessão/empresa
// posterior a esse instante, o prompt é obsoleto.

import { randomUUID } from "node:crypto"
import { createServiceClient } from "@/lib/supabase/service"

export const ENGINE_SUPERSEDED_EVENT = "chat.engine_superseded"

export type EngineSupersedeReason = "reopen_options" | "payment_claim" | "pay_now"

/**
 * Grava a marca. Best-effort e nunca lança: sem a marca, a resposta tardia do
 * motor cai nas regras anteriores (guard do menu protegido), como antes.
 */
export async function markEngineSuperseded(input: {
  companyId: string
  sessionId: string
  reason: EngineSupersedeReason
}): Promise<void> {
  try {
    const { error } = await createServiceClient().from("journey_events").insert({
      company_id: input.companyId,
      session_id: input.sessionId,
      event_type: ENGINE_SUPERSEDED_EVENT,
      event_id: `engine_superseded:${input.sessionId}:${randomUUID()}`,
      actor: "customer",
      payload: { reason: input.reason },
      occurred_at: new Date().toISOString(),
    })
    if (error) console.warn("[engine-supersede] marca não gravada (não-fatal):", error.code ?? "err")
  } catch (err) {
    console.warn("[engine-supersede] marca falhou (não-fatal):", err instanceof Error ? err.name : "erro")
  }
}

/**
 * Instante da marca mais recente POSTERIOR a `originSentAt` (null = nenhuma, ou
 * origem desconhecida, ou leitura falhou). Nunca lança: na dúvida não recusa.
 */
export async function engineSupersededSince(
  sessionId: string,
  companyId: string,
  originSentAt: string | null | undefined,
): Promise<string | null> {
  const originMs = Date.parse(originSentAt ?? "")
  if (!Number.isFinite(originMs)) return null
  try {
    const { data, error } = await createServiceClient()
      .from("journey_events")
      .select("occurred_at")
      .eq("session_id", sessionId)
      .eq("company_id", companyId)
      .eq("event_type", ENGINE_SUPERSEDED_EVENT)
      .gt("occurred_at", new Date(originMs).toISOString())
      .order("occurred_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) return null
    const at = (data as { occurred_at?: string | null } | null)?.occurred_at
    return typeof at === "string" && Date.parse(at) > originMs ? at : null
  } catch {
    return null
  }
}
