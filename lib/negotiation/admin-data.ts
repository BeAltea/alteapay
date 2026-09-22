// Carregadores server-side das telas de gestão do chatbot (admin/super_admin).
// companyId null = visão global (super_admin). PII sempre mascarado aqui —
// as telas nunca recebem documento/nome em claro.
//
// A2: o contador de mensagens (Msgs) e o funil leem de `chat_messages` (runtime
// atual da jornada), NÃO da tabela legada `conversation_messages` (que está vazia
// em produção). A1.2: a lista é agregada POR DEVEDOR. A1.3: os KPIs derivam da
// mesma agregação, de forma coerente.

import type { RedirectEventRow } from "@/components/negotiation/redirects-content"
import {
  computeKpis,
  groupByDebtor,
  activeWindowMinutes,
  type ChatKpis,
  type ChatSessionInput,
  type DebtorRow,
} from "@/lib/negotiation/chat-debtors"
import { maskDocument } from "@/lib/journey/document"
import { createServiceClient } from "@/lib/supabase/service"
import { maskCpf, maskName } from "./pii"

export interface ChatDebtorsData {
  debtors: DebtorRow[]
  kpis: ChatKpis
}

/**
 * Carrega as sessões do chatbot já agregadas POR DEVEDOR + KPIs coerentes.
 * `Msgs` vem de `chat_messages` (por session_id). Sessão sem mensagem conta 0.
 */
export async function loadChatDebtors(companyId: string | null): Promise<ChatDebtorsData> {
  const supabase = createServiceClient()
  let query = supabase
    .from("negotiation_sessions")
    .select(
      "id, company_id, customer_id, channel, channel_origin, engine, frontend_mode, fulfillment_mode, outcome, identity_verified_at, consent_lgpd_at, debt_acknowledged_at, agreement_id, last_activity_at, created_at, companies(name), customers(name, document)",
    )
    .order("created_at", { ascending: false })
    .range(0, 99999)
  if (companyId) query = query.eq("company_id", companyId)
  const { data: sessions } = await query
  if (!sessions?.length) {
    return {
      debtors: [],
      kpis: computeKpis({
        debtors: [],
        sessions: [],
        agreementsClosedAmount: 0,
        redirectCount: 0,
        redirectAmount: 0,
        ackYes: 0,
        ackNo: 0,
        now: Date.now(),
        windowMin: activeWindowMinutes(),
      }),
    }
  }

  const ids = sessions.map((s) => s.id)

  // contagem de mensagens + última mensagem por sessão (chat_messages), em lotes
  const counts = new Map<string, number>()
  const lastMessageAt = new Map<string, string>()
  for (let i = 0; i < ids.length; i += 500) {
    const slice = ids.slice(i, i + 500)
    const { data: msgs } = await supabase
      .from("chat_messages")
      .select("session_id, created_at")
      .in("session_id", slice)
      .range(0, 99999)
    for (const m of msgs ?? []) {
      counts.set(m.session_id, (counts.get(m.session_id) ?? 0) + 1)
      const prev = lastMessageAt.get(m.session_id)
      if (!prev || m.created_at > prev) lastMessageAt.set(m.session_id, m.created_at)
    }
  }

  const inputs: ChatSessionInput[] = sessions.map((s) => {
    const company = s.companies as unknown as { name: string } | null
    const customer = s.customers as unknown as { name: string; document: string } | null
    return {
      id: s.id,
      company_id: s.company_id,
      customer_id: s.customer_id,
      company_name: company?.name ?? "—",
      customer_name_masked: customer ? maskName(customer.name) : "—",
      document_masked: customer ? maskDocument(customer.document) : "***",
      channel: s.channel,
      channel_origin: s.channel_origin,
      engine: s.engine,
      fulfillment_mode: s.fulfillment_mode,
      outcome: s.outcome,
      identity_verified: Boolean(s.identity_verified_at),
      consent_given: Boolean(s.consent_lgpd_at),
      debt_acknowledged: Boolean(s.debt_acknowledged_at),
      agreement_id: s.agreement_id,
      message_count: counts.get(s.id) ?? 0,
      created_at: s.created_at,
      last_message_at: lastMessageAt.get(s.id) ?? null,
      last_activity_at: s.last_activity_at ?? null,
    }
  })

  const debtors = groupByDebtor(inputs)

  // R$ dos acordos fechados (agreements dos devedores)
  const agreementIds = Array.from(
    new Set(debtors.map((d) => d.agreement_id).filter((x): x is string => x != null)),
  )
  let agreementsClosedAmount = 0
  if (agreementIds.length) {
    for (let i = 0; i < agreementIds.length; i += 500) {
      const { data: agrs } = await supabase
        .from("agreements")
        .select("agreed_amount, total_amount")
        .in("id", agreementIds.slice(i, i + 500))
      for (const a of agrs ?? []) {
        const v = a.agreed_amount ?? a.total_amount
        if (v != null) agreementsClosedAmount += Number(v)
      }
    }
  }

  // Redirects (separado dos acordos), com R$ — filtrado por company quando aplicável
  let redirQuery = supabase
    .from("redirect_events")
    .select("debt_amount_at_redirect")
    .range(0, 99999)
  if (companyId) redirQuery = redirQuery.eq("company_id", companyId)
  const { data: redirects } = await redirQuery
  const redirectCount = redirects?.length ?? 0
  const redirectAmount = (redirects ?? []).reduce(
    (sum, r) => sum + Number(r.debt_amount_at_redirect ?? 0),
    0,
  )

  // Reconhecimentos (sim/não) a partir de debt_acknowledgement_latest (última
  // resposta por sessão+dívida). Sem PII (só booleano).
  let ackYes = 0
  let ackNo = 0
  for (let i = 0; i < ids.length; i += 500) {
    const { data: acks } = await supabase
      .from("debt_acknowledgement_latest")
      .select("acknowledged")
      .in("session_id", ids.slice(i, i + 500))
      .range(0, 99999)
    for (const a of acks ?? []) {
      if (a.acknowledged) ackYes += 1
      else ackNo += 1
    }
  }

  const windowMin = activeWindowMinutes()
  const kpis = computeKpis({
    debtors,
    sessions: inputs,
    agreementsClosedAmount,
    redirectCount,
    redirectAmount,
    ackYes,
    ackNo,
    now: Date.now(),
    windowMin,
  })

  return { debtors, kpis }
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
