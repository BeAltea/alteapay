// GET /api/negotiation/session/status — estado da sessão do cookie + links do
// acordo (as URLs mock do ASAAS são preenchidas async pela fila de charge;
// o frontend consulta aqui após o fechamento até os links existirem).

import { cookies } from "next/headers"
import { NextResponse } from "next/server"

import { CHAT_COOKIE_NAME } from "@/lib/negotiation/crypto"
import { getSessionFromCookie } from "@/lib/negotiation/sessions"
import { createServiceClient } from "@/lib/supabase/service"

export const dynamic = "force-dynamic"

export async function GET() {
  const session = await getSessionFromCookie(cookies().get(CHAT_COOKIE_NAME)?.value)
  if (!session) {
    return NextResponse.json({ success: false, error: "sessão inválida" }, { status: 401 })
  }

  let agreement = null
  if (session.agreement_id) {
    const supabase = createServiceClient()
    const { data } = await supabase
      .from("agreements")
      .select(
        "id, agreed_amount, installments, installment_amount, due_date, status, payment_status, asaas_boleto_url, asaas_pix_qrcode_url, asaas_invoice_url, asaas_payment_url",
      )
      .eq("id", session.agreement_id)
      .eq("company_id", session.company_id)
      .maybeSingle()
    agreement = data ?? null
  }

  return NextResponse.json({
    success: true,
    outcome: session.outcome,
    identity_verified: Boolean(session.identity_verified_at),
    agreement,
  })
}
