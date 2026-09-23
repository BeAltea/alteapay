// Envelope canônico dos eventos plataforma → n8n (Frente A, onda D1).
//
// UMA fonte de verdade para os 3 eventos que a plataforma dispara ao fluxo n8n:
//   - session.start     (enxuto, no login)          → buildSessionStartPayload
//   - chat.turn         (por turno)                  → buildChatTurnPayload
//   - negotiation.start (rico, no clique "Sim")      → buildNegotiationStartPayload
//
// Todos compartilham o MESMO envelope (superset compatível com o Apêndice A do
// prompt da onda): todo campo do exemplo está presente com o mesmo tipo; os
// campos aditivos (amount_cents/amount_formatted/button.numeric_id/tenant.chat_link/
// contract_version) são acréscimos, nunca substituições.
//
// Invariantes G0:
//   - Máscara MANTIDA: maskDocument de lib/journey/document.ts (***.456.789-**).
//   - Valores REAIS no banco (numeric(10,2)); o payload manda os 3: amount (reais),
//     amount_cents (round(reais*100)), amount_formatted ("R$ 1.234,56"). O ASAAS
//     segue em REAIS — este módulo NÃO toca ASAAS.
//   - Sem e-mail/telefone no payload. Documento em claro = null (só máscara+hash).
//   - Serialização ESTÁVEL (ordem de chave determinística): o HMAC é sobre o corpo
//     cru serializado com stableStringify.
//   - Campo ausente = null EXPLÍCITO (nunca undefined/omitido).

import { createHash } from "node:crypto"

import { agingDays } from "@/lib/negotiation/config"
import { maskDocument, normalizeDocument } from "@/lib/journey/document"

export const CONTRACT_VERSION = "1.0"

// Tipos internos de canal (enum da coluna negotiation_sessions.channel) → o rótulo
// externo do Apêndice B. Todo canal web colapsa para "webchat"; n8n/whatsapp são
// mantidos para quando um turno chegar por esses caminhos.
const CHANNEL_MAP: Record<string, PayloadChannel> = {
  web_public_link: "webchat",
  web_campaign: "webchat",
  web_generic: "webchat",
  admin_preview: "webchat",
  webchat: "webchat",
  whatsapp: "whatsapp",
  n8n: "n8n",
}

export type PayloadChannel = "webchat" | "whatsapp" | "n8n"

/** Mapa interno → rótulo do Apêndice B. Canal desconhecido cai em "webchat". */
export function mapChannel(internal: string | null | undefined): PayloadChannel {
  if (!internal) return "webchat"
  return CHANNEL_MAP[internal] ?? "webchat"
}

// Rótulos default dos eventos (o tenant pode sobrepor via tenant_chat_config.
// n8n_event_names, mapa {session_start, chat_turn, negotiation_start}).
export const DEFAULT_EVENT_NAMES = {
  session_start: "session.start",
  chat_turn: "chat.turn",
  negotiation_start: "negotiation.start",
} as const

export type EventKind = keyof typeof DEFAULT_EVENT_NAMES

export interface EventNameOverrides {
  session_start?: string | null
  chat_turn?: string | null
  negotiation_start?: string | null
}

/** Resolve o rótulo do evento a partir do override do tenant (default fixo). */
export function resolveEventName(kind: EventKind, overrides?: EventNameOverrides | null): string {
  const raw = overrides?.[kind]
  if (typeof raw === "string" && raw.trim() !== "") return raw.trim()
  return DEFAULT_EVENT_NAMES[kind]
}

// ---------------------------------------------------------------------------
// Serialização estável: ordem de chave determinística em qualquer profundidade.
// O corpo assinado (HMAC) é EXATAMENTE esta string — nunca re-serializar depois.

/** JSON com chaves ordenadas recursivamente. Arrays preservam a ordem. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

// ---------------------------------------------------------------------------
// event_id DETERMINÍSTICO. A reentrada da MESMA abertura (mesmo session_id +
// reopen_count) NÃO re-dispara o session.start; o chat.turn distingue por seq do
// turno. Um hash estável (sha256 → 32 hex) sobre a tupla de identidade.

export interface EventIdParts {
  sessionId: string
  reopenCount: number
  kind: EventKind
  /** Sequência do turno (chat.turn); 0 para session.start/negotiation.start. */
  seq?: number
}

export function deterministicEventId(parts: EventIdParts): string {
  const seq = parts.seq ?? 0
  const material = `${parts.sessionId}|${parts.reopenCount}|${parts.kind}|${seq}`
  return createHash("sha256").update(material).digest("hex").slice(0, 32)
}

// ---------------------------------------------------------------------------
// thread_id ESTÁVEL por sessão, derivado do session_id — NUNCA o UUID cru. Mesmo
// esquema já usado em createHandoffSession (`web_<session_id>`); centralizado aqui.
export function threadIdOf(sessionId: string, existing?: string | null): string {
  if (typeof existing === "string" && existing.trim() !== "") return existing
  return `web_${sessionId}`
}

// ---------------------------------------------------------------------------
// Formatação monetária. amount = reais (do banco); amount_cents = round(reais*100);
// amount_formatted = "R$ 1.234,56" (pt-BR).
const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" })

export function toCents(reais: number | null | undefined): number | null {
  return reais == null ? null : Math.round(reais * 100)
}

export function formatBRL(reais: number | null | undefined): string | null {
  return reais == null ? null : BRL.format(reais)
}

// ---------------------------------------------------------------------------
// Estruturas do envelope.

export interface PayloadButton {
  id: string
  numeric_id: number
  text: string | null
}

export interface PayloadDebtor {
  document: null // NUNCA em claro neste caminho
  document_masked: string
  document_hash: string
}

export interface PayloadDebt {
  amount: number | null
  amount_cents: number | null
  amount_formatted: string | null
  currency: "BRL"
  due_date: string | null
  aging_days: number | null
  invoice_count: number
  has_live_charge: boolean
}

export interface PayloadTenant {
  official_channel_label: string | null
  brand_name: string
  chat_link: string | null
}

export interface PayloadSessionState {
  identity_verified: boolean
  debt_acknowledged: boolean
  fulfillment_mode: string
  outcome: string | null
}

export interface CanonicalEnvelope {
  type: string
  contract_version: string
  event_id: string
  occurred_at: string
  thread_id: string
  session_id: string
  company_id: string
  channel: PayloadChannel
  message: string | null
  button: PayloadButton | null
  session_state: PayloadSessionState
  debtor: PayloadDebtor | null
  debt: PayloadDebt | null
  tenant: PayloadTenant
}

// Entradas canônicas que o chamador reúne (do banco/buildAckContext) e este
// módulo transforma em envelope. Reais no `amount` (do banco), NUNCA centavos.
export interface DebtorInput {
  /** Documento em CLARO (só para derivar máscara + hash — nunca vai no payload). */
  document: string
}

export interface DebtInput {
  /** Valor aberto consolidado em REAIS (do banco). null quando indisponível. */
  amount: number | null
  /** Vencimento ORIGINAL mais antigo (YYYY-MM-DD) — base do aging_days. */
  dueDate: string | null
  invoiceCount: number
  hasLiveCharge: boolean
}

export interface TenantInput {
  officialChannelLabel: string | null
  brandName: string
  /** public_link_code do tenant (para montar o chat_link). null → chat_link null. */
  publicLinkCode: string | null
}

export interface SessionStateInput {
  identityVerified: boolean
  debtAcknowledged: boolean
  fulfillmentMode: string
  outcome: string | null
}

export interface ButtonInput {
  id: string
  numericId: number
  text: string | null
}

export interface BuildEnvelopeInput {
  kind: EventKind
  eventNames?: EventNameOverrides | null
  sessionId: string
  companyId: string
  reopenCount: number
  threadId?: string | null
  channel: string | null
  /** Sequência do turno (só chat.turn); default 0. */
  seq?: number
  message?: string | null
  button?: ButtonInput | null
  sessionState: SessionStateInput
  debtor: DebtorInput | null
  debt: DebtInput | null
  tenant: TenantInput
  /** Timestamp do evento (ISO). Injeta para testes determinísticos. */
  occurredAt?: string
  /** event_id explícito (raro): por padrão é determinístico. */
  eventId?: string
}

/** URL /n/{code} do link público do tenant. null quando não há code. */
function chatLinkOf(publicLinkCode: string | null): string | null {
  if (!publicLinkCode) return null
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? "https://alteapay.com").replace(/\/+$/, "")
  return `${base}/n/${publicLinkCode}`
}

/**
 * Monta o envelope canônico. Campo ausente = null EXPLÍCITO. O `type` sai do mapa
 * de rótulos (default fixo, override por tenant). O documento em claro nunca entra
 * (só máscara + hash). Reusa `amount` REAIS (do banco) para derivar cents/formatted.
 */
export function buildEnvelope(input: BuildEnvelopeInput): CanonicalEnvelope {
  const type = resolveEventName(input.kind, input.eventNames)
  const eventId =
    input.eventId ??
    deterministicEventId({
      sessionId: input.sessionId,
      reopenCount: input.reopenCount,
      kind: input.kind,
      seq: input.seq ?? 0,
    })

  const debtor: PayloadDebtor | null = input.debtor
    ? {
        document: null,
        document_masked: maskDocument(input.debtor.document),
        document_hash: createHash("sha256").update(normalizeDocument(input.debtor.document)).digest("hex"),
      }
    : null

  const debt: PayloadDebt | null = input.debt
    ? {
        amount: input.debt.amount,
        amount_cents: toCents(input.debt.amount),
        amount_formatted: formatBRL(input.debt.amount),
        currency: "BRL",
        due_date: input.debt.dueDate,
        aging_days: input.debt.dueDate ? agingDays(input.debt.dueDate) : null,
        invoice_count: input.debt.invoiceCount,
        has_live_charge: input.debt.hasLiveCharge,
      }
    : null

  const button: PayloadButton | null = input.button
    ? { id: input.button.id, numeric_id: input.button.numericId, text: input.button.text }
    : null

  return {
    type,
    contract_version: CONTRACT_VERSION,
    event_id: eventId,
    occurred_at: input.occurredAt ?? new Date().toISOString(),
    thread_id: threadIdOf(input.sessionId, input.threadId),
    session_id: input.sessionId,
    company_id: input.companyId,
    channel: mapChannel(input.channel),
    message: input.message ?? null,
    button,
    session_state: {
      identity_verified: input.sessionState.identityVerified,
      debt_acknowledged: input.sessionState.debtAcknowledged,
      fulfillment_mode: input.sessionState.fulfillmentMode,
      outcome: input.sessionState.outcome,
    },
    debtor,
    debt,
    tenant: {
      official_channel_label: input.tenant.officialChannelLabel,
      brand_name: input.tenant.brandName,
      chat_link: chatLinkOf(input.tenant.publicLinkCode),
    },
  }
}
