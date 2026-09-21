// Consulta do detalhe do devedor (T5 §6). server-only.
//
// Agrega, por (company_id, customer_id): estado atual (negotiation_state),
// timeline (journey_events com data + PROCEDÊNCIA=actor), transcrição das
// sessões, reconhecimento, ofertas, acordo, pagamentos, casos e mensagens por
// canal (whatsapp_messages). Documento SEMPRE mascarado.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { maskDocument } from "@/lib/journey/document"
import { maskName } from "@/lib/negotiation/pii"
import { agreementCard, type AgreementCardView } from "@/lib/journey/history"

export interface TimelineEvent {
  id: number
  event_type: string
  actor: string // procedência: system|customer|ai|n8n|provider|admin
  occurred_at: string
  session_id: string | null
  campaign_id: string | null
}

export interface TranscriptMessage {
  id: string
  role: string
  text: string
  engine: string | null
  created_at: string
}

export interface OfferView {
  id: string
  status: string
  source: string
  terms: unknown
  valid_until: string | null
  presented_at: string
}

export interface CaseView {
  id: string
  type: string
  status: string
  resolution: string | null
  created_at: string
  resolved_at: string | null
}

export interface PaymentView {
  id: string
  amount: number | null
  due_date: string | null
  payment_date: string | null
  status: string | null
}

export interface ChannelMessageView {
  id: string
  channel: string | null
  status: string | null
  provider_status_source: string | null
  created_at: string
}

export interface AckDetail {
  acknowledged: boolean
  created_at: string
}

export interface NegotiationDetail {
  found: boolean
  nameMasked: string
  documentMasked: string
  cedente: string | null
  stage: string
  stageAt: string | null
  channel: string | null
  hasLiveCharge: boolean
  providerStatusSource: string
  timeline: TimelineEvent[]
  transcript: TranscriptMessage[]
  acknowledgement: AckDetail | null
  offers: OfferView[]
  agreement: AgreementCardView | null
  payments: PaymentView[]
  cases: CaseView[]
  channelMessages: ChannelMessageView[]
}

export async function queryNegotiationDetail(
  companyId: string,
  customerId: string,
): Promise<NegotiationDetail> {
  const supabase = createServiceClient()

  const [
    { data: state },
    { data: customer },
    { data: company },
    { data: timeline },
    { data: offers },
    { data: cases },
  ] = await Promise.all([
    (supabase as any)
      .from("negotiation_state")
      .select("stage, stage_at, channel, agreement_id, has_live_charge, provider_status_source")
      .eq("company_id", companyId)
      .eq("customer_id", customerId)
      .maybeSingle(),
    (supabase as any).from("customers").select("name, document").eq("id", customerId).maybeSingle(),
    (supabase as any).from("companies").select("name").eq("id", companyId).maybeSingle(),
    (supabase as any)
      .from("journey_events")
      .select("id, event_type, actor, occurred_at, session_id, campaign_id")
      .eq("company_id", companyId)
      .eq("customer_id", customerId)
      .order("occurred_at", { ascending: true })
      .limit(500),
    (supabase as any)
      .from("negotiation_offers")
      .select("id, status, source, terms, valid_until, presented_at")
      .eq("company_id", companyId)
      .eq("customer_id", customerId)
      .order("presented_at", { ascending: true }),
    (supabase as any)
      .from("negotiation_cases")
      .select("id, type, status, resolution, created_at, resolved_at")
      .eq("company_id", companyId)
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false }),
  ])

  if (!customer) {
    return {
      found: false,
      nameMasked: "***",
      documentMasked: "***",
      cedente: company?.name ?? null,
      stage: "not_started",
      stageAt: null,
      channel: null,
      hasLiveCharge: false,
      providerStatusSource: "none",
      timeline: [],
      transcript: [],
      acknowledgement: null,
      offers: [],
      agreement: null,
      payments: [],
      cases: [],
      channelMessages: [],
    }
  }

  // sessões do devedor → transcrição + reconhecimento + mensagens por canal
  const { data: sessions } = await (supabase as any)
    .from("negotiation_sessions")
    .select("id")
    .eq("company_id", companyId)
    .eq("customer_id", customerId)
    .order("created_at", { ascending: true })
    .limit(50)
  const sessionIds = ((sessions ?? []) as Array<{ id: string }>).map((s) => s.id)

  let transcript: TranscriptMessage[] = []
  let acknowledgement: AckDetail | null = null
  if (sessionIds.length) {
    const [{ data: msgs }, { data: ack }] = await Promise.all([
      (supabase as any)
        .from("chat_messages")
        .select("id, role, text, engine, created_at, session_id")
        .in("session_id", sessionIds)
        .order("created_at", { ascending: true })
        .limit(500),
      (supabase as any)
        .from("debt_acknowledgement_latest")
        .select("acknowledged, created_at")
        .in("session_id", sessionIds)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ])
    transcript = (msgs ?? []) as TranscriptMessage[]
    acknowledgement = (ack as AckDetail | null) ?? null
  }

  // mensagens por canal (whatsapp_messages). O "canal" desta tabela é o provider
  // (voxuy/mock) — não há coluna `channel` aqui; mapeamos provider→channel.
  const { data: waMsgs } = await (supabase as any)
    .from("whatsapp_messages")
    .select("id, provider, status, provider_status_source, created_at")
    .eq("company_id", companyId)
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false })
    .limit(100)

  // pagamentos do devedor (via agreements do devedor)
  const { data: agrs } = await (supabase as any)
    .from("agreements")
    .select("id")
    .eq("company_id", companyId)
    .eq("customer_id", customerId)
    .limit(200)
  const agreementIds = ((agrs ?? []) as Array<{ id: string }>).map((a) => a.id)
  let payments: PaymentView[] = []
  if (agreementIds.length) {
    const { data: pays } = await (supabase as any)
      .from("payments")
      .select("id, amount, due_date, payment_date, status")
      .in("agreement_id", agreementIds)
      .order("due_date", { ascending: true })
      .limit(300)
    payments = ((pays ?? []) as any[]).map((p) => ({
      id: p.id,
      amount: p.amount != null ? Number(p.amount) : null,
      due_date: p.due_date ?? null,
      payment_date: p.payment_date ?? null,
      status: p.status ?? null,
    }))
  }

  const agreement = state?.agreement_id
    ? await agreementCard(state.agreement_id, companyId)
    : null

  return {
    found: true,
    nameMasked: maskName(customer.name),
    documentMasked: maskDocument(customer.document),
    cedente: company?.name ?? null,
    stage: state?.stage ?? "not_started",
    stageAt: state?.stage_at ?? null,
    channel: state?.channel ?? null,
    hasLiveCharge: !!state?.has_live_charge,
    providerStatusSource: state?.provider_status_source ?? "none",
    timeline: (timeline ?? []) as TimelineEvent[],
    transcript,
    acknowledgement,
    offers: (offers ?? []) as OfferView[],
    agreement,
    payments,
    cases: (cases ?? []) as CaseView[],
    channelMessages: ((waMsgs ?? []) as Array<Record<string, unknown>>).map((m) => ({
      id: m.id as string,
      channel: (m.provider as string | null) ?? null,
      status: (m.status as string | null) ?? null,
      provider_status_source: (m.provider_status_source as string | null) ?? null,
      created_at: m.created_at as string,
    })),
  }
}
