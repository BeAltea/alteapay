// GET /api/negotiation/session/:id/transcript — auditoria (admin/super_admin).
//
// A2: lê de `chat_messages` (runtime atual da jornada), não da tabela legada
// `conversation_messages`. A2.3: devolve transcript COM CONTEXTO — cabeçalho
// (devedor mascarado, empresa, canal, engine, início, duração, desfecho,
// session_id/campaign_id), timeline cronológica (mensagens + eventos + cliques
// de botão), rodapé (acordo + casos). Sessão sem mensagem NÃO abre vazia: devolve
// uma explicação objetiva. O n8n_execution_id vem no item da timeline e a UI só o
// exibe para super_admin.
//
// `?scope=customer` consolida TODAS as sessões do mesmo (company_id, customer_id)
// num único transcript (Ação "Transcript consolidado" da lista por devedor).
// Documento SEMPRE mascarado; o conteúdo já é redigido na origem.

import { NextResponse } from "next/server"

import { agreementCard } from "@/lib/journey/history"
import { maskDocument } from "@/lib/journey/document"
import { maskName } from "@/lib/negotiation/pii"
import {
  buildTimeline,
  emptySessionExplanation,
  humanDuration,
  type TranscriptEventInput,
  type TranscriptMessageInput,
} from "@/lib/negotiation/transcript-context"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"

export const dynamic = "force-dynamic"

export async function GET(request: Request, { params }: { params: { id: string } }) {
  const supabaseAuth = await createClient()
  const {
    data: { user },
  } = await supabaseAuth.auth.getUser()
  if (!user) {
    return NextResponse.json({ success: false, error: "não autenticado" }, { status: 401 })
  }

  const supabase = createServiceClient()
  const { data: profile } = await supabase
    .from("profiles")
    .select("role, company_id")
    .eq("id", user.id)
    .maybeSingle()
  const role = profile?.role
  if (role !== "admin" && role !== "super_admin" && role !== "viewer") {
    return NextResponse.json({ success: false, error: "sem permissão" }, { status: 403 })
  }

  const url = new URL(request.url)
  const scopeCustomer = url.searchParams.get("scope") === "customer"

  // Sessão de entrada (âncora). No modo consolidado, serve para achar o devedor.
  const { data: anchor } = await supabase
    .from("negotiation_sessions")
    .select(
      "id, company_id, customer_id, channel, channel_origin, engine, outcome, identity_verified_at, debt_acknowledged_at, consent_lgpd_at, agreement_id, last_activity_at, closed_at, created_at",
    )
    .eq("id", params.id)
    .maybeSingle()
  if (!anchor) {
    return NextResponse.json({ success: false, error: "sessão não encontrada" }, { status: 404 })
  }
  if (role !== "super_admin" && anchor.company_id !== profile?.company_id) {
    return NextResponse.json({ success: false, error: "sem permissão" }, { status: 403 })
  }

  // Conjunto de sessões a transcrever: só a âncora, ou todas do devedor.
  type SessionRow = typeof anchor
  let sessions: SessionRow[] = [anchor]
  if (scopeCustomer && anchor.customer_id) {
    const { data: rows } = await supabase
      .from("negotiation_sessions")
      .select(
        "id, company_id, customer_id, channel, channel_origin, engine, outcome, identity_verified_at, debt_acknowledged_at, consent_lgpd_at, agreement_id, last_activity_at, closed_at, created_at",
      )
      .eq("company_id", anchor.company_id)
      .eq("customer_id", anchor.customer_id)
      .order("created_at", { ascending: true })
      .range(0, 999)
    if (rows?.length) sessions = rows as SessionRow[]
  }
  const sessionIds = sessions.map((s) => s.id)

  // Trilha de acesso (LGPD art. 46) — abrir o conteúdo integral de conversa.
  await supabase
    .from("security_events")
    .insert({
      event_type: "data_access",
      severity: "low",
      user_id: user.id,
      user_email: user.email,
      company_id: anchor.company_id,
      action: scopeCustomer ? "read_customer_transcript" : "read_session_transcript",
      resource_type: "negotiation_session",
      resource_id: anchor.id,
      metadata: { requested_at: new Date().toISOString(), sessions: sessionIds.length },
      status: "success",
    })
    .select("id")

  // Cabeçalho: empresa + devedor mascarado + campanha (via journey_events).
  const [{ data: company }, { data: customer }] = await Promise.all([
    supabase.from("companies").select("name").eq("id", anchor.company_id).maybeSingle(),
    anchor.customer_id
      ? supabase.from("customers").select("name, document").eq("id", anchor.customer_id).maybeSingle()
      : Promise.resolve({ data: null as { name: string; document: string } | null }),
  ])

  // Mensagens + eventos de TODAS as sessões do conjunto, em lote.
  const messages: TranscriptMessageInput[] = []
  const events: TranscriptEventInput[] = []
  let campaignId: string | null = null
  for (let i = 0; i < sessionIds.length; i += 200) {
    const slice = sessionIds.slice(i, i + 200)
    const [{ data: msgs }, { data: evs }] = await Promise.all([
      supabase
        .from("chat_messages")
        .select("id, role, text, button_id, prompt_id, n8n_execution_id, engine, latency_ms, created_at")
        .in("session_id", slice)
        .order("created_at", { ascending: true })
        .range(0, 99999),
      supabase
        .from("journey_events")
        .select("id, event_type, actor, occurred_at, payload, campaign_id")
        .in("session_id", slice)
        .order("occurred_at", { ascending: true })
        .range(0, 99999),
    ])
    for (const m of msgs ?? []) messages.push(m as TranscriptMessageInput)
    for (const e of evs ?? []) {
      events.push({
        id: e.id,
        event_type: e.event_type,
        actor: e.actor,
        occurred_at: e.occurred_at,
        payload: e.payload as Record<string, unknown> | null,
      })
      if (!campaignId && e.campaign_id) campaignId = e.campaign_id
    }
  }

  const timeline = buildTimeline(messages, events)

  // Rodapé: cartão do acordo (colunas reais) + casos abertos.
  const agreementId = sessions.map((s) => s.agreement_id).find((a) => a != null) ?? null
  const agreement = agreementId ? await agreementCard(agreementId, anchor.company_id) : null

  let cases: Array<{ id: string; type: string; status: string; created_at: string }> = []
  if (anchor.customer_id) {
    const { data: caseRows } = await supabase
      .from("negotiation_cases")
      .select("id, type, status, created_at")
      .eq("company_id", anchor.company_id)
      .eq("customer_id", anchor.customer_id)
      .order("created_at", { ascending: false })
      .limit(50)
    cases = (caseRows ?? []) as typeof cases
  }

  // Desfecho + início/fim da "conversa" (âncora, ou o span de todas as sessões).
  const startIso = sessions.reduce((min, s) => (s.created_at < min ? s.created_at : min), sessions[0].created_at)
  const endIso = sessions.reduce<string | null>((max, s) => {
    const cand = s.closed_at ?? s.last_activity_at
    if (!cand) return max
    return !max || cand > max ? cand : max
  }, null)

  const emptyExplanation = emptySessionExplanation({
    hasMessages: messages.length > 0,
    identityVerifiedAt: anchor.identity_verified_at,
    createdAt: startIso,
  })

  return NextResponse.json({
    success: true,
    scope: scopeCustomer ? "customer" : "session",
    header: {
      customer_name_masked: customer ? maskName(customer.name) : "***",
      document_masked: customer ? maskDocument(customer.document) : "***",
      company_name: company?.name ?? "—",
      channel: anchor.channel ?? anchor.channel_origin ?? "—",
      engine: anchor.engine,
      started_at: startIso,
      ended_at: endIso,
      duration: humanDuration(startIso, endIso),
      outcome: anchor.outcome,
      session_id: anchor.id,
      session_count: sessionIds.length,
      campaign_id: campaignId,
    },
    empty_explanation: emptyExplanation,
    timeline,
    agreement,
    cases,
  })
}
