// Modo assistido determinístico (D13): quando NEGOTIATION_ENGINE=disabled,
// o chat funciona sem IA — menu de ações servido pelo servidor a partir das
// ofertas da matriz. Torna a jornada inteira testável sem n8n nem agente.
// Não decide desconto: só apresenta o que a matriz gerou (D8). A ação de
// domínio pretendida viaja em tool_calls (rastreabilidade); o efeito real é
// aplicado pela rota /api/chat/session conforme o cliente toca os botões.

import type { EngineTurnInput, EngineTurnResult } from "./engine"
import { loadSessionCtx, listOffers } from "@/lib/journey/actions"

const MENU_ITEMS = [
  "Ver detalhes das faturas",
  "Ver opções de pagamento",
  "Já paguei",
  "Contestar este débito",
  "Falar com um atendente",
]

function formatBRL(v: number): string {
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })
}

function result(reply: string, intent: string, action: EngineTurnResult["action"] = null): EngineTurnResult {
  return {
    reply,
    tool_calls: intent === "menu" ? [] : [{ name: `journey.${intent}`, args: {} }],
    events: [`assisted:${intent}`],
    prompt_version: "assisted_v1",
    verified: true,
    agreement_id: null,
    action,
  }
}

export async function assistedChat(input: EngineTurnInput): Promise<EngineTurnResult> {
  const ctx = await loadSessionCtx(input.session.id)
  const text = (input.message || "").toLowerCase()

  if (!ctx) {
    return result("Não consegui carregar seus dados agora. Toque em uma opção do menu ou fale com um atendente.", "menu")
  }

  if (/paga|opç|opc|parcel|desconto|à vista|a vista|acordo|negoci/.test(text)) {
    const offers = await listOffers(ctx)
    if (offers.length === 0) {
      return result(
        "No momento não há uma condição automática para este débito. Vou registrar seu interesse e um atendente segue com você.",
        "human_transfer", "handoff",
      )
    }
    const linhas = offers.map((o, i) => {
      const t = o.terms
      return t.installments === 1
        ? `${i + 1}) À vista por ${formatBRL(t.total_value)} (${Math.round(t.discount_pct)}% de desconto), via ${t.billing_type}.`
        : `${i + 1}) ${t.installments}x de ${formatBRL(t.installment_value)} (total ${formatBRL(t.total_value)}), via ${t.billing_type}.`
    })
    return result(
      `Estas são as opções disponíveis para o seu débito:\n\n• ${linhas.join("\n• ")}\n\nEscolha uma opção ao lado para gerar o pagamento, ou use o menu.`,
      "offers_listed",
    )
  }
  if (/fatura|detalhe|quanto|valor|dívida|divida|deve/.test(text)) {
    return result("Vou abrir os detalhes das suas faturas ao lado. Quando quiser, toque em “Ver opções de pagamento” para negociar.", "debt_explain")
  }
  if (/já paguei|ja paguei|paguei|quitei/.test(text)) {
    return result("Certo. Vou registrar que você já efetuou o pagamento para a nossa equipe conferir. Se tiver o comprovante, guarde-o. Posso ajudar em algo mais?", "payment_claim")
  }
  if (/contest|não reconhe|nao reconhe|não devo|nao devo|indevid/.test(text)) {
    return result("Entendo. Vou registrar a sua contestação e nossa equipe vai analisar. Enquanto isso, este débito fica pausado. Deseja falar com um atendente?", "dispute")
  }
  if (/atendente|humano|pessoa|falar com|atendimento/.test(text)) {
    return result("Sem problema. Vou transferir você para um de nossos atendentes. Em breve entramos em contato.", "human_transfer", "handoff")
  }

  return result(`Olá! Sou o assistente de negociação. Como posso ajudar hoje?\n\n• ${MENU_ITEMS.join("\n• ")}`, "menu")
}
