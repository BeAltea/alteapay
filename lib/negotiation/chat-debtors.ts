// Agregação PURA (sem banco, sem React) da lista do painel /super-admin/negociacoes-chat.
//
// A1.2: a lista passa a ser POR DEVEDOR — uma linha por (company_id, customer_id)
// — em vez de por sessão. Isso resolve o sintoma "6 linhas do mesmo devedor" no
// display (o reuso de sessão na origem é outra trilha). As sessões individuais
// ficam disponíveis para expandir.
//
// A1.3: os KPIs derivam desta mesma agregação, de modo coerente:
//   - Devedores em negociação (linhas distintas) + Sessões (número secundário)
//   - % de autenticação (devedores com ao menos 1 sessão autenticada)
//   - Conversas ativas (sessões com mensagem nos últimos CHAT_ACTIVE_WINDOW_MIN)
//   - Acordos fechados / Redirects (separados, com R$)
//   - Reconhecimentos (sim/não)
//
// Toda entrada aqui já vem mascarada da camada de dados (nome/doc). Nunca há PII
// em claro neste módulo.

import { STAGE_META } from "@/components/super-admin/negotiations/stages"

/** Janela (min) para "conversa ativa". Default 30; sobrescrito por env. */
export function activeWindowMinutes(): number {
  const raw = process.env.CHAT_ACTIVE_WINDOW_MIN
  const n = raw ? Number.parseInt(raw, 10) : NaN
  return Number.isFinite(n) && n > 0 ? n : 30
}

/** Rank de estágio para escolher o "mais avançado" do devedor (espelha stages.ts). */
const STAGE_RANK_BY_KEY = new Map(STAGE_META.map((m) => [m.stage, m.rank]))

/**
 * Mapeia o `outcome` de uma sessão para um "estágio" comparável (rank do funil),
 * para escolher o estágio MAIS AVANÇADO entre as sessões do devedor. Só usamos os
 * outcomes que a tabela legada de sessões conhece.
 */
const OUTCOME_TO_STAGE: Record<string, string> = {
  in_progress: "in_chat",
  agreement_closed: "charge_generated",
  redirected_official: "offer_presented",
  handoff_human: "human_handoff",
  abandoned: "chat_idle",
  identity_failed: "no_contact",
  expired: "chat_idle",
}

/** Estágio (chave) derivado de uma sessão, considerando funil + reconhecimento. */
export function sessionStage(s: {
  outcome: string
  identity_verified: boolean
  debt_acknowledged: boolean
  message_count: number
}): string {
  if (s.outcome === "agreement_closed") return "charge_generated"
  if (s.outcome === "redirected_official") return "offer_presented"
  if (s.outcome === "handoff_human") return "human_handoff"
  if (s.debt_acknowledged) return "acknowledged"
  if (s.message_count > 0 && s.identity_verified) return "in_chat"
  if (s.identity_verified) return "authenticated"
  return OUTCOME_TO_STAGE[s.outcome] ?? "not_started"
}

function stageRank(stage: string): number {
  return STAGE_RANK_BY_KEY.get(stage) ?? 0
}

/** Uma sessão individual (já mascarada) usada para agregar por devedor. */
export interface ChatSessionInput {
  id: string
  company_id: string
  customer_id: string | null
  company_name: string
  customer_name_masked: string
  document_masked: string
  channel: string | null
  channel_origin: string
  engine: string | null
  fulfillment_mode: string | null
  outcome: string
  identity_verified: boolean
  consent_given: boolean
  debt_acknowledged: boolean
  agreement_id: string | null
  message_count: number
  created_at: string
  /** created_at da mensagem mais recente da sessão (para "conversa ativa"). */
  last_message_at: string | null
  /** last_activity_at da sessão (fallback quando não há mensagem). */
  last_activity_at: string | null
}

/** Uma sessão como exibida ao expandir a linha do devedor. */
export interface DebtorSessionRow {
  id: string
  created_at: string
  last_activity_at: string | null
  channel: string
  engine: string | null
  fulfillment_mode: string | null
  outcome: string
  identity_verified: boolean
  message_count: number
  agreement_id: string | null
}

/** Uma linha da lista: um devedor (agregado de suas sessões). */
export interface DebtorRow {
  /** chave estável company_id:customer_id (customer_id null → id da 1ª sessão). */
  key: string
  company_id: string
  customer_id: string | null
  company_name: string
  customer_name_masked: string
  document_masked: string
  session_count: number
  /** created_at da sessão MAIS ANTIGA (Início). */
  started_at: string
  /** atividade mais recente (msg ou last_activity_at) entre as sessões. */
  last_activity_at: string
  /** canal da sessão MAIS RECENTE. */
  channel: string
  /** engine da sessão mais recente (fallback: qualquer não-nulo). */
  engine: string | null
  /** soma das mensagens de todas as sessões. */
  message_count: number
  /** estágio MAIS AVANÇADO entre as sessões. */
  stage: string
  /** resultado da sessão CANÔNICA (a mais avançada; empate → mais recente). */
  outcome: string
  /** algum reconhecimento de dívida (sim/não). */
  acknowledged: boolean
  /** algum acordo fechado. */
  agreement_id: string | null
  /** link de pagamento ASAAS enviado (invoiceUrl/boleto/pix). Consultável no hub;
   * a AlteaPay o compartilha pelo chat/e-mail/WhatsApp (o ASAAS não comunica). */
  payment_link?: string | null
  /** status de pagamento do acordo (payment_status/asaas_status). */
  payment_status?: string | null
  /** true quando conciliado como pago — o link fica só para consulta, sem cobrar. */
  payment_paid?: boolean
  /** sessões individuais (para expandir). */
  sessions: DebtorSessionRow[]
}

function normalizeChannel(s: ChatSessionInput): string {
  return s.channel ?? s.channel_origin ?? "—"
}

/** Escolhe a sessão canônica: estágio mais avançado; empate → mais recente. */
function pickCanonical(sessions: ChatSessionInput[]): ChatSessionInput {
  return sessions.reduce((best, cur) => {
    const rb = stageRank(sessionStage(best))
    const rc = stageRank(sessionStage(cur))
    if (rc > rb) return cur
    if (rc === rb && cur.created_at > best.created_at) return cur
    return best
  })
}

/** activity efetiva de uma sessão (msg mais recente, senão last_activity_at, senão created_at). */
function sessionActivity(s: ChatSessionInput): string {
  return s.last_message_at ?? s.last_activity_at ?? s.created_at
}

/**
 * Agrupa sessões por (company_id, customer_id). Sessões sem customer_id não se
 * agrupam entre si (cada uma vira seu próprio "devedor" com chave pela sessão).
 * Saída ordenada por atividade mais recente desc.
 */
export function groupByDebtor(sessions: ChatSessionInput[]): DebtorRow[] {
  const groups = new Map<string, ChatSessionInput[]>()
  for (const s of sessions) {
    const key = s.customer_id ? `${s.company_id}:${s.customer_id}` : `session:${s.id}`
    const arr = groups.get(key)
    if (arr) arr.push(s)
    else groups.set(key, [s])
  }

  const rows: DebtorRow[] = []
  for (const [key, group] of groups) {
    // ordena sessões por created_at asc (Início = mais antiga)
    const ordered = [...group].sort((a, b) => a.created_at.localeCompare(b.created_at))
    const oldest = ordered[0]
    const newest = ordered[ordered.length - 1]
    const canonical = pickCanonical(ordered)
    const stage = ordered
      .map(sessionStage)
      .reduce((a, b) => (stageRank(b) > stageRank(a) ? b : a))
    const lastActivity = ordered
      .map(sessionActivity)
      .reduce((a, b) => (b > a ? b : a))
    const engine =
      newest.engine ?? ordered.map((s) => s.engine).find((e) => e != null) ?? null

    rows.push({
      key,
      company_id: oldest.company_id,
      customer_id: oldest.customer_id,
      company_name: oldest.company_name,
      customer_name_masked: oldest.customer_name_masked,
      document_masked: oldest.document_masked,
      session_count: ordered.length,
      started_at: oldest.created_at,
      last_activity_at: lastActivity,
      channel: normalizeChannel(newest),
      engine,
      message_count: ordered.reduce((sum, s) => sum + s.message_count, 0),
      stage,
      outcome: canonical.outcome,
      acknowledged: ordered.some((s) => s.debt_acknowledged),
      agreement_id: ordered.find((s) => s.agreement_id)?.agreement_id ?? null,
      sessions: ordered.map((s) => ({
        id: s.id,
        created_at: s.created_at,
        last_activity_at: s.last_activity_at,
        channel: normalizeChannel(s),
        engine: s.engine,
        fulfillment_mode: s.fulfillment_mode,
        outcome: s.outcome,
        identity_verified: s.identity_verified,
        message_count: s.message_count,
        agreement_id: s.agreement_id,
      })),
    })
  }

  rows.sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at))
  return rows
}

/** Uma sessão "ativa" tem mensagem dentro da janela. Puro/testável. */
export function isActiveSession(
  s: Pick<ChatSessionInput, "last_message_at">,
  now: number,
  windowMin: number,
): boolean {
  if (!s.last_message_at) return false
  const t = new Date(s.last_message_at).getTime()
  if (!Number.isFinite(t)) return false
  return now - t <= windowMin * 60_000
}

export interface ChatKpis {
  /** devedores distintos em negociação (linhas da lista). */
  debtors: number
  /** total de sessões (número secundário). */
  sessions: number
  /** devedores com ao menos uma sessão autenticada. */
  authenticatedDebtors: number
  /** % de autenticação (0–100, arredondado). */
  authRatePct: number
  /** sessões com mensagem nos últimos `windowMin` minutos. */
  activeConversations: number
  /** janela usada (min) — para o rótulo explícito. */
  activeWindowMin: number
  /** acordos fechados (nº de devedores com agreement_closed) + soma R$. */
  agreementsClosed: number
  agreementsClosedAmount: number
  /** redirects (nº de eventos) + soma R$. */
  redirects: number
  redirectsAmount: number
  /** reconhecimentos de dívida: sim (reconheceu) / não (não reconheceu). */
  ackYes: number
  ackNo: number
}

export interface KpiInputs {
  debtors: DebtorRow[]
  sessions: ChatSessionInput[]
  /** soma R$ dos acordos fechados (dos agreements dos devedores). */
  agreementsClosedAmount: number
  /** redirects: contagem e soma R$ (de redirect_events). */
  redirectCount: number
  redirectAmount: number
  /** reconhecimentos: (de debt_acknowledgement_latest / journey_events). */
  ackYes: number
  ackNo: number
  now: number
  windowMin: number
}

/** Calcula os KPIs coerentes do topo do painel. Puro/testável. */
export function computeKpis(input: KpiInputs): ChatKpis {
  const debtors = input.debtors.length
  const sessions = input.sessions.length
  const authenticatedDebtors = input.debtors.filter((d) =>
    d.sessions.some((s) => s.identity_verified),
  ).length
  const activeConversations = input.sessions.filter((s) =>
    isActiveSession(s, input.now, input.windowMin),
  ).length
  const agreementsClosed = input.debtors.filter(
    (d) => d.outcome === "agreement_closed" || d.agreement_id != null,
  ).length
  return {
    debtors,
    sessions,
    authenticatedDebtors,
    authRatePct: debtors > 0 ? Math.round((authenticatedDebtors / debtors) * 100) : 0,
    activeConversations,
    activeWindowMin: input.windowMin,
    agreementsClosed,
    agreementsClosedAmount: input.agreementsClosedAmount,
    redirects: input.redirectCount,
    redirectsAmount: input.redirectAmount,
    ackYes: input.ackYes,
    ackNo: input.ackNo,
  }
}
