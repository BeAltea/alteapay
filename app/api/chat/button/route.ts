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
import {
  buildAckContext,
  handleDebtConsult,
  handleDebtNegotiate,
  handleDebtNotRecognized,
  persistAssistantMessage,
  recordAcknowledgement,
  startN8nNegotiation,
} from "@/lib/journey/acknowledgement"
import { engineName } from "@/lib/negotiation/engine"
import { BTN_CONSULT, BTN_HANDOFF, BTN_NEGOTIATE, BTN_NO } from "@/lib/journey/buttons"

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

  // Fluxo Consultar/Negociar (prompt inicial pedido pelo dono): DOIS botões
  // [2]=Consultar, [3]=Negociar; após consultar, [3]=Negociar + [0]=Não reconheço.
  //  - Consultar → mostra os dados da dívida + reabre o menu (não inicia n8n);
  //  - Negociar  → mostra os dados + reconhece "Sim" + inicia o n8n (fallback assistido);
  //  - Não reconheço [0] → contestação (registra dispute);
  //  - Atendente [99] → handoff.
  if (prompt.kind === "debt_consult") {
   // Envolvemos a branch INTEIRA em try/catch: o clique NUNCA pode morrer por
   // exceção (ou por qualquer I/O lento) sem devolver JSON — senão o front fica
   // preso em "..." esperando um corpo que não vem. Qualquer erro inesperado vira
   // 500 {code:'consult_flow_error'} e o front re-habilita os botões.
   try {
    // 1) responde o prompt (marca answered + grava a mensagem do cliente = label).
    //    A integridade do clique (ativo/botão existe) é validada aqui.
    const answered = await answerPrompt({ sessionId: ctx.sessionId, companyId: ctx.companyId, promptId, buttonId })
    if (!answered.ok) return NextResponse.json({ error: answered.code, code: answered.code }, { status: answered.status })

    // debtIds do prompt.context (buildAckContext consolida o valor). Fallback: o
    // debt primário do ctx quando o contexto não trouxer a lista.
    const debtIds = Array.isArray((prompt.context as { debt_ids?: unknown } | null)?.debt_ids)
      ? ((prompt.context as { debt_ids: string[] }).debt_ids)
      : [ctx.debtId]
    const primaryDebtId =
      (typeof (prompt.context as { primary_debt_id?: unknown } | null)?.primary_debt_id === "string"
        ? (prompt.context as { primary_debt_id: string }).primary_debt_id
        : null) ?? ctx.debtId

    if (buttonId === BTN_CONSULT) {
      const out = await handleDebtConsult({
        companyId: ctx.companyId, sessionId: ctx.sessionId, customerId: ctx.customerId,
        debtId: ctx.debtId, debtIds, primaryDebtId,
      })
      return NextResponse.json({ ok: true, button_id: buttonId, action: "consulted", reply: out.reply })
    }

    if (buttonId === BTN_NEGOTIATE) {
      const out = await handleDebtNegotiate({
        companyId: ctx.companyId, sessionId: ctx.sessionId, customerId: ctx.customerId,
        debtId: ctx.debtId, debtIds, promptId, buttonId, ip, userAgent,
      })
      return NextResponse.json({
        ok: true, button_id: buttonId, action: "negotiate",
        acknowledged: true, engine_owner: out.engineOwner, reply: out.reply,
      })
    }

    if (buttonId === BTN_NO) {
      const out = await handleDebtNotRecognized({
        companyId: ctx.companyId, sessionId: ctx.sessionId, customerId: ctx.customerId,
        debtId: ctx.debtId, promptId, buttonId, ip, userAgent,
      })
      if (out.onNotRecognized === "dispute") {
        await registerDispute(ctx, { source: "debt_not_recognized" }, "customer")
      } else if (out.onNotRecognized === "human") {
        await transferToHuman(ctx, "debt_not_recognized", "customer")
      }
      let creditorName = "empresa credora"
      try {
        const ackCtx = await buildAckContext({ companyId: ctx.companyId, customerId: ctx.customerId, debtIds: [ctx.debtId] })
        creditorName = ackCtx.creditorName
      } catch {
        /* fallback silencioso: mantém o texto genérico */
      }
      const notRecognizedReply = `Obrigado pelo seu retorno. Para esclarecimentos sobre esta cobrança, entre em contato diretamente com a ${creditorName}.`
      await persistAssistantMessage({ companyId: ctx.companyId, sessionId: ctx.sessionId, text: notRecognizedReply })
      return NextResponse.json({
        ok: true, button_id: buttonId, action: "not_recognized",
        acknowledged: false, on_not_recognized: out.onNotRecognized, reply: notRecognizedReply,
      })
    }

    if (buttonId === BTN_HANDOFF) {
      await transferToHuman(ctx, "handoff_button", "customer")
      return NextResponse.json({ ok: true, transferred: true, button_id: buttonId })
    }

    // Botão fora do catálogo esperado do debt_consult: já respondido, sem efeito.
    return NextResponse.json({ ok: true, button_id: buttonId })
   } catch (err) {
     // Nunca deixa a request morrer por exceção/timeout: sempre devolve JSON. O
     // prompt pode já ter sido respondido (answerPrompt) — o front recarrega o
     // estado via pollMessages; o importante é o botão sair do "...".
     console.error("[chat:button] debt_consult falhou:", (err as Error).message)
     return NextResponse.json(
       { ok: false, code: "consult_flow_error", error: "consult_flow_error" },
       { status: 500 },
     )
   }
  }

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
      // Reply fixo local (n8n ainda não plugado): direciona o cliente ao credor.
      let creditorName = "empresa credora"
      try {
        const ackCtx = await buildAckContext({
          companyId: ctx.companyId,
          customerId: ctx.customerId,
          debtIds: [ctx.debtId],
        })
        creditorName = ackCtx.creditorName
      } catch {
        /* fallback silencioso: mantém o texto genérico */
      }
      const notRecognizedReply = `Obrigado pelo seu retorno. Para esclarecimentos sobre esta cobrança, entre em contato diretamente com a ${creditorName}.`
      // Persiste a resposta do assistente no histórico (o clique do cliente já foi
      // gravado por answerPrompt dentro de recordAcknowledgement). Assim a sessão
      // reaberta reconstrói [pergunta+resumo] → [clique] → [resposta].
      await persistAssistantMessage({
        companyId: ctx.companyId,
        sessionId: ctx.sessionId,
        text: notRecognizedReply,
      })
      return NextResponse.json({
        ok: true,
        acknowledged: false,
        button_id: buttonId,
        on_not_recognized: res.onNotRecognized ?? "continue",
        reply: notRecognizedReply,
      })
    }
    // "Sim, reconheço" (button 1): handoff ao n8n em BACKGROUND (best-effort —
    // negotiation.start disparado sem bloquear o clique). RESILIENTE (H8): se o
    // n8n não estiver plugado/o disparo falhar, mantém o assistido e o cliente
    // NÃO vê erro. Nunca derruba nem pendura a resposta do clique.
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
    const recognizedReply = "Perfeito! Então vamos trabalhar juntos para sanar o seu débito."
    // SEMPRE persiste o reply (bug histórico: condicionar a engineOwner==='platform'
    // deixava o lado do assistente VAZIO no banco quando o n8n era dado como dono
    // mas não empurrava nada — a sessão reaberta só trazia a pergunta + o clique
    // "Sim". Como o handoff é best-effort/background e a entrega não é confirmada
    // aqui, o histórico não pode depender do n8n). O clique do cliente já foi
    // gravado por answerPrompt dentro de recordAcknowledgement.
    await persistAssistantMessage({
      companyId: ctx.companyId,
      sessionId: ctx.sessionId,
      text: recognizedReply,
    })
    return NextResponse.json({
      ok: true,
      acknowledged: true,
      button_id: buttonId,
      engine_owner: engineOwner,
      reply: recognizedReply,
    })
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
