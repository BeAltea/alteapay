// GET /api/negotiation/session/:id/transcript — auditoria (admin/super_admin).
// Por padrão devolve content_redacted; conteúdo integral apenas super_admin
// com ?full=1, com registro de acesso em security_events.

import { NextResponse } from "next/server"

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

  const { data: session } = await supabase
    .from("negotiation_sessions")
    .select("*")
    .eq("id", params.id)
    .maybeSingle()
  if (!session) {
    return NextResponse.json({ success: false, error: "sessão não encontrada" }, { status: 404 })
  }
  if (role !== "super_admin" && session.company_id !== profile?.company_id) {
    return NextResponse.json({ success: false, error: "sem permissão" }, { status: 403 })
  }

  const url = new URL(request.url)
  const wantFull = url.searchParams.get("full") === "1"
  const fullAllowed = wantFull && role === "super_admin"

  if (fullAllowed) {
    // Trilha de acesso ao conteúdo integral (LGPD art. 46 — permissão elevada)
    await supabase
      .from("security_events")
      .insert({
        event_type: "data_access",
        severity: "low",
        user_id: user.id,
        user_email: user.email,
        company_id: session.company_id,
        action: "lgpd_read_full_transcript",
        resource_type: "negotiation_session",
        resource_id: session.id,
        metadata: { requested_at: new Date().toISOString() },
        status: "success",
      })
      .select("id")
  }

  const { data: messages } = await supabase
    .from("conversation_messages")
    .select(
      "id, channel, direction, sender, content, content_redacted, tool_calls, llm_model, prompt_version, provider_message_id, created_at",
    )
    .eq("session_id", session.id)
    .order("created_at", { ascending: true })
    .range(0, 99999)

  return NextResponse.json({
    success: true,
    session: {
      id: session.id,
      company_id: session.company_id,
      channel_origin: session.channel_origin,
      frontend_mode: session.frontend_mode,
      fulfillment_mode: session.fulfillment_mode,
      outcome: session.outcome,
      identity_verified_at: session.identity_verified_at,
      debt_acknowledged_at: session.debt_acknowledged_at,
      consent_lgpd_at: session.consent_lgpd_at,
      consent_lgpd_version: session.consent_lgpd_version,
      agreement_id: session.agreement_id,
      created_at: session.created_at,
    },
    full_content: fullAllowed,
    messages: (messages ?? []).map((m) => ({
      id: m.id,
      channel: m.channel,
      direction: m.direction,
      sender: m.sender,
      content: fullAllowed ? m.content : (m.content_redacted ?? m.content),
      tool_calls: m.tool_calls,
      llm_model: m.llm_model,
      prompt_version: m.prompt_version,
      created_at: m.created_at,
    })),
  })
}
