// Estado do pagamento do acordo da sessão (F3.7): a UI faz polling enquanto o
// worker gera a cobrança no ASAAS. Lê SÓ as colunas reais de agreements.
import { NextRequest, NextResponse } from "next/server"
import { verifyChatJwt, CHAT_COOKIE_NAME } from "@/lib/negotiation/crypto"
import { createServiceClient } from "@/lib/supabase/service"
import { isTerminalAgreement } from "@/lib/asaas-idempotency"

export const dynamic = "force-dynamic"
export const fetchCache = "force-no-store"
export const revalidate = 0

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
    .select("id, asaas_payment_id, asaas_billing_type, payment_status, asaas_status, status, asaas_payment_url, asaas_invoice_url, asaas_boleto_url, asaas_pix_qrcode_url, installments, installment_amount, agreed_amount, due_date")
    .eq("id", session.agreement_id)
    .single()
  if (!ag?.asaas_payment_id) {
    return NextResponse.json({ ok: true, status: "generating" })
  }
  // A1 / N-D1-2: acordo TERMINAL (cancelado / cobrança deletada / reembolsada)
  // NUNCA é 'ready' — devolver o link morto travava o devedor na "Fatura
  // cancelada". Sem cobrança viva, o estado é o mesmo de "ainda não há link".
  if (isTerminalAgreement(ag)) {
    return NextResponse.json({ ok: true, status: "generating", reason: "no_live_charge" })
  }
  // N-D1-6: o poll NÃO grava payment.viewed (o devedor não abriu o link) — o
  // sinal real é o webhook PAYMENT_CHECKOUT_VIEWED / a reconciliação.
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
