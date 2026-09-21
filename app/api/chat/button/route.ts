// POST /api/chat/button (onda R) — clique num prompt de botões.
// Body: { prompt_id, button_id }. Sessão pelo cookie JWT httpOnly.
//
// Fluxo:
//  - integridade do clique (§2.3): prompt da sessão + ativo + botão existe,
//    senão 409 prompt_not_active / 404 prompt_not_found / 409 button_invalid;
//  - se o prompt é debt_acknowledgement → recordAcknowledgement grava os 4
//    efeitos e (Não/[99]) aplica on_debt_not_recognized (continue|dispute|human);
//  - senão → answerPrompt (marca answered + grava a mensagem do cliente);
//  - engine ativa (n8n) → envia um turno de BOTÃO ao fluxo (Apêndice A.2) e
//    devolve o reply; engine disabled → próxima etapa determinística (sem reply).
import { NextRequest, NextResponse } from "next/server"
import { verifyChatJwt, CHAT_COOKIE_NAME } from "@/lib/negotiation/crypto"
import { loadSessionCtx, registerDispute, transferToHuman } from "@/lib/journey/actions"
import { getPrompt, answerPrompt } from "@/lib/journey/prompts"
import { recordAcknowledgement, startN8nNegotiation } from "@/lib/journey/acknowledgement"
import { engineName } from "@/lib/negotiation/engine"
import { BTN_HANDOFF } from "@/lib/journey/buttons"

export const dynamic = "force-dynamic"
export const maxDuration = 60

function clientIp(req: NextRequest): string | null {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null
}

export async function POST(req: NextRequest) {
  if (process.env.CHAT_JOURNEY_ENABLED !== "true") {
    return NextResponse.json({ error: "not found" }, { status: 404 })
  }
  const cookie = req.cookies.get(CHAT_COOKIE_NAME)?.value
  const claims = cookie ? verifyChatJwt(cookie) : null
  if (!claims) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const ctx = await loadSessionCtx(claims.sid)
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const body = await req.json().catch(() => ({} as Record<string, unknown>))
  const promptId = String(body.prompt_id ?? "")
  const buttonId = Number(body.button_id)
  if (!promptId || !Number.isInteger(buttonId)) {
    return NextResponse.json({ error: "prompt_id e button_id obrigatórios" }, { status: 422 })
  }

  const prompt = await getPrompt(promptId, ctx.sessionId)
  if (!prompt) return NextResponse.json({ error: "prompt não encontrado", code: "prompt_not_found" }, { status: 404 })

  const ip = clientIp(req)
  const userAgent = req.headers.get("user-agent")

  // Reconhecimento da dívida: caminho dedicado (4 efeitos + comportamento em "Não").
  if (prompt.kind === "debt_acknowledgement") {
    const res = await recordAcknowledgement({
      companyId: ctx.companyId,
      sessionId: ctx.sessionId,
      customerId: ctx.customerId,
      debtId: ctx.debtId,
      promptId,
      buttonId,
      ip,
      userAgent,
    })
    if (!res.ok) return NextResponse.json({ error: res.code, code: res.code }, { status: res.status })

    // "Não reconheço" ou [99]: aplica on_debt_not_recognized (default continue).
    if (!res.acknowledged) {
      if (res.onNotRecognized === "dispute") {
        await registerDispute(ctx, { source: "debt_not_recognized" }, "customer")
      } else if (res.onNotRecognized === "human") {
        await transferToHuman(ctx, "debt_not_recognized", "customer")
      }
      return NextResponse.json({
        ok: true,
        acknowledged: false,
        button_id: buttonId,
        on_not_recognized: res.onNotRecognized ?? "continue",
      })
    }
    // "Sim, reconheço" (button 1): handoff ao n8n (engine_owner='n8n' + emite
    // negotiation.start). RESILIENTE (H8): se o n8n não estiver plugado, mantém
    // o assistido e o cliente NÃO vê erro. Nunca derruba a resposta do clique.
    let engineOwner: "platform" | "n8n" = "platform"
    try {
      const start = await startN8nNegotiation({
        companyId: ctx.companyId,
        sessionId: ctx.sessionId,
        customerId: ctx.customerId,
        debtId: ctx.debtId,
      })
      engineOwner = start.owner
    } catch (err) {
      console.warn("[chat:button] negotiation.start falhou (fallback assistido):", (err as Error).message)
    }
    return NextResponse.json({ ok: true, acknowledged: true, button_id: buttonId, engine_owner: engineOwner })
  }

  // Handoff genérico ([99]) em qualquer prompt: transfere e responde.
  if (buttonId === BTN_HANDOFF) {
    const answered = await answerPrompt({ sessionId: ctx.sessionId, companyId: ctx.companyId, promptId, buttonId })
    if (!answered.ok) return NextResponse.json({ error: answered.code, code: answered.code }, { status: answered.status })
    await transferToHuman(ctx, "handoff_button", "customer")
    return NextResponse.json({ ok: true, transferred: true, button_id: buttonId })
  }

  // Demais prompts: responde (marca answered + grava a mensagem do cliente).
  const answered = await answerPrompt({ sessionId: ctx.sessionId, companyId: ctx.companyId, promptId, buttonId })
  if (!answered.ok) return NextResponse.json({ error: answered.code, code: answered.code }, { status: answered.status })

  // Engine ativa (n8n): envia um turno de BOTÃO e devolve o reply. Engine
  // disabled: a próxima etapa é determinística (sem reply do n8n).
  if (engineName() === "n8n") {
    try {
      const { runJourneyTurn } = await import("@/lib/journey/chat-turn")
      const label = answered.button.label
      const out = await runJourneyTurn(ctx, label)
      return NextResponse.json({ ok: true, button_id: buttonId, reply: out.reply, offers: out.offers, action: out.action })
    } catch {
      return NextResponse.json({ ok: true, button_id: buttonId })
    }
  }

  return NextResponse.json({ ok: true, button_id: buttonId })
}
