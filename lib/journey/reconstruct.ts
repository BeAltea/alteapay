// Reconstrução de transcript (chat_messages) a partir de journey_events das
// sessões ANTIGAS — aquelas que gravaram só o log append-only de eventos, ANTES
// de chat_messages virar o runtime da conversa (por isso o painel mostra Msgs=0
// e a timeline fica pobre). O painel já lê chat_messages; este helper produz as
// linhas reconstituíveis, de forma PURA, DETERMINÍSTICA e TESTÁVEL.
//
// Regra de ouro: NÃO inventar conteúdo. Só reconstrói o que o evento (mais o
// chat_prompts referenciado, quando houver) permite reconstituir com fidelidade:
//   - chat.turn.customer  → mensagem do cliente, se payload.text existir;
//   - chat.turn.assistant → mensagem do assistente = texto do prompt referenciado
//                           (chat_prompts.question) OU payload.text/reply se vier;
//   - debt.acknowledged / debt.not_recognized → clique do cliente (button 1/0) com
//                           o label do botão do prompt (recuperável);
//   - offer.presented     → resumo sintético do assistente, montado APENAS de
//                           campos estruturados (offer_id/parcelas/total) — sem
//                           texto livre inventado;
// Qualquer evento sem texto/estrutura reconstituível → NÃO gera mensagem (fica
// marcado como não-reconstituível para o script contabilizar e não inserir lixo).
//
// PII: o texto reconstruído nunca contém mais do que o próprio evento/prompt já
// carregava (que já é redigido/mascarado na origem). Este módulo não formata
// documento/telefone e não injeta valores fora dos que vêm do prompt.

import { BTN_NO, BTN_YES, findButton, type Button } from "./buttons"

/** Linha de journey_events necessária à reconstrução (subconjunto lido do banco). */
export interface ReconstructEvent {
  /** id da linha de journey_events — âncora determinística da idempotência. */
  id: string | number
  event_type: string
  actor: string | null
  occurred_at: string
  payload: Record<string, unknown> | null
}

/** Prompt referenciado por um evento (subconjunto de chat_prompts). */
export interface ReconstructPrompt {
  id: string
  question: string
  buttons: Button[]
  n8n_execution_id?: string | null
}

/**
 * Mensagem reconstituída pronta para virar uma linha de chat_messages. Os nomes
 * espelham as colunas REAIS de chat_messages (não há coluna `type` nem `source`
 * na tabela — o "tipo" é derivado de button_id, e a origem 'reconstructed' vai no
 * jsonb `offers_snapshot` + no `n8n_event_id` determinístico p/ idempotência).
 */
export interface ReconstructedMessage {
  role: "customer" | "assistant" | "system"
  text: string
  /** clique de botão → button_id (senão null). */
  button_id: number | null
  /** prompt de origem (quando o evento aponta para um chat_prompts). */
  prompt_id: string | null
  n8n_execution_id: string | null
  /** created_at determinístico = occurred_at do evento de origem. */
  created_at: string
  /** id determinístico p/ dedupe idempotente: `reconstructed:<eventId>`. */
  reconstruction_id: string
  /** tipo de evento que originou a linha (auditoria / marcador). */
  source_event_type: string
}

/** Evento que NÃO pôde ser reconstituído (para contagem/relatório; nunca inserido). */
export interface UnreconstructableEvent {
  id: string | number
  event_type: string
  reason: string
}

export interface MapResult {
  messages: ReconstructedMessage[]
  skipped: UnreconstructableEvent[]
}

/** Prefixo do marcador de idempotência gravado em chat_messages.n8n_event_id. */
export const RECONSTRUCTION_PREFIX = "reconstructed:"

/** id determinístico de uma linha reconstruída (idempotência por session+este id). */
export function reconstructionIdFor(eventId: string | number): string {
  return `${RECONSTRUCTION_PREFIX}${eventId}`
}

/** Só eventos com um id de execução no payload propagam n8n_execution_id. */
function n8nExecFromPayload(payload: Record<string, unknown> | null): string | null {
  const v = payload?.["n8n_execution_id"]
  return typeof v === "string" && v.length > 0 ? v : null
}

/** Extrai um texto livre do payload (chat.turn.*), se houver — sem inventar. */
function textFromPayload(payload: Record<string, unknown> | null): string | null {
  for (const key of ["text", "reply", "message"]) {
    const v = payload?.[key]
    if (typeof v === "string" && v.trim().length > 0) return v.trim()
  }
  return null
}

const BRL = (v: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v || 0)

/**
 * Resumo sintético de uma oferta apresentada — montado SOMENTE de campos
 * estruturados do payload (parcelas + total). Sem texto livre. Determinístico.
 * Retorna null se não há estrutura suficiente (aí o evento é não-reconstituível).
 */
function offerSummary(payload: Record<string, unknown> | null): string | null {
  const installments = Number(payload?.["installments"])
  const totalRaw = payload?.["total"]
  const total = typeof totalRaw === "number" ? totalRaw : Number(totalRaw)
  const hasInst = Number.isFinite(installments) && installments > 0
  const hasTotal = Number.isFinite(total) && total > 0
  if (!hasInst && !hasTotal) return null
  if (hasInst && hasTotal) {
    const per = total / installments
    return `Proposta: ${installments}x de ${BRL(per)} (total ${BRL(total)}).`
  }
  if (hasTotal) return `Proposta: total ${BRL(total)}.`
  return `Proposta em ${installments}x.`
}

/**
 * Mapeia os journey_events de UMA sessão para as linhas de chat_messages
 * reconstituíveis. Ordena por occurred_at (empate → id) para uma timeline
 * estável. `promptsById` traz os chat_prompts referenciados (o script os
 * pré-carrega); sem o prompt, um chat.turn.assistant/ack só é reconstituível se
 * o próprio payload trouxer o texto. NÃO acessa o banco: é puro.
 */
export function mapEventsToChatMessages(
  events: ReconstructEvent[],
  promptsById: Map<string, ReconstructPrompt> = new Map(),
): MapResult {
  const messages: ReconstructedMessage[] = []
  const skipped: UnreconstructableEvent[] = []

  const ordered = [...events].sort((a, b) => {
    if (a.occurred_at !== b.occurred_at) return a.occurred_at < b.occurred_at ? -1 : 1
    return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0
  })

  for (const ev of ordered) {
    const payload = ev.payload ?? {}
    const promptId = typeof payload["prompt_id"] === "string" ? (payload["prompt_id"] as string) : null
    const prompt = promptId ? promptsById.get(promptId) ?? null : null

    const base = {
      created_at: ev.occurred_at,
      reconstruction_id: reconstructionIdFor(ev.id),
      source_event_type: ev.event_type,
      n8n_execution_id: n8nExecFromPayload(payload) ?? prompt?.n8n_execution_id ?? null,
    }

    switch (ev.event_type) {
      case "chat.turn.customer": {
        const text = textFromPayload(payload)
        if (!text) {
          skipped.push({ id: ev.id, event_type: ev.event_type, reason: "no_customer_text" })
          break
        }
        messages.push({ ...base, role: "customer", text, button_id: null, prompt_id: promptId })
        break
      }

      case "chat.turn.assistant": {
        // 1) texto livre no payload (raro nas antigas) tem prioridade;
        // 2) senão, o texto do prompt referenciado (a pergunta do assistente);
        // 3) senão, é uma anotação de transição de engine (event/engine_owner) sem
        //    conteúdo — NÃO inventa: fica não-reconstituível.
        const text = textFromPayload(payload) ?? prompt?.question ?? null
        if (!text) {
          const reason = promptId ? "prompt_unavailable" : "no_assistant_text"
          skipped.push({ id: ev.id, event_type: ev.event_type, reason })
          break
        }
        messages.push({ ...base, role: "assistant", text, button_id: null, prompt_id: promptId })
        break
      }

      case "debt.acknowledged":
      case "debt.not_recognized": {
        const buttonIdRaw = payload["button_id"]
        const buttonId =
          typeof buttonIdRaw === "number"
            ? buttonIdRaw
            : ev.event_type === "debt.acknowledged"
              ? BTN_YES
              : BTN_NO
        // label do botão via prompt (fiel ao que o cliente viu); fallback textual
        // fixo (Sim/Não reconhece) só quando o prompt não está disponível.
        const label =
          (prompt ? findButton(prompt.buttons, buttonId)?.label : null) ??
          (buttonId === BTN_YES ? "Sim, reconheço" : "Não reconheço")
        messages.push({
          ...base,
          role: "customer",
          text: label,
          button_id: buttonId,
          prompt_id: promptId,
        })
        break
      }

      case "offer.presented": {
        const summary = offerSummary(payload)
        if (!summary) {
          skipped.push({ id: ev.id, event_type: ev.event_type, reason: "offer_not_structured" })
          break
        }
        messages.push({ ...base, role: "assistant", text: summary, button_id: null, prompt_id: promptId })
        break
      }

      default:
        // Eventos de ciclo (auth.success, consent.given, session.started, payment.*,
        // etc.) NÃO são turnos de chat — a timeline já os mostra como eventos. Não
        // viram mensagem.
        skipped.push({ id: ev.id, event_type: ev.event_type, reason: "not_a_chat_turn" })
    }
  }

  return { messages, skipped }
}

/** Tipos de evento que este helper pode reconstituir (para pré-filtro no script). */
export const RECONSTRUCTIBLE_EVENT_TYPES: readonly string[] = [
  "chat.turn.customer",
  "chat.turn.assistant",
  "debt.acknowledged",
  "debt.not_recognized",
  "offer.presented",
] as const

/**
 * Monta o objeto `offers_snapshot` (jsonb) que marca a linha como reconstruída —
 * a coluna nativa reutilizada como marcador de origem (chat_messages não tem
 * coluna própria de 'source'; o painel já reusa offers_snapshot para metadados).
 */
export function reconstructedMarker(m: ReconstructedMessage): Record<string, unknown> {
  return {
    reconstructed: true,
    reconstruction_id: m.reconstruction_id,
    source_event_type: m.source_event_type,
  }
}
