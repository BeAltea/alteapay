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
import { buildAcceptSummary, confirmAccept } from "@/lib/journey/closing"

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
      const r = await confirmAccept({
        ctx, offerId: String(body.offerId ?? ""), termsHash: String(body.termsHash ?? ""),
        ip, userAgent: req.headers.get("user-agent"),
      })
      if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 409 })
      return NextResponse.json({ ok: true, agreementId: r.agreementId })
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
