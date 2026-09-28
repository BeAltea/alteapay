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
// Body: { action: 'reopen_options' | 'handoff' | 'payment_claim' | 'pay_now' }.
//   - reopen_options → reopenThreeOptions(sessão) → { ok:true, action:'reopen_options', reply }
//   - handoff        → transferToHuman(sessão)     → { ok:true, action:'handoff', transferred:true }
//   - pay_now        → N87-09: "Pagar agora"/"Pagar à vista" na espera do motor
//                      (aguardando_motor/menu_degradado): reabre o menu e segue
//                      pelo MESMO clique do Pagar do menu (POST /api/chat/button,
//                      button_id 4) — mesma oferta integral, guard duplo e
//                      idempotência. Fora da espera = reopen_options (sem cobrar).
//
// Idempotente: reopenThreeOptions reusa bootstrapThreeOptionsPrompt (não duplica o
// menu se já houver um prompt ativo). NUNCA declara pago; a única cobrança possível
// aqui é a do pay_now, e ela é o próprio caminho do Pagar do menu.
import { NextRequest, NextResponse } from "next/server"
import { verifyChatJwt, CHAT_COOKIE_NAME } from "@/lib/negotiation/crypto"
import { HANDOFF_STAGE, handlePaymentClaim, loadSessionCtx, transferToHumanWithOutcome } from "@/lib/journey/actions"
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
import { BTN_PAY, findButton } from "@/lib/journey/buttons"
import { markEngineSuperseded } from "@/lib/journey/engine-supersede"
import { createServiceClient } from "@/lib/supabase/service"
import { settledReopenBody } from "@/lib/journey/settled-state"
import { afterResponseMode } from "@/lib/journey/after-response"

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
  threadEpoch?: number
}): Promise<{ id: string; text: string; button_id: number; created_at: string } | null> {
  try {
    const supabase = createServiceClient()
    // Latência: a época já vem no contexto da sessão (mesma leitura); sem ela, lê.
    let epoch = ctx.threadEpoch
    if (typeof epoch !== "number") {
      const { data: sess } = await supabase
        .from("negotiation_sessions")
        .select("thread_epoch")
        .eq("id", ctx.sessionId)
        .eq("company_id", ctx.companyId)
        .maybeSingle()
      epoch = Number((sess as { thread_epoch?: number | null } | null)?.thread_epoch ?? 0)
    }
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
  ctx?: { debtIds?: string[]; primaryDebtId?: string | null; debtId: string },
): Promise<{ debtIds: string[]; primaryDebtId: string }> {
  // Latência: debt_ids/primary_debt_id já vieram no contexto (mesma leitura da
  // sessão) → mesma regra, sem nova ida ao banco. ctx.debtId é a coluna debt_id.
  if (ctx && Array.isArray(ctx.debtIds)) {
    const primaryDebtId = ctx.primaryDebtId ?? ctx.debtId ?? fallbackDebtId
    const debtIds = ctx.debtIds.length > 0 ? ctx.debtIds : [primaryDebtId]
    return { debtIds, primaryDebtId }
  }
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
  // pay_now devolve a resposta do /api/chat/button: preserva as etapas da cobrança.
  const prev = res.headers.get("Server-Timing")
  res.headers.set("Server-Timing", [prev, `total;dur=${Date.now() - t0}, after_${afterResponseMode()};dur=0`].filter(Boolean).join(", "))
  return res
}

/**
 * N87-09 — reivindica a saída da espera do motor para o pay_now: update
 * condicional aguardando_motor|menu_degradado → gerando_cobranca (uma linha só
 * vence). "claimed" = este toque cobra; "busy" = outro toque já está cobrando;
 * "none" = a sessão não está na espera do motor (pay_now vira reopen_options).
 * Nunca lança (erro → "none": nenhuma cobrança, só o menu).
 */
async function claimEngineWaitForPay(sessionId: string, companyId: string): Promise<"claimed" | "busy" | "none"> {
  try {
    const { data, error } = await createServiceClient()
      .from("negotiation_sessions")
      .update({ wait_state: "gerando_cobranca", wait_started_at: new Date().toISOString() })
      .eq("id", sessionId)
      .eq("company_id", companyId)
      .in("wait_state", ["aguardando_motor", "menu_degradado"])
      .select("id")
    if (error) return "none"
    if (Array.isArray(data) && data.length > 0) return "claimed"
    return (await readWaitState(sessionId, companyId)) === "gerando_cobranca" ? "busy" : "none"
  } catch {
    return "none"
  }
}

/** Desfaz a reivindicação quando o clique não chegou à cobrança. Nunca lança. */
async function releasePayClaim(sessionId: string, companyId: string): Promise<void> {
  try {
    await createServiceClient()
      .from("negotiation_sessions")
      .update({ wait_state: null, wait_started_at: null })
      .eq("id", sessionId)
      .eq("company_id", companyId)
      .eq("wait_state", "gerando_cobranca")
  } catch {
    /* defensivo: o poll/decidePayResume reconciliam */
  }
}

/** wait_state persistido da sessão (null se ausente/erro). Nunca lança. */
async function readWaitState(sessionId: string, companyId: string): Promise<string | null> {
  try {
    const { data } = await createServiceClient()
      .from("negotiation_sessions")
      .select("wait_state")
      .eq("id", sessionId)
      .eq("company_id", companyId)
      .maybeSingle()
    return (data as { wait_state?: string | null } | null)?.wait_state ?? null
  } catch {
    return null
  }
}

async function handleReopen(req: NextRequest): Promise<NextResponse> {
  if (process.env.CHAT_JOURNEY_ENABLED !== "true") {
    return NextResponse.json({ error: "not found" }, { status: 404 })
  }
  const cookie = req.cookies.get(CHAT_COOKIE_NAME)?.value
  const claims = cookie ? verifyChatJwt(cookie) : null
  if (!claims) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const body = await req.json().catch(() => ({} as Record<string, unknown>))
  const action = String(body.action ?? "reopen_options")

  // Latência (10-latencia.md): no "Já paguei" o último clique da sessão (guard de
  // toque múltiplo) só depende do sid do cookie → lido JUNTO com o contexto.
  const lastClickP = action === "payment_claim" ? lastCustomerClick(claims.sid) : null
  const ctx = await loadSessionCtx(claims.sid)
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  try {
    // F8-02: dívida quitada → "Já paguei"/"Voltar às opções" de uma página
    // defasada recebem o estado de quitado (sem caso, sem menu de pagar).
    const settled = await settledReopenBody(ctx, action)
    if (settled) return NextResponse.json(settled)

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
      // QA rodada 6 (Q5r2-02): o corpo traz o OUTCOME persistido do handoff —
      // o client renderiza a confirmação na hora (antes encerrava sem bolha).
      const out = await transferToHumanWithOutcome(ctx, "wait_degraded_handoff", "customer")
      return NextResponse.json({
        ok: true, action: "handoff", transferred: true,
        outcome: out.messageId && out.reply
          ? { id: out.messageId, text: out.reply, stage: HANDOFF_STAGE, created_at: new Date().toISOString() }
          : null,
        prompt: null,
        state_time: new Date().toISOString(),
      })
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
      const last = lastClickP ? await lastClickP : await lastCustomerClick(ctx.sessionId)
      if (last.buttonId === BTN_PAYMENT_CLAIM && isWithinWindow(last.at, Date.now(), DOUBLE_TAP_WINDOW_MS)) {
        return NextResponse.json({
          ok: true, action: "payment_claim", claim_registered: true, duplicate: true,
          prompt: await activePromptView(ctx.sessionId), state_time: new Date().toISOString(),
        })
      }
      // Mesmo último clique já lido (este guard não faz releitura) — não relê.
      const dt = await checkEffectDoubleTap({
        sessionId: ctx.sessionId, companyId: ctx.companyId, customerId: ctx.customerId, debtId: ctx.debtId,
        buttonId: BTN_PAYMENT_CLAIM, source: "reopen", prefetchedLast: last,
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
      // Latência (10-latencia.md): eco, caso/resultado, menu reaberto e limpeza da
      // espera correm em PARALELO; a ORDEM do histórico é garantida por
      // encadeamento — o resultado só é gravado depois do eco, e a pergunta do menu
      // só depois do resultado.
      const echoP = persistClaimEcho(ctx)
      const claimP = handlePaymentClaim(ctx, "customer", undefined, { beforeReply: () => echoP })
      claimP.catch(() => {}) // aguardado (e o erro propagado) no Promise.all abaixo
      const { debtIds: cDebtIds, primaryDebtId: cPrimary } = await sessionDebtIds(ctx.sessionId, ctx.debtId, ctx)
      // reabre o menu payável (best-effort — a orientação já foi persistida).
      const reopenP = reopenThreeOptions({
        companyId: ctx.companyId,
        sessionId: ctx.sessionId,
        customerId: ctx.customerId,
        debtIds: cDebtIds,
        primaryDebtId: cPrimary,
        threadEpoch: ctx.threadEpoch,
        precedingWrite: () => claimP,
      }).catch((err: Error) => {
        console.warn("[chat:reopen] menu após payment_claim falhou (não-fatal):", err.message)
        return null
      })
      const [echo, claim, reopened] = await Promise.all([
        echoP, claimP, reopenP, clearWaitState(ctx.sessionId),
        // N87-07: prompt tardio do motor não troca o menu reaberto.
        markEngineSuperseded({ companyId: ctx.companyId, sessionId: ctx.sessionId, reason: "payment_claim" }),
      ])
      const reopenedPrompt = reopened && reopened.ok && reopened.prompt ? promptView(reopened.prompt) : null
      // QA round 4 (R-24/R-13): o corpo É o próximo estado — eco + resultado
      // persistidos (ids reais, o client deduplica com o poll) + o menu ativo.
      return NextResponse.json({
        ok: true, action: "payment_claim", claim_registered: true, case_id: claim.caseId, reply: claim.reply,
        echo,
        outcome: claim.messageId
          ? { id: claim.messageId, text: claim.reply, stage: "payment_claim", created_at: new Date().toISOString() }
          : null,
        prompt: reopenedPrompt ?? (await activePromptView(ctx.sessionId)),
        state_time: new Date().toISOString(),
      })
    }

    // reopen_options (default): re-publica o menu de 3 opções (payável), M10/M7.
    // N87-09: pay_now só cobra saindo da espera do motor, e só UM toque sai dela:
    // a transição aguardando_motor|menu_degradado → gerando_cobranca é um update
    // condicional (atômico no Postgres). O perdedor de um toque duplo recebe
    // `duplicate` (o client acompanha a cobrança do vencedor pelo poll).
    const payNow = action === "pay_now"
    const payClaim = payNow ? await claimEngineWaitForPay(ctx.sessionId, ctx.companyId) : "none"
    if (payClaim === "busy") {
      return NextResponse.json({
        ok: true, action: "pay_now", duplicate: true,
        prompt: await activePromptView(ctx.sessionId), state_time: new Date().toISOString(),
      })
    }
    const payClaimed = payClaim === "claimed"
    const { debtIds, primaryDebtId } = await sessionDebtIds(ctx.sessionId, ctx.debtId, ctx)
    // A-02: encerra a espera para não duplicar o menu — em paralelo com o menu
    // (latência); todos terminam antes da resposta. No pay_now reivindicado a
    // espera já virou 'gerando_cobranca' (a cobrança governa o estado daqui).
    const [back] = await Promise.all([
      reopenThreeOptions({
        companyId: ctx.companyId,
        sessionId: ctx.sessionId,
        customerId: ctx.customerId,
        debtIds,
        primaryDebtId,
        threadEpoch: ctx.threadEpoch,
      }),
      payClaimed ? Promise.resolve() : clearWaitState(ctx.sessionId),
      // N87-07: o devedor saiu da conversa com o motor — um prompt do n8n que
      // responde a um evento anterior não troca este menu (chat-send.ts).
      markEngineSuperseded({ companyId: ctx.companyId, sessionId: ctx.sessionId, reason: payNow ? "pay_now" : "reopen_options" }),
    ])
    if (!back.ok) {
      if (payClaimed) await releasePayClaim(ctx.sessionId, ctx.companyId)
      return NextResponse.json({ ok: false, code: "reopen_failed", error: "reopen_failed" }, { status: 500 })
    }
    if (payClaimed) {
      const menu = back.prompt ?? (await getActivePrompt(ctx.sessionId).catch(() => null))
      if (menu && menu.status === "active" && menu.kind === "debt_three_options" && findButton(menu.buttons ?? [], BTN_PAY)) {
        // O MESMO clique do Pagar do menu (rota /api/chat/button, button_id 4):
        // toque múltiplo, oferta integral do servidor, guard duplo
        // (lib/asaas-idempotency.ts), idempotência e wait_state da cobrança são
        // os dela. Só o corpo do clique muda (o menu acabou de ser reaberto).
        const { POST: clickButton } = await import("@/app/api/chat/button/route")
        const forwarded = {
          cookies: req.cookies,
          headers: req.headers,
          json: async () => ({ prompt_id: menu.id, button_id: BTN_PAY }),
        } as unknown as NextRequest
        const res = await clickButton(forwarded)
        // Clique sem cobrança (obsoleto/ignorado/quitado): devolve a espera
        // reivindicada — nunca um 'gerando_cobranca' pendurado.
        const out = (await res.clone().json().catch(() => null)) as { action?: unknown } | null
        if (out?.action !== "pay") await releasePayClaim(ctx.sessionId, ctx.companyId)
        return res
      }
      await releasePayClaim(ctx.sessionId, ctx.companyId)
    }
    // QA round 4 (R-13): o menu reaberto vai no corpo (o client aplica sem esperar o poll).
    return NextResponse.json({
      ok: true, action: "reopen_options", reply: back.reply,
      prompt: back.prompt ? promptView(back.prompt) : await activePromptView(ctx.sessionId),
      state_time: new Date().toISOString(),
    })
  } catch (err) {
    // Nunca deixa a request morrer sem JSON (o front re-habilita a UI e o poll
    // reconstrói o estado). Rótulo curto, sem PII/segredo.
    console.error("[chat:reopen] falhou:", (err as Error).message)
    return NextResponse.json({ ok: false, code: "reopen_flow_error", error: "reopen_flow_error" }, { status: 500 })
  }
}
