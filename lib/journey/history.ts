// Leitura de histórico da jornada (N6). Duas visões:
//   - customerHistory: para a área do cliente (só a própria sessão, mascarado).
//   - adminSessions/adminSessionDetail: para o painel super-admin (com o
//     n8n_execution_id por turno; documento SEMPRE mascarado).
// Toda leitura é server-side com service role; NUNCA devolve documento em claro.

import { createServiceClient } from "@/lib/supabase/service"
import { maskDocument } from "./document"
import { maskName } from "@/lib/negotiation/pii"

export interface ChatMessageView {
  id: string
  role: "customer" | "assistant" | "system"
  text: string
  button_id: number | null
  prompt_id: string | null
  n8n_execution_id: string | null
  engine: string | null
  latency_ms: number | null
  created_at: string
}

export interface PromptView {
  id: string
  kind: string
  question: string
  buttons: Array<{ id: number; label: string; value?: string }>
  status: string
  answered_button_id: number | null
  answered_value: string | null
  answered_at: string | null
  created_by: string
  n8n_execution_id: string | null
  created_at: string
}

export interface AckView {
  acknowledged: boolean
  button_id: number
  created_at: string
}

export interface AgreementCardView {
  id: string
  total_value: number | null
  discount_amount: number | null
  discount_percentage: number | null
  installments: number | null
  installment_amount: number | null
  first_due_date: string | null
  billing_type: string | null
  status: string | null
  payment_status: string | null
  proposal_valid_until: string | null
  invoice_url: string | null
  pix_copy_paste: string | null
  boleto_url: string | null
}

/** Cartão do acordo a partir das COLUNAS REAIS de agreements. */
export async function agreementCard(
  agreementId: string,
  companyId: string,
): Promise<AgreementCardView | null> {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from("agreements")
    .select(
      "id, agreed_amount, discount_amount, discount_percentage, installments, installment_amount, due_date, asaas_billing_type, status, payment_status, proposal_valid_until, asaas_invoice_url, asaas_payment_url, asaas_pix_qrcode_url, asaas_boleto_url",
    )
    .eq("id", agreementId)
    .eq("company_id", companyId)
    .maybeSingle()
  if (!data) return null
  return {
    id: data.id,
    total_value: data.agreed_amount != null ? Number(data.agreed_amount) : null,
    discount_amount: data.discount_amount != null ? Number(data.discount_amount) : null,
    discount_percentage: data.discount_percentage != null ? Number(data.discount_percentage) : null,
    installments: data.installments ?? null,
    installment_amount: data.installment_amount != null ? Number(data.installment_amount) : null,
    first_due_date: data.due_date ?? null,
    billing_type: data.asaas_billing_type ?? null,
    status: data.status ?? null,
    payment_status: data.payment_status ?? null,
    proposal_valid_until: data.proposal_valid_until ?? null,
    invoice_url: data.asaas_invoice_url ?? data.asaas_payment_url ?? null,
    pix_copy_paste: data.asaas_pix_qrcode_url ?? null,
    boleto_url: data.asaas_boleto_url ?? null,
  }
}

export interface CustomerHistory {
  messages: ChatMessageView[]
  agreement: AgreementCardView | null
}

/** Histórico da PRÓPRIA sessão do cliente (chat + acordo). Sem PII em claro. */
export async function customerHistory(sessionId: string, companyId: string): Promise<CustomerHistory> {
  const supabase = createServiceClient()
  const { data: msgs } = await supabase
    .from("chat_messages")
    .select("id, role, text, button_id, prompt_id, n8n_execution_id, engine, latency_ms, created_at")
    .eq("session_id", sessionId)
    .eq("company_id", companyId)
    .order("created_at", { ascending: true })
    .limit(200)
  const { data: session } = await supabase
    .from("negotiation_sessions")
    .select("agreement_id")
    .eq("id", sessionId)
    .eq("company_id", companyId)
    .maybeSingle()
  const agreement = session?.agreement_id
    ? await agreementCard(session.agreement_id, companyId)
    : null
  return { messages: (msgs ?? []) as ChatMessageView[], agreement }
}

export interface AdminSessionRow {
  id: string
  channel: string | null
  company_id: string
  brand_name: string | null
  customer_masked: string
  customer_name_masked: string
  engine: string | null
  status: string | null
  outcome: string | null
  created_at: string
  last_activity_at: string | null
  closed_at: string | null
  duration_seconds: number | null
  agreement_id: string | null
}

/** Lista de sessões para o painel super-admin. Documento e nome mascarados. */
export async function adminSessions(filter: {
  outcome?: string
  channel?: string
  limit?: number
}): Promise<AdminSessionRow[]> {
  const supabase = createServiceClient()
  let q = supabase
    .from("negotiation_sessions")
    .select(
      "id, company_id, customer_id, channel, engine, status, outcome, created_at, last_activity_at, closed_at, agreement_id",
    )
    .order("created_at", { ascending: false })
    .limit(filter.limit ?? 100)
  if (filter.outcome) q = q.eq("outcome", filter.outcome)
  if (filter.channel) q = q.eq("channel", filter.channel)
  const { data: sessions } = await q
  const rows = sessions ?? []

  // resolve nomes de empresa e clientes em lote (mascarados na saída)
  const companyIds = Array.from(new Set(rows.map((r) => r.company_id)))
  const customerIds = Array.from(new Set(rows.map((r) => r.customer_id).filter(Boolean))) as string[]
  const [{ data: companies }, { data: customers }] = await Promise.all([
    companyIds.length
      ? supabase.from("companies").select("id, name").in("id", companyIds)
      : Promise.resolve({ data: [] as Array<{ id: string; name: string }> }),
    customerIds.length
      ? supabase.from("customers").select("id, name, document").in("id", customerIds)
      : Promise.resolve({ data: [] as Array<{ id: string; name: string; document: string }> }),
  ])
  const companyById = new Map((companies ?? []).map((c) => [c.id, c.name]))
  const customerById = new Map((customers ?? []).map((c) => [c.id, c]))

  return rows.map((r) => {
    const cust = r.customer_id ? customerById.get(r.customer_id) : null
    const start = new Date(r.created_at).getTime()
    const end = r.closed_at
      ? new Date(r.closed_at).getTime()
      : r.last_activity_at
        ? new Date(r.last_activity_at).getTime()
        : null
    return {
      id: r.id,
      channel: r.channel,
      company_id: r.company_id,
      brand_name: companyById.get(r.company_id) ?? null,
      customer_masked: cust ? maskDocument(cust.document) : "***",
      customer_name_masked: cust ? maskName(cust.name) : "***",
      engine: r.engine,
      status: r.status,
      outcome: r.outcome,
      created_at: r.created_at,
      last_activity_at: r.last_activity_at,
      closed_at: r.closed_at,
      duration_seconds: end ? Math.max(0, Math.round((end - start) / 1000)) : null,
      agreement_id: r.agreement_id,
    }
  })
}

export interface AdminSessionDetail {
  session: AdminSessionRow | null
  messages: ChatMessageView[]
  offers: Array<{ id: string; status: string; terms: unknown; valid_until: string | null }>
  prompts: PromptView[]
  acknowledgement: AckView | null
  agreement: AgreementCardView | null
}

/** Detalhe de uma sessão para o painel: transcrição + n8n_execution_id + botões +
 * prompts + reconhecimento em destaque + ofertas + acordo. */
export async function adminSessionDetail(sessionId: string): Promise<AdminSessionDetail> {
  const supabase = createServiceClient()
  const { data: session } = await supabase
    .from("negotiation_sessions")
    .select(
      "id, company_id, customer_id, channel, engine, status, outcome, created_at, last_activity_at, closed_at, agreement_id",
    )
    .eq("id", sessionId)
    .maybeSingle()
  if (!session) return { session: null, messages: [], offers: [], prompts: [], acknowledgement: null, agreement: null }

  const [{ data: msgs }, { data: offers }, { data: prompts }, { data: ack }, { data: company }, { data: customer }] =
    await Promise.all([
      supabase
        .from("chat_messages")
        .select("id, role, text, button_id, prompt_id, n8n_execution_id, engine, latency_ms, created_at")
        .eq("session_id", sessionId)
        .order("created_at", { ascending: true })
        .limit(500),
      supabase
        .from("negotiation_offers")
        .select("id, status, terms, valid_until")
        .eq("session_id", sessionId)
        .order("created_at", { ascending: true }),
      supabase
        .from("chat_prompts")
        .select("id, kind, question, buttons, status, answered_button_id, answered_value, answered_at, created_by, n8n_execution_id, created_at")
        .eq("session_id", sessionId)
        .order("created_at", { ascending: true }),
      supabase
        .from("debt_acknowledgement_latest")
        .select("acknowledged, button_id, created_at")
        .eq("session_id", sessionId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase.from("companies").select("name").eq("id", session.company_id).maybeSingle(),
      session.customer_id
        ? supabase.from("customers").select("name, document").eq("id", session.customer_id).maybeSingle()
        : Promise.resolve({ data: null as { name: string; document: string } | null }),
    ])

  const start = new Date(session.created_at).getTime()
  const end = session.closed_at
    ? new Date(session.closed_at).getTime()
    : session.last_activity_at
      ? new Date(session.last_activity_at).getTime()
      : null
  const detailRow: AdminSessionRow = {
    id: session.id,
    channel: session.channel,
    company_id: session.company_id,
    brand_name: company?.name ?? null,
    customer_masked: customer ? maskDocument(customer.document) : "***",
    customer_name_masked: customer ? maskName(customer.name) : "***",
    engine: session.engine,
    status: session.status,
    outcome: session.outcome,
    created_at: session.created_at,
    last_activity_at: session.last_activity_at,
    closed_at: session.closed_at,
    duration_seconds: end ? Math.max(0, Math.round((end - start) / 1000)) : null,
    agreement_id: session.agreement_id,
  }

  const agreement = session.agreement_id
    ? await agreementCard(session.agreement_id, session.company_id)
    : null

  return {
    session: detailRow,
    messages: (msgs ?? []) as ChatMessageView[],
    offers: (offers ?? []) as AdminSessionDetail["offers"],
    prompts: (prompts ?? []) as PromptView[],
    acknowledgement: (ack as AckView | null) ?? null,
    agreement,
  }
}
