// POST /api/negotiation/handoff — cria negotiation_session + token opaco.
// Interno (server-to-server): mesmo x-agent-token do WS-5. Chamado pelo worker
// de WhatsApp e por ferramentas internas; nunca pelo browser.

import { NextResponse } from "next/server"
import { z } from "zod"

import { createHandoffSession } from "@/lib/negotiation/sessions"

export const dynamic = "force-dynamic"

const bodySchema = z.object({
  company_id: z.string().uuid(),
  customer_id: z.string().uuid().nullish(),
  debt_id: z.string().uuid().nullish(),
  document: z.string().min(3),
  channel_origin: z.enum(["whatsapp", "direct", "mock"]),
  frontend_mode: z.enum(["alteapay", "whitelabel"]).optional(),
  identity_verified: z.boolean().optional(),
  debt_acknowledged: z.boolean().optional(),
})

export async function POST(request: Request) {
  const expected = process.env.AGENT_APP_TOKEN
  if (!expected) {
    return NextResponse.json({ success: false, error: "AGENT_APP_TOKEN não configurado" }, { status: 503 })
  }
  if (request.headers.get("x-agent-token") !== expected) {
    return NextResponse.json({ success: false, error: "não autorizado" }, { status: 401 })
  }

  let parsed
  try {
    parsed = bodySchema.safeParse(await request.json())
  } catch {
    return NextResponse.json({ success: false, error: "JSON inválido" }, { status: 400 })
  }
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: parsed.error.message }, { status: 422 })
  }

  try {
    const { session, token, deep_link } = await createHandoffSession(parsed.data)
    return NextResponse.json({
      success: true,
      session_id: session.id,
      thread_id: session.thread_id,
      frontend_mode: session.frontend_mode,
      token, // em claro UMA única vez; só o hash persiste
      deep_link,
      expires_at: session.token_expires_at,
    })
  } catch (err) {
    console.error("[negotiation:handoff]", err instanceof Error ? err.message : err)
    return NextResponse.json({ success: false, error: "falha ao criar sessão" }, { status: 500 })
  }
}
