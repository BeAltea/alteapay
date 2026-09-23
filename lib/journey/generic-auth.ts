// Autenticação genérica por documento (N1, endpoint /t/{slug}/negociar).
//
// Diferente de lib/journey/auth.ts (que autentica DENTRO de um token de
// campanha /c/{token}), aqui não há token: o cliente informa só o documento e o
// servidor resolve quem é (resolver.ts) no company_id do slug.
//
// Mitigações §3 (TODAS obrigatórias):
//   3. Resposta uniforme: inexistente, sem-dívida e bloqueado devolvem a MESMA
//      mensagem, MESMO status e timing equalizado (o padding fica na rota).
//   4. Lock em 2 dimensões INDEPENDENTES: por IP (5 tent/10min → 30min) E por
//      documento (3 erros → 30min). Durável em chat_auth_generic_* (service role).
//   5. Nada antes de autenticar (a rota não expõe valor/credor/faturas).
//   6. Auditoria de toda tentativa com doc_hash + ip_hash (NUNCA o documento).
//   7. Captcha atrás de flag (verifyCaptcha; default OFF).
//   nada é revelado por caminho: sucesso e falha só diferem no cookie.

import { createHash } from "node:crypto"
import { createServiceClient } from "@/lib/supabase/service"
import { signChatJwt, CHAT_COOKIE_NAME } from "@/lib/negotiation/crypto"
import { recordEvent } from "./events"
import { GENERIC_AUTH_MESSAGE } from "./auth"
import { isAcceptableDocument, normalizeDocument } from "./document"
import { resolveByDocument, type ResolvedDebtor, type SettledDebtor } from "./resolver"
import { bootstrapAckSafe, bootstrapSettledSafe } from "./acknowledgement"
import { verifyCaptcha as verifyCaptchaFunctional } from "./captcha"
import {
  docHashOf,
  ipHashOf,
  registerPublicAttempt,
  evaluatePublicRateLimit,
  onPublicFailure,
} from "./public-rate-limit"

export { GENERIC_AUTH_MESSAGE }

// Mensagem uniforme do link público /n/{code}: MESMO texto, MESMO status para
// inexistente E sem-dívida (nunca revela se o documento existe na base).
export const PUBLIC_NO_DEBT_MESSAGE =
  "Não encontramos dívidas cadastradas para negociação com este documento. Se você recebeu uma mensagem nossa, confira se digitou o documento corretamente. Se preferir, fale com nosso atendimento."

// Mensagem neutra de bloqueio (rate-limit/lock): não revela se o documento existe.
export const PUBLIC_BLOCKED_MESSAGE =
  "Muitas tentativas em sequência. Por segurança, tente novamente em alguns minutos."

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex")
const docHash = (doc: string) => sha256(normalizeDocument(doc))
const ipHash = (ip: string | null) => (ip ? sha256(ip).slice(0, 32) : null)

// Defaults do §3.4 (podem ser sobrepostos por env). Lidos em tempo de chamada
// para respeitar a configuração por deploy (e permitir testes determinísticos).
const ipMaxAttempts = () => Number(process.env.CHAT_AUTH_IP_MAX_ATTEMPTS || "5")
const ipWindowMin = () => Number(process.env.CHAT_AUTH_IP_WINDOW_MIN || "10")
const IP_LOCK_MIN = 30
const DOC_MAX_ATTEMPTS_DEFAULT = 3
const DOC_LOCK_MIN_DEFAULT = 30

export interface GenericAuthInput {
  companyId: string
  document: string
  consent: boolean
  ip: string | null
  userAgent: string | null
  captchaToken?: string | null
  channel: "web_generic" | "admin_preview"
}

export interface SessionSuccess {
  ok: true
  sessionId: string
  cookieName: string
  cookieValue: string
  cookieMaxAge: number
}

export type GenericAuthResult = SessionSuccess | { ok: false; message: string }

type Supabase = ReturnType<typeof createServiceClient>

/** Verificação de captcha (Turnstile) atrás de flag. OFF → sempre passa.
 *  Delega à implementação FUNCIONAL canônica (lib/journey/captcha.ts). */
export async function verifyCaptcha(token: string | null | undefined): Promise<boolean> {
  return verifyCaptchaFunctional(token)
}

async function isIpLocked(supabase: Supabase, companyId: string, ipH: string | null): Promise<boolean> {
  if (!ipH) return false
  const { data } = await supabase
    .from("chat_auth_generic_locks")
    .select("id")
    .eq("company_id", companyId)
    .eq("scope", "ip")
    .eq("key_hash", ipH)
    .gt("locked_until", new Date().toISOString())
    .limit(1)
  return (data?.length ?? 0) > 0
}

async function isDocLocked(supabase: Supabase, companyId: string, dHash: string): Promise<boolean> {
  const { data } = await supabase
    .from("chat_auth_generic_locks")
    .select("id")
    .eq("company_id", companyId)
    .eq("scope", "document")
    .eq("key_hash", dHash)
    .gt("locked_until", new Date().toISOString())
    .limit(1)
  return (data?.length ?? 0) > 0
}

async function recordAttempt(
  supabase: Supabase,
  companyId: string,
  dHash: string,
  ipH: string | null,
  success: boolean,
  reason: string | null,
): Promise<void> {
  await supabase.from("chat_auth_generic_attempts").insert({
    company_id: companyId,
    doc_hash: dHash,
    ip_hash: ipH,
    success,
    failure_reason: reason, // interno; NUNCA vai ao cliente
  })
}

/** Conta falhas na janela e cria lock durável se estourar o limite da dimensão. */
async function maybeLock(
  supabase: Supabase,
  companyId: string,
  scope: "ip" | "document",
  keyHash: string,
  windowMin: number,
  maxAttempts: number,
  lockMin: number,
): Promise<void> {
  const since = new Date(Date.now() - windowMin * 60_000).toISOString()
  const column = scope === "ip" ? "ip_hash" : "doc_hash"
  const { data } = await supabase
    .from("chat_auth_generic_attempts")
    .select("id")
    .eq("company_id", companyId)
    .eq(column, keyHash)
    .eq("success", false)
    .gte("created_at", since)
  if ((data?.length ?? 0) >= maxAttempts) {
    await supabase.from("chat_auth_generic_locks").insert({
      company_id: companyId,
      scope,
      key_hash: keyHash,
      locked_until: new Date(Date.now() + lockMin * 60_000).toISOString(),
      reason: `${scope}_attempts`,
    })
  }
}

/**
 * Autentica por documento no tenant. O CHAMADOR (rota) equaliza o timing.
 * NUNCA revela por que falhou: qualquer falha → GENERIC_AUTH_MESSAGE.
 */
export async function authenticateByDocument(input: GenericAuthInput): Promise<GenericAuthResult> {
  const supabase = createServiceClient()
  const doc = normalizeDocument(input.document)
  const dHash = docHash(doc)
  const ipH = ipHash(input.ip)

  const { data: cfg } = await supabase
    .from("tenant_chat_config")
    .select("auth_max_attempts, auth_lock_minutes, session_ttl_minutes")
    .eq("company_id", input.companyId)
    .maybeSingle()
  const docMax = cfg?.auth_max_attempts ?? DOC_MAX_ATTEMPTS_DEFAULT
  const docLockMin = cfg?.auth_lock_minutes ?? DOC_LOCK_MIN_DEFAULT

  await recordEvent({ companyId: input.companyId, type: "auth.attempt", actor: "customer", payload: {} })

  // fail: registra tentativa, avalia locks das DUAS dimensões, devolve uniforme.
  const fail = async (reason: string): Promise<GenericAuthResult> => {
    await recordAttempt(supabase, input.companyId, dHash, ipH, false, reason)
    await maybeLock(supabase, input.companyId, "document", dHash, docLockMin, docMax, docLockMin)
    if (ipH) await maybeLock(supabase, input.companyId, "ip", ipH, ipWindowMin(), ipMaxAttempts(), IP_LOCK_MIN)
    await recordEvent({ companyId: input.companyId, type: "auth.failed", actor: "customer", payload: {} })
    return { ok: false, message: GENERIC_AUTH_MESSAGE }
  }

  // Locks são checados PRIMEIRO e retornam a MESMA resposta uniforme (sem
  // revelar o bloqueio) — mas sem contabilizar nova tentativa/lock.
  if (await isIpLocked(supabase, input.companyId, ipH)) return { ok: false, message: GENERIC_AUTH_MESSAGE }
  if (await isDocLocked(supabase, input.companyId, dHash)) return { ok: false, message: GENERIC_AUTH_MESSAGE }

  // captcha (se flag) — falha vira resposta uniforme, contabiliza.
  if (!(await verifyCaptcha(input.captchaToken))) return fail("captcha_failed")
  if (!input.consent) return fail("consent_missing")
  if (!isAcceptableDocument(doc)) return fail("doc_invalid")

  const resolved = await resolveByDocument({ companyId: input.companyId, document: doc })
  if (resolved.kind === "none") {
    // inexistente OU só-VMAX-sem-customers OU sem dívida nenhuma: mesma resposta.
    // auth.unresolved é auditoria interna (não distingue os casos para o cliente).
    await recordEvent({ companyId: input.companyId, type: "auth.failed", actor: "customer", payload: { reason: "unresolved" } })
    return fail("unresolved")
  }

  // sucesso: sessão consolidada via handoff helper — dívida aberta (reconhecimento)
  // ou dívida quitada (mensagem informativa). Os dois criam sessão + cookie.
  await recordAttempt(supabase, input.companyId, dHash, ipH, true, null)
  return establishSession({
    supabase,
    companyId: input.companyId,
    resolved,
    document: doc,
    channel: input.channel,
    userAgent: input.userAgent,
    ipHash: ipH,
    sessionTtlMinutes: cfg?.session_ttl_minutes ?? 60,
  })
}

// --- helper compartilhado: consolida sessão + cookie + eventos + 1ª mensagem ---
// Usado tanto pelo caminho genérico /t/{slug} quanto pelo link público /n/{code}.
// Aceita os DOIS desfechos com sessão: dívida aberta (reconhecimento) e dívida
// quitada (mensagem informativa). O `debt_id` primário da sessão é a dívida mais
// antiga (aberta) ou a 1ª paga (quitado) — só para amarrar a sessão a uma dívida.
type ResolvedForSession =
  | { kind: "open"; debtor: ResolvedDebtor }
  | { kind: "settled"; debtor: SettledDebtor }

interface EstablishSessionInput {
  supabase: Supabase
  companyId: string
  resolved: ResolvedForSession
  document: string
  channel: string
  userAgent: string | null
  ipHash: string | null
  /** TTL efetivo da sessão em minutos (o chamador já aplicou o seu default). */
  sessionTtlMinutes: number
}

async function establishSession(input: EstablishSessionInput): Promise<SessionSuccess> {
  const { resolved } = input
  const customerId = resolved.debtor.customerId
  // dívida "primária" só para vincular a sessão: aberta mais antiga OU 1ª paga.
  const debtIds = resolved.kind === "open" ? resolved.debtor.debtIds : resolved.debtor.paidDebtIds
  const primaryDebtId = resolved.kind === "open" ? resolved.debtor.primaryDebtId : (resolved.debtor.paidDebtIds[0] ?? null)

  const { createHandoffSession, findReusableOpenSession, reopenSession } = await import("@/lib/negotiation/sessions")

  // A1.1 — REUSO: antes de criar uma sessão nova, procura a sessão 'open' mais
  // recente do mesmo (company_id, customer_id) DENTRO do TTL. Se existir, REABRE
  // (bump de atividade + reopen_count) e devolve o MESMO session_id/cookie, em vez
  // de multiplicar registros do mesmo devedor. O bootstrap de reconhecimento/
  // quitação abaixo é idempotente, então não recria a 1ª mensagem.
  const reusable = await findReusableOpenSession({
    companyId: input.companyId,
    customerId,
    ttlMinutes: input.sessionTtlMinutes,
  })

  const now = new Date().toISOString()
  let sessionId: string
  const reopened = reusable !== null

  if (reusable) {
    sessionId = reusable.id
    await reopenSession({
      sessionId,
      channel: input.channel,
      userAgent: input.userAgent,
      ipHash: input.ipHash,
      currentReopenCount: reusable.reopen_count ?? 0,
    })
  } else {
    const created = await createHandoffSession({
      company_id: input.companyId,
      customer_id: customerId,
      debt_id: primaryDebtId ?? undefined,
      document: input.document,
      channel_origin: "direct",
      identity_verified: true,
      debt_acknowledged: false,
    })
    sessionId = created.session.id
    // Se havia uma sessão anterior FECHADA (fora do TTL), encadeia a nova nela
    // para não perder a linha do tempo (previous_session_id).
    const { data: prevClosed } = await input.supabase
      .from("negotiation_sessions")
      .select("id")
      .eq("company_id", input.companyId)
      .eq("customer_id", customerId)
      .neq("id", sessionId)
      .order("last_activity_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    const { error: enrichErr } = await input.supabase.from("negotiation_sessions").update({
      debt_ids: debtIds,
      primary_debt_id: primaryDebtId,
      channel: input.channel,
      status: "open",
      engine: process.env.NEGOTIATION_ENGINE || "disabled",
      consent_lgpd_at: now,
      consent_lgpd_version: "journey-v1",
      consent_at: now,
      first_opened_at: now,
      last_activity_at: now,
      previous_session_id: (prevClosed as { id: string } | null)?.id ?? null,
      user_agent: input.userAgent,
      ip_hash: input.ipHash,
    }).eq("id", sessionId)
    // NÃO silenciar: se este enriquecimento falhar (ex.: schema-cache velho após
    // migration sem reload), a sessão fica degradada (sem debt_ids/first_opened_at)
    // mas o reuso segue OK porque last_activity_at já foi gravado no INSERT.
    // Logamos sem PII para não repetir o bug silencioso que zerava o reuso.
    if (enrichErr) {
      console.error(`[journey] enriquecimento da sessão ${sessionId} falhou: ${enrichErr.message}`)
    }
  }

  const base = { companyId: input.companyId, customerId, debtId: primaryDebtId ?? undefined, sessionId }
  if (reopened) {
    // Reuso: registra a reabertura (auditoria da consolidação) + auth.success.
    await recordEvent({ ...base, type: "session.reopened" as unknown as Parameters<typeof recordEvent>[0]["type"], actor: "system", payload: { channel: input.channel } })
    await recordEvent({ ...base, type: "auth.success", actor: "customer" })
  } else {
    await recordEvent({ ...base, type: "consent.given", actor: "customer", payload: { version: "journey-v1" } })
    await recordEvent({ ...base, type: "auth.success", actor: "customer" })
    await recordEvent({ ...base, type: "session.started", actor: "system", payload: { channel: input.channel } })
  }

  if (resolved.kind === "open") {
    // onda R: reconhecimento da dívida é a 1ª interação (determinístico, local).
    await bootstrapAckSafe({
      companyId: input.companyId,
      sessionId,
      customerId,
      debtIds: resolved.debtor.debtIds,
      primaryDebtId: resolved.debtor.primaryDebtId,
    })
  } else {
    // dívida quitada: SEM prompt Sim/Não — mensagem informativa de quitação como
    // 1ª mensagem do chat (mesmo mecanismo `chat_messages` que a UI já lê).
    await bootstrapSettledSafe({
      companyId: input.companyId,
      sessionId,
      customerId,
      totalPaid: resolved.debtor.totalPaid,
      oldestDueDate: resolved.debtor.oldestDueDate,
      paidAt: resolved.debtor.paidAt,
    })
  }

  // D1/Frente A: session.start (plataforma → n8n) SÓ numa abertura FRESCA (não no
  // reuso/reopen — a reentrada da MESMA abertura não re-dispara). Grava no outbox
  // (durável, idempotente por event_id) e dispara best-effort ao n8n. A entrega
  // ao n8n NÃO soma na resposta ao devedor: o reconhecimento (nossos dados) já
  // rodou acima e a equalização de ~600ms é feita pela rota. Gated
  // (NEGOTIATION_ENGINE=disabled) → outbox nasce 'skipped_engine_disabled'.
  if (!reopened) {
    await emitSessionStartSafe({
      companyId: input.companyId,
      sessionId,
      customerId,
      document: input.document,
      debtIds,
      channel: input.channel,
      settled: resolved.kind === "settled",
    })
  }

  const ttlSeconds = input.sessionTtlMinutes * 60
  const cookieValue = signChatJwt({ sid: sessionId, cid: input.companyId }, ttlSeconds)
  return { ok: true, sessionId, cookieName: CHAT_COOKIE_NAME, cookieValue, cookieMaxAge: ttlSeconds }
}

// -----------------------------------------------------------------------------
// D1/Frente A: disparo do session.start no login. Envelope canônico via
// emitSessionStart (engine.ts): grava no outbox + POST best-effort ao n8n. Este
// wrapper NUNCA lança (uma falha no engine não pode derrubar a autenticação) e
// usa Promise.allSettled para que o POST ao n8n NÃO some na resposta ao devedor.
// Só roda com CHAT_JOURNEY_ENABLED=true (comportamento de prod idêntico com a
// flag OFF), como bootstrapAckSafe.
interface EmitSessionStartInput {
  companyId: string
  sessionId: string
  customerId: string
  document: string
  debtIds: string[]
  channel: string
  settled: boolean
}

async function emitSessionStartSafe(input: EmitSessionStartInput): Promise<void> {
  if (process.env.CHAT_JOURNEY_ENABLED !== "true") return
  try {
    const supabase = createServiceClient()
    // Estado real da sessão recém-criada (identity/ack/outcome/fulfillment/thread/
    // reopen_count) — uma leitura enxuta.
    const { data: session } = await supabase
      .from("negotiation_sessions")
      .select(
        "thread_id, reopen_count, identity_verified_at, debt_acknowledged_at, fulfillment_mode, outcome",
      )
      .eq("id", input.sessionId)
      .maybeSingle()

    const { emitSessionStart } = await import("@/lib/negotiation/engine")
    // Promise.allSettled: a resposta ao devedor não espera o POST ao n8n.
    const results = await Promise.allSettled([
      emitSessionStart({
        sessionId: input.sessionId,
        companyId: input.companyId,
        customerId: input.customerId,
        document: input.document,
        debtIds: input.debtIds,
        reopenCount: Number(session?.reopen_count ?? 0),
        channel: input.channel,
        threadId: (session?.thread_id as string | null) ?? null,
        identityVerified: Boolean(session?.identity_verified_at),
        debtAcknowledged: Boolean(session?.debt_acknowledged_at),
        fulfillmentMode: (session?.fulfillment_mode as string | null) ?? "A",
        outcome: (session?.outcome as string | null) ?? "in_progress",
        settled: input.settled,
      }),
    ])
    const rejected = results.find((r) => r.status === "rejected")
    if (rejected && rejected.status === "rejected") {
      // rótulo técnico curto — NUNCA payload/segredo.
      console.warn("[journey] session.start falhou (não-fatal)")
    }
  } catch (err) {
    console.warn("[journey] emitSessionStartSafe falhou (não-fatal):", (err as Error).message)
  }
}

// =============================================================================
// LINK ÚNICO PÚBLICO /n/{code}  (Hub §3/§6)
// =============================================================================
//
// O `companyId` JÁ vem resolvido pelo code (public-link.ts) — quem endereça o
// tenant é o code; quem autentica é o DOCUMENTO. Ordem EXATA (decisão H4):
//   formato+DV → captcha (se ligado) → rate-limit IP → rate-limit documento →
//   teto do cedente/hora → resolveByDocument.
//
// Respostas (HTTP 200 em todos os casos de negócio, timing equalizado na rota):
//   - resolvido c/ dívida        → { ok:true, ... }  (sessão + cookie)
//   - inexistente OU sem dívida   → { ok:false, reason:'no_debt' } — MESMA msg
//   - bloqueado (lock/rate-limit) → { ok:false, reason:'blocked' } — neutro
//   - inválido (DV/consent/captcha) → { ok:false, reason:'invalid' }

export interface PublicLinkAuthInput {
  companyId: string
  document: string
  consent: boolean
  ip: string | null
  userAgent: string | null
  captchaToken?: string | null
}

export type PublicLinkAuthReason = "no_debt" | "blocked" | "invalid"

export type PublicLinkAuthResult =
  | { ok: true; sessionId: string; cookieName: string; cookieValue: string; cookieMaxAge: number }
  | { ok: false; reason: PublicLinkAuthReason; message: string }

export async function authenticateByPublicLink(
  input: PublicLinkAuthInput,
): Promise<PublicLinkAuthResult> {
  const supabase = createServiceClient()
  const doc = normalizeDocument(input.document)
  const dHash = docHashOf(doc)
  const ipH = ipHashOf(input.ip)

  const invalid = (_reason: string): PublicLinkAuthResult => ({
    ok: false, reason: "invalid", message: GENERIC_AUTH_MESSAGE,
  })
  const noDebt = async (reason: string): Promise<PublicLinkAuthResult> => {
    await registerPublicAttempt({ companyId: input.companyId, docHash: dHash, ipHash: ipH, success: false, reason })
    await onPublicFailure({ companyId: input.companyId, docHash: dHash, ipHash: ipH })
    // auditoria: doc_hash + ip_hash apenas; NUNCA o documento em claro.
    // `auth.no_debt` é evento de auditoria (event_type é texto livre no schema;
    // fora do union de JourneyEventType, daí o cast).
    await recordEvent({
      companyId: input.companyId,
      type: "auth.no_debt" as unknown as Parameters<typeof recordEvent>[0]["type"],
      actor: "customer",
      payload: { doc_hash: dHash },
    })
    return { ok: false, reason: "no_debt", message: PUBLIC_NO_DEBT_MESSAGE }
  }
  const blocked = async (reason: string): Promise<PublicLinkAuthResult> => {
    await recordEvent({ companyId: input.companyId, type: "auth.locked", actor: "system", payload: { doc_hash: dHash, scope: reason } })
    return { ok: false, reason: "blocked", message: PUBLIC_BLOCKED_MESSAGE }
  }

  await recordEvent({ companyId: input.companyId, type: "auth.attempt", actor: "customer", payload: { doc_hash: dHash } })

  // config do tenant (TTL da sessão; default 30min no link público).
  const { data: cfg } = await supabase
    .from("tenant_chat_config")
    .select("session_ttl_minutes")
    .eq("company_id", input.companyId)
    .maybeSingle()

  // 1) formato + DV (CPF e CNPJ). consent também é pré-condição de negócio.
  if (!input.consent) return invalid("consent_missing")
  if (!isAcceptableDocument(doc)) return invalid("doc_invalid")

  // teto do cedente/hora → modo DEGRADADO: exige captcha SEMPRE (mesmo desligado).
  const decision = await evaluatePublicRateLimit({ companyId: input.companyId, docHash: dHash, ipHash: ipH })
  if (decision.blocked) return blocked(decision.scope)

  // 2) captcha (se ligado) — no modo degradado, exigido mesmo com a flag OFF.
  const captchaOk = await verifyCaptchaFunctional(input.captchaToken, input.ip)
  if (decision.degraded) {
    // alerta de operação (teto estourado) + captcha OBRIGATÓRIO.
    await recordEvent({ companyId: input.companyId, type: "auth.locked", actor: "system", payload: { scope: "tenant_hourly_cap", degraded: true } })
    if (!input.captchaToken || !captchaOk) return blocked("degraded")
  } else if (!captchaOk) {
    // captcha ligado e falhou → registra a tentativa (alimenta o teto/cedente-hora)
    // e responde neutro. O captcha já é o controle anti-bot deste ramo.
    await registerPublicAttempt({ companyId: input.companyId, docHash: dHash, ipHash: ipH, success: false, reason: "captcha" })
    return blocked("captcha")
  }

  // 3+4) rate-limit IP e documento já avaliados em evaluatePublicRateLimit (locks).

  // 5) resolução do devedor no tenant do code.
  const resolved = await resolveByDocument({ companyId: input.companyId, document: doc })
  if (resolved.kind === "none") {
    // inexistente OU só-VMAX OU sem dívida nenhuma → MESMA resposta no_debt.
    // (dívida quitada NÃO é no_debt: o cliente entra e vê a mensagem de quitação.)
    return noDebt("unresolved")
  }

  // sucesso (aberta OU quitada): registra e consolida sessão (reuso do helper do /t/).
  await registerPublicAttempt({ companyId: input.companyId, docHash: dHash, ipHash: ipH, success: true, reason: "ok" })
  return establishSession({
    supabase,
    companyId: input.companyId,
    resolved,
    document: doc,
    channel: "web_public_link",
    userAgent: input.userAgent,
    ipHash: ipH,
    sessionTtlMinutes: cfg?.session_ttl_minutes ?? 30,
  })
}
