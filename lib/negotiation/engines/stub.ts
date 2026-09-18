// Engine STUB (N3): roteiro determinístico que exercita TODAS as ações do
// contrato (saudação → resumo → ofertas → aceite → payment.create → link →
// encerramento + contestação, "já paguei", humano). Só existe fora de produção
// ou com MOCK_ALL_INTEGRATIONS=1. Permite validar a jornada inteira E2E sem
// n8n nem LLM. Não decide desconto: as ofertas vêm da matriz (D8).
//
// Diferente do modo "disabled" (assisted.ts), o stub roteia por INTENÇÃO
// explícita e emite os tool_calls do contrato n8n (offer.list, offer.propose,
// payment.create...) para os testes cobrirem o caminho das ações.

import type { EngineTurnInput, EngineTurnResult } from "../engine"
import { loadSessionCtx, listOffers } from "@/lib/journey/actions"

function res(
  reply: string,
  toolCalls: Array<{ name: string; args: unknown }>,
  action: EngineTurnResult["action"] = null,
  agreementId: string | null = null,
): EngineTurnResult {
  return {
    reply,
    tool_calls: toolCalls,
    events: toolCalls.map((t) => `stub:${t.name}`),
    prompt_version: "stub_v1",
    verified: true,
    agreement_id: agreementId,
    action,
  }
}

/**
 * Turno determinístico do stub. Encaminha para a intenção detectada no texto;
 * a saudação (default) apresenta o menu. As ofertas reais são geradas pela
 * matriz (listOffers), garantindo que o caminho servidor→matriz é exercitado.
 */
export async function stubChat(input: EngineTurnInput): Promise<EngineTurnResult> {
  const ctx = await loadSessionCtx(input.session.id)
  const text = (input.message || "").toLowerCase()

  if (!ctx) {
    return res(
      "Não consegui carregar seus dados agora. Toque em uma opção do menu.",
      [{ name: "debt.summary", args: {} }],
    )
  }

  // resumo da dívida
  if (/fatura|detalhe|resumo|quanto|valor|dívida|divida|deve/.test(text)) {
    return res(
      "Aqui está o resumo da sua dívida ao lado. Quando quiser, veja as opções de pagamento.",
      [{ name: "debt.summary", args: {} }],
    )
  }

  // ofertas (offer.list — gera da matriz)
  if (/opç|opc|pagar|parcel|desconto|à vista|a vista|acordo|negoci|condiç/.test(text)) {
    const offers = await listOffers(ctx)
    if (offers.length === 0) {
      return res(
        "Não há condição automática agora. Vou transferir você para um atendente.",
        [{ name: "human.transfer", args: { reason: "sem_oferta" } }],
        "handoff",
      )
    }
    return res(
      "Estas são as condições disponíveis. Escolha uma ao lado para gerar o pagamento.",
      [{ name: "offer.list", args: { count: offers.length } }],
    )
  }

  // proposta específica do cliente → offer.propose (validada no servidor)
  if (/proposta|contraproposta|consigo pagar|posso pagar|quero pagar em/.test(text)) {
    return res(
      "Vou verificar essa condição para você.",
      [{ name: "offer.propose", args: { intent: "customer_proposal" } }],
    )
  }

  // "já paguei" → payment_claim.register
  if (/já paguei|ja paguei|paguei|quitei|comprovante/.test(text)) {
    return res(
      "Certo. Vou registrar que você já pagou para a nossa equipe conferir. O acordo só muda quando o pagamento é confirmado na fonte oficial.",
      [{ name: "payment_claim.register", args: {} }],
    )
  }

  // contestação → dispute.register
  if (/contest|não reconhe|nao reconhe|não devo|nao devo|indevid|disputa/.test(text)) {
    return res(
      "Entendo. Vou registrar sua contestação e nossa equipe vai analisar. Este débito fica pausado.",
      [{ name: "dispute.register", args: {} }],
      null,
    )
  }

  // atendimento humano → human.transfer
  if (/atendente|humano|pessoa|falar com|atendimento/.test(text)) {
    return res(
      "Sem problema. Vou transferir você para um atendente.",
      [{ name: "human.transfer", args: { reason: "cliente_solicitou" } }],
      "handoff",
    )
  }

  // encerramento
  if (/obrigad|tchau|encerrar|finalizar|sair/.test(text)) {
    return res(
      "Obrigado pelo contato! Qualquer coisa, é só voltar por aqui.",
      [{ name: "session.close", args: { outcome: "closed_by_customer" } }],
    )
  }

  // saudação / menu (default)
  return res(
    "Olá! Sou o assistente de negociação. Posso mostrar o resumo da sua dívida, as opções de pagamento, registrar um pagamento já feito, uma contestação, ou transferir para um atendente. Como posso ajudar?",
    [{ name: "debt.summary", args: {} }],
  )
}
