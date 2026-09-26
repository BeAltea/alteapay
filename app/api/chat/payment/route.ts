// Estado do pagamento do acordo da sessão (F3.7): a UI faz polling enquanto o
// worker gera a cobrança no ASAAS. Lê SÓ as colunas reais de agreements.
import { NextRequest, NextResponse } from "next/server"
import { verifyChatJwt, CHAT_COOKIE_NAME } from "@/lib/negotiation/crypto"
import { createServiceClient } from "@/lib/supabase/service"
import { isTerminalAgreement } from "@/lib/asaas-idempotency"
import { isPendingCharge, reconcilePendingCharge } from "@/lib/journey/charge-reconcile"

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
  const AGREEMENT_COLS =
    "id, company_id, debt_id, origin, offer_id, negotiation_session_id, created_at, asaas_payment_id, asaas_billing_type, payment_status, asaas_status, status, asaas_payment_url, asaas_invoice_url, asaas_boleto_url, asaas_pix_qrcode_url, installments, installment_amount, agreed_amount, due_date"
  const readAgreement = async () =>
    (await supabase.from("agreements").select(AGREEMENT_COLS).eq("id", session.agreement_id).single()).data
  let ag = await readAgreement()
  if (ag && !ag.asaas_payment_id && isPendingCharge(ag)) {
    // QA rodada 5 (Q2-01): acordo espelhado ANTES do ASAAS e ainda sem cobrança
    // (a request do clique está criando, ou morreu no meio). Reconciliação
    // idempotente pela externalReference: achou → espelha e segue 'ready';
    // órfão vencido sem cobrança → cancelado → 'failed' (o devedor tenta de
    // novo; nenhuma cobrança existe). NUNCA cria cobrança aqui.
    const outcome = await reconcilePendingCharge(ag)
    if (outcome === "linked") ag = await readAgreement()
    if (outcome === "cancelled") {
      return NextResponse.json({ ok: true, status: "failed", reason: "charge_not_created" })
    }
  }
  // Acordo da jornada cancelado SEM nunca ter tido cobrança (órfão reconciliado
  // ou fechamento desfeito por prazo): estado estável 'failed' — o client mostra
  // o erro com "Tentar novamente" em vez de esperar um link que não virá.
  if (ag && !ag.asaas_payment_id && ag.origin === "chat_journey" && isTerminalAgreement(ag)) {
    return NextResponse.json({ ok: true, status: "failed", reason: "charge_not_created" })
  }
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
