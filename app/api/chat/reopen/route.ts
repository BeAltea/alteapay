// POST /api/chat/reopen (onda "3 opções", trilha D1) — re-publica o menu de 3
// opções OU transfere ao atendimento humano SEM depender de um prompt ativo.
//
// PORQUÊ (D2 BLOQUEANTE / M10): as saídas da espera (10s) e o menu de degradação
// (15s) precisam de caminhos REAIS mesmo quando o menu de 3 opções já foi
// consumido (ex.: o devedor clicou "Quero negociar", o prompt ficou answered e
// sumiu). Nesse estado não há prompt ativo para o /api/chat/button responder, e o
// poll não repõe um prompt já respondido — a UI ficava numa tela morta. Esta rota
// re-emite o menu payável (reopenThreeOptions) para que "Pagar à vista"/"Tentar as
// opções de novo" sempre tenham botão real; e faz o handoff direto para "Falar com
// atendimento". Sem prompt_id/button_id — a sessão vem do cookie JWT.
//
// Body: { action: 'reopen_options' | 'handoff' }.
//   - reopen_options → reopenThreeOptions(sessão) → { ok:true, action:'reopen_options', reply }
//   - handoff        → transferToHuman(sessão)     → { ok:true, action:'handoff', transferred:true }
//
// Idempotente: reopenThreeOptions reusa bootstrapThreeOptionsPrompt (não duplica o
// menu se já houver um prompt ativo). NUNCA declara pago, NUNCA cobra aqui.
import { NextRequest, NextResponse } from "next/server"
import { verifyChatJwt, CHAT_COOKIE_NAME } from "@/lib/negotiation/crypto"
import { handlePaymentClaim, loadSessionCtx, transferToHuman } from "@/lib/journey/actions"
import { reopenThreeOptions } from "@/lib/journey/acknowledgement"
import { createServiceClient } from "@/lib/supabase/service"

export const dynamic = "force-dynamic"
export const maxDuration = 60

// A-02: ao re-publicar o menu, a espera acabou → limpa wait_state para o poll
// (rehydrateWait) NÃO re-armar o menu de degradação por cima do menu novo (menu
// duplicado com o n8n fora). Defensivo/não-fatal (coluna M-4 pode não estar aplicada).
async function clearWaitState(sessionId: string): Promise<void> {
  try {
    const supabase = createServiceClient()
    const { error } = await supabase
      .from("negotiation_sessions")
      .update({ wait_state: null, wait_started_at: null })
      .eq("id", sessionId)
    if (error) console.warn("[chat:reopen] clear wait_state não aplicado (coluna M-4 pendente?):", error.message)
  } catch (err) {
    console.warn("[chat:reopen] clear wait_state falhou (defensivo):", (err as Error).message)
  }
}

/**
 * debt_ids/primary_debt_id da sessão (o menu de 3 opções consolida o valor sobre
 * todas as dívidas). Fallback: a dívida primária do ctx quando as colunas estão
 * vazias. Nunca lança — degrada para [ctx.debtId].
 */
async function sessionDebtIds(
  sessionId: string,
  fallbackDebtId: string,
): Promise<{ debtIds: string[]; primaryDebtId: string }> {
  try {
    const supabase = createServiceClient()
    const { data } = await supabase
      .from("negotiation_sessions")
      .select("debt_ids, primary_debt_id, debt_id")
      .eq("id", sessionId)
      .maybeSingle()
    const primaryDebtId =
      (data?.primary_debt_id as string | null) ?? (data?.debt_id as string | null) ?? fallbackDebtId
    const rawIds = (data?.debt_ids as string[] | null) ?? []
    const debtIds = rawIds.length > 0 ? rawIds : [primaryDebtId]
    return { debtIds, primaryDebtId }
  } catch {
    return { debtIds: [fallbackDebtId], primaryDebtId: fallbackDebtId }
  }
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
  const action = String(body.action ?? "reopen_options")

  try {
    if (action === "handoff") {
      await transferToHuman(ctx, "wait_degraded_handoff", "customer")
      return NextResponse.json({ ok: true, action: "handoff", transferred: true })
    }

    // R5 — "Já paguei / enviar comprovante": registra o payment_claim (conferência
    // pela equipe) + persiste a orientação ao devedor SEM declarar pago (D6/M15).
    // NÃO é desfecho terminal (diferente do handoff): reabrimos o menu de 3 opções
    // logo em seguida para o devedor seguir (nunca beco sem saída, M7). O poll
    // seguinte traz a bolha de orientação + o menu de volta.
    if (action === "payment_claim") {
      const claim = await handlePaymentClaim(ctx, "customer")
      const { debtIds: cDebtIds, primaryDebtId: cPrimary } = await sessionDebtIds(ctx.sessionId, ctx.debtId)
      // reabre o menu payável (best-effort — a orientação já foi persistida).
      await reopenThreeOptions({
        companyId: ctx.companyId,
        sessionId: ctx.sessionId,
        customerId: ctx.customerId,
        debtIds: cDebtIds,
        primaryDebtId: cPrimary,
      })
      await clearWaitState(ctx.sessionId)
      return NextResponse.json({
        ok: true, action: "payment_claim", claim_registered: true, case_id: claim.caseId, reply: claim.reply,
      })
    }

    // reopen_options (default): re-publica o menu de 3 opções (payável), M10/M7.
    const { debtIds, primaryDebtId } = await sessionDebtIds(ctx.sessionId, ctx.debtId)
    const back = await reopenThreeOptions({
      companyId: ctx.companyId,
      sessionId: ctx.sessionId,
      customerId: ctx.customerId,
      debtIds,
      primaryDebtId,
    })
    if (!back.ok) {
      return NextResponse.json({ ok: false, code: "reopen_failed", error: "reopen_failed" }, { status: 500 })
    }
    await clearWaitState(ctx.sessionId) // A-02: encerra a espera para não duplicar o menu
    return NextResponse.json({ ok: true, action: "reopen_options", reply: back.reply })
  } catch (err) {
    // Nunca deixa a request morrer sem JSON (o front re-habilita a UI e o poll
    // reconstrói o estado). Rótulo curto, sem PII/segredo.
    console.error("[chat:reopen] falhou:", (err as Error).message)
    return NextResponse.json({ ok: false, code: "reopen_flow_error", error: "reopen_flow_error" }, { status: 500 })
  }
}
