// Estado do pagamento do acordo da sessão (F3.7): a UI faz polling enquanto o
// worker gera a cobrança no ASAAS. Lê SÓ as colunas reais de agreements.
import { NextRequest, NextResponse } from "next/server"
import { verifyChatJwt, CHAT_COOKIE_NAME } from "@/lib/negotiation/crypto"
import { createServiceClient } from "@/lib/supabase/service"
import { recordEvent } from "@/lib/journey/events"

export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  if (process.env.CHAT_JOURNEY_ENABLED !== "true") {
    return NextResponse.json({ error: "not found" }, { status: 404 })
  }
  const cookie = req.cookies.get(CHAT_COOKIE_NAME)?.value
  const claims = cookie ? verifyChatJwt(cookie) : null
  if (!claims) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const supabase = createServiceClient()
  const { data: session } = await supabase
    .from("negotiation_sessions")
    .select("id, company_id, customer_id, debt_id, agreement_id")
    .eq("id", claims.sid)
    .single()
  if (!session?.agreement_id) {
    return NextResponse.json({ ok: true, status: "generating" })
  }
  const { data: ag } = await supabase
    .from("agreements")
    .select("id, asaas_payment_id, asaas_billing_type, payment_status, asaas_status, asaas_payment_url, asaas_invoice_url, asaas_boleto_url, asaas_pix_qrcode_url, installments, installment_amount, agreed_amount, due_date")
    .eq("id", session.agreement_id)
    .single()
  if (!ag?.asaas_payment_id) {
    return NextResponse.json({ ok: true, status: "generating" })
  }
  await recordEvent({
    companyId: session.company_id, customerId: session.customer_id, debtId: session.debt_id,
    sessionId: session.id, agreementId: ag.id, type: "payment.viewed", actor: "customer",
    eventId: `payment-viewed-ui-${ag.id}`,
  })
  return NextResponse.json({
    ok: true, status: "ready",
    payment: {
      billingType: ag.asaas_billing_type,
      pixQrCodeUrl: ag.asaas_pix_qrcode_url,
      boletoUrl: ag.asaas_boleto_url,
      invoiceUrl: ag.asaas_invoice_url ?? ag.asaas_payment_url,
      installments: ag.installments,
      installmentAmount: ag.installment_amount,
      total: ag.agreed_amount,
      dueDate: ag.due_date,
    },
  })
}
