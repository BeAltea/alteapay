// Montagem PURA (sem banco) do transcript com contexto do painel
// /super-admin/negociacoes-chat (A2.3).
//
// Combina, em ordem cronológica:
//   - mensagens do chat (chat_messages: role/text/button_id/prompt_id/engine/n8n_execution_id)
//   - eventos da sessão (journey_events: event_type/actor/occurred_at)
// e rotula tudo em pt-BR compreensível sem treino. Nunca há PII em claro aqui
// (o texto já chega redigido da camada de dados).

/** Item unificado da timeline do transcript. */
export interface TranscriptItem {
  kind: "message" | "event"
  /** id estável para React (prefixado por kind). */
  key: string
  at: string
  /** quem: customer | assistant | system (mensagens) ou o actor do evento. */
  actor: string
  /** rótulo pt-BR do que aconteceu. */
  label: string
  /** texto da mensagem (só kind=message). */
  text: string | null
  /** botão clicado (só kind=message quando veio de clique). */
  buttonId: number | null
  /** engine que respondeu (só assistant). */
  engine: string | null
  /** rastreio n8n — exibido em badge SOMENTE super_admin. */
  n8nExecutionId: string | null
}

export interface TranscriptMessageInput {
  id: string
  role: "customer" | "assistant" | "system"
  text: string
  button_id: number | null
  prompt_id: string | null
  n8n_execution_id: string | null
  engine: string | null
  latency_ms: number | null
  created_at: string
}

export interface TranscriptEventInput {
  id: number | string
  event_type: string
  actor: string
  occurred_at: string
  payload: Record<string, unknown> | null
}

/** Rótulos pt-BR para os tipos de evento da jornada exibidos na timeline. */
const EVENT_LABELS: Record<string, string> = {
  "campaign.created": "Campanha criada",
  "campaign.started": "Campanha iniciada",
  "message.queued": "Mensagem enfileirada",
  "message.suppressed": "Mensagem suprimida",
  "message.sent": "Mensagem enviada",
  "message.delivered": "Mensagem entregue",
  "message.read": "Mensagem lida",
  "message.failed": "Falha no envio",
  "message.accepted": "Mensagem aceita",
  "link.clicked": "Link aberto",
  "auth.attempt": "Tentativa de autenticação",
  "auth.failed": "Autenticação falhou",
  "auth.locked": "Bloqueio de autenticação",
  "auth.success": "Autenticado",
  "auth.no_debt": "Autenticado (sem dívida)",
  "consent.given": "Consentimento LGPD",
  "session.started": "Sessão iniciada",
  "session.closed": "Sessão encerrada",
  "chat.turn.customer": "Turno do cliente",
  "chat.turn.assistant": "Turno do assistente",
  "chat.engine_error": "Falha do motor (fallback)",
  "chat.engine_invalid_action": "Ação recusada (fora da matriz)",
  "debt.viewed": "Dívida visualizada",
  "debt.acknowledged": "Dívida reconhecida",
  "debt.not_recognized": "Dívida não reconhecida",
  "offer.presented": "Oferta apresentada",
  "offer.invalid": "Oferta inválida",
  "offer.accepted": "Oferta aceita",
  "offer.rejected": "Oferta rejeitada",
  "offer.expired": "Oferta expirada",
  "agreement.created": "Acordo criado",
  "payment.generated": "Cobrança gerada",
  "payment.viewed": "Cobrança visualizada",
  "payment.paid": "Pagamento confirmado",
  "payment.overdue": "Pagamento em atraso",
  "payment.cancelled": "Cobrança cancelada",
  "receipt.issued": "Recibo emitido",
  "creditor.notified": "Credor notificado",
  "dispute.registered": "Contestação registrada",
  "payment_claim.registered": "Alegação de pagamento",
  "human.transfer": "Transferido para atendente",
  "optout.received": "Opt-out recebido",
  "block.received": "Bloqueio recebido",
  "document.revealed": "Documento revelado (auditoria)",
}

export function eventLabel(eventType: string): string {
  return EVENT_LABELS[eventType] ?? eventType
}

/** Eventos que NÃO viram item de timeline (ruído — já representados por mensagens). */
const HIDDEN_EVENTS = new Set(["chat.turn.customer", "chat.turn.assistant"])

const ROLE_LABEL: Record<string, string> = {
  customer: "Cliente",
  assistant: "Assistente",
  system: "Sistema",
}

/** Rótulo de uma mensagem de chat (considerando clique de botão). */
function messageLabel(m: TranscriptMessageInput): string {
  const base = ROLE_LABEL[m.role] ?? m.role
  if (m.button_id != null) return `${base} (botão ${m.button_id})`
  return base
}

/**
 * Monta a timeline unificada, cronológica. Mensagens sempre entram; eventos só
 * os que agregam contexto (auth, consentimento, reconhecimento, oferta, acordo,
 * pagamento, fallback…). Ordenação estável por timestamp; empate → mensagem antes
 * de evento (a mensagem é o fato, o evento é a anotação).
 */
export function buildTimeline(
  messages: TranscriptMessageInput[],
  events: TranscriptEventInput[],
): TranscriptItem[] {
  const items: TranscriptItem[] = []

  for (const m of messages) {
    items.push({
      kind: "message",
      key: `m:${m.id}`,
      at: m.created_at,
      actor: m.role,
      label: messageLabel(m),
      text: m.text,
      buttonId: m.button_id,
      engine: m.role === "assistant" ? m.engine : null,
      n8nExecutionId: m.n8n_execution_id,
    })
  }

  for (const e of events) {
    if (HIDDEN_EVENTS.has(e.event_type)) continue
    items.push({
      kind: "event",
      key: `e:${e.id}`,
      at: e.occurred_at,
      actor: e.actor,
      label: eventLabel(e.event_type),
      text: null,
      buttonId: null,
      engine: null,
      n8nExecutionId: null,
    })
  }

  items.sort((a, b) => {
    if (a.at !== b.at) return a.at.localeCompare(b.at)
    if (a.kind !== b.kind) return a.kind === "message" ? -1 : 1
    return a.key.localeCompare(b.key)
  })
  return items
}

/**
 * Explicação para SESSÃO SEM MENSAGEM (não abrir vazia). Se a sessão foi
 * autenticada mas nenhuma mensagem foi trocada, devolvemos uma frase objetiva;
 * senão, null (há timeline para exibir).
 */
export function emptySessionExplanation(input: {
  hasMessages: boolean
  identityVerifiedAt: string | null
  createdAt: string
}): string | null {
  if (input.hasMessages) return null
  if (input.identityVerifiedAt) {
    return `Sessão autenticada em ${input.identityVerifiedAt}. Nenhuma mensagem trocada.`
  }
  return `Sessão iniciada em ${input.createdAt}. Nenhuma mensagem trocada (não autenticada).`
}

/** Duração legível (a partir de início/fim em ISO). Null quando não há fim. */
export function humanDuration(startIso: string, endIso: string | null): string | null {
  if (!endIso) return null
  const secs = Math.max(0, Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 1000))
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const remS = secs % 60
  if (mins < 60) return remS ? `${mins}min ${remS}s` : `${mins}min`
  const hrs = Math.floor(mins / 60)
  const remM = mins % 60
  return remM ? `${hrs}h ${remM}min` : `${hrs}h`
}
