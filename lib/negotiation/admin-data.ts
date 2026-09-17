// Carregadores server-side das telas de gestão do chatbot (admin/super_admin).
// companyId null = visão global (super_admin). PII sempre mascarado aqui —
// as telas nunca recebem documento/nome em claro.

import type { ChatSessionRow } from "@/components/negotiation/chat-sessions-content"
import type { RedirectEventRow } from "@/components/negotiation/redirects-content"
import { createServiceClient } from "@/lib/supabase/service"
import { maskCpf, maskName } from "./pii"

export async function loadChatSessions(companyId: string | null): Promise<ChatSessionRow[]> {
  const supabase = createServiceClient()
  let query = supabase
    .from("negotiation_sessions")
    .select(
      "id, company_id, customer_id, channel_origin, frontend_mode, fulfillment_mode, outcome, identity_verified_at, consent_lgpd_at, debt_acknowledged_at, agreement_id, created_at, companies(name), customers(name)",
    )
    .order("created_at", { ascending: false })
    .range(0, 99999)
  if (companyId) query = query.eq("company_id", companyId)
  const { data: sessions } = await query
  if (!sessions?.length) return []

  // contagem de mensagens por sessão (uma query, agregada no app)
  const ids = sessions.map((s) => s.id)
  const counts = new Map<string, number>()
  for (let i = 0; i < ids.length; i += 500) {
    const { data: msgs } = await supabase
      .from("conversation_messages")
      .select("session_id")
      .in("session_id", ids.slice(i, i + 500))
      .range(0, 99999)
    for (const m of msgs ?? []) counts.set(m.session_id, (counts.get(m.session_id) ?? 0) + 1)
  }

  return sessions.map((s) => {
    const company = s.companies as unknown as { name: string } | null
    const customer = s.customers as unknown as { name: string } | null
    return {
      id: s.id,
      company_name: company?.name ?? "—",
      customer_name_masked: customer ? maskName(customer.name) : "—",
      channel_origin: s.channel_origin,
      frontend_mode: s.frontend_mode,
      fulfillment_mode: s.fulfillment_mode,
      outcome: s.outcome,
      identity_verified: Boolean(s.identity_verified_at),
      consent_given: Boolean(s.consent_lgpd_at),
      debt_acknowledged: Boolean(s.debt_acknowledged_at),
      agreement_id: s.agreement_id,
      message_count: counts.get(s.id) ?? 0,
      created_at: s.created_at,
    }
  })
}

export async function loadRedirectEvents(companyId: string | null): Promise<RedirectEventRow[]> {
  const supabase = createServiceClient()
  let query = supabase
    .from("redirect_events")
    .select(
      "id, company_id, debt_amount_at_redirect, offer_presented, official_channel_url, confirmed_intent, clicked_at, companies(name), customers(name, document)",
    )
    .order("clicked_at", { ascending: false })
    .range(0, 99999)
  if (companyId) query = query.eq("company_id", companyId)
  const { data: events } = await query

  return (events ?? []).map((e) => {
    const company = e.companies as unknown as { name: string } | null
    const customer = e.customers as unknown as { name: string; document: string } | null
    return {
      id: e.id,
      company_name: company?.name ?? "—",
      customer_name_masked: customer ? maskName(customer.name) : "—",
      document_masked: customer ? maskCpf(customer.document) : "—",
      debt_amount_at_redirect: Number(e.debt_amount_at_redirect),
      offer_presented: e.offer_presented as RedirectEventRow["offer_presented"],
      official_channel_url: e.official_channel_url,
      confirmed_intent: e.confirmed_intent,
      clicked_at: e.clicked_at,
    }
  })
}
