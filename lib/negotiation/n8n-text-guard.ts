// Guard de TEXTO vindo do n8n (N8N-6). Regra de ouro (CLAUDE.md §16): o SERVIDOR
// decide desconto/parcela/validade; o n8n só escolhe entre ofertas geradas. Logo,
// um texto livre do n8n NÃO pode anunciar ao devedor um fato monetário ou de
// estado que a plataforma não produziu ("90% de desconto aprovado!", "acordo
// fechado", "pagamento confirmado"), nem vazar o fallback/erro do fluxo
// ("selecione uma das opções válidas", uuid/null, stack trace).
//
// ÚNICO módulo com as regras. Pontos de uso (ganchos mínimos):
//   - ingestão papel B: lib/journey/chat-send.ts (chat.send e kickoff síncrono);
//   - ingestão papel A: lib/negotiation/engine.ts (reply síncrono do chat.turn);
//   - leitura: app/api/chat/messages e app/api/chat/history (linhas já gravadas).
//
// Camadas:
//   1) normalizeN8nText  — PURA: tira HTML, links markdown, URLs fora do domínio
//      da plataforma, normaliza espaços e corta em MAX_MESSAGE_CHARS.
//   2) assessN8nText     — PURA: classifica o texto contra os FATOS do servidor.
//   3) loadGuardFacts    — I/O: ofertas/prompt ativo/dívida/acordos/estado da sessão.
//   4) guardN8nIngest / filterN8nRowsForRead — orquestração + telemetria.
//
// Falsos positivos (conservador): números SÓ contam como fato monetário quando
// vêm com R$/"reais", "%" (exceto "100% seguro/online/…"), "Nx"/"N parcelas" ou
// data dd/mm/aaaa (dd/mm só com contexto de prazo). "desconto" sem número passa.
// Tempo futuro ("assim que o pagamento FOR confirmado") não é alegação de estado.

import { createHash } from "node:crypto"
import { appUrl, MAX_MESSAGE_CHARS } from "./config"
import { isGenericEngineFallback, sanitizeEngineText } from "@/lib/journey/wait-machine"

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export type GuardCategory = "fallback" | "money" | "state" | "empty"

export type GuardReason =
  | "empty_after_sanitize"
  | "engine_fallback_text"
  | "internal_leak"
  | "unverified_amount"
  | "unverified_percent"
  | "unverified_installments"
  | "unverified_date"
  | "discount_claim"
  | "state_claim_paid"
  | "state_claim_agreement"
  | "state_claim_closed"

export type GuardVerdict =
  | { ok: true; text: string }
  | { ok: false; reason: GuardReason; category: GuardCategory }

/** Fatos que o SERVIDOR produziu para a sessão (o único universo de números permitido). */
export interface GuardFacts {
  amountsCents: number[]
  percents: number[]
  installments: number[]
  /** YYYY-MM-DD */
  dates: string[]
  paymentConfirmed: boolean
  agreementClosed: boolean
  sessionClosed: boolean
}

export const EMPTY_FACTS: GuardFacts = {
  amountsCents: [],
  percents: [],
  installments: [],
  dates: [],
  paymentConfirmed: false,
  agreementClosed: false,
  sessionClosed: false,
}

// ---------------------------------------------------------------------------
// 1) Normalização (PURA)
// ---------------------------------------------------------------------------

const PLATFORM_HOSTS = ["alteapay.com"]

function platformHosts(): string[] {
  const hosts = [...PLATFORM_HOSTS]
  try {
    hosts.push(new URL(appUrl()).hostname.toLowerCase())
  } catch {
    /* appUrl inválida: só o domínio fixo */
  }
  return hosts
}

/** URL é do domínio da plataforma (ou subdomínio)? */
export function isPlatformUrl(raw: string, hosts: string[] = platformHosts()): boolean {
  try {
    const u = new URL(raw)
    if (u.protocol !== "https:" && u.protocol !== "http:") return false
    const h = u.hostname.toLowerCase()
    return hosts.some((d) => h === d || h.endsWith(`.${d}`))
  } catch {
    return false
  }
}

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>()"']+/gi

/**
 * PURA. HTML fora; link markdown `[rótulo](url)` → rótulo (+ url se for da
 * plataforma); URL solta fora do domínio da plataforma → removida; espaços
 * normalizados; corte em MAX_MESSAGE_CHARS. Ênfase markdown fica (o client a
 * sanitiza na exibição); o classificador lê a versão sem ênfase.
 */
export function normalizeN8nText(raw: string, hosts: string[] = platformHosts()): string {
  let t = String(raw ?? "")
  t = t.replace(/<[^>]*>/g, "")
  t = t.replace(/\[([^\]]*)\]\(([^)\s]*)\)/g, (_m, label: string, url: string) =>
    isPlatformUrl(url, hosts) ? `${label} ${url}`.trim() : label,
  )
  t = t.replace(URL_RE, (u) => {
    const trimmed = u.replace(/[.,;:!?]+$/, "")
    const tail = u.slice(trimmed.length)
    const full = trimmed.startsWith("www.") ? `https://${trimmed}` : trimmed
    return isPlatformUrl(full, hosts) ? u : tail
  })
  t = t
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  if (t.length > MAX_MESSAGE_CHARS) t = t.slice(0, MAX_MESSAGE_CHARS).trimEnd()
  return t
}

// ---------------------------------------------------------------------------
// 2) Extração de alegações (PURA)
// ---------------------------------------------------------------------------

/** "1.234,56" | "175,5" | "175.50" | "1.234" | "175" → centavos (null se não parseia). */
export function parseBrlToCents(raw: string): number | null {
  let s = String(raw ?? "").trim().replace(/\s/g, "").replace(/[.,]+$/, "")
  if (!s || !/^\d[\d.,]*$/.test(s)) return null
  if (s.includes(",")) {
    s = s.replace(/\./g, "").replace(",", ".")
  } else if (s.includes(".")) {
    const parts = s.split(".")
    const last = parts[parts.length - 1]
    s = last.length === 3 ? parts.join("") : `${parts.slice(0, -1).join("")}.${last}`
  }
  const n = Number(s)
  return Number.isFinite(n) ? Math.round(n * 100) : null
}

export interface ExtractedDate {
  y: number | null
  m: number
  d: number
}

export interface Claims {
  amountsCents: number[]
  percents: number[]
  installments: number[]
  dates: ExtractedDate[]
  discountClaim: boolean
  paidClaim: boolean
  agreementClaim: boolean
  closedClaim: boolean
}

const MONEY_RS_RE = /R\$\s*(\d[\d.]*(?:,\d{1,2})?)/gi
const MONEY_REAIS_RE = /(\d[\d.]*(?:,\d{1,2})?)\s*reais\b/gi
// "100% seguro/online/…" não é desconto.
const PERCENT_RE =
  /(\d{1,3}(?:[.,]\d{1,2})?)\s*(?:%|por\s*cento)(?!\s*(?:seguro|segura|online|digital|gratuito|gr[aá]tis|confidencial|sigiloso|protegido|autom[aá]tico|oficial))/gi
const INSTALLMENT_X_RE = /(?<![\d.,/])(\d{1,2})\s?x(?![a-zà-ú0-9])/gi
const INSTALLMENT_WORD_RE = /(?<![\d.,/])(\d{1,2})\s+(?:parcelas?|presta[cç][oõ]es|presta[cç][aã]o|vezes)\b/gi
const DATE_FULL_RE = /(?<![\d/])(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})(?![\d/])/g
const DATE_ISO_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/g
// dd/mm sem ano só com contexto de prazo ("até 30/09", "vence dia 05/10").
const DATE_SHORT_CTX_RE =
  /\b(?:at[eé]|vence|vencimento|venc\.?|dia|v[aá]lid[oa]s?|prazo|data|pagar\s+em|em)\s+(?:[a-zà-ú]+\s+){0,2}?(\d{1,2})\/(\d{1,2})(?![\d/])/gi

const DISCOUNT_CLAIM_RE: readonly RegExp[] = [
  /(?:desconto|abatimento|redu[cç][aã]o)\s+(?:especial\s+|exclusivo\s+|extra\s+)?(?:de\s+[\d.,]+\s*%\s+)?(?:j[aá]\s+)?(?:foi\s+|est[aá]\s+|fica\s+)?(?:aprovad|concedid|liberad|autorizad|garantid)/i,
  /(?:aprovamos|concedemos|liberamos|autorizamos|garantimos)\s+(?:um|uma|o|a|seu|sua)?\s*(?:desconto|abatimento|redu[cç][aã]o)/i,
  /d[ií]vida\s+(?:j[aá]\s+)?(?:foi\s+|est[aá]\s+)?(?:perdoad|zerad|anulad)/i,
]
const PAID_CLAIM_RE: readonly RegExp[] = [
  /(?:pagamento|pix|boleto)\s+(?:j[aá]\s+)?(?:foi\s+)?(?:confirmad|recebid|aprovad|identificad|compensad)/i,
  /recebemos\s+(?:o\s+)?(?:seu\s+|sua\s+)?(?:pagamento|pix)/i,
  /(?:d[ií]vida|d[eé]bito|fatura|conta|parcela|acordo)s?\s+(?:j[aá]\s+)?(?:foi|foram|est[aá]|est[aã]o|ficou|consta(?:m)?\s+como)\s+(?:totalmente\s+|integralmente\s+)?(?:quitad|pag[oa]s?\b)/i,
  /(?:d[eé]bito|d[ií]vida|conta|fatura)\s+quitad/i,
  /\bj[aá]\s+(?:est[aá]|foi)\s+(?:tudo\s+)?quitad/i,
]
const AGREEMENT_CLAIM_RE: readonly RegExp[] = [
  /acordo\s+(?:j[aá]\s+)?(?:foi\s+|est[aá]\s+|consta\s+como\s+)?(?:fechad|firmad|formalizad|conclu[ií]d|efetivad|registrad)/i,
  /(?:fechamos|firmamos|formalizamos)\s+(?:o\s+|seu\s+|um\s+)?acordo/i,
]
const CLOSED_CLAIM_RE: readonly RegExp[] = [
  /(?:negocia[cç][aã]o|atendimento|conversa|sess[aã]o)\s+(?:j[aá]\s+)?(?:foi\s+|est[aá]\s+|consta\s+como\s+)?(?:encerrad|finalizad|conclu[ií]d|cancelad)/i,
]

function collect(re: RegExp, text: string, fn: (m: RegExpExecArray) => void): void {
  re.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) fn(m)
}

function validDate(d: number, m: number): boolean {
  return d >= 1 && d <= 31 && m >= 1 && m <= 12
}

/** PURA. Extrai números monetários/prazos e alegações de estado do texto. */
export function extractClaims(rawText: string): Claims {
  const text = sanitizeEngineText(rawText ?? "")
  const amounts: number[] = []
  const percents: number[] = []
  const installments: number[] = []
  const dates: ExtractedDate[] = []

  const pushAmount = (m: RegExpExecArray) => {
    const c = parseBrlToCents(m[1])
    if (c != null) amounts.push(c)
  }
  collect(MONEY_RS_RE, text, pushAmount)
  collect(MONEY_REAIS_RE, text, pushAmount)
  collect(PERCENT_RE, text, (m) => {
    const n = Number(m[1].replace(",", "."))
    if (Number.isFinite(n)) percents.push(n)
  })
  collect(INSTALLMENT_X_RE, text, (m) => installments.push(Number(m[1])))
  collect(INSTALLMENT_WORD_RE, text, (m) => installments.push(Number(m[1])))
  collect(DATE_FULL_RE, text, (m) => {
    const d = Number(m[1]), mo = Number(m[2])
    let y = Number(m[3])
    if (m[3].length === 2) y += 2000
    if (validDate(d, mo)) dates.push({ y, m: mo, d })
  })
  collect(DATE_ISO_RE, text, (m) => {
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3])
    if (validDate(d, mo)) dates.push({ y, m: mo, d })
  })
  collect(DATE_SHORT_CTX_RE, text, (m) => {
    const d = Number(m[1]), mo = Number(m[2])
    if (validDate(d, mo)) dates.push({ y: null, m: mo, d })
  })

  return {
    amountsCents: amounts,
    percents,
    installments,
    dates,
    discountClaim: DISCOUNT_CLAIM_RE.some((re) => re.test(text)),
    paidClaim: PAID_CLAIM_RE.some((re) => re.test(text)),
    agreementClaim: AGREEMENT_CLAIM_RE.some((re) => re.test(text)),
    closedClaim: CLOSED_CLAIM_RE.some((re) => re.test(text)),
  }
}

/** PURA. true quando o texto contém algo que exige os fatos do servidor. */
export function hasClaims(c: Claims): boolean {
  return (
    c.amountsCents.length > 0 || c.percents.length > 0 || c.installments.length > 0 || c.dates.length > 0 ||
    c.discountClaim || c.paidClaim || c.agreementClaim || c.closedClaim
  )
}

// ---------------------------------------------------------------------------
// Fallback / vazamento técnico do fluxo (PURA)
// ---------------------------------------------------------------------------

const EXTRA_FALLBACK_RE: readonly RegExp[] = [
  /n[aã]o\s+conseguimos\s+encontrar\s+(?:o\s+|seu\s+|um\s+)?hist[oó]rico/i,
  /hist[oó]rico\s+de\s+intera[cç][oõ]es/i,
  /(?:op[cç][aã]o|resposta)\s+inv[aá]lida/i,
]
const LEAK_RE: readonly RegExp[] = [
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  /\b(?:null|undefined|NaN)\b/,
  /\[object Object\]/,
  /\{\{[\s\S]*?\}\}/,
  /\$json\b|\$node\b|\$\(\s*['"]/,
  /\bat\s+[\w.$<>]+\s+\([^)]*:\d+:\d+\)/,
  /\b(?:TypeError|ReferenceError|SyntaxError|RangeError)\b/,
  /Cannot read propert/i,
  /\bECONN[A-Z]+\b|\bETIMEDOUT\b/,
  /\bstack\s*trace\b/i,
  /Internal Server Error/i,
  /\bstatus code [45]\d\d\b/i,
]

/** PURA. Texto é fallback/erro do fluxo (tratar como falha do engine)? */
export function detectEngineFailureText(text: string): "engine_fallback_text" | "internal_leak" | null {
  const t = text ?? ""
  if (isGenericEngineFallback(t) || EXTRA_FALLBACK_RE.some((re) => re.test(t))) return "engine_fallback_text"
  if (LEAK_RE.some((re) => re.test(t))) return "internal_leak"
  return null
}

// ---------------------------------------------------------------------------
// 3) Avaliação contra os fatos (PURA)
// ---------------------------------------------------------------------------

function amountAllowed(cents: number, facts: GuardFacts): boolean {
  return facts.amountsCents.some((a) => Math.abs(a - cents) <= 1)
}
function percentAllowed(p: number, facts: GuardFacts): boolean {
  return facts.percents.some((a) => Math.abs(a - p) < 0.01 || Math.round(a) === p)
}
function installmentsAllowed(n: number, facts: GuardFacts): boolean {
  return n === 1 || facts.installments.includes(n)
}
function dateAllowed(d: ExtractedDate, facts: GuardFacts): boolean {
  const mmdd = `${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`
  return facts.dates.some((iso) => iso.slice(5, 10) === mmdd && (d.y == null || Number(iso.slice(0, 4)) === d.y))
}

/**
 * PURA. Classifica um texto do n8n. `facts=null` = fatos indisponíveis:
 * qualquer alegação é recusada (fail-closed), texto sem alegação passa.
 */
export function assessN8nText(rawText: string, facts: GuardFacts | null): GuardVerdict {
  const text = normalizeN8nText(rawText)
  if (!text) return { ok: false, reason: "empty_after_sanitize", category: "empty" }
  const failure = detectEngineFailureText(sanitizeEngineText(text))
  if (failure) return { ok: false, reason: failure, category: "fallback" }

  const claims = extractClaims(text)
  if (!hasClaims(claims)) return { ok: true, text }
  const f = facts ?? EMPTY_FACTS

  if (claims.discountClaim) return { ok: false, reason: "discount_claim", category: "money" }
  if (claims.amountsCents.some((c) => !amountAllowed(c, f))) return { ok: false, reason: "unverified_amount", category: "money" }
  if (claims.percents.some((p) => !percentAllowed(p, f))) return { ok: false, reason: "unverified_percent", category: "money" }
  if (claims.installments.some((n) => !installmentsAllowed(n, f))) {
    return { ok: false, reason: "unverified_installments", category: "money" }
  }
  if (claims.dates.some((d) => !dateAllowed(d, f))) return { ok: false, reason: "unverified_date", category: "money" }
  if (claims.paidClaim && !f.paymentConfirmed) return { ok: false, reason: "state_claim_paid", category: "state" }
  if (claims.agreementClaim && !(f.agreementClosed || f.paymentConfirmed)) {
    return { ok: false, reason: "state_claim_agreement", category: "state" }
  }
  if (claims.closedClaim && !f.sessionClosed) return { ok: false, reason: "state_claim_closed", category: "state" }
  return { ok: true, text }
}

/** Monta os fatos a partir de linhas cruas (PURA — testável sem banco). */
export function buildFacts(input: {
  offers?: Array<{ terms?: Record<string, unknown> | null; valid_until?: string | null }>
  agreements?: Array<Record<string, unknown>>
  debts?: Array<{ amount?: unknown; due_date?: unknown }>
  extraAmountsReais?: Array<number | null | undefined>
  extraDates?: Array<string | null | undefined>
  promptTexts?: string[]
  session?: { outcome?: string | null; status?: string | null; agreement_id?: string | null } | null
}): GuardFacts {
  const amounts: number[] = []
  const percents: number[] = []
  const installments: number[] = []
  const dates: string[] = []
  const reais = (v: unknown) => {
    const n = Number(v)
    if (v != null && v !== "" && Number.isFinite(n)) amounts.push(Math.round(n * 100))
  }
  const date = (v: unknown) => {
    if (typeof v !== "string" || !v) return
    const iso = v.slice(0, 10)
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) dates.push(iso)
    // valid_until é timestamptz: a data local (São Paulo) pode ser a anterior.
    if (v.length > 10) {
      const t = Date.parse(v)
      if (Number.isFinite(t)) dates.push(new Date(t).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }))
    }
  }

  for (const o of input.offers ?? []) {
    const t = (o.terms ?? {}) as Record<string, unknown>
    for (const k of ["original_value", "discount_value", "entry_value", "installment_value", "total_value"]) reais(t[k])
    if (t.discount_pct != null && Number.isFinite(Number(t.discount_pct))) percents.push(Number(t.discount_pct))
    if (Number.isFinite(Number(t.installments))) installments.push(Number(t.installments))
    date(t.first_due_date)
    date(o.valid_until)
  }
  let paymentConfirmed = false
  let agreementClosed = false
  for (const a of input.agreements ?? []) {
    for (const k of ["agreed_amount", "total_amount", "installment_amount", "discount_amount", "original_amount"]) reais(a[k])
    if (a.discount_percentage != null && Number.isFinite(Number(a.discount_percentage))) {
      percents.push(Number(a.discount_percentage))
    }
    if (Number.isFinite(Number(a.installments)) && a.installments != null) installments.push(Number(a.installments))
    date(a.due_date)
    date(a.first_due_date)
    date(a.proposal_valid_until)
    const status = String(a.status ?? "")
    const pay = String(a.payment_status ?? "")
    const asaas = String(a.asaas_status ?? "")
    const cancelled = ["cancelled", "canceled"].includes(status) || ["cancelled", "deleted", "refunded"].includes(pay)
    if (!cancelled) agreementClosed = true
    if (["paid", "completed", "pago_ao_cliente"].includes(status) || ["received", "confirmed"].includes(pay) ||
      ["RECEIVED", "RECEIVED_IN_CASH", "CONFIRMED"].includes(asaas)) {
      paymentConfirmed = true
    }
  }
  for (const d of input.debts ?? []) {
    reais(d.amount)
    date(d.due_date)
  }
  for (const v of input.extraAmountsReais ?? []) reais(v)
  for (const v of input.extraDates ?? []) date(v)
  for (const pt of input.promptTexts ?? []) {
    const c = extractClaims(pt)
    amounts.push(...c.amountsCents)
    percents.push(...c.percents)
    installments.push(...c.installments)
    for (const d of c.dates) {
      if (d.y != null) dates.push(`${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`)
    }
  }
  const outcome = input.session?.outcome ?? "in_progress"
  if (outcome === "agreement_closed") agreementClosed = true
  const sessionClosed = input.session?.status === "closed" || (outcome != null && outcome !== "in_progress")

  return { amountsCents: amounts, percents, installments, dates, paymentConfirmed, agreementClosed, sessionClosed }
}

// ---------------------------------------------------------------------------
// 4) I/O: fatos do servidor, telemetria, ganchos
// ---------------------------------------------------------------------------

/**
 * Lê os fatos da sessão. `mode='ingest'`: só ofertas vigentes (presented/accepted);
 * `mode='read'`: todas as ofertas da sessão (uma linha gravada citando uma oferta
 * que depois expirou continua legítima). Retorna null em falha (fail-closed).
 */
export async function loadGuardFacts(
  sessionId: string,
  companyId: string,
  mode: "ingest" | "read" = "ingest",
): Promise<GuardFacts | null> {
  try {
    const { createServiceClient } = await import("@/lib/supabase/service")
    const supabase = createServiceClient()
    const { data: session } = await supabase
      .from("negotiation_sessions")
      .select("id, customer_id, debt_id, debt_ids, primary_debt_id, outcome, status, agreement_id")
      .eq("id", sessionId)
      .eq("company_id", companyId)
      .maybeSingle()
    if (!session) return null
    const s = session as {
      customer_id?: string | null; debt_id?: string | null; debt_ids?: string[] | null
      primary_debt_id?: string | null; outcome?: string | null; status?: string | null; agreement_id?: string | null
    }
    const debtIds = Array.from(new Set([...(s.debt_ids ?? []), s.primary_debt_id, s.debt_id].filter(Boolean))) as string[]

    let offersQ = supabase.from("negotiation_offers").select("terms, valid_until, status").eq("session_id", sessionId)
    if (mode === "ingest") offersQ = offersQ.in("status", ["presented", "accepted"])

    const [offersRes, promptRes, debtsRes, agreementsRes, pinned] = await Promise.all([
      offersQ.limit(100),
      supabase
        .from("chat_prompts")
        .select("question, buttons, created_by")
        .eq("session_id", sessionId)
        .eq("status", "active")
        .limit(1)
        .maybeSingle(),
      debtIds.length
        ? supabase.from("debts").select("amount, due_date").eq("company_id", companyId).in("id", debtIds)
        : Promise.resolve({ data: [] as Array<{ amount?: unknown; due_date?: unknown }> }),
      s.customer_id
        ? supabase
            .from("agreements")
            .select("id, agreed_amount, installment_amount, installments, discount_amount, discount_percentage, due_date, proposal_valid_until, status, payment_status, asaas_status")
            .eq("company_id", companyId)
            .eq("customer_id", s.customer_id)
            .limit(50)
        : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
      import("@/lib/journey/pinned-debt").then((m) => m.buildPinnedDebt(sessionId, companyId)).catch(() => null),
    ])

    const prompt = promptRes.data as { question?: string; buttons?: Array<{ label?: string }>; created_by?: string } | null
    const promptTexts =
      prompt && prompt.created_by === "platform"
        ? [String(prompt.question ?? ""), ...(prompt.buttons ?? []).map((b) => String(b?.label ?? ""))]
        : []

    return buildFacts({
      offers: (offersRes.data ?? []) as Array<{ terms?: Record<string, unknown> | null; valid_until?: string | null }>,
      agreements: (agreementsRes.data ?? []) as Array<Record<string, unknown>>,
      debts: (debtsRes.data ?? []) as Array<{ amount?: unknown; due_date?: unknown }>,
      extraAmountsReais: [pinned?.updated_value],
      extraDates: [pinned?.oldest_due_date],
      promptTexts,
      session: s,
    })
  } catch (err) {
    console.warn("[n8n-text-guard] fatos indisponíveis (fail-closed):", err instanceof Error ? err.name : "erro")
    return null
  }
}

/** Hash curto (sem texto cru) para correlacionar a recusa na telemetria. */
export function shortTextHash(text: string): string {
  return createHash("sha256").update(text ?? "").digest("hex").slice(0, 12)
}

export interface GuardSessionRef {
  sessionId: string
  companyId: string
  customerId?: string | null
  debtId?: string | null
}

/** Telemetria da recusa: journey_events SEM PII e SEM texto cru (só motivo, tamanho, hash). */
export async function recordTextRejection(
  ref: GuardSessionRef,
  source: string,
  reason: GuardReason,
  category: GuardCategory,
  rawText: string,
): Promise<void> {
  try {
    const { recordEvent } = await import("@/lib/journey/events")
    await recordEvent({
      companyId: ref.companyId,
      customerId: ref.customerId ?? null,
      debtId: ref.debtId ?? null,
      sessionId: ref.sessionId,
      type: "chat.engine_text_rejected",
      actor: "n8n",
      payload: { reason, category, source, text_len: (rawText ?? "").length, text_hash: shortTextHash(rawText) },
    })
  } catch (err) {
    console.warn("[n8n-text-guard] telemetria (não-fatal):", err instanceof Error ? err.name : "erro")
  }
}

/**
 * Fallback/erro do fluxo = falha do engine (mesmo caminho do chat-turn §5):
 * a sessão cai no assistido nos próximos turnos (engine='disabled'), salvo
 * NEGOTIATION_ENGINE_FALLBACK=off. Best-effort, nunca lança.
 */
export async function degradeSessionToAssisted(sessionId: string): Promise<void> {
  if (process.env.NEGOTIATION_ENGINE_FALLBACK === "off") return
  try {
    const { createServiceClient } = await import("@/lib/supabase/service")
    await createServiceClient().from("negotiation_sessions").update({ engine: "disabled" }).eq("id", sessionId)
  } catch (err) {
    console.warn("[n8n-text-guard] degradação (não-fatal):", err instanceof Error ? err.name : "erro")
  }
}

export type IngestVerdict = GuardVerdict

/**
 * Gate de INGESTÃO: avalia `text` (+ pergunta/rótulos de prompt, se houver)
 * contra os fatos da sessão. Só lê o banco quando o texto tem alegações. Em
 * recusa: telemetria; fallback/vazamento → degrada a sessão para o assistido.
 * O chamador decide o que o devedor vê (nada gravado / reply assistido).
 */
export async function guardN8nIngest(
  ref: GuardSessionRef,
  parts: { text: string; extra?: string[] },
  source: string,
): Promise<IngestVerdict> {
  const text = normalizeN8nText(parts.text ?? "")
  const pieces = [text, ...(parts.extra ?? []).map((e) => normalizeN8nText(e))].filter(Boolean)
  if (pieces.length === 0) {
    return { ok: false, reason: "empty_after_sanitize", category: "empty" }
  }
  const needs = pieces.some((p) => hasClaims(extractClaims(p)))
  const facts = needs ? await loadGuardFacts(ref.sessionId, ref.companyId, "ingest") : null
  for (const p of pieces) {
    const v = assessN8nText(p, facts)
    if (!v.ok) {
      await recordTextRejection(ref, source, v.reason, v.category, parts.text ?? "")
      if (v.category === "fallback") await degradeSessionToAssisted(ref.sessionId)
      return v
    }
  }
  return { ok: true, text }
}

/**
 * Filtro de LEITURA (defesa para linhas já gravadas e para clientes da API além
 * do web): remove linhas role='assistant' engine='n8n' que o guard recusaria e
 * devolve o texto normalizado nas demais. Só lê fatos se alguma linha n8n tiver
 * alegação. Nunca lança: em falha dos fatos, linhas COM alegação saem (fail-closed).
 */
export async function filterN8nRowsForRead<T extends { role?: unknown; engine?: unknown; text?: unknown }>(
  rows: T[],
  ref: { sessionId: string; companyId: string },
): Promise<T[]> {
  // Texto vazio não é alegação (a exibição já o oculta) — a linha segue intacta.
  const isN8n = (r: T) =>
    r.role === "assistant" && r.engine === "n8n" && typeof r.text === "string" && r.text.trim() !== ""
  if (!rows.some(isN8n)) return rows
  const needs = rows.some((r) => isN8n(r) && hasClaims(extractClaims(String(r.text))))
  const facts = needs ? await loadGuardFacts(ref.sessionId, ref.companyId, "read") : null
  const out: T[] = []
  for (const r of rows) {
    if (!isN8n(r)) {
      out.push(r)
      continue
    }
    const v = assessN8nText(String(r.text), facts)
    if (v.ok) out.push({ ...r, text: v.text })
  }
  return out
}
