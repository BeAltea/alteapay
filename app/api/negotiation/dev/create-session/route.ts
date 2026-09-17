// POST /api/negotiation/dev/create-session — SOMENTE ambiente mock/dev.
// Cria uma sessão channel_origin='mock' para dialogar com o agente sem passar
// pelo WhatsApp. Identity gate permanece ATIVO (usar as identidades sintéticas
// de GET /training/identities do agente).

import { NextResponse } from "next/server"
import { z } from "zod"

import { createHandoffSession } from "@/lib/negotiation/sessions"
import { createServiceClient } from "@/lib/supabase/service"

export const dynamic = "force-dynamic"

function devModeEnabled(): boolean {
  return process.env.MOCK_ALL_INTEGRATIONS === "1" || process.env.NODE_ENV === "development"
}

const bodySchema = z.object({
  company_id: z.string().uuid().optional(),
  debt_id: z.string().uuid().optional(),
  identity_verified: z.boolean().optional(), // simula handoff pré-verificado do WhatsApp
})

export async function POST(request: Request) {
  if (!devModeEnabled()) {
    return NextResponse.json({ success: false, error: "não encontrado" }, { status: 404 })
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: parsed.error.message }, { status: 422 })
  }

  const supabase = createServiceClient()
  let debtQuery = supabase
    .from("debts")
    .select("id, company_id, customer_id, amount, status")
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(1)
  if (parsed.data.debt_id) debtQuery = debtQuery.eq("id", parsed.data.debt_id)
  if (parsed.data.company_id) debtQuery = debtQuery.eq("company_id", parsed.data.company_id)

  const { data: debts } = await debtQuery
  const debt = debts?.[0]
  if (!debt) {
    return NextResponse.json({ success: false, error: "nenhuma dívida pending encontrada" }, { status: 404 })
  }

  const { data: customer } = await supabase
    .from("customers")
    .select("id, name, document")
    .eq("id", debt.customer_id)
    .maybeSingle()
  if (!customer) {
    return NextResponse.json({ success: false, error: "cliente da dívida não encontrado" }, { status: 404 })
  }

  const { session, token, deep_link } = await createHandoffSession({
    company_id: debt.company_id,
    customer_id: customer.id,
    debt_id: debt.id,
    document: customer.document,
    channel_origin: "mock",
    identity_verified: parsed.data.identity_verified ?? false,
  })

  return NextResponse.json({
    success: true,
    session_id: session.id,
    thread_id: session.thread_id,
    deep_link,
    token,
    hint: "identity gate ativo — use GET /training/identities do agente para CPF+data válidos",
  })
}
