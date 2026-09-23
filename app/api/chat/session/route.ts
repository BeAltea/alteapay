// Rotas da sessão do devedor (F3.5/F3.7), consumidas pelo frontend /c/[token].
// Sessão pelo cookie JWT (mesmo esquema do chatbot). Ações:
//   GET  ?action=summary|offers        → resumo da dívida / ofertas da matriz
//   POST { action: "message", text }   → turno do chat (engine disabled|n8n|agent)
//   POST { action: "accept", offerId } → passo 1: resumo do aceite
//   POST { action: "confirm", offerId, termsHash } → passo 2: fecha + cobra
//   POST { action: "reject"|"dispute"|"payment_claim"|"human_transfer", ... }
import { NextRequest, NextResponse } from "next/server"
import { verifyChatJwt, CHAT_COOKIE_NAME } from "@/lib/negotiation/crypto"
import { runChatbotTurn } from "@/lib/negotiation/turn"
import { createServiceClient } from "@/lib/supabase/service"
import {
  loadSessionCtx, debtSummary, listOffers, rejectOffer,
  registerDispute, registerPaymentClaim, transferToHuman,
} from "@/lib/journey/actions"
import { buildAcceptSummary } from "@/lib/journey/closing"
import { acceptMatrixCondition } from "@/lib/journey/assisted"

export const dynamic = "force-dynamic"

function clientIp(req: NextRequest): string | null {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null
}

async function sessionFromCookie(req: NextRequest) {
  if (process.env.CHAT_JOURNEY_ENABLED !== "true") return null
  const cookie = req.cookies.get(CHAT_COOKIE_NAME)?.value
  if (!cookie) return null
  const claims = verifyChatJwt(cookie)
  if (!claims) return null
  return loadSessionCtx(claims.sid)
}

export async function GET(req: NextRequest) {
  const ctx = await sessionFromCookie(req)
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  const action = req.nextUrl.searchParams.get("action")
  if (action === "summary") return NextResponse.json({ ok: true, summary: await debtSummary(ctx) })
  if (action === "offers") return NextResponse.json({ ok: true, offers: await listOffers(ctx) })
  return NextResponse.json({ error: "ação inválida" }, { status: 400 })
}

export async function POST(req: NextRequest) {
  const ctx = await sessionFromCookie(req)
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  const body = await req.json().catch(() => ({} as Record<string, unknown>))
  const action = String(body.action ?? "")
  const ip = clientIp(req)

  switch (action) {
    case "message": {
      const supabase = createServiceClient()
      const { data: session } = await supabase
        .from("negotiation_sessions").select("*").eq("id", ctx.sessionId).single()
      const result = await runChatbotTurn(session, String(body.text ?? ""), "webchat")
      return NextResponse.json({ ok: true, reply: result.reply, action: result.action })
    }
    case "accept": {
      const pre = await buildAcceptSummary(ctx, String(body.offerId ?? ""))
      if (!pre.ok) return NextResponse.json({ ok: false, error: pre.error }, { status: 409 })
      return NextResponse.json({ ok: true, summary: pre.summary })
    }
    case "confirm": {
      const offerId = String(body.offerId ?? "")
      // Passo 2 (2-passos F3.7): revalida os termos que o cliente confirmou. Se a
      // oferta mudou/expirou desde o resumo → TERMS_CHANGED/OFFER_* (409). Preserva
      // o guard de integridade antes de delegar ao caminho de cobrança compartilhado.
      const pre = await buildAcceptSummary(ctx, offerId)
      if (!pre.ok) return NextResponse.json({ ok: false, error: pre.error }, { status: 409 })
      if (pre.summary.termsHash !== String(body.termsHash ?? "")) {
        return NextResponse.json({ ok: false, error: "TERMS_CHANGED" }, { status: 409 })
      }
      // Aceite assistido → MESMO payment.create interno (matriz 422 / ack 409 /
      // guard already_charged → link existente / closeAgreement+charge-inline).
      const r = await acceptMatrixCondition(ctx, offerId)
      if (!r.ok) return NextResponse.json({ ok: false, error: r.code, code: r.code }, { status: r.status })
      if (r.status === "already_charged") {
        return NextResponse.json({ ok: true, status: "already_charged", payment: r.payment })
      }
      if (r.status === "processing") {
        return NextResponse.json({ ok: true, status: "processing", agreementId: r.agreementId })
      }
      return NextResponse.json({ ok: true, status: "created", agreementId: r.agreementId, payment: r.payment })
    }
    case "reject":
      await rejectOffer(ctx, String(body.offerId ?? ""), "customer", body.reason as string | undefined)
      return NextResponse.json({ ok: true })
    case "dispute": {
      const id = await registerDispute(ctx, { note: String(body.note ?? "") }, "customer")
      return NextResponse.json({ ok: true, caseId: id })
    }
    case "payment_claim": {
      const id = await registerPaymentClaim(ctx, {
        paidAt: body.paidAt as string | undefined,
        amount: body.amount as number | undefined,
        channel: body.channel as string | undefined,
        note: body.note as string | undefined,
      }, "customer")
      return NextResponse.json({ ok: true, caseId: id })
    }
    case "human_transfer": {
      const id = await transferToHuman(ctx, String(body.reason ?? "solicitado"), "customer")
      return NextResponse.json({ ok: true, caseId: id })
    }
    default:
      return NextResponse.json({ error: "ação inválida" }, { status: 400 })
  }
}
