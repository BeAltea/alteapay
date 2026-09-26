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
import {
  BTN_PAYMENT_CLAIM,
  checkEffectDoubleTap,
  DOUBLE_TAP_WINDOW_MS,
  isDoubleTapHandoff,
  isWithinWindow,
  lastCustomerClick,
} from "@/lib/journey/double-tap"
import { getActivePrompt, promptView, type PromptView } from "@/lib/journey/prompts"
import { createServiceClient } from "@/lib/supabase/service"

/** Rótulo do eco do "Já paguei" (o mesmo da afordância na tela). */
const PAYMENT_CLAIM_LABEL = "Já paguei este valor"

/** Prompt ATIVO no shape do GET (null se não houver / falha). Nunca lança. */
async function activePromptView(sessionId: string): Promise<PromptView | null> {
  try {
    return promptView(await getActivePrompt(sessionId))
  } catch {
    return null
  }
}

/**
 * QA round 4 — eco do "Já paguei" (role customer, button_id 96, sem prompt_id),
 * carimbado na época corrente. Best-effort: falha → null (o claim segue).
 */
async function persistClaimEcho(ctx: {
  sessionId: string
  companyId: string
}): Promise<{ id: string; text: string; button_id: number; created_at: string } | null> {
  try {
    const supabase = createServiceClient()
    const { data: sess } = await supabase
      .from("negotiation_sessions")
      .select("thread_epoch")
      .eq("id", ctx.sessionId)
      .eq("company_id", ctx.companyId)
      .maybeSingle()
    const epoch = Number((sess as { thread_epoch?: number | null } | null)?.thread_epoch ?? 0)
    const row: Record<string, unknown> = {
      company_id: ctx.companyId,
      session_id: ctx.sessionId,
      role: "customer",
      text: PAYMENT_CLAIM_LABEL,
      button_id: BTN_PAYMENT_CLAIM,
    }
    if (epoch > 0) row.thread_epoch = epoch
    const { data } = await supabase.from("chat_messages").insert(row).select("id, created_at").single()
    const r = data as { id?: string; created_at?: string } | null
    if (!r?.id) return null
    return { id: r.id, text: PAYMENT_CLAIM_LABEL, button_id: BTN_PAYMENT_CLAIM, created_at: r.created_at ?? new Date().toISOString() }
  } catch (err) {
    console.warn("[chat:reopen] eco do payment_claim falhou (não-fatal):", (err as Error).message)
    return null
  }
}

export const dynamic = "force-dynamic"
export const fetchCache = "force-no-store"
export const revalidate = 0
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

/** QA round 4 (R-16/R-26, S7): `Server-Timing: total` em toda resposta. Sem PII. */
export async function POST(req: NextRequest) {
  const t0 = Date.now()
  const res = await handleReopen(req)
  res.headers.set("Server-Timing", `total;dur=${Date.now() - t0}`)
  return res
}

async function handleReopen(req: NextRequest): Promise<NextResponse> {
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
      // QA round 1 (QAA1-01): um handoff < 2 s depois de um clique válido na
      // sessão é o 2º toque de um toque duplo (o bloco de espera nascia sob o
      // ponteiro). Ignorado: nunca transfere/suprime/encerra por um toque que o
      // devedor não quis dar. O client só faz poll (não reabre o menu).
      const dt = await isDoubleTapHandoff({
        sessionId: ctx.sessionId, companyId: ctx.companyId, customerId: ctx.customerId, debtId: ctx.debtId,
        source: "reopen",
      })
      if (dt.doubleTap) {
        return NextResponse.json({ ok: true, action: "handoff", transferred: false, ignored: "double_tap" })
      }
      await transferToHuman(ctx, "wait_degraded_handoff", "customer")
      return NextResponse.json({ ok: true, action: "handoff", transferred: true })
    }

    // R5 — "Já paguei / enviar comprovante": registra o payment_claim (conferência
    // pela equipe) + persiste a orientação ao devedor SEM declarar pago (D6/M15).
    // NÃO é desfecho terminal (diferente do handoff): reabrimos o menu de 3 opções
    // logo em seguida para o devedor seguir (nunca beco sem saída, M7). O poll
    // seguinte traz a bolha de orientação + o menu de volta.
    if (action === "payment_claim") {
      // QA round 4 (R-11/R-21): toque múltiplo — um "Já paguei" < 2 s depois de
      // um clique VÁLIDO de outro controle da sessão é ignorado (nenhum caso);
      // < 2 s depois de outro "Já paguei" é o MESMO pedido (o caso aberto é
      // reusado e nenhuma bolha nova é gravada). Em ambos devolve o estado atual.
      const last = await lastCustomerClick(ctx.sessionId)
      if (last.buttonId === BTN_PAYMENT_CLAIM && isWithinWindow(last.at, Date.now(), DOUBLE_TAP_WINDOW_MS)) {
        return NextResponse.json({
          ok: true, action: "payment_claim", claim_registered: true, duplicate: true,
          prompt: await activePromptView(ctx.sessionId), state_time: new Date().toISOString(),
        })
      }
      const dt = await checkEffectDoubleTap({
        sessionId: ctx.sessionId, companyId: ctx.companyId, customerId: ctx.customerId, debtId: ctx.debtId,
        buttonId: BTN_PAYMENT_CLAIM, source: "reopen",
      })
      if (dt.doubleTap) {
        return NextResponse.json({
          ok: true, action: "payment_claim", claim_registered: false, ignored: "double_tap",
          prompt: await activePromptView(ctx.sessionId), state_time: new Date().toISOString(),
        })
      }
      // Eco do clique (R-11/R-13): a escolha do devedor fica no histórico ANTES
      // do resultado, com button_id 96 — o guard de toque múltiplo do /button a
      // enxerga (um 2º toque que caia em "Não reconheço" é ignorado).
      const echo = await persistClaimEcho(ctx)
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
      // QA round 4 (R-24/R-13): o corpo É o próximo estado — eco + resultado
      // persistidos (ids reais, o client deduplica com o poll) + o menu ativo.
      return NextResponse.json({
        ok: true, action: "payment_claim", claim_registered: true, case_id: claim.caseId, reply: claim.reply,
        echo,
        outcome: claim.messageId
          ? { id: claim.messageId, text: claim.reply, stage: "payment_claim", created_at: new Date().toISOString() }
          : null,
        prompt: await activePromptView(ctx.sessionId),
        state_time: new Date().toISOString(),
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
    // QA round 4 (R-13): o menu reaberto vai no corpo (o client aplica sem esperar o poll).
    return NextResponse.json({
      ok: true, action: "reopen_options", reply: back.reply,
      prompt: await activePromptView(ctx.sessionId), state_time: new Date().toISOString(),
    })
  } catch (err) {
    // Nunca deixa a request morrer sem JSON (o front re-habilita a UI e o poll
    // reconstrói o estado). Rótulo curto, sem PII/segredo.
    console.error("[chat:reopen] falhou:", (err as Error).message)
    return NextResponse.json({ ok: false, code: "reopen_flow_error", error: "reopen_flow_error" }, { status: 500 })
  }
}
