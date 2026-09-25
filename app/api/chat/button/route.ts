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
import { createServiceClient } from "@/lib/supabase/service"
import { getPrompt, answerPrompt } from "@/lib/journey/prompts"
import {
  buildAckContext,
  debtConsultReply,
  handleDebtConsult,
  handleDebtNegotiate,
  handleDebtNotRecognized,
  notRecognizedReply,
  persistAssistantMessage,
  presentMatrixOffers,
  recognizeImplicit,
  recordAcknowledgement,
  reopenThreeOptions,
  resolveCreditorChannel,
  resolveOfferIdFromButton,
  startN8nNegotiation,
} from "@/lib/journey/acknowledgement"
import { acceptMatrixCondition } from "@/lib/journey/assisted"
import { payService } from "@/lib/journey/pay"
import { engineName } from "@/lib/negotiation/engine"
import {
  BTN_BACK,
  BTN_CONSULT,
  BTN_HANDOFF,
  BTN_NEGOTIATE,
  BTN_NO,
  BTN_PAY,
  BTN_YES,
} from "@/lib/journey/buttons"

export const dynamic = "force-dynamic"
export const maxDuration = 60

function clientIp(req: NextRequest): string | null {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null
}

/**
 * Grava wait_state='aguardando_motor' + wait_started_at=now() na sessão (M11,
 * contrato G1). A coluna é da migration M-4 do D2, que roda DEPOIS desta trilha —
 * então a escrita é DEFENSIVA: se a coluna ainda não existir (ou o update falhar
 * por qualquer motivo), NÃO derruba o clique. A espera é reconstruída client-side
 * pelo D2 a partir de wait_started_at; sem a coluna, a UI apenas não restaura o
 * degrau no reload (degradação graciosa). NUNCA lança.
 */
async function markWaitingForEngine(sessionId: string): Promise<void> {
  try {
    const supabase = createServiceClient()
    const { error } = await supabase
      .from("negotiation_sessions")
      .update({ wait_state: "aguardando_motor", wait_started_at: new Date().toISOString() })
      .eq("id", sessionId)
    if (error) {
      // Coluna ausente (M-4 do D2 ainda não aplicada) ou outro erro não-fatal.
      console.warn("[chat:button] wait_state write não aplicado (coluna M-4 pendente?):", error.message)
    }
  } catch (err) {
    console.warn("[chat:button] wait_state write falhou (defensivo):", (err as Error).message)
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
  const promptId = String(body.prompt_id ?? "")
  const buttonId = Number(body.button_id)
  if (!promptId || !Number.isInteger(buttonId)) {
    return NextResponse.json({ error: "prompt_id e button_id obrigatórios" }, { status: 422 })
  }

  const prompt = await getPrompt(promptId, ctx.sessionId)
  if (!prompt) return NextResponse.json({ error: "prompt não encontrado", code: "prompt_not_found" }, { status: 404 })

  const ip = clientIp(req)
  const userAgent = req.headers.get("user-agent")

  // R1 — ESCOLHA DE PARCELA (kind 'offer_choice'): o devedor escolheu uma das
  // OPÇÕES DE PARCELAMENTO DETERMINÍSTICAS da matriz (apresentadas no fallback
  // assistido do "Quero negociar"). O clique num item [2..N] → acceptMatrixCondition
  // (caminho canônico: payment.create interno → closeAgreement → charge-inline),
  // que VALIDA a oferta contra a matriz vigente no servidor (não confia no client,
  // D8/D11), aplica o guard de idempotência (D7) e already_charged (D23) — clique
  // duplo → 1 acordo/1 link, NUNCA 2ª cobrança, NUNCA declara pago (D6). O [98]
  // volta ao menu de 3 opções (M7). A resposta reusa o MESMO shape de PAGAR
  // (action:'pay') para o D2 renderizar o link/erro pela copy §5. try/catch total:
  // o clique nunca morre sem JSON.
  if (prompt.kind === "offer_choice") {
    try {
      // 1) integridade do clique (ativo/botão existe) + grava a mensagem do cliente.
      const answered = await answerPrompt({ sessionId: ctx.sessionId, companyId: ctx.companyId, promptId, buttonId })
      if (!answered.ok) return NextResponse.json({ error: answered.code, code: answered.code }, { status: answered.status })

      const debtIds = Array.isArray((prompt.context as { debt_ids?: unknown } | null)?.debt_ids)
        ? ((prompt.context as { debt_ids: string[] }).debt_ids)
        : [ctx.debtId]
      const primaryDebtId =
        (typeof (prompt.context as { primary_debt_id?: unknown } | null)?.primary_debt_id === "string"
          ? (prompt.context as { primary_debt_id: string }).primary_debt_id
          : null) ?? ctx.debtId

      // --- VOLTA [98] → reabre o menu de 3 opções (M7). ----------------------
      if (buttonId === BTN_BACK) {
        const back = await reopenThreeOptions({
          companyId: ctx.companyId, sessionId: ctx.sessionId, customerId: ctx.customerId,
          debtIds, primaryDebtId,
        })
        if (!back.ok) {
          return NextResponse.json({ ok: false, code: "reopen_failed", error: "reopen_failed" }, { status: 500 })
        }
        return NextResponse.json({ ok: true, button_id: buttonId, action: "back_to_options", reply: back.reply })
      }

      // --- ATENDIMENTO [99] → handoff. ---------------------------------------
      if (buttonId === BTN_HANDOFF) {
        await transferToHuman(ctx, "handoff_button", "customer")
        return NextResponse.json({ ok: true, transferred: true, button_id: buttonId })
      }

      // --- ESCOLHA DE UMA OFERTA [2..N] --------------------------------------
      // O `value` do botão carrega o offer_id (uuid). O servidor valida que o
      // value pertence ao prompt/context (defesa) e acceptMatrixCondition revalida
      // a oferta contra a matriz vigente (autoridade — 422 se fora da matriz).
      const offerId = resolveOfferIdFromButton(prompt, buttonId)
      if (!offerId) {
        // botão desconhecido no offer_choice: já respondido, sem efeito.
        return NextResponse.json({ ok: true, button_id: buttonId })
      }
      // O reconhecimento IMPLÍCITO já foi gravado no clique NEGOCIAR (M4) que
      // apresentou estas ofertas; o guard D18 já está destravado. acceptMatrixCondition
      // reusa paymentCreateOrExistingLink (guard duplo D7 + revalidação de matriz).
      const accepted = await acceptMatrixCondition(ctx, offerId)
      if (!accepted.ok) {
        // Rótulo de negócio (não erro de transporte): o D2 mostra a copy humana
        // §5.4. HTTP 200 para o front tratar como resultado do pagamento, não como
        // falha de rede. NUNCA a mensagem crua/HTTP/"n8n" ao devedor.
        return NextResponse.json(
          { ok: false, button_id: buttonId, action: "pay", error: accepted.code },
          { status: 200 },
        )
      }
      if (accepted.status === "already_charged") {
        // D23/M14: devolve o LINK EXISTENTE, nunca cria 2ª cobrança.
        return NextResponse.json({
          ok: true, button_id: buttonId, action: "pay", acknowledged: true,
          link: accepted.payment?.invoice_url ?? accepted.payment?.boleto_url ?? accepted.payment?.pix_copy_paste ?? null,
          valor: accepted.payment?.total_value ?? null,
          vencimento_link: accepted.payment?.due_date ?? null,
          already_charged: true, processing: false,
          agreement_id: accepted.payment?.agreement_id ?? null,
        })
      }
      if (accepted.status === "processing") {
        // Cobrança aceita, worker ainda não gravou as URLs. A UI faz polling; NÃO
        // declaramos pago (M15).
        return NextResponse.json({
          ok: true, button_id: buttonId, action: "pay", acknowledged: true,
          link: null, valor: null, vencimento_link: null,
          already_charged: false, processing: true,
          agreement_id: accepted.agreementId,
        })
      }
      // status: 'created' — link pronto (inline).
      return NextResponse.json({
        ok: true, button_id: buttonId, action: "pay", acknowledged: true,
        link: accepted.payment.invoice_url ?? accepted.payment.boleto_url ?? accepted.payment.pix_copy_paste ?? null,
        valor: accepted.payment.total_value ?? null,
        vencimento_link: accepted.payment.due_date ?? null,
        already_charged: false, processing: false,
        agreement_id: accepted.payment.agreement_id ?? null,
      })
    } catch (err) {
      console.error("[chat:button] offer_choice falhou:", (err as Error).message)
      return NextResponse.json(
        { ok: false, code: "offer_choice_flow_error", error: "offer_choice_flow_error" },
        { status: 500 },
      )
    }
  }

  // Onda "3 opções" (§6.1, §6.2, M2–M7): menu pós-login com Pagar(4) › Negociar(1)
  // › Não reconheço(0) (+ Atendimento[99]); depois do "Não reconheço", volta[98].
  //  - Pagar [4]     → reconhecimento IMPLÍCITO + payService(ctx) do D3 (link ASAAS);
  //  - Negociar [1]  → reconhecimento IMPLÍCITO + negotiation.start + apresenta as
  //                    parcelas da matriz (fallback assistido R1) OU arma a espera D2;
  //  - Não reconheço [0] → ack negativo + copy do cedente (fallback seguro) + volta;
  //  - Volta [98]    → reabre o menu de 3 opções (M7);
  //  - Atendente [99] → handoff.
  // A branch INTEIRA é envolvida em try/catch: o clique NUNCA morre por exceção sem
  // devolver JSON (senão o front fica preso em "..."). Erro inesperado → 500
  // {code:'three_options_flow_error'} e o front re-habilita os botões.
  if (prompt.kind === "debt_three_options") {
    try {
      // 1) integridade do clique (ativo/botão existe) + grava a mensagem do cliente.
      const answered = await answerPrompt({ sessionId: ctx.sessionId, companyId: ctx.companyId, promptId, buttonId })
      if (!answered.ok) return NextResponse.json({ error: answered.code, code: answered.code }, { status: answered.status })

      const debtIds = Array.isArray((prompt.context as { debt_ids?: unknown } | null)?.debt_ids)
        ? ((prompt.context as { debt_ids: string[] }).debt_ids)
        : [ctx.debtId]
      const primaryDebtId =
        (typeof (prompt.context as { primary_debt_id?: unknown } | null)?.primary_debt_id === "string"
          ? (prompt.context as { primary_debt_id: string }).primary_debt_id
          : null) ?? ctx.debtId

      // --- PAGAR [4] ---------------------------------------------------------
      if (buttonId === BTN_PAY) {
        // Reconhecimento IMPLÍCITO ANTES do payService (M4): destrava o guard D18.
        await recognizeImplicit({
          companyId: ctx.companyId, sessionId: ctx.sessionId, customerId: ctx.customerId,
          debtId: ctx.debtId, promptId, buttonId, source: "chat_three_options_pay", ip, userAgent,
        })
        // payService (trilha D3): oferta integral 0% → link ASAAS canônico. NUNCA
        // 2ª cobrança; NUNCA declara pago. A copy humana (link/erro) é da UI (D2);
        // aqui devolvemos o shape estruturado para o D2 renderizar. Passamos os
        // MESMOS debtIds que geraram o rótulo do botão (prompt.context.debt_ids)
        // para o valor cobrado bater com o valor exibido (D3 ALTO — valor
        // divergente do botão seria BLOQUEANTE em sessão multi-fatura).
        const pay = await payService(ctx, { debtIds })
        if (!pay.ok) {
          return NextResponse.json(
            { ok: false, button_id: buttonId, action: "pay", error: pay.error },
            { status: 200 }, // rótulo de negócio, não erro de transporte: o D2 mostra a copy §5.4
          )
        }
        return NextResponse.json({
          ok: true, button_id: buttonId, action: "pay", acknowledged: true,
          link: pay.link, valor: pay.valor, vencimento_link: pay.vencimento_link,
          already_charged: pay.already_charged, processing: pay.processing,
          agreement_id: pay.agreement_id,
        })
      }

      // --- NEGOCIAR [1] ------------------------------------------------------
      if (buttonId === BTN_YES) {
        // Reconhecimento IMPLÍCITO (M4) — clicar negociar reconhece a dívida.
        await recognizeImplicit({
          companyId: ctx.companyId, sessionId: ctx.sessionId, customerId: ctx.customerId,
          debtId: ctx.debtId, promptId, buttonId, source: "chat_three_options_negotiate", ip, userAgent,
        })
        // Confirmação NOSSA imediata (A.2) — persistida para o histórico. Nada do
        // n8n é aguardado: a espera é client-side em D2.
        // T2 / R-26: mesma frase EXATA da bolha optimistic do client
        // (NEGOTIATION_PENDING_TEXT em chat-display.ts) — 1 só bolha para o mesmo
        // instante (M4). "Certo." (não "Perfeito."), "para você" (não "seu caso").
        const reply = "Certo. Vou buscar as condições de pagamento disponíveis para você."
        await persistAssistantMessage({ companyId: ctx.companyId, sessionId: ctx.sessionId, text: reply })
        // Dispara negotiation.start em BACKGROUND (best-effort/resiliente H8): se o
        // n8n um dia conduzir, ele assume os próximos turnos. NÃO aguardamos.
        let engineOwner: "platform" | "n8n" = "platform"
        try {
          const start = await startN8nNegotiation({
            companyId: ctx.companyId, sessionId: ctx.sessionId,
            customerId: ctx.customerId, debtId: ctx.debtId,
          })
          engineOwner = start.owner
        } catch (err) {
          console.warn("[chat:button] negotiation.start (3 opções) falhou (fallback assistido):", (err as Error).message)
        }

        // R1 — FALLBACK ASSISTIDO (sem n8n): apresentamos JÁ as PARCELAS DA MATRIZ
        // como botões (modo assistido, servidor dono da matriz — D8). O gatilho é
        // IMEDIATO após o nosso kickoff: o devedor NÃO fica 15s olhando o spinner
        // para só então ver as parcelas — as opções determinísticas aparecem agora.
        // Se o n8n assumir (engine_owner='n8n'), ele conduz os próximos turnos e
        // esta apresentação assistida é a rede de segurança. NUNCA lança: uma falha
        // aqui cai na espera instrumentada (D2), nunca em beco sem saída.
        let presentedOffers = false
        try {
          const pres = await presentMatrixOffers({
            companyId: ctx.companyId, sessionId: ctx.sessionId,
            customerId: ctx.customerId, debtId: ctx.debtId,
          })
          presentedOffers = pres.ok && pres.presented === true
        } catch (err) {
          console.warn("[chat:button] presentMatrixOffers falhou (cai na espera D2):", (err as Error).message)
        }

        // Só armamos a espera instrumentada (M11/D2) quando NÃO conseguimos
        // apresentar as parcelas agora (sem faixa de matriz vigente / falha): aí o
        // devedor vê a espera e, aos 15s, o menu de degradação (M10). Com as
        // parcelas na tela, não há spinner — a ação está imediatamente disponível.
        if (!presentedOffers) {
          await markWaitingForEngine(ctx.sessionId)
          return NextResponse.json({
            ok: true, button_id: buttonId, action: "negotiate", acknowledged: true,
            wait_state: "aguardando_motor", engine_owner: engineOwner, reply,
          })
        }
        return NextResponse.json({
          ok: true, button_id: buttonId, action: "negotiate", acknowledged: true,
          offers_presented: true, engine_owner: engineOwner, reply,
        })
      }

      // --- CONSULTAR [2] (informativo — NÃO reconhece a dívida) --------------
      if (buttonId === BTN_CONSULT) {
        const ackCtx = await buildAckContext({
          companyId: ctx.companyId, customerId: ctx.customerId, debtIds,
        })
        const reply = debtConsultReply(ackCtx)
        await persistAssistantMessage({ companyId: ctx.companyId, sessionId: ctx.sessionId, text: reply })
        // Consultar é informativo: reabre o menu de 3 opções para o devedor seguir
        // (Pagar/Negociar/Não reconheço). Sem reconhecimento implícito.
        await reopenThreeOptions({
          companyId: ctx.companyId, sessionId: ctx.sessionId, customerId: ctx.customerId,
          debtIds, primaryDebtId,
        })
        return NextResponse.json({ ok: true, button_id: buttonId, action: "consult", acknowledged: false, reply })
      }

      // --- NÃO RECONHEÇO [0] -------------------------------------------------
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
        // Copy do cedente com FALLBACK SEGURO (§6.2/M6, incidente GNLink): nunca
        // vazio/"null"/outro cedente. Emite alerta de config quando o label é NULL.
        const channel = await resolveCreditorChannel({
          companyId: ctx.companyId, customerId: ctx.customerId, debtId: ctx.debtId,
        })
        if (!channel.hasConfig) {
          // Alerta operacional (sem PII): tenant sem official_channel_label semeado.
          console.warn(`[chat:button] GNLink: official_channel_label ausente (company=${ctx.companyId}) — usando fallback seguro`)
        }
        const reply = notRecognizedReply(channel)
        await persistAssistantMessage({ companyId: ctx.companyId, sessionId: ctx.sessionId, text: reply })
        // Botão de VOLTA (M7): [98] reabre o menu de 3 opções. Só um botão-link de
        // ação; a UI (D2) o renderiza. Persistido como prompt para a re-entrada.
        const { createPrompt } = await import("@/lib/journey/prompts")
        const { backToOptionsButtons } = await import("@/lib/journey/acknowledgement")
        await createPrompt({
          companyId: ctx.companyId, sessionId: ctx.sessionId, kind: "debt_three_options",
          question: "Se preferir, você pode voltar às opções.",
          buttons: backToOptionsButtons(),
          context: { primary_debt_id: primaryDebtId, debt_ids: debtIds, stage: "not_recognized_back" },
          createdBy: "platform",
        })
        return NextResponse.json({
          ok: true, button_id: buttonId, action: "not_recognized", acknowledged: false,
          on_not_recognized: out.onNotRecognized, has_channel_config: channel.hasConfig, reply,
        })
      }

      // --- VOLTA [98] --------------------------------------------------------
      if (buttonId === BTN_BACK) {
        const back = await reopenThreeOptions({
          companyId: ctx.companyId, sessionId: ctx.sessionId, customerId: ctx.customerId,
          debtIds, primaryDebtId,
        })
        if (!back.ok) {
          return NextResponse.json({ ok: false, code: "reopen_failed", error: "reopen_failed" }, { status: 500 })
        }
        return NextResponse.json({ ok: true, button_id: buttonId, action: "back_to_options", reply: back.reply })
      }

      // --- ATENDIMENTO [99] --------------------------------------------------
      if (buttonId === BTN_HANDOFF) {
        await transferToHuman(ctx, "handoff_button", "customer")
        return NextResponse.json({ ok: true, transferred: true, button_id: buttonId })
      }

      // Botão fora do catálogo esperado: já respondido, sem efeito.
      return NextResponse.json({ ok: true, button_id: buttonId })
    } catch (err) {
      console.error("[chat:button] debt_three_options falhou:", (err as Error).message)
      return NextResponse.json(
        { ok: false, code: "three_options_flow_error", error: "three_options_flow_error" },
        { status: 500 },
      )
    }
  }

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
      // R-46: mesma carta de voz do notRecognizedReply — adulto, sem "Obrigado
      // pelo seu retorno" (muleta), sem "se já pagou desconsidere". Identifica a
      // {credor} (dona da dívida) e a AlteaPay (operadora do canal). Sem ameaça.
      const notRecognizedReply = `Registramos que você não reconhece esta cobrança e não vamos gerar nenhum pagamento agora. Para entender a origem da dívida e contestar, fale diretamente com a ${creditorName}. A AlteaPay opera o canal de negociação; quem tem os detalhes do contrato é a ${creditorName}.`
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
      // R-46: mesma carta de voz do notRecognizedReply — adulto, sem "Obrigado
      // pelo seu retorno" (muleta), sem "se já pagou desconsidere". Identifica a
      // {credor} (dona da dívida) e a AlteaPay (operadora do canal). Sem ameaça.
      const notRecognizedReply = `Registramos que você não reconhece esta cobrança e não vamos gerar nenhum pagamento agora. Para entender a origem da dívida e contestar, fale diretamente com a ${creditorName}. A AlteaPay opera o canal de negociação; quem tem os detalhes do contrato é a ${creditorName}.`
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
