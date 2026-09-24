// Lógica PURA de EXIBIÇÃO do chat do devedor (C1-client). Fica num .ts separado
// (sem React) para ser testável no ambiente node do vitest — mesmo padrão dos
// demais concerns (a decisão vive fora do componente; o .tsx apenas consome).
//
// Cobre dois objetivos do comportamento desejado:
//  - "MANTER SÓ A ÚLTIMA RESPOSTA": colapsar bolhas assistant de conteúdo
//    idêntico no render (dedupAssistantByContent).
//  - Indicador "trabalhando" ao Negociar: reconhecer o botão de negociação pelo
//    rótulo (isNegotiateLabel), já que a UI não tem o `kind` do botão.

export interface MsgAction {
  type: string
  label: string
  href: string
}

export interface ChatMsg {
  id: string
  from: "customer" | "assistant"
  text: string
  action?: MsgAction | null
  // prompt_id da pergunta que originou esta bolha (quando é a mensagem do prompt).
  promptId?: string | null
}

/** Texto da bolha optimistic local injetada ao clicar Negociar (feedback
 *  imediato de "trabalhando" enquanto o backend dispara negotiation.start ao n8n
 *  e aguardamos a 1ª resposta chegar via poll). É texto plano, sem PII. */
export const NEGOTIATION_PENDING_TEXT = "Estou preparando sua negociação..."

/** Reconhece o botão que dispara a negociação n8n pelo rótulo (a UI não tem o
 *  kind do botão). Casa "Negociar" / "Negociar Dívida" sem depender do id. */
export function isNegotiateLabel(label: string): boolean {
  return /negociar/i.test(label)
}

// Colapsa bolhas do ASSISTENTE com texto idêntico, mantendo apenas a ÚLTIMA
// ocorrência (na posição original da última). O servidor pode re-persistir a
// mesma resposta ("Aqui estão os dados...", saudação re-bootstrapada) — aqui
// garantimos "só a última resposta" na EXIBIÇÃO, sem tocar no buffer bruto nem
// no backend. Bolhas do cliente e bolhas com <a> de ação nunca são colapsadas.
export function dedupAssistantByContent(list: ChatMsg[]): ChatMsg[] {
  // 1º passo: para cada texto assistant "colapsável", achar o índice da ÚLTIMA
  // ocorrência.
  const lastIdxByText = new Map<string, number>()
  list.forEach((m, i) => {
    if (m.from !== "assistant") return
    if (m.action) return // ação anexada: preserva sempre
    lastIdxByText.set(m.text.trim(), i)
  })
  // 2º passo: manter cliente sempre; manter assistant só na última ocorrência
  // do seu texto (ou se não for colapsável).
  return list.filter((m, i) => {
    if (m.from !== "assistant") return true
    if (m.action) return true
    return lastIdxByText.get(m.text.trim()) === i
  })
}
