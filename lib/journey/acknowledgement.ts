// Reconhecimento da dívida (onda R, §3). PRIMEIRO passo do chat, determinístico
// e local (não chama n8n antes da resposta). Log append-only auditável.
//
// Fluxo:
//  - buildAcknowledgementPrompt: monta o resumo (credor, valor atualizado, N
//    faturas, vencimento mais antigo) + pergunta Sim/Não e cria o chat_prompts.
//  - recordAcknowledgement: grava numa "transação" lógica (4 efeitos):
//      1) chat_prompts → answered (via answerPrompt, que também grava a mensagem
//         do cliente com o label + button_id);
//      2) debt_acknowledgements (append-only, button_id 0|1);
//      3) journey_events (debt.acknowledged | debt.not_recognized);
//      4) negotiation_sessions.debt_acknowledged_at (espelho do timestamp).
//  - getLatestAcknowledgement: última resposta por (session, debt) via view.
//  - assertAcknowledgedForPayment: invariante do payment.create.
//
// IDs: 1=Sim reconhece, 0=Não reconhece. show_handoff_button liga o [99].

import { createHash, randomUUID } from "node:crypto"
import { createServiceClient } from "@/lib/supabase/service"
import { recordEvent } from "./events"
import {
  BTN_BACK,
  BTN_CONSULT,
  BTN_HANDOFF,
  BTN_NEGOTIATE,
  BTN_NO,
  BTN_PAY,
  BTN_YES,
  type Button,
} from "./buttons"
import { createPrompt, answerPrompt, getActivePrompt, promptView, type PromptRow, type PromptView } from "./prompts"
import { listOffers, type ListedOffer, type SessionCtx } from "./actions"
import type { OfferTerms } from "@/lib/negotiation/offers"
import { NEGOTIATION_PENDING_TEXT, NEGOTIATION_SEARCHING_TEXT } from "./wait-machine"
import { formatDueDatePt } from "./pay-poll"

const BRL = (v: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v || 0)

/**
 * dd/mm/aaaa; ausente/inválida → "" (o chamador omite o segmento — nunca um
 * placeholder na fala do devedor). A4 r2 (B3-F4), sem depender do fuso do runtime:
 *  - data civil (`YYYY-MM-DD`, coluna `date`: vencimento) → componentes por regex
 *    (formatDueDatePt, sem `Date`): "2026-08-15" é 15/08 em qualquer fuso;
 *  - instante (`timestamptz` ISO: pagamento recebido) → dia civil em
 *    America/Sao_Paulo (o runtime da Netlify é UTC; 22h de Brasília não vira o
 *    dia seguinte).
 */
function formatDatePt(iso: string | null): string {
  if (!iso) return ""
  const s = iso.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return formatDueDatePt(s)
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return ""
  return d.toLocaleDateString("pt-BR", {
    timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric",
  })
}

/**
 * A4 (Apêndice B) — abertura comum a TODAS as saudações da jornada: identifica o
 * canal (oficial, de negociação, da {credor}) e a AlteaPay como operadora. Sem
 * valor, sem "Tudo bem?", sem emoji, sem "se já pagou desconsidere". Sem nome →
 * "Olá." (nunca "Olá, ."/"null").
 */
function channelGreeting(ctx: Pick<AckContext, "firstName" | "creditorName">): string {
  const greeting = ctx.firstName ? `Olá, ${ctx.firstName}.` : "Olá."
  return `${greeting} Este é o canal oficial de negociação da ${ctx.creditorName}, operado pela AlteaPay.`
}

/**
 * A4 (S10/S24, Apêndice B "Detalhes") — linha compacta de detalhes da dívida:
 * "Vencimento original {venc} · {n} fatura(s) · serviço da {credor}". Segmentos
 * ausentes são omitidos (nunca "—"/vazio). A4 r2 (B3-F6): sem vencimento E sem
 * nº de faturas a linha nunca degenera em fragmento ("serviço da X.") — vira a
 * frase completa "Este valor refere-se a um serviço da {credor}". SEM valor (mora
 * no card — R-12) e sem PII. A pergunta "Como prefere seguir?" NÃO entra aqui:
 * quem pergunta é o menu reemitido logo abaixo (REOPEN_MENU_QUESTION) — uma
 * pergunta só na tela.
 */
function debtDetailLine(ctx: AckContext): string {
  const parts: string[] = []
  const venc = formatDatePt(ctx.oldestDueDate)
  if (venc) parts.push(`Vencimento original ${venc}`)
  if (ctx.invoiceCount > 0) parts.push(`${ctx.invoiceCount} ${ctx.invoiceCount === 1 ? "fatura" : "faturas"}`)
  if (parts.length === 0) return `Este valor refere-se a um serviço da ${ctx.creditorName}`
  parts.push(`serviço da ${ctx.creditorName}`)
  return parts.join(" · ")
}

export interface AckContext {
  firstName: string // primeiro nome do cliente (vazio se indisponível)
  creditorName: string
  updatedValue: number // reais (a UI/n8n formata; cents só na borda n8n)
  invoiceCount: number
  oldestDueDate: string | null
}

/** Primeiro nome de PESSOA FÍSICA (ex.: "Fabio Mendes" → "Fabio"); null para
 *  vazio, CNPJ, razão social ou 1º token inválido (QA round 3 / QAB3-03). Fonte
 *  única em lib/journey/first-name.ts; re-exportado aqui (A3: o recap e o
 *  campaign-send usam a MESMA regra). */
export { firstNameOf } from "./first-name"
import { firstNameOf } from "./first-name"

/** Resumo objetivo da dívida (cliente, credor, valor atualizado, vencimento). */
export async function buildAckContext(input: {
  companyId: string
  customerId: string
  debtIds: string[]
}): Promise<AckContext> {
  const supabase = createServiceClient()
  const { data: company } = await supabase
    .from("companies")
    .select("name")
    .eq("id", input.companyId)
    .maybeSingle()
  const { data: cfg } = await supabase
    .from("tenant_chat_config")
    .select("branding")
    .eq("company_id", input.companyId)
    .maybeSingle()
  const branding = (cfg?.branding ?? {}) as Record<string, unknown>
  const creditorName =
    (typeof branding.brand_name === "string" && branding.brand_name) || company?.name || "Credor"

  const { data: debts } = await supabase
    .from("debts")
    .select("id, amount, due_date")
    .eq("company_id", input.companyId)
    .in("id", input.debtIds)
  const updatedValue = (debts ?? []).reduce(
    (s, d) => s + Number(d.amount ?? 0),
    0,
  )

  const { data: customer } = await supabase
    .from("customers")
    .select("name, document")
    .eq("id", input.customerId)
    .maybeSingle()
  const firstName = firstNameOf(customer?.name, customer?.document) ?? ""
  const doc = (customer?.document ?? "").replace(/\D/g, "")
  const { data: invoices } = await supabase
    .from("vmax_invoices")
    .select("vencimento")
    .eq("id_company", input.companyId)
    .eq("doc", doc)
    .order("vencimento", { ascending: true })
  const oldestInvoiceDue = invoices?.[0]?.vencimento ?? null
  const oldestDebtDue = (debts ?? []).map((d) => d.due_date).filter(Boolean).sort()[0] ?? null

  return {
    firstName,
    creditorName,
    updatedValue,
    // N5: `??` nunca caía em debts.length quando vmax_invoices devolvia [] (0 é
    // não-nulo). Sem faturas VMAX, o nº de faturas é o nº de dívidas abertas.
    invoiceCount: invoices?.length || debts?.length || 0,
    oldestDueDate: oldestInvoiceDue ?? oldestDebtDue,
  }
}

/** Botões do reconhecimento: [1]=Sim, [0]=Não (+[99] se show_handoff_button). */
export function acknowledgementButtons(showHandoff: boolean): Button[] {
  const buttons: Button[] = [
    { id: BTN_YES, label: "Sim, reconheço" },
    { id: BTN_NO, label: "Não reconheço" },
  ]
  if (showHandoff) buttons.push({ id: BTN_HANDOFF, label: "Falar com atendimento" })
  return buttons
}

/**
 * Texto do prompt de reconhecimento — mensagem ÚNICA (saudação + resumo +
 * pergunta). Sem contagem de faturas. Se firstName vazio, cai no genérico.
 */
export function acknowledgementQuestion(ctx: AckContext): string {
  // A4/S23 (Apêndice B): abertura comum + pergunta. Sem valor na fala (R-12), sem
  // "desconsiderar" (é o botão "Já paguei"), sem exclamação. D36: sem ameaça.
  return `${channelGreeting(ctx)} Você reconhece esta cobrança em seu nome?`
}

// --- fluxo Consultar/Negociar (prompt inicial pedido pelo dono) -------------
//
// O 1º prompt da sessão deixa de ser Sim/Não isolado: passa a oferecer DOIS
// botões — "Consultar Dívida" [2] e "Negociar Dívida" [3]:
//   - Consultar → mostra o resumo da dívida como MENSAGEM e reabre o menu com
//     "Negociar Dívida" [3] + "Não reconheço a dívida" [0];
//   - Negociar  → mostra o resumo E inicia a negociação no n8n (reconhecimento
//     "Sim" + negotiation.start); fallback assistido se o n8n não responder;
//   - Não reconheço [0] → contestação (registra dispute), como antes.
// Ambos os prompts usam o kind 'debt_consult' (a rota /api/chat/button conduz).

/** Botões do prompt inicial: [2] Consultar, [3] Negociar (+[99] se handoff). */
export function consultNegotiateButtons(showHandoff: boolean): Button[] {
  const buttons: Button[] = [
    { id: BTN_CONSULT, label: "Detalhes da dívida" },
    { id: BTN_NEGOTIATE, label: "Negociar" },
  ]
  if (showHandoff) buttons.push({ id: BTN_HANDOFF, label: "Falar com atendimento" })
  return buttons
}

/**
 * Botões do menu APÓS consultar: [3] Negociar Dívida + [0] Não reconheço a
 * dívida (+[99] se handoff). É o passo que o dono pediu — depois de ver os
 * dados, o devedor pode negociar ou contestar.
 */
export function postConsultButtons(showHandoff: boolean): Button[] {
  const buttons: Button[] = [
    { id: BTN_NEGOTIATE, label: "Negociar" },
    { id: BTN_NO, label: "Não reconheço" },
  ]
  if (showHandoff) buttons.push({ id: BTN_HANDOFF, label: "Falar com atendimento" })
  return buttons
}

/**
 * Saudação + convite (mensagem/pergunta do prompt inicial Consultar/Negociar).
 * Sem valor/vencimento aqui — o resumo detalhado sai só ao Consultar/Negociar
 * (na mensagem `debtInfoMessage`), evitando repetir os números duas vezes.
 */
export function consultNegotiateQuestion(ctx: AckContext): string {
  // A4/S24 (Apêndice B): abertura comum + convite. Sem valor, sem exclamação.
  return `${channelGreeting(ctx)} O que você deseja fazer?`
}

/** Pergunta do menu pós-consulta (após mostrar os dados da dívida). */
export function postConsultQuestion(): string {
  return "Como deseja seguir?"
}

/**
 * Resumo detalhado da dívida exibido como MENSAGEM do assistente ao Consultar/
 * Negociar: valor atualizado, vencimento mais antigo e nº de faturas. Sem PII
 * (nada de documento) — só os dados financeiros que o devedor pode ver.
 */
export function debtInfoMessage(ctx: AckContext): string {
  // A3 (§2.4 / R-12): o VALOR mora só no card fixo e nos outcomes — nunca numa
  // guidance. A4/S24: a mesma linha compacta do "Detalhes da dívida" (sem valor).
  return `${debtDetailLine(ctx)}.`
}

// ============================================================================
// Onda "3 opções" (§6.1, §6.2, M2–M7) — menu pós-login: Pagar › Negociar › Não
// reconheço. Trilha D1. Reconhecimento IMPLÍCITO ao clicar Pagar/Negociar (M4).
// ============================================================================

/** Rótulo/valor exibidos em REAIS, com o mesmo Intl do resumo (R$ 250,00). */
function payLabel(value: number): string {
  return `Pagar ${BRL(value)}`
}

/**
 * Botões do menu de 3 opções (§6.1, ordem contratual G1 D.2):
 *   [4] Pagar (rótulo com valor canônico) › [1] Negociar › [0] Não reconheço.
 * A ordem de EXIBIÇÃO é fixada por `order` (0,1,2) — NÃO pela ordem dos ids (que é
 * 4,1,0). show_handoff_button acrescenta [99] ao final. O rótulo de pagar carrega
 * o {valor} da fonte canônica (M3): clique informado, sem tela extra de confirmação.
 */
export function threeOptionsButtons(value: number, showHandoff: boolean): Button[] {
  const buttons: Button[] = [
    { id: BTN_PAY, label: payLabel(value), order: 0 },
    { id: BTN_YES, label: "Negociar", order: 1 },
    { id: BTN_CONSULT, label: "Detalhes da dívida", order: 2 },
    { id: BTN_NO, label: "Não reconheço", order: 3 },
  ]
  if (showHandoff) buttons.push({ id: BTN_HANDOFF, label: "Falar com atendimento", order: 4 })
  return buttons
}

/** Botão único de VOLTA do "Não reconheço" (M7): reabre o menu de 3 opções. */
export function backToOptionsButtons(): Button[] {
  return [{ id: BTN_BACK, label: "Voltar às opções", order: 0 }]
}

/**
 * Mensagem-resumo/abertura do menu de 3 opções (T1 / R-24 — carta de voz §10.2).
 * Adulto-para-adulto: SEM alegria forçada ("Tudo bem?"/emoji), SEM "se já pagou
 * desconsidere" (isso virou o botão "Já paguei" — C10) e SEM o VALOR na fala (o
 * número mora no CARD fixo e no rótulo do botão PAGAR — R-11/R-12). Identifica a
 * AlteaPay como operadora do canal e a {credor} como dona da dívida (transparência
 * LGPD — R-24). Variação sem nome cai em "Olá." (nunca "Olá, ."/"null"). Sem PII.
 */
export function threeOptionsSummary(ctx: AckContext): string {
  // A4/S5 — texto do Apêndice B, ipsis litteris.
  return `${channelGreeting(ctx)} Como você prefere seguir?`
}

/**
 * Resposta do "Consultar dívida" [2] (T4 / R-27 — carta de voz §10.2). Informativo,
 * NÃO reconhece a dívida. Frase única, adulto, que TERMINA oferecendo caminho de
 * volta ("é só escolher abaixo como prefere seguir") — a carta pede sempre oferecer
 * caminho. Condicional de plural: só cita "reúne N faturas" quando N>1. Sem valor
 * na fala (mora no card/rótulo — R-12). Sem PII (nada de documento).
 */
export function debtConsultReply(ctx: AckContext): string {
  // A4/S10 (Apêndice B "Detalhes"): bloco compacto; a pergunta vem do menu abaixo.
  return `${debtDetailLine(ctx)}.`
}

/**
 * Canal oficial do cedente (§6.2/M6) com FALLBACK SEGURO (decisão G1 D.1):
 *  - se `official_channel_label` do tenant existir → usa-o (+ url se houver);
 *  - se estiver NULL/vazio (VMAX hoje) → NUNCA renderiza vazio/"null"/outro cedente
 *    (incidente "GNLink"): devolve `hasConfig:false` e o texto genérico é montado
 *    por `notRecognizedReply` ("pelo canal informado na sua fatura ou no site
 *    oficial da {credor}"). Quem chama emite o alerta de config (telemetria/log).
 */
export interface CreditorChannel {
  creditorName: string
  hasConfig: boolean
  channelLabel: string | null
  channelUrl: string | null
}

export async function resolveCreditorChannel(input: {
  companyId: string
  customerId: string
  debtId: string
}): Promise<CreditorChannel> {
  const supabase = createServiceClient()
  const { data: cfg } = await supabase
    .from("tenant_chat_config")
    .select("official_channel_label, official_channel_url")
    .eq("company_id", input.companyId)
    .maybeSingle()
  // {credor} SEMPRE da fonte canônica (buildAckContext), nunca do label do canal.
  let creditorName = "empresa credora"
  try {
    const ackCtx = await buildAckContext({
      companyId: input.companyId,
      customerId: input.customerId,
      debtIds: [input.debtId],
    })
    creditorName = ackCtx.creditorName
  } catch {
    /* fallback silencioso: mantém o genérico */
  }
  const rawLabel = typeof cfg?.official_channel_label === "string" ? cfg.official_channel_label.trim() : ""
  const rawUrl = typeof cfg?.official_channel_url === "string" ? cfg.official_channel_url.trim() : ""
  const hasConfig = rawLabel.length > 0
  return {
    creditorName,
    hasConfig,
    channelLabel: hasConfig ? rawLabel : null,
    channelUrl: rawUrl.length > 0 ? rawUrl : null,
  }
}

/**
 * Copy do "Não reconheço" (§6.2, 03-copy.md §3), encaminhando ao CEDENTE. Nunca
 * promete pagamento; nunca cita AlteaPay como responsável pela dívida. D36:
 * "se já pagou, informe o credor". Duas variações — só a frase do canal muda:
 *   COM config    → "pelo canal oficial: {label}[ ({url})]"
 *   SEM config    → "pelo canal informado na sua fatura ou no site oficial da {credor}"
 * NUNCA renderiza "null"/vazio/terceiro (garantido por resolveCreditorChannel).
 */
export function notRecognizedReply(channel: CreditorChannel): string {
  const { creditorName } = channel
  // A4/S11 (Apêndice B): "…fale com a {credor}: {canal_oficial}." COM config; SEM
  // config (VMAX hoje) o fallback seguro "pelo canal informado na sua fatura ou no
  // site oficial da {credor}" ocupa o lugar de {canal_oficial}. Nunca "null"/vazio.
  const contact = channel.hasConfig
    ? `: ${channel.channelLabel}${channel.channelUrl ? ` (${channel.channelUrl})` : ""}`
    : ` pelo canal informado na sua fatura ou no site oficial da ${creditorName}`
  return (
    `Registramos que você não reconhece esta cobrança. ` +
    `Para entender a origem e contestar, fale com a ${creditorName}${contact}.`
  )
}

export type BootstrapThreeOptionsResult =
  | { ok: true; created: false; reason: "disabled" | "already_active"; prompt?: PromptRow }
  | { ok: true; created: true; prompt: PromptRow }
  | { ok: false; error: string }

/** Modo do menu de 3 opções: 'initial' (pós-login, com saudação) ou 'reopen'
 *  (menu reemitido após um clique — Detalhes/Voltar/Já paguei/reopen). */
export type ThreeOptionsMenuMode = "initial" | "reopen"

/**
 * Pergunta CURTA do menu reemitido (A1 / §2.3): o menu que volta depois de uma
 * ação NÃO repete a saudação — só pergunta como seguir.
 */
export const REOPEN_MENU_QUESTION = "Como prefere seguir?"

/**
 * Pergunta do bloco de botões por modo. No menu INICIAL a saudação já é uma
 * bolha própria do log (stage 'greeting', que termina com "Como você prefere
 * seguir?") — o bloco de botões vem SEM texto para não repetir a pergunta na
 * tela (§2.1: card + UMA saudação + UM menu). No reopen, a pergunta curta.
 */
export function menuQuestion(mode: ThreeOptionsMenuMode): string {
  return mode === "reopen" ? REOPEN_MENU_QUESTION : ""
}

/** Marcador de estágio da bolha de saudação (offers_snapshot.stage). */
export const GREETING_STAGE = "greeting"

/**
 * A1 / G6 — persiste a SAUDAÇÃO (threeOptionsSummary) UMA vez por thread
 * (sessão + thread_epoch), como bolha própria: sem prompt_id (não é a pergunta
 * de nenhum menu — não vira `superseded` quando o menu é reemitido) e com
 * `offers_snapshot.stage='greeting'` (marcador para a poda/retomada da A3).
 * Idempotente por (sessão, época, stage): re-login/reopen NÃO empilham. Best-
 * effort: NUNCA lança.
 */
export async function ensureGreetingMessage(input: {
  companyId: string
  sessionId: string
  text: string
  threadEpoch?: number
}): Promise<string | null> {
  try {
    const supabase = createServiceClient()
    const epoch =
      typeof input.threadEpoch === "number" ? input.threadEpoch : await getCurrentThreadEpoch(input.sessionId)
    const { data: rows } = await supabase
      .from("chat_messages")
      .select("id, offers_snapshot, thread_epoch, archived_at")
      .eq("session_id", input.sessionId)
      .eq("role", "assistant")
      .is("archived_at", null)
      .order("created_at", { ascending: false })
      .limit(200)
    const existing = (rows ?? []).find((r) => {
      const row = r as { offers_snapshot?: { stage?: unknown } | null; thread_epoch?: number | null }
      const stage = row.offers_snapshot && typeof row.offers_snapshot === "object" ? row.offers_snapshot.stage : null
      if (stage !== GREETING_STAGE) return false
      const e = row.thread_epoch
      return e == null ? epoch === 0 : Number(e) === epoch
    })
    if (existing) return (existing as { id: string }).id
    return await persistAssistantMessage({
      companyId: input.companyId,
      sessionId: input.sessionId,
      text: input.text,
      stage: GREETING_STAGE,
      threadEpoch: epoch,
      // a saudação é única por thread — nunca cair no dedup de conteúdo de 15min
      // (que devolveria a saudação de outra época e não gravaria a desta).
      skipContentDedup: true,
    })
  } catch (err) {
    console.warn("[journey] ensureGreetingMessage falhou (não-fatal):", (err as Error).message)
    return null
  }
}

/** Contexto do prompt de 3 opções (menu_mode marca initial/reopen). */
function threeOptionsContext(
  ackCtx: AckContext,
  input: { primaryDebtId: string; debtIds: string[] },
  mode: ThreeOptionsMenuMode,
): Record<string, unknown> {
  return {
    creditor_name: ackCtx.creditorName,
    updated_value: ackCtx.updatedValue,
    invoice_count: ackCtx.invoiceCount,
    oldest_due_date: ackCtx.oldestDueDate,
    primary_debt_id: input.primaryDebtId,
    debt_ids: input.debtIds,
    menu_mode: mode,
  }
}

function sameButtons(a: Button[], b: Button[]): boolean {
  if (a.length !== b.length) return false
  const key = (x: Button) => `${x.id}|${x.label}|${x.value ?? ""}|${x.order ?? ""}`
  const as = a.map(key).sort()
  const bs = b.map(key).sort()
  return as.every((v, i) => v === bs[i])
}

/**
 * Cria o prompt INICIAL da sessão no formato de 3 opções (§6.1). Idempotente na
 * RE-ENTRADA: só recria quando NÃO há prompt ativo da jornada
 * (debt_three_options/debt_consult/debt_acknowledgement) — assim uma sessão
 * reaberta não perde o menu, e um reload durante a negociação não duplica o
 * prompt. Respeita acknowledgement_enabled. NÃO grava reconhecimento — só
 * apresenta (o reconhecimento implícito é no clique).
 *
 * A1 (G6/N-D5-7):
 *  - `mode:'initial'` (default, login): garante a SAUDAÇÃO 1x por thread como
 *    bolha própria (ensureGreetingMessage) e cria o menu SEM pergunta no bloco de
 *    botões (a saudação já pergunta);
 *  - `mode:'reopen'` (Detalhes/Voltar/Já paguei/reopen): menu com a pergunta
 *    curta e NENHUMA saudação nova;
 *  - `question` explícita sobrepõe a pergunta do modo;
 *  - `ackCtx` já calculado pelo chamador evita recalcular (latência);
 *  - `already_active`: se a pergunta/botões do prompt ativo diferirem do que o
 *    código gera hoje (copy nova, valor novo), atualiza IN-PLACE (mesmo id e
 *    status) — a copy nova chega a prompts já gravados. O menu-volta do "não
 *    reconheço" (stage not_recognized_back) não é tocado.
 */
/** QA round 4 (R-12): janela em que um prompt recém-respondido ainda espera o sucessor. */
export const PROMPT_SWAP_GRACE_MS = 3000
const SUCCESSOR_WAIT_MS = 2000
const SUCCESSOR_POLL_MS = 150

/**
 * QA round 4 (R-12) — se o prompt mais recente da sessão foi respondido há menos
 * de PROMPT_SWAP_GRACE_MS e não há ativo (um clique está criando o sucessor),
 * espera até SUCCESSOR_WAIT_MS pelo sucessor e o devolve. null = nada em
 * transição (ou o sucessor não apareceu): o chamador segue o fluxo normal.
 * Nunca lança.
 */
async function awaitPromptSuccessor(sessionId: string): Promise<PromptRow | null> {
  try {
    const supabase = createServiceClient()
    const { data } = await supabase
      .from("chat_prompts")
      .select("id, status, answered_at, created_at")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    const last = data as { status?: string | null; answered_at?: string | null } | null
    if (!last || last.status !== "answered") return null
    const at = Date.parse(last.answered_at ?? "")
    if (!Number.isFinite(at) || Date.now() - at >= PROMPT_SWAP_GRACE_MS) return null
    const deadline = Date.now() + SUCCESSOR_WAIT_MS
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, SUCCESSOR_POLL_MS))
      const active = await getActivePrompt(sessionId)
      if (active) return active
    }
    return null
  } catch {
    return null
  }
}

export async function bootstrapThreeOptionsPrompt(input: {
  companyId: string
  sessionId: string
  customerId: string
  debtIds: string[]
  primaryDebtId: string
  question?: string
  mode?: ThreeOptionsMenuMode
  ackCtx?: AckContext
}): Promise<BootstrapThreeOptionsResult> {
  const supabase = createServiceClient()
  const mode: ThreeOptionsMenuMode = input.mode ?? "initial"
  const [{ data: cfg }, { data: existingRaw }, threadEpoch] = await Promise.all([
    supabase
      .from("tenant_chat_config")
      .select("acknowledgement_enabled, show_handoff_button")
      .eq("company_id", input.companyId)
      .maybeSingle(),
    supabase
      .from("chat_prompts")
      .select("*")
      .eq("session_id", input.sessionId)
      .in("kind", ["debt_three_options", "debt_consult", "debt_acknowledgement"])
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    getCurrentThreadEpoch(input.sessionId),
  ])
  if (cfg?.acknowledgement_enabled === false) {
    return { ok: true, created: false, reason: "disabled" }
  }
  const showHandoff = cfg?.show_handoff_button === true
  const existing = (existingRaw as PromptRow | null) ?? null

  const ackCtx =
    input.ackCtx ??
    (await buildAckContext({
      companyId: input.companyId,
      customerId: input.customerId,
      debtIds: input.debtIds,
    }))
  const greeting = threeOptionsSummary(ackCtx)

  if (existing) {
    // Saudação 1x por thread: garantida também na re-entrada com menu vivo (a
    // thread pode ter nascido antes desta regra, sem bolha de saudação).
    if (mode === "initial") {
      await ensureGreetingMessage({ companyId: input.companyId, sessionId: input.sessionId, text: greeting, threadEpoch })
    }
    // N-D5-7: copy atual no prompt ativo (só o menu payável de 3 opções).
    const ctx = (existing.context ?? {}) as { stage?: unknown; menu_mode?: unknown }
    const isPayableMenu =
      existing.kind === "debt_three_options" &&
      ctx.stage !== "not_recognized_back" &&
      (existing.buttons ?? []).some((b) => b.id === BTN_PAY)
    if (isPayableMenu) {
      const existingMode: ThreeOptionsMenuMode =
        ctx.menu_mode === "reopen" || ctx.menu_mode === "initial" ? ctx.menu_mode : mode
      const expectedQuestion = input.question ?? menuQuestion(existingMode)
      const expectedButtons = threeOptionsButtons(ackCtx.updatedValue, showHandoff)
      const questionDiffers = existing.question !== expectedQuestion
      const buttonsDiffer = !sameButtons(existing.buttons ?? [], expectedButtons)
      if (questionDiffers || buttonsDiffer) {
        const patch: Record<string, unknown> = {}
        if (questionDiffers) patch.question = expectedQuestion
        if (buttonsDiffer) patch.buttons = expectedButtons
        patch.context = { ...(existing.context ?? {}), ...threeOptionsContext(ackCtx, input, existingMode) }
        const { data: refreshed } = await supabase
          .from("chat_prompts")
          .update(patch)
          .eq("id", existing.id)
          .eq("session_id", input.sessionId)
          .eq("status", "active")
          .select("*")
        const row = Array.isArray(refreshed) && refreshed[0] ? (refreshed[0] as PromptRow) : { ...existing, ...patch } as PromptRow
        return { ok: true, created: false, reason: "already_active", prompt: row }
      }
    }
    return { ok: true, created: false, reason: "already_active", prompt: existing }
  }

  // QA round 4 (R-12, S4) — LOGIN/RETOMADA CONCORRENTE a um clique em curso
  // (só no modo inicial: o modo 'reopen' é chamado pelos próprios handlers, que
  // acabaram de responder o prompt):
  //  (1) clique em voo: o prompt mais recente acabou de ser respondido e o
  //      sucessor ainda não foi gravado → espera o sucessor (até 2 s) e o reusa,
  //      em vez de publicar um menu que a outra aba vai superseder (409);
  //  (2) contestação em curso/registrada: o último clique da sessão é o "Não
  //      reconheço" [0] → publica o menu-volta [98], NUNCA o menu pagável.
  if (mode === "initial") {
    const successor = await awaitPromptSuccessor(input.sessionId)
    if (successor) return { ok: true, created: false, reason: "already_active", prompt: successor }
    const { lastCustomerClick } = await import("./double-tap")
    const last = await lastCustomerClick(input.sessionId)
    if (last.buttonId === BTN_NO) {
      await ensureGreetingMessage({ companyId: input.companyId, sessionId: input.sessionId, text: greeting, threadEpoch })
      const back = await createPrompt({
        companyId: input.companyId,
        sessionId: input.sessionId,
        kind: "debt_three_options",
        question: "",
        buttons: backToOptionsButtons(),
        context: { primary_debt_id: input.primaryDebtId, debt_ids: input.debtIds, stage: "not_recognized_back" },
        createdBy: "platform",
        threadEpoch,
      })
      if (!back.ok) return { ok: false, error: back.error }
      return { ok: true, created: true, prompt: back.prompt }
    }
  }

  // Saudação ANTES do menu (ordem cronológica na tela): só no modo inicial e só
  // uma vez por thread.
  if (mode === "initial") {
    await ensureGreetingMessage({ companyId: input.companyId, sessionId: input.sessionId, text: greeting, threadEpoch })
  }

  const question = input.question ?? menuQuestion(mode)
  const created = await createPrompt({
    companyId: input.companyId,
    sessionId: input.sessionId,
    kind: "debt_three_options",
    question,
    buttons: threeOptionsButtons(ackCtx.updatedValue, showHandoff),
    context: threeOptionsContext(ackCtx, input, mode),
    createdBy: "platform",
    threadEpoch,
  })
  if (!created.ok) return { ok: false, error: created.error }

  // A pergunta do menu (quando houver) fica ligada ao prompt (histórico/painel);
  // no modo inicial a pergunta é vazia → nada a persistir (a saudação já está).
  await persistAssistantMessage({
    companyId: input.companyId,
    sessionId: input.sessionId,
    text: question,
    promptId: created.prompt.id,
    threadEpoch,
  })
  return { ok: true, created: true, prompt: created.prompt }
}

// 24h sem interação → a thread atual é ENCERRADA e outra é aberta; o histórico é
// PRESERVADO (arquivado), não apagado.
const CHAT_HISTORY_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Época (thread) CORRENTE da sessão (int monotônico, default 0). É o filtro que
 * separa a conversa nova das velhas dentro da MESMA sessão reusada (C3). Best-
 * effort: se a coluna thread_epoch ainda não existir (migration 20260935 pendente
 * em prod), degrada para 0 = comportamento de hoje. NUNCA lança.
 */
export async function getCurrentThreadEpoch(sessionId: string): Promise<number> {
  try {
    const supabase = createServiceClient()
    const { data } = await supabase
      .from("negotiation_sessions")
      .select("thread_epoch")
      .eq("id", sessionId)
      .maybeSingle()
    const raw = (data as { thread_epoch?: number | null } | null)?.thread_epoch
    return typeof raw === "number" ? raw : 0
  } catch {
    return 0
  }
}

/**
 * Decisão G3 D.3 (aprovada pelo Fabio): passadas 24h da ÚLTIMA interação, o reset
 * DEIXA de ser DELETE físico. Passa a ENCERRAR A THREAD ATUAL E ABRIR OUTRA:
 *   - incrementa negotiation_sessions.thread_epoch (int monotônico) — a conversa
 *     nova começa numa época nova;
 *   - ARQUIVA (UPDATE archived_at=now(), NÃO DELETE) as linhas de chat_messages e
 *     chat_prompts da época ANTERIOR — auditoria e itens C8 (link, escolha, "já
 *     paguei", reconhecimento) permanecem consultáveis;
 *   - supersede os prompts 'active' da época velha (não ficam vivos na tela nova).
 * O GET /api/chat/messages passa a filtrar a época corrente → a tela começa limpa,
 * mas o banco preserva tudo. journey_events INTACTO (C2/R-09: não é referenciado).
 *
 * Baseia-se na última `chat_messages` da sessão (a última interação REAL) — não no
 * `last_activity_at`, que a própria auth acabou de bumpar ao reabrir a sessão.
 * Best-effort/NÃO-fatal: uma falha aqui não derruba a auth. Retorna true se
 * encerrou/rotacionou a thread (o SELECT antes/depois vê as MESMAS linhas — agora
 * arquivadas). DEFENSIVO: se as colunas 20260935 ainda não existirem em prod, o
 * incremento/arquivamento é no-op silencioso e a tela apenas não "recomeça".
 */
export async function resetStaleChatIfInactive(sessionId: string, _companyId: string): Promise<boolean> {
  try {
    const supabase = createServiceClient()
    const { data: last } = await supabase
      .from("chat_messages")
      .select("created_at")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!last?.created_at) return false // sem histórico → nada a rotacionar
    if (Date.now() - new Date(last.created_at).getTime() < CHAT_HISTORY_TTL_MS) return false // ainda fresco

    const nowIso = new Date().toISOString()
    const prevEpoch = await getCurrentThreadEpoch(sessionId)
    const nextEpoch = prevEpoch + 1

    // 1) ARQUIVA (UPDATE, nunca DELETE) as linhas ainda-não-arquivadas da sessão:
    //    a partir de agora elas pertencem à thread anterior. archived_at marca o
    //    encerramento; o filtro de época no GET as tira da tela nova sem removê-las.
    await supabase
      .from("chat_messages")
      .update({ archived_at: nowIso })
      .eq("session_id", sessionId)
      .is("archived_at", null)
      .then(() => {}, () => {})
    // 2) supersede + arquiva os prompts da época velha (não ficam 'active' na nova).
    await supabase
      .from("chat_prompts")
      .update({ archived_at: nowIso, status: "superseded" })
      .eq("session_id", sessionId)
      .is("archived_at", null)
      .then(() => {}, () => {})
    // 3) incrementa a época da sessão + limpa a espera. A partir daqui, as inserts
    //    gravam thread_epoch=nextEpoch (ver currentEpochForInsert nos bootstraps).
    await supabase
      .from("negotiation_sessions")
      .update({ thread_epoch: nextEpoch, wait_state: null, wait_started_at: null })
      .eq("id", sessionId)
      .then(() => {}, () => {})
    return true
  } catch (err) {
    console.warn("[journey] reset 24h: rotação de thread (não-fatal):", (err as Error).message)
    return false
  }
}

/**
 * Bootstrap tolerante a falhas do menu de 3 opções (análogo a bootstrapAckSafe).
 * Só roda com CHAT_JOURNEY_ENABLED=true e NUNCA lança — uma falha aqui não pode
 * derrubar a autenticação (o devedor entra no chat de qualquer forma).
 */
export async function bootstrapThreeOptionsSafe(input: {
  companyId: string
  sessionId: string
  customerId: string
  debtIds: string[]
  primaryDebtId: string | null
}): Promise<void> {
  if (process.env.CHAT_JOURNEY_ENABLED !== "true") return
  if (!input.primaryDebtId || input.debtIds.length === 0) return
  try {
    // 24h sem interação → apaga o histórico e recomeça (antes de (re)publicar o menu).
    await resetStaleChatIfInactive(input.sessionId, input.companyId)
    await bootstrapThreeOptionsPrompt({
      companyId: input.companyId,
      sessionId: input.sessionId,
      customerId: input.customerId,
      debtIds: input.debtIds,
      primaryDebtId: input.primaryDebtId,
    })
  } catch (err) {
    console.warn("[journey] bootstrap 3 opções falhou:", (err as Error).message)
  }
}

/**
 * Reemite o menu de 3 opções depois de uma ação (Detalhes [2], Voltar [98],
 * "Já paguei", /api/chat/reopen). A1 / G6: modo 'reopen' — pergunta CURTA
 * ("Como prefere seguir?") e NENHUMA saudação nova (a saudação é 1x por thread).
 * Reusa bootstrapThreeOptionsPrompt (idempotente); se ainda houver um prompt
 * ativo, devolve o ativo. `ackCtx` do chamador evita o 2º buildAckContext
 * (N-D3-5). O `reply` devolvido é a pergunta curta (o client não injeta bolha).
 */
export async function reopenThreeOptions(input: {
  companyId: string
  sessionId: string
  customerId: string
  debtIds: string[]
  primaryDebtId: string
  ackCtx?: AckContext
}): Promise<{ ok: true; reply: string; promptId: string | null } | { ok: false; error: string }> {
  const res = await bootstrapThreeOptionsPrompt({ ...input, mode: "reopen" })
  if (!res.ok) return res
  return { ok: true, reply: REOPEN_MENU_QUESTION, promptId: res.prompt?.id ?? null }
}

// ============================================================================
// R1 (onda "3 opções", modo ASSISTIDO sem n8n) — apresentação das PARCELAS DA
// MATRIZ como botões quando o devedor clica "Quero negociar" e o motor n8n NÃO
// conduz (fallback determinístico). O SERVIDOR é dono da matriz (D8/D11): as
// ofertas saem de `listOffers` (lib/negotiation/offers.ts → matriz do servidor),
// nunca do client. Selecionar uma → acceptMatrixCondition/caminho canônico
// (closeAgreement → charge-inline) gera o link ASAAS no chat, com guard de
// idempotência (D7) e already_charged (D23): NUNCA 2ª cobrança, NUNCA declara pago.
// ============================================================================

/** IDs de item de lista (2..97) para as ofertas, na ORDEM em que `listOffers`
 *  devolve (à vista primeiro, depois parcelado). id 2 = 1ª oferta, 3 = 2ª, … O
 *  `value` carrega o offer_id (uuid persistido em negotiation_offers) — o servidor
 *  revalida contra a matriz no aceite (não confia no client). */
const OFFER_FIRST_BUTTON_ID = 2

/**
 * Rótulo de uma oferta de parcelamento (T6 / R-45 — âncora de economia). Sem PII.
 *   - à vista (1 parcela) COM desconto: "À vista R$ 175,00 — você economiza R$ 75,00
 *     (recomendado)" (âncora de economia em REAIS + destaque "recomendado", que
 *     orienta a escolha à quitação — A4/N1); sem desconto: "À vista R$ 175,00
 *     (recomendado)" (recomenda, mas NUNCA insinua economia que não existe);
 *   - parcelado (N>1): "3x de R$ 78,33 (total R$ 235,00)".
 * Valores da OFERTA (total/parcela/economia) — a mesma matriz que gerou a oferta.
 */
export function offerButtonLabel(terms: OfferTerms): string {
  if (terms.installments <= 1) {
    const base = `À vista ${BRL(terms.total_value)}`
    return terms.discount_value > 0
      ? `${base}, economia de ${BRL(terms.discount_value)} (recomendado)`
      : `${base} (recomendado)`
  }
  return `${terms.installments}x de ${BRL(terms.installment_value)} (total ${BRL(terms.total_value)})`
}

/** Monta os botões de escolha de oferta a partir da lista da matriz (na ordem
 *  de `listOffers`). id = 2..N (item de lista), value = offer_id, order = índice
 *  para a exibição preservar a ordem "à vista → parcelado". `order` também deixa o
 *  BTN_BACK (98) no fim, dando ao devedor a saída "voltar às opções" (M7). */
export function offerChoiceButtons(offers: ListedOffer[]): Button[] {
  const buttons: Button[] = offers.map((o, i) => ({
    id: OFFER_FIRST_BUTTON_ID + i,
    label: offerButtonLabel(o.terms),
    value: o.id,
    order: i,
  }))
  // volta às opções (M7): nunca é beco sem saída.
  buttons.push({ id: BTN_BACK, label: "Voltar às opções", order: offers.length })
  return buttons
}

/** Pergunta que acompanha os botões de parcelamento (T5 / R-28 — carta de voz).
 *  Uma ideia, sem "se já pagou desconsidere" (isso é o botão "Já paguei" — C10).
 *  Sem PII; sem ameaça/negativação; sem valor na fala (mora no card/rótulo — R-12). */
export function offerChoiceQuestion(): string {
  // A4/S8: a MESMA frase do eco do clique Negociar (S7). T2 (S7) é persistida
  // antes deste prompt; na tela, o client (chat-display.resolvePromptForRender)
  // omite a pergunta do bloco de botões quando ela já é a última bolha visível —
  // S7 aparece uma vez. Aqui a pergunta segue gravada (histórico/retomada).
  return NEGOTIATION_PENDING_TEXT
}

export type PresentMatrixOffersResult =
  | {
      ok: true
      presented: true
      offers: ListedOffer[]
      promptId: string
      /** A2: o prompt COMPLETO (shape do GET /api/chat/messages.active_prompt) para o
       *  POST do clique devolvê-lo e o client renderizar as parcelas NA HORA. */
      prompt: PromptView
      /** true quando um 'offer_choice' já estava ativo e foi reusado (idempotência). */
      reused: boolean
    }
  | { ok: true; presented: false; reason: "no_offers" }
  | { ok: false; error: string }

/**
 * R1 — apresenta as OPÇÕES DE PARCELAMENTO DETERMINÍSTICAS da matriz do servidor
 * (`listOffers`) como um prompt de botões (kind 'offer_choice'). É o fallback
 * assistido do "Quero negociar" quando o n8n não conduz. Idempotente na
 * re-entrada: se já há um prompt 'offer_choice' ATIVO nesta sessão, não recria
 * (reload/clique duplo não empilha). Sem ofertas na matriz (sem faixa vigente) →
 * `presented:false` (o chamador cai no caminho de degradação, nunca beco sem
 * saída). NÃO cobra nada aqui — só apresenta; a cobrança é no aceite. NÃO decide
 * desconto/parcela (D8): só exibe o que a matriz gerou.
 *
 * A2 (N-D2-2, clique < 3 s): UMA leitura de contexto — o prompt ativo, as ofertas
 * (listOffers já é 1 leitura + lote) e a época correm em PARALELO; a pergunta é
 * gravada sem o dedup de conteúdo (é única por prompt) e com a época já lida.
 * `precedingWrite` (opcional) produz a escrita que deve PRECEDER a bolha-pergunta
 * no histórico (ex.: a confirmação "Certo…" do clique) — é chamada só quando há
 * parcelas a apresentar, e as leituras não esperam por ela, só a escrita da
 * pergunta (o chamador pode devolver uma Promise já em curso).
 */
export async function presentMatrixOffers(input: {
  companyId: string
  sessionId: string
  customerId: string
  debtId: string
  precedingWrite?: () => Promise<unknown>
}): Promise<PresentMatrixOffersResult> {
  const ctx: SessionCtx = {
    companyId: input.companyId,
    sessionId: input.sessionId,
    customerId: input.customerId,
    debtId: input.debtId,
  }
  const supabase = createServiceClient()

  const [{ data: existing }, offers, epoch] = await Promise.all([
    // idempotência: se já existe um 'offer_choice' ATIVO, reusa (não re-apresenta).
    supabase
      .from("chat_prompts")
      .select("*")
      .eq("session_id", input.sessionId)
      .eq("kind", "offer_choice")
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    listOffers(ctx),
    getCurrentThreadEpoch(input.sessionId),
  ])
  // QA round 1 (M2): o 'offer_choice' ativo só é reusado quando os seus botões
  // ainda apontam para o CONJUNTO vigente — se listOffers regenerou (conjunto
  // parcialmente consumido), um prompt novo com as ofertas novas substitui o
  // antigo (cujos offer_ids já não são aceitáveis).
  if (existing) {
    const row = existing as PromptRow
    const existingIds = Array.isArray((row.context as { offer_ids?: unknown } | null)?.offer_ids)
      ? ((row.context as { offer_ids: string[] }).offer_ids)
      : (row.buttons ?? []).map((b) => b.value).filter((v): v is string => typeof v === "string")
    const currentIds = offers.map((o) => o.id)
    const sameSet =
      existingIds.length === currentIds.length && currentIds.every((id) => existingIds.includes(id))
    if (sameSet || offers.length === 0) {
      return { ok: true, presented: true, offers, promptId: row.id, prompt: promptView(row)!, reused: true }
    }
  }
  if (offers.length === 0) return { ok: true, presented: false, reason: "no_offers" }

  const question = offerChoiceQuestion()
  // a bolha de confirmação do clique (se houver) entra ANTES do prompt/pergunta.
  if (input.precedingWrite) await input.precedingWrite().catch(() => {})
  const created = await createPrompt({
    companyId: input.companyId,
    sessionId: input.sessionId,
    kind: "offer_choice",
    question,
    buttons: offerChoiceButtons(offers),
    context: {
      debt_ids: [input.debtId],
      primary_debt_id: input.debtId,
      offer_ids: offers.map((o) => o.id),
      source: "assisted_matrix",
    },
    createdBy: "platform",
    threadEpoch: epoch,
  })
  if (!created.ok) return { ok: false, error: created.error }
  await persistAssistantMessage({
    companyId: input.companyId,
    sessionId: input.sessionId,
    text: question,
    promptId: created.prompt.id,
    threadEpoch: epoch,
    skipContentDedup: true,
  })
  return {
    ok: true, presented: true, offers, promptId: created.prompt.id,
    prompt: promptView(created.prompt)!, reused: false,
  }
}

/**
 * debt_ids/primary_debt_id da SESSÃO (o menu de 3 opções consolida o valor sobre
 * todas as dívidas). Para reabrir o menu assistido a partir de um prompt que não
 * carrega `context.debt_ids` (ex.: prompt criado pelo n8n). Nunca lança —
 * degrada para [fallbackDebtId].
 */
export async function resolveSessionDebtIds(
  sessionId: string,
  fallbackDebtId: string,
): Promise<{ debtIds: string[]; primaryDebtId: string }> {
  try {
    const supabase = createServiceClient()
    const { data } = await supabase
      .from("negotiation_sessions")
      .select("debt_ids, primary_debt_id, debt_id")
      .eq("id", sessionId)
      .maybeSingle()
    const row = data as { debt_ids?: string[] | null; primary_debt_id?: string | null; debt_id?: string | null } | null
    const primaryDebtId = row?.primary_debt_id ?? row?.debt_id ?? fallbackDebtId
    const rawIds = row?.debt_ids ?? []
    const debtIds = rawIds.length > 0 ? rawIds : [primaryDebtId]
    return { debtIds, primaryDebtId }
  } catch {
    return { debtIds: [fallbackDebtId], primaryDebtId: fallbackDebtId }
  }
}

/**
 * Resolve o offer_id a partir do clique num botão de 'offer_choice': o `value` do
 * botão carrega o uuid da oferta. Valida que o botão pertence ao prompt e que a
 * oferta ainda está listada no context (defesa em profundidade — o servidor não
 * confia no client; a revalidação de matriz definitiva é do paymentCreate). Sem
 * PII. Retorna null quando o botão não mapeia uma oferta (ex.: BTN_BACK).
 */
export function resolveOfferIdFromButton(
  prompt: PromptRow,
  buttonId: number,
): string | null {
  const btn = (prompt.buttons ?? []).find((b) => b.id === buttonId)
  const value = btn?.value
  if (typeof value !== "string" || value.length === 0) return null
  const offerIds = Array.isArray((prompt.context as { offer_ids?: unknown } | null)?.offer_ids)
    ? ((prompt.context as { offer_ids: string[] }).offer_ids)
    : null
  // Se o context lista offer_ids, o value TEM que estar entre eles (não aceita um
  // id arbitrário do client). Sem lista (context antigo), aceita o value do botão
  // — a matriz ainda é revalidada no aceite (paymentCreate → assertOfferWithinMatrix).
  if (offerIds && !offerIds.includes(value)) return null
  return value
}

// --- dívida quitada (cliente já pagou) --------------------------------------
//
// Quando o cliente autentica e NÃO tem dívida aberta, mas TEM dívida(s) paga(s),
// não há o que reconhecer/negociar. Em vez do prompt Sim/Não, empurramos uma
// MENSAGEM informativa (role='assistant') como 1ª mensagem do chat — o mesmo
// mecanismo (`chat_messages`) que a UI já renderiza, sem botões.

export interface SettledContext {
  firstName: string
  creditorName: string
  totalPaid: number // reais
  oldestDueDate: string | null // vencimento mais antigo entre as pagas
  paidAt: string | null // data de pagamento mais recente (ISO)
}

/**
 * Ação de LINK EXTERNO anexada à mensagem de quitação: abre o formulário de
 * contato da home (#contato) com o campo "Sou" já em "Recebi uma cobrança"
 * (a home lê ?tipo=recebi_cobranca e pré-seleciona). Só um botão-link (<a>),
 * sem POST — a UI (chat.tsx) renderiza abaixo da bolha. Segue a convenção da
 * home: query ANTES do hash (ex.: /?tipo=publico#contato).
 */
export interface MessageLinkAction {
  type: "external_link"
  label: string
  href: string
}

/** URL do form de contato da home com o "Sou" pré-preenchido "Recebi uma cobrança". */
export function debtSettledContactHref(): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? "https://alteapay.com").replace(/\/+$/, "")
  return `${base}/?tipo=recebi_cobranca#contato`
}

/** Ação de contato mostrada na mensagem de quitação (botão-link externo). */
export function debtSettledContactAction(): MessageLinkAction {
  return {
    type: "external_link",
    label: "Falar com atendimento",
    href: debtSettledContactHref(),
  }
}

/**
 * Texto informativo de quitação (pt-BR). Sem botões de reconhecimento. Se a data
 * de pagamento for desconhecida, omite o "em {data}" e mantém o "consta como paga".
 */
export function settledMessage(ctx: SettledContext): string {
  // A4/S21: sem exclamação, sem CAPS, sem "Obrigado!". O valor é o do OUTCOME
  // (pagamento recebido), permitido pela R-12.
  const greeting = ctx.firstName ? `Olá, ${ctx.firstName}.` : "Olá."
  const paidDate = ctx.paidAt ? formatDatePt(ctx.paidAt) : ""
  const paidWhen = paidDate ? ` em ${paidDate}` : ""
  return (
    `${greeting} Não há valor em aberto em seu nome com a ${ctx.creditorName}: ` +
    `o pagamento de ${BRL(ctx.totalPaid)} consta como recebido${paidWhen}. ` +
    `Se precisar de algo, fale com o atendimento.`
  )
}

/**
 * Monta o contexto de quitação: nome do cliente + credor (branding › company) +
 * total pago + vencimento mais antigo + data de pagamento. Reaproveita a mesma
 * fonte de credor do reconhecimento.
 */
export async function buildSettledContext(input: {
  companyId: string
  customerId: string
  totalPaid: number
  oldestDueDate: string | null
  paidAt: string | null
}): Promise<SettledContext> {
  const supabase = createServiceClient()
  const { data: company } = await supabase
    .from("companies")
    .select("name")
    .eq("id", input.companyId)
    .maybeSingle()
  const { data: cfg } = await supabase
    .from("tenant_chat_config")
    .select("branding")
    .eq("company_id", input.companyId)
    .maybeSingle()
  const branding = (cfg?.branding ?? {}) as Record<string, unknown>
  const creditorName =
    (typeof branding.brand_name === "string" && branding.brand_name) || company?.name || "Credor"
  const { data: customer } = await supabase
    .from("customers")
    .select("name, document")
    .eq("id", input.customerId)
    .maybeSingle()
  return {
    firstName: firstNameOf(customer?.name, customer?.document) ?? "",
    creditorName,
    totalPaid: input.totalPaid,
    oldestDueDate: input.oldestDueDate,
    paidAt: input.paidAt,
  }
}

export type BootstrapSettledResult =
  | { ok: true; created: false; reason: "already_present" }
  | { ok: true; created: true; messageId: string }
  | { ok: false; error: string }

/**
 * Publica a mensagem informativa de quitação como 1ª mensagem da sessão. Grava
 * uma linha em `chat_messages` (role='assistant') — o mesmo caminho que a UI
 * (`components/journey/chat.tsx`) já lê via /api/chat/messages. Idempotente: não
 * duplica se já houver uma mensagem 'assistant' na sessão.
 */
export async function bootstrapSettledMessage(input: {
  companyId: string
  sessionId: string
  customerId: string
  totalPaid: number
  oldestDueDate: string | null
  paidAt: string | null
}): Promise<BootstrapSettledResult> {
  const supabase = createServiceClient()

  // idempotência: já existe mensagem do assistente na sessão? não recria.
  const { data: existing } = await supabase
    .from("chat_messages")
    .select("id")
    .eq("session_id", input.sessionId)
    .eq("role", "assistant")
    .limit(1)
    .maybeSingle()
  if (existing) return { ok: true, created: false, reason: "already_present" }

  const ctx = await buildSettledContext({
    companyId: input.companyId,
    customerId: input.customerId,
    totalPaid: input.totalPaid,
    oldestDueDate: input.oldestDueDate,
    paidAt: input.paidAt,
  })
  const { data: message, error } = await supabase
    .from("chat_messages")
    .insert({
      company_id: input.companyId,
      session_id: input.sessionId,
      role: "assistant",
      text: settledMessage(ctx),
      engine: "platform",
      // Botão-link externo (Recebi uma cobrança → #contato) anexado à bolha.
      // Reusa a coluna jsonb existente (offers_snapshot) — sem migração — e a
      // rota /api/chat/messages devolve como `action` para a UI renderizar.
      offers_snapshot: { message_action: debtSettledContactAction() },
    })
    .select("id")
    .single()
  if (error || !message) return { ok: false, error: error?.message ?? "settled_message_insert_failed" }

  await recordEvent({
    companyId: input.companyId,
    customerId: input.customerId,
    sessionId: input.sessionId,
    type: "chat.turn.assistant",
    actor: "system",
    payload: { message_id: message.id, kind: "debt_settled" },
  })
  return { ok: true, created: true, messageId: message.id }
}

/**
 * Bootstrap tolerante a falhas da mensagem de quitação (análogo a bootstrapAckSafe).
 * Só roda com CHAT_JOURNEY_ENABLED=true e NUNCA lança — uma falha aqui não pode
 * derrubar a autenticação (o cliente entra no chat de qualquer forma).
 */
export async function bootstrapSettledSafe(input: {
  companyId: string
  sessionId: string
  customerId: string
  totalPaid: number
  oldestDueDate: string | null
  paidAt: string | null
}): Promise<void> {
  if (process.env.CHAT_JOURNEY_ENABLED !== "true") return
  try {
    await bootstrapSettledMessage(input)
  } catch (err) {
    console.warn("[journey] bootstrap quitação falhou:", (err as Error).message)
  }
}

export type BootstrapAckResult =
  | { ok: true; created: false; reason: "disabled" | "already_active" }
  | { ok: true; created: true; prompt: PromptRow }
  | { ok: false; error: string }

/**
 * Cria o prompt INICIAL da sessão — Consultar/Negociar (fluxo pedido pelo dono).
 * Idempotente na RE-ENTRADA: só evita recriar quando já há um prompt ATIVO da
 * jornada (debt_consult/debt_acknowledgement) na sessão.
 *
 * BUG corrigido (histórico/dead-state): antes, bastar existir QUALQUER
 * reconhecimento anterior ('Sim, reconheço') para o bootstrap devolver
 * 'already_answered' e NÃO recriar prompt — a sessão reaberta ficava sem prompt
 * ativo (menu morto), o devedor via só o clique antigo e não conseguia
 * continuar. Agora, com um reconhecimento passado mas SEM prompt ativo, o
 * bootstrap reabre o menu Consultar/Negociar para o devedor seguir. O histórico
 * completo (persistido em chat_messages) continua carregando normalmente.
 *
 * Respeita acknowledgement_enabled (default true).
 */
export async function bootstrapAcknowledgementPrompt(input: {
  companyId: string
  sessionId: string
  customerId: string
  debtIds: string[]
  primaryDebtId: string
}): Promise<BootstrapAckResult> {
  const supabase = createServiceClient()
  const { data: cfg } = await supabase
    .from("tenant_chat_config")
    .select("acknowledgement_enabled, show_handoff_button")
    .eq("company_id", input.companyId)
    .maybeSingle()
  if (cfg?.acknowledgement_enabled === false) {
    return { ok: true, created: false, reason: "disabled" }
  }

  // idempotência: já existe um prompt ATIVO da jornada (Consultar/Negociar ou o
  // reconhecimento legado)? Não recria — devolve o ativo. NÃO barramos mais por
  // reconhecimento passado (esse era o bug do menu morto): sem prompt ativo, o
  // menu é reaberto ainda que já tenha havido um "Sim/Não" antes.
  const { data: existing } = await supabase
    .from("chat_prompts")
    .select("*")
    .eq("session_id", input.sessionId)
    .in("kind", ["debt_consult", "debt_acknowledgement"])
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (existing) {
    return { ok: true, created: true, prompt: existing as PromptRow }
  }

  const ackCtx = await buildAckContext({
    companyId: input.companyId,
    customerId: input.customerId,
    debtIds: input.debtIds,
  })
  const question = consultNegotiateQuestion(ackCtx)
  const created = await createPrompt({
    companyId: input.companyId,
    sessionId: input.sessionId,
    kind: "debt_consult",
    question,
    buttons: consultNegotiateButtons(cfg?.show_handoff_button === true),
    context: {
      creditor_name: ackCtx.creditorName,
      updated_value: ackCtx.updatedValue,
      invoice_count: ackCtx.invoiceCount,
      oldest_due_date: ackCtx.oldestDueDate,
      primary_debt_id: input.primaryDebtId,
      // debt_ids consolida o valor no Consultar/Negociar (buildAckContext soma
      // todos). Sem isso, a rota cai no debt primário só.
      debt_ids: input.debtIds,
    },
    createdBy: "platform",
  })
  if (!created.ok) return { ok: false, error: created.error }

  // Persiste a PERGUNTA (saudação + convite Consultar/Negociar) como
  // chat_messages(role='assistant'), ligada ao prompt via prompt_id. Enquanto o
  // prompt está 'active' a UI a mostra no bloco de botões; depois de respondido,
  // este registro mantém a pergunta no histórico — sem ele, uma sessão reaberta
  // só traria o clique do cliente.
  await persistAssistantMessage({
    companyId: input.companyId,
    sessionId: input.sessionId,
    text: question,
    promptId: created.prompt.id,
  })

  return { ok: true, created: true, prompt: created.prompt }
}

/** Ação anexada a uma bolha (botão-link renderizado pelo client abaixo dela). */
export interface MessageAction {
  type: "external_link" | "open_payment_link"
  label: string
  href: string
}

/**
 * Grava uma mensagem do assistente em chat_messages (engine='platform', fluxo
 * assistido). Reusa o mesmo caminho que /api/chat/messages lê. Idempotente por
 * (prompt_id, stage) quando `promptId` é informado: a pergunta de um prompt é
 * gravada uma única vez (stage null), e uma resposta ligada ao prompt respondido
 * (ex.: stage 'detail') idem — os dois convivem no mesmo prompt_id. O texto já é
 * neutro/sem PII. NUNCA lança — uma falha aqui não pode derrubar a criação do
 * prompt nem o processamento do clique.
 *
 * `stage` e `action` vão para offers_snapshot ({ stage, message_action, ... }):
 * marcadores que a rota /api/chat/messages expõe ao client (stage/action) e que
 * a poda/retomada (A3) usa para classificar outcome/greeting.
 */
export async function persistAssistantMessage(input: {
  companyId: string
  sessionId: string
  text: string
  promptId?: string | null
  /** marcador de estágio (greeting | detail | payment_link | not_recognized | payment_claim). */
  stage?: string | null
  /** botão-link anexado à bolha (offers_snapshot.message_action). */
  action?: MessageAction | null
  /** campos extras de offers_snapshot (ex.: agreement_id). */
  snapshot?: Record<string, unknown> | null
  /** época já lida pelo chamador (evita 1 round-trip). */
  threadEpoch?: number
  /** pula o dedup de conteúdo de 15min (bolhas únicas por natureza, ex.: saudação). */
  skipContentDedup?: boolean
}): Promise<string | null> {
  const text = (input.text ?? "").trim()
  if (!text) return null
  const supabase = createServiceClient()
  const stage = input.stage ?? null
  // Um OUTCOME ligado ao clique (stage + promptId — ex.: detalhes da dívida do
  // prompt X) é uma resposta ÀQUELE clique: não cai no dedup de conteúdo de 15min
  // (a idempotência por (prompt_id, stage) já impede a duplicata do mesmo clique;
  // textos idênticos de cliques distintos colapsam só na EXIBIÇÃO, no client).
  const skipContentDedup = input.skipContentDedup === true || (!!stage && !!input.promptId)
  try {
    // Leituras INDEPENDENTES em paralelo (A1: latência do clique): idempotência por
    // (prompt_id, stage), dedup por conteúdo (15min) e época corrente.
    const since = new Date(Date.now() - 15 * 60_000).toISOString()
    const [byPrompt, byContent, epoch] = await Promise.all([
      input.promptId
        ? supabase
            .from("chat_messages")
            .select("id, offers_snapshot")
            .eq("session_id", input.sessionId)
            .eq("prompt_id", input.promptId)
            .eq("role", "assistant")
            .limit(20)
        : Promise.resolve({ data: null as Array<{ id: string; offers_snapshot?: unknown }> | null }),
      skipContentDedup
        ? Promise.resolve({ data: null as { id: string } | null })
        : supabase
            .from("chat_messages")
            .select("id")
            .eq("session_id", input.sessionId)
            .eq("role", "assistant")
            .eq("text", text)
            .gte("created_at", since)
            .limit(1)
            .maybeSingle(),
      typeof input.threadEpoch === "number"
        ? Promise.resolve(input.threadEpoch)
        : getCurrentThreadEpoch(input.sessionId),
    ])

    // idempotência: a pergunta (stage null) / a resposta (stage X) de um prompt é
    // gravada uma única vez cada.
    const existing = ((byPrompt.data ?? []) as Array<{ id: string; offers_snapshot?: unknown }>).find((r) => {
      const snap = r.offers_snapshot && typeof r.offers_snapshot === "object" ? (r.offers_snapshot as { stage?: unknown }) : null
      const rowStage = snap && typeof snap.stage === "string" ? snap.stage : null
      return rowStage === stage
    })
    if (existing) return existing.id

    // DEDUP POR CONTEÚDO — "manter só a última" (mesmo padrão provado em
    // chat-send.ts:87-99). Fluxos plataforma re-persistiam texto IDÊNTICO a cada
    // clique/re-entrada — sem promptId, ou com um prompt NOVO. Se uma mensagem
    // 'assistant' com o MESMO texto já existe nesta sessão nos últimos 15min, NÃO
    // re-insere: devolve o id existente.
    const dup = byContent.data as { id: string } | null
    if (dup) return dup.id

    // C3: carimba a ÉPOCA corrente na bolha nova (só quando > 0 — época 0 =
    // default = dispensa a coluna e não quebra em prod antes da 20260935).
    const insertRow: Record<string, unknown> = {
      company_id: input.companyId,
      session_id: input.sessionId,
      role: "assistant",
      text,
      engine: "platform",
      prompt_id: input.promptId ?? null,
    }
    if (epoch > 0) insertRow.thread_epoch = epoch
    const snapshot: Record<string, unknown> = { ...(input.snapshot ?? {}) }
    if (stage) snapshot.stage = stage
    if (input.action) snapshot.message_action = input.action
    if (Object.keys(snapshot).length > 0) insertRow.offers_snapshot = snapshot
    const { data } = await supabase
      .from("chat_messages")
      .insert(insertRow)
      .select("id")
      .single()
    return (data as { id: string } | null)?.id ?? null
  } catch (err) {
    console.warn("[journey] persistAssistantMessage falhou:", (err as Error).message)
    return null
  }
}

/**
 * Bootstrap tolerante a falhas para chamar na criação da sessão (auth). Só roda
 * com CHAT_JOURNEY_ENABLED=true (comportamento de prod idêntico com a flag OFF)
 * e NUNCA lança — uma falha no reconhecimento não pode derrubar a autenticação.
 */
export async function bootstrapAckSafe(input: {
  companyId: string
  sessionId: string
  customerId: string
  debtIds: string[]
  primaryDebtId: string | null
}): Promise<void> {
  if (process.env.CHAT_JOURNEY_ENABLED !== "true") return
  if (!input.primaryDebtId || input.debtIds.length === 0) return
  try {
    await bootstrapAcknowledgementPrompt({
      companyId: input.companyId,
      sessionId: input.sessionId,
      customerId: input.customerId,
      debtIds: input.debtIds,
      primaryDebtId: input.primaryDebtId,
    })
  } catch (err) {
    console.warn("[journey] bootstrap reconhecimento falhou:", (err as Error).message)
  }
}

export interface AckLatest {
  id: string
  session_id: string
  debt_id: string
  acknowledged: boolean
  button_id: number
  created_at: string
}

/** Última resposta de reconhecimento por (session, debt) via view. */
export async function getLatestAcknowledgement(
  sessionId: string,
  debtId: string,
): Promise<AckLatest | null> {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from("debt_acknowledgement_latest")
    .select("id, session_id, debt_id, acknowledged, button_id, created_at")
    .eq("session_id", sessionId)
    .eq("debt_id", debtId)
    .maybeSingle()
  return (data as AckLatest) ?? null
}

export type RecordAckResult =
  | { ok: true; acknowledged: boolean; buttonId: number; onNotRecognized?: "continue" | "dispute" | "human" }
  | { ok: false; status: number; code: string }

/**
 * Grava os 3 efeitos append-only do reconhecimento (append-log + journey_event +
 * espelho da sessão). Factored-out para ser reusado pelo reconhecimento legado
 * (recordAcknowledgement) E pelo fluxo Consultar/Negociar (o prompt já foi
 * respondido pela rota via answerPrompt). NÃO responde o prompt — quem chama
 * decide quando marcar answered. `source` distingue a origem no append-log.
 */
export async function persistDebtRecognition(input: {
  companyId: string
  sessionId: string
  customerId: string
  debtId: string
  promptId: string
  buttonId: number
  acknowledged: boolean
  source: string
  /** M4: 'implicit' quando o reconhecimento vem do clique em Pagar/Negociar no
   *  menu de 3 opções; 'explicit' (default) no "Sim, reconheço". */
  mode?: "explicit" | "implicit"
  ip?: string | null
  userAgent?: string | null
}): Promise<void> {
  const supabase = createServiceClient()
  const ipHash = input.ip
    ? createHash("sha256").update(input.ip).digest("hex").slice(0, 32)
    : null

  // 1) append-only debt_acknowledgements. O supabase-js NÃO lança em violação de
  //    constraint (retorna {error}) — checamos explicitamente para NUNCA descartar
  //    o reconhecimento em silêncio. Bug histórico: o CHECK(button_id in (0,1))
  //    rejeitava o button_id=3 (Negociar) e a linha sumia sem trace, quebrando o
  //    debt_acknowledgement_latest/o guard de pagamento. A migration
  //    20260932_debt_ack_button_id_relax.sql relaxa o CHECK para (0,1,2,3) e a
  //    20260933_debt_ack_mode.sql estende para (0,1,2,3,4) incluindo PAGAR; aqui
  //    lançamos o erro para o chamador (rota) resolver como 500 auditável em vez
  //    de seguir com um reconhecimento fantasma.
  const { error: ackInsertError } = await supabase.from("debt_acknowledgements").insert({
    company_id: input.companyId,
    session_id: input.sessionId,
    customer_id: input.customerId,
    debt_id: input.debtId,
    prompt_id: input.promptId,
    acknowledged: input.acknowledged,
    button_id: input.buttonId,
    source: input.source,
    mode: input.mode ?? "explicit",
    ip_hash: ipHash,
    user_agent: input.userAgent ?? null,
  })
  if (ackInsertError) {
    throw new Error(`debt_acknowledgements insert falhou: ${ackInsertError.message}`)
  }

  // 2) journey_events (debt.acknowledged | debt.not_recognized)
  await recordEvent({
    companyId: input.companyId,
    customerId: input.customerId,
    debtId: input.debtId,
    sessionId: input.sessionId,
    type: input.acknowledged ? "debt.acknowledged" : "debt.not_recognized",
    actor: "customer",
    payload: { button_id: input.buttonId, prompt_id: input.promptId },
  })

  // 3) espelho do timestamp na sessão (só quando reconhece)
  if (input.acknowledged) {
    await supabase
      .from("negotiation_sessions")
      .update({ debt_acknowledged_at: new Date().toISOString() })
      .eq("id", input.sessionId)
  }
}

/** Comportamento do tenant no "Não reconheço" (default continue). */
async function onNotRecognizedBehavior(companyId: string): Promise<"continue" | "dispute" | "human"> {
  const supabase = createServiceClient()
  const { data: cfg } = await supabase
    .from("tenant_chat_config")
    .select("on_debt_not_recognized")
    .eq("company_id", companyId)
    .maybeSingle()
  return (cfg?.on_debt_not_recognized ?? "continue") as "continue" | "dispute" | "human"
}

/**
 * Registra a resposta de reconhecimento a partir de um clique num prompt
 * debt_acknowledgement. Grava os 4 efeitos numa transação lógica. Trata o
 * botão [99] (atendente) como handoff — não é 0 nem 1, então NÃO grava
 * debt_acknowledgements; devolve onNotRecognized='human'.
 */
export async function recordAcknowledgement(input: {
  companyId: string
  sessionId: string
  customerId: string
  debtId: string
  promptId: string
  buttonId: number
  ip?: string | null
  userAgent?: string | null
}): Promise<RecordAckResult> {
  // 1) responde o prompt (valida integridade + grava a mensagem do cliente)
  const answered = await answerPrompt({
    sessionId: input.sessionId,
    companyId: input.companyId,
    promptId: input.promptId,
    buttonId: input.buttonId,
  })
  if (!answered.ok) return { ok: false, status: answered.status, code: answered.code }

  // botão de handoff [99]: não é reconhecimento — o chamador conduz o transfer.
  if (input.buttonId === BTN_HANDOFF) {
    return { ok: true, acknowledged: false, buttonId: BTN_HANDOFF, onNotRecognized: "human" }
  }

  const acknowledged = input.buttonId === BTN_YES // 1 = reconhece; 0 = não
  await persistDebtRecognition({
    companyId: input.companyId,
    sessionId: input.sessionId,
    customerId: input.customerId,
    debtId: input.debtId,
    promptId: input.promptId,
    buttonId: input.buttonId,
    acknowledged,
    source: "chat_button",
    ip: input.ip,
    userAgent: input.userAgent,
  })

  if (!acknowledged) {
    const behavior = await onNotRecognizedBehavior(input.companyId)
    return { ok: true, acknowledged: false, buttonId: input.buttonId, onNotRecognized: behavior }
  }

  return { ok: true, acknowledged: true, buttonId: input.buttonId }
}

export type StartN8nResult =
  | { ok: true; owner: "n8n"; delivered: boolean }
  | { ok: true; owner: "platform"; delivered: false } // fallback assistido (H8)

/**
 * Dispara o negotiation.start ao n8n em BACKGROUND (best-effort, fora do caminho
 * crítico do clique) e grava a auditoria do desfecho quando ele resolver. NUNCA
 * é aguardado pelo caminho da resposta ao cliente: o fetch ao webhook n8n pode
 * levar até N8N_FLOW_TIMEOUT_MS (~60s) e a rota tem maxDuration=60 — aguardar aqui
 * estourava o budget e deixava o botão "..." pendurado (Netlify matava a função
 * antes de responder). Ao rodar solto, o clique responde em <2s e o handoff n8n
 * segue por trás; se ele entregar, o engine_owner vira 'n8n' e os PRÓXIMOS turnos
 * vão ao fluxo (a resposta DESTE clique já foi persistida localmente pelo
 * chamador — o histórico nunca depende do n8n). NUNCA lança.
 */
/** Desfecho do disparo do negotiation.start (A2): o que foi gravado no banco. */
export type NegotiationStartOutcome =
  | { delivered: true; owner: "n8n" }
  | { delivered: false; owner: "platform"; reason: string }

/**
 * Executa o negotiation.start ao n8n e grava a auditoria/engine_owner conforme o
 * desfecho. É a unidade que dispatchNegotiationStartInBackground (fire-and-forget
 * legado) e kickoffNegotiationStart (com deadline — A2) compartilham. NUNCA lança:
 * qualquer falha vira `delivered:false` com um rótulo curto (sem URL/segredo/PII).
 */
async function runNegotiationStartDispatch(input: {
  companyId: string
  sessionId: string
  customerId: string
  debtId: string
  eventId: string
}): Promise<NegotiationStartOutcome> {
  try {
    const { emitNegotiationStart } = await import("@/lib/negotiation/engine")
    const emit = await emitNegotiationStart(input.sessionId, input.eventId)
    const delivered = emit.ok === true && "delivered" in emit && emit.delivered === true
    const reason = "reason" in emit ? String(emit.reason) : "unknown"

    const supabase = createServiceClient()
    // Só promove o dono a n8n quando o disparo foi de fato ENTREGUE. Sem entrega
    // (n8n não plugado/timeout/5xx) a sessão permanece no assistido (platform).
    if (delivered) {
      await supabase
        .from("negotiation_sessions")
        .update({ engine_owner: "n8n", updated_at: new Date().toISOString() })
        .eq("id", input.sessionId)
    }

    await recordEvent({
      companyId: input.companyId,
      customerId: input.customerId,
      debtId: input.debtId,
      sessionId: input.sessionId,
      // O funil não tem estágio próprio para negotiation.start; usamos um evento de
      // timeline (chat.turn.assistant marca a transição de dono do engine na
      // auditoria, com um payload explícito). engine_unavailable idem, no fallback.
      type: "chat.turn.assistant",
      actor: delivered ? "n8n" : "system",
      eventId: delivered ? `neg_start:${input.eventId}` : `neg_start_unavailable:${input.eventId}`,
      payload: delivered
        ? { event: "negotiation.start", engine_owner: "n8n" }
        : { event: "engine_unavailable", engine_owner: "platform", reason },
    })
    return delivered ? { delivered: true, owner: "n8n" } : { delivered: false, owner: "platform", reason }
  } catch (err) {
    // Best-effort: uma falha no handoff jamais afeta o clique. Só loga um rótulo
    // curto (sem URL/segredo/PII).
    console.warn("[journey] negotiation.start (dispatch) falhou:", (err as Error).message)
    return { delivered: false, owner: "platform", reason: "dispatch_error" }
  }
}

async function dispatchNegotiationStartInBackground(input: {
  companyId: string
  sessionId: string
  customerId: string
  debtId: string
  eventId: string
}): Promise<void> {
  await runNegotiationStartDispatch(input)
}

/** Estado do kickoff no momento da RESPOSTA ao clique (A2). `pending` = o disparo
 *  não resolveu dentro do deadline e segue solto (a resposta não espera). */
export type KickoffStatus =
  | { status: "delivered"; owner: "n8n" }
  | { status: "unavailable"; owner: "platform"; reason: string }
  // QA round 4 (R-18/R-27, S9): desfecho ainda desconhecido → "pending" explícito
  // (nunca "platform" presumido — o banco virava n8n depois e divergia do corpo).
  | { status: "pending"; owner: "pending" }

export interface KickoffHandle {
  eventId: string
  /** Aguarda o disparo até `deadlineMs` (≥ 0). Se resolver, devolve o desfecho
   *  gravado no banco (engine_owner alinhado — N-D2-12); senão `pending`. */
  settle(deadlineMs: number): Promise<KickoffStatus>
}

/** Deadline padrão do kickoff no caminho do clique (ms). Configurável por env
 *  N8N_KICKOFF_DEADLINE_MS; o POST ao n8n tem o seu próprio N8N_KICKOFF_TIMEOUT_MS. */
export function kickoffDeadlineMs(): number {
  const n = Number(process.env.N8N_KICKOFF_DEADLINE_MS)
  return Number.isFinite(n) && n >= 0 ? n : 2500
}

/**
 * A2 (N-D2-10) — kickoff do negotiation.start FORA do caminho crítico mas
 * CONFIÁVEL em serverless: o disparo começa JÁ (em paralelo com a apresentação
 * das parcelas) e a resposta ao clique só o aguarda até um deadline curto
 * (Promise.race, o mesmo mecanismo do handleDebtNegotiate). Na prática o POST
 * ao webhook do n8n responde na hora ("Workflow was started") e o disparo resolve
 * antes das parcelas — o `engine_owner` devolvido é então o que está no banco.
 * Estourado o deadline, a resposta não espera e o disparo segue solto (o mesmo
 * risco de congelamento de antes, agora BOUNDED e sinalizado como `pending`).
 * NUNCA lança.
 */
export function kickoffNegotiationStart(input: {
  companyId: string
  sessionId: string
  customerId: string
  debtId: string
}): KickoffHandle {
  const eventId = randomUUID()
  const dispatch = runNegotiationStartDispatch({ ...input, eventId })
  let settled: KickoffStatus | null = null
  const settledPromise: Promise<KickoffStatus> = dispatch.then((out) => {
    settled = out.delivered
      ? { status: "delivered", owner: "n8n" }
      : { status: "unavailable", owner: "platform", reason: out.reason }
    return settled
  })
  return {
    eventId,
    async settle(deadlineMs: number): Promise<KickoffStatus> {
      if (settled) return settled
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race<KickoffStatus>([
          settledPromise,
          new Promise<KickoffStatus>((resolve) => {
            timer = setTimeout(() => resolve({ status: "pending", owner: "pending" }), Math.max(0, deadlineMs))
            // não segura o event loop: o disparo, se estourar, segue solto.
            timer.unref?.()
          }),
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }
    },
  }
}

/**
 * H7: handoff ao n8n no reconhecimento "Sim"/Negociar. Efeitos:
 *   1) DISPARA negotiation.start ao n8n em BACKGROUND (best-effort — ver
 *      dispatchNegotiationStartInBackground). O fetch ao webhook n8n NÃO é
 *      aguardado: manter o clique instantâneo é a garantia de vivacidade do botão.
 *   2) a auditoria (engine_owner + journey_event) é gravada pelo background
 *      quando o disparo resolve.
 *
 * RESILIENTE (H8): SEMPRE retorna owner='platform' SÍNCRONO — a resposta DESTE
 * clique é persistida localmente pelo chamador (o histórico nunca depende do
 * n8n). Se o n8n entregar por trás, os PRÓXIMOS turnos vão ao fluxo. NUNCA lança.
 *
 * `waitForDispatch` (default false) permite ao chamador/teste aguardar o
 * background de forma DETERMINÍSTICA. handleDebtNegotiate passa `true` DE
 * PROPÓSITO (protegido por um Promise.race contra deadline curto), garantindo
 * que o disparo é iniciado sem travar o clique; o default fire-and-forget vale
 * para os demais caminhos (ex.: reconhecimento legado na rota).
 */
export async function startN8nNegotiation(input: {
  companyId: string
  sessionId: string
  customerId: string
  debtId: string
  waitForDispatch?: boolean
}): Promise<StartN8nResult> {
  const eventId = randomUUID()

  const dispatch = dispatchNegotiationStartInBackground({
    companyId: input.companyId,
    sessionId: input.sessionId,
    customerId: input.customerId,
    debtId: input.debtId,
    eventId,
  })
  // CORRIGIDO (2026-09-23): o caminho crítico do clique NUNCA aguarda o dispatch
  // por PADRÃO. O kickoff (emitNegotiationStart) já roda com timeout curto (~5s,
  // N8N_KICKOFF_TIMEOUT_MS) DENTRO do dispatch; aguardá-lo aqui por default era o
  // que travava o botão em "..." (build + até 5s de POST síncrono). Agora o default
  // é fire-and-forget: o clique responde imediatamente após persistir, e o disparo
  // segue resolvendo em background. `waitForDispatch:true` EXPLÍCITO ainda permite
  // o modo determinístico — usado pelos testes e por handleDebtNegotiate, que se
  // protege da trava com um Promise.race contra deadline curto próprio. O rejection
  // é engolido dentro do dispatch (nunca lança).
  if (input.waitForDispatch === true) {
    await dispatch
  } else {
    void dispatch
  }

  // Owner SÍNCRONO = platform: o clique responde já e o reply é sempre
  // persistido. A promoção a 'n8n' (se entregar) acontece no background.
  return { ok: true, owner: "platform", delivered: false }
}

// --- orquestração do fluxo Consultar/Negociar (rota /api/chat/button) --------
//
// As funções abaixo são chamadas pela rota DEPOIS de answerPrompt (que já marcou
// o prompt debt_consult como answered e gravou o clique do cliente). Elas
// publicam a MENSAGEM de dados da dívida e conduzem o próximo passo, sempre
// persistindo em chat_messages para o histórico da re-entrada.

/** Lê show_handoff_button do tenant (default false). */
async function showHandoff(companyId: string): Promise<boolean> {
  const supabase = createServiceClient()
  const { data: cfg } = await supabase
    .from("tenant_chat_config")
    .select("show_handoff_button")
    .eq("company_id", companyId)
    .maybeSingle()
  return cfg?.show_handoff_button === true
}

/**
 * "Consultar Dívida" [2]: publica os DADOS da dívida como mensagem do assistente
 * e reabre o menu (Negociar Dívida [3] + Não reconheço [0]). NÃO inicia o n8n
 * nem registra reconhecimento — só mostra e devolve o controle ao devedor.
 */
export async function handleDebtConsult(input: {
  companyId: string
  sessionId: string
  customerId: string
  debtId: string
  debtIds: string[]
  primaryDebtId: string
}): Promise<{ ok: true; reply: string }> {
  const ackCtx = await buildAckContext({
    companyId: input.companyId,
    customerId: input.customerId,
    debtIds: input.debtIds,
  })
  const info = debtInfoMessage(ackCtx)
  await persistAssistantMessage({
    companyId: input.companyId,
    sessionId: input.sessionId,
    text: info,
  })

  // reabre o menu pós-consulta (Negociar / Não reconheço). A pergunta também é
  // persistida como mensagem (ligada ao prompt) para o histórico da re-entrada.
  const handoff = await showHandoff(input.companyId)
  const question = postConsultQuestion()
  const created = await createPrompt({
    companyId: input.companyId,
    sessionId: input.sessionId,
    kind: "debt_consult",
    question,
    buttons: postConsultButtons(handoff),
    context: {
      creditor_name: ackCtx.creditorName,
      updated_value: ackCtx.updatedValue,
      invoice_count: ackCtx.invoiceCount,
      oldest_due_date: ackCtx.oldestDueDate,
      primary_debt_id: input.primaryDebtId,
      debt_ids: input.debtIds,
      stage: "post_consult",
    },
    createdBy: "platform",
  })
  if (created.ok) {
    await persistAssistantMessage({
      companyId: input.companyId,
      sessionId: input.sessionId,
      text: question,
      promptId: created.prompt.id,
    })
  }
  return { ok: true, reply: info }
}

/**
 * "Negociar Dívida" [3] (caminho LEGADO do prompt debt_consult): mostra os dados
 * da dívida, registra o reconhecimento ("Sim") e INICIA a negociação no n8n
 * (negotiation.start). RESILIENTE (H8): se o n8n não responder, mantém o
 * assistido e persiste o reply — o cliente nunca vê erro.
 *
 * A2 (G2-c): este caminho NUNCA apresentava as parcelas (a única chamada a
 * presentMatrixOffers era o ramo 3-opções) — o devedor ficava em "preparando…
 * só um instante" para sempre. Agora apresenta a MATRIZ como o ramo 3-opções:
 * nenhum caminho de "negociar" sem parcelas na tela. O kickoff corre em paralelo
 * (kickoffNegotiationStart) e só é aguardado até o deadline curto.
 */
export async function handleDebtNegotiate(input: {
  companyId: string
  sessionId: string
  customerId: string
  debtId: string
  debtIds: string[]
  promptId: string
  buttonId: number
  ip?: string | null
  userAgent?: string | null
  dispatchDeadlineMs?: number // deadline do kickoff no caminho do clique (default N8N_KICKOFF_DEADLINE_MS/2500)
}): Promise<{
  ok: true
  engineOwner: "platform" | "n8n" | "pending"
  reply: string
  kickoff: KickoffStatus["status"]
  offersPresented: boolean
  prompt: PromptView | null
}> {
  const t0 = Date.now()
  // kickoff JÁ (fora do caminho crítico; aguardado só até o deadline no fim).
  const kickoff = kickoffNegotiationStart({
    companyId: input.companyId,
    sessionId: input.sessionId,
    customerId: input.customerId,
    debtId: input.debtId,
  })

  const ackCtx = await buildAckContext({
    companyId: input.companyId,
    customerId: input.customerId,
    debtIds: input.debtIds,
  })
  // dados da dívida (histórico legado) e reconhecimento em PARALELO (independentes).
  await Promise.all([
    persistAssistantMessage({
      companyId: input.companyId,
      sessionId: input.sessionId,
      text: debtInfoMessage(ackCtx),
    }),
    // Reconhecimento implícito ao Negociar: o devedor quer negociar → reconhece a
    // dívida. Grava os efeitos append-only (o prompt já foi respondido pela rota).
    persistDebtRecognition({
      companyId: input.companyId,
      sessionId: input.sessionId,
      customerId: input.customerId,
      debtId: input.debtId,
      promptId: input.promptId,
      buttonId: input.buttonId,
      acknowledged: true,
      source: "chat_button_negotiate",
      ip: input.ip,
      userAgent: input.userAgent,
    }),
  ])

  // Parcelas da matriz (assistido SEMPRE — A2 item 1). A confirmação T2 precede a
  // pergunta das parcelas no histórico (gravada só quando há parcelas). NUNCA
  // lança: falha → cai na espera.
  let presented: PresentMatrixOffersResult | null = null
  try {
    presented = await presentMatrixOffers({
      companyId: input.companyId,
      sessionId: input.sessionId,
      customerId: input.customerId,
      debtId: input.debtId,
      precedingWrite: () =>
        // T2 / R-26 (A4/S7): a MESMA constante da bolha otimista do client e da
        // pergunta das parcelas (fonte única em wait-machine.ts, N-D5-8).
        persistAssistantMessage({
          companyId: input.companyId,
          sessionId: input.sessionId,
          text: NEGOTIATION_PENDING_TEXT,
        }),
    })
  } catch (err) {
    console.warn("[journey] presentMatrixOffers (legado) falhou (cai na espera):", (err as Error).message)
  }
  const offersPresented = !!presented && presented.ok && presented.presented === true
  const prompt = offersPresented && presented && presented.ok && presented.presented ? presented.prompt : null

  // A4/S22: sem "Perfeito!"/"sanar o seu débito". Com parcelas, a confirmação S7
  // (T2, "…disponíveis para você:") já foi gravada como precedingWrite e as
  // condições vêm logo abaixo. A4 r2 (B3-F2): sem parcelas NADA vem depois, então
  // a frase é a completa, sem dois-pontos (NEGOTIATION_SEARCHING_TEXT).
  const reply = offersPresented ? NEGOTIATION_PENDING_TEXT : NEGOTIATION_SEARCHING_TEXT
  if (!offersPresented) {
    // Sem parcelas (sem faixa de matriz/falha): indicador "trabalhando" até o n8n
    // empurrar o próximo turno (via chat.send) ou a espera degradar (D2). Sem PII.
    // SEMPRE persiste o reply localmente (o histórico não depende do n8n).
    await persistAssistantMessage({
      companyId: input.companyId,
      sessionId: input.sessionId,
      text: reply,
    })
  }

  // Kickoff: aguarda só o que resta do deadline curto (Promise.race). Se entregou,
  // engine_owner devolvido = o gravado no banco ('n8n'); senão platform/pending.
  // QA round 2 (QAA2-02): com as parcelas prontas a resposta NÃO espera o
  // disparo (`settle(0)`), como no ramo de 3 opções — o kickoff segue em curso.
  const deadlineMs = input.dispatchDeadlineMs ?? kickoffDeadlineMs()
  const kick = await kickoff.settle(offersPresented ? 0 : Math.max(0, deadlineMs - (Date.now() - t0)))
  return { ok: true, engineOwner: kick.owner, reply, kickoff: kick.status, offersPresented, prompt }
}

/**
 * "Não reconheço a dívida" [0]: registra o não-reconhecimento a partir do prompt
 * debt_consult, aplica on_debt_not_recognized (continue|dispute|human) e devolve
 * o reply direcionando ao credor. O prompt já foi respondido pela rota.
 */
export async function handleDebtNotRecognized(input: {
  companyId: string
  sessionId: string
  customerId: string
  debtId: string
  promptId: string
  buttonId: number
  ip?: string | null
  userAgent?: string | null
}): Promise<{ ok: true; onNotRecognized: "continue" | "dispute" | "human" }> {
  await persistDebtRecognition({
    companyId: input.companyId,
    sessionId: input.sessionId,
    customerId: input.customerId,
    debtId: input.debtId,
    promptId: input.promptId,
    buttonId: input.buttonId,
    acknowledged: false,
    source: "chat_button_consult",
    ip: input.ip,
    userAgent: input.userAgent,
  })
  const onNotRecognized = await onNotRecognizedBehavior(input.companyId)
  return { ok: true, onNotRecognized }
}

/**
 * Reconhecimento IMPLÍCITO (M4) do menu de 3 opções: o clique em Pagar (4) ou
 * Negociar (1) conta como reconhecimento da dívida — grava
 * debt_acknowledgements(acknowledged=true, mode='implicit', button_id) e destrava
 * o payment.create (guard D18). É gravado ANTES de payService/negotiation.start
 * pela rota /api/chat/button (contrato G1). NÃO responde o prompt (a rota já
 * chamou answerPrompt). `source` distingue a origem no append-log:
 *   chat_three_options_pay | chat_three_options_negotiate.
 */
export async function recognizeImplicit(input: {
  companyId: string
  sessionId: string
  customerId: string
  debtId: string
  promptId: string
  buttonId: number // BTN_PAY (4) ou BTN_YES (1)
  source: string
  ip?: string | null
  userAgent?: string | null
}): Promise<void> {
  await persistDebtRecognition({
    companyId: input.companyId,
    sessionId: input.sessionId,
    customerId: input.customerId,
    debtId: input.debtId,
    promptId: input.promptId,
    buttonId: input.buttonId,
    acknowledged: true,
    mode: "implicit",
    source: input.source,
    ip: input.ip,
    userAgent: input.userAgent,
  })
}

/**
 * A1 / N-D1-5: reconhecimento implícito SEM regravar. Se a sessão já tem um
 * reconhecimento positivo para a dívida (view debt_acknowledgement_latest), NÃO
 * grava outro (3 escritas a menos por clique repetido em PAGAR). Senão, delega a
 * recognizeImplicit. Nunca lança além do que recognizeImplicit lança.
 */
export async function recognizeImplicitOnce(
  input: Parameters<typeof recognizeImplicit>[0],
): Promise<{ recorded: boolean }> {
  // Lê o APPEND-LOG (fonte da view debt_acknowledgement_latest): a última
  // resposta desta (sessão, dívida). Positiva → nada a regravar.
  const supabase = createServiceClient()
  const { data: latest } = await supabase
    .from("debt_acknowledgements")
    .select("acknowledged, created_at")
    .eq("session_id", input.sessionId)
    .eq("debt_id", input.debtId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if ((latest as { acknowledged?: boolean } | null)?.acknowledged === true) return { recorded: false }
  await recognizeImplicit(input)
  return { recorded: true }
}

export type AckGuard =
  | { ok: true }
  | { ok: false; code: "debt_not_acknowledged" }

/**
 * Invariante do payment.create (§3): com acknowledged=false (ou sem resposta),
 * recusa a menos que allow_payment_without_acknowledgement=true.
 * Retorna ok quando pode cobrar.
 */
export async function assertAcknowledgedForPayment(input: {
  companyId: string
  sessionId: string
  debtId: string
}): Promise<AckGuard> {
  const supabase = createServiceClient()
  const { data: cfg } = await supabase
    .from("tenant_chat_config")
    .select("allow_payment_without_acknowledgement, acknowledgement_enabled")
    .eq("company_id", input.companyId)
    .maybeSingle()
  // exceção explícita por tenant
  if (cfg?.allow_payment_without_acknowledgement === true) return { ok: true }
  // reconhecimento desligado no tenant → não bloqueia (nada a reconhecer)
  if (cfg?.acknowledgement_enabled === false) return { ok: true }

  const latest = await getLatestAcknowledgement(input.sessionId, input.debtId)
  if (latest?.acknowledged === true) return { ok: true }
  return { ok: false, code: "debt_not_acknowledged" }
}
