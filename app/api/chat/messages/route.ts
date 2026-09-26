// GET /api/chat/messages?since=<iso> (onda R) — polling das mensagens da PRÓPRIA
// sessão (chat_messages) + o prompt ativo. A UI faz polling 2–3s enquanto o n8n
// empurra mensagens/prompts via chat.send/prompt.ask. Sessão pelo cookie JWT.
// Nunca devolve PII em claro (chat_messages já é texto neutro; sem documento).
import { NextRequest, NextResponse } from "next/server"
import { verifyChatJwt, CHAT_COOKIE_NAME } from "@/lib/negotiation/crypto"
import { createServiceClient } from "@/lib/supabase/service"
import { buildPinnedDebt } from "@/lib/journey/pinned-debt"
import { buildRecap } from "@/lib/journey/recap"
import { annotateMessageGenerations, type GenerationPromptRow } from "@/lib/journey/display-class"
import { isTerminalAgreement, type AgreementLike } from "@/lib/asaas-idempotency"
import { isPromptPending } from "@/lib/journey/poll-order"

export const dynamic = "force-dynamic"
export const fetchCache = "force-no-store"
export const revalidate = 0

export async function GET(req: NextRequest) {
  if (process.env.CHAT_JOURNEY_ENABLED !== "true") {
    return NextResponse.json({ error: "not found" }, { status: 404 })
  }
  const cookie = req.cookies.get(CHAT_COOKIE_NAME)?.value
  const claims = cookie ? verifyChatJwt(cookie) : null
  if (!claims) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const since = req.nextUrl.searchParams.get("since")
  const supabase = createServiceClient()
  // QA round 4 (R-13/R-22, S3): `server_time` é tirado ANTES da 1ª leitura — o
  // client compara este carimbo com o `state_time` de um POST (tirado depois da
  // última escrita): um GET cujas leituras começaram antes do POST terminar é
  // mais antigo e não regride o estado aplicado.
  const serverTime = new Date().toISOString()
  const t0 = Date.now()
  const timing: string[] = []
  const mark = (name: string, since0: number) => timing.push(`${name};dur=${Date.now() - since0}`)

  // QA round 4 (R-14/R-25, S5): as leituras INDEPENDENTES rodam em paralelo
  // (antes: 5-6 idas ao banco em série — 6 s na 1ª pintura de sessões longas).
  //  - sessão (época + wait_state) numa leitura só;
  //  - mensagens (QA round 3 / QAB3-02b: SEM `since` a fatia de 200 é a das
  //    linhas MAIS RECENTES; COM `since`, ascendente e contígua);
  //  - prompts da sessão (geração por mensagem + prompt_pending) e o ATIVO;
  //  - card fixo, recap (só no 1º poll) e links mortos.
  const base = supabase
    .from("chat_messages")
    .select("id, role, text, button_id, prompt_id, n8n_execution_id, engine, offers_snapshot, thread_epoch, archived_at, created_at")
    .eq("session_id", claims.sid)
    .eq("company_id", claims.cid)
  const q = since
    ? base.gt("created_at", since).order("created_at", { ascending: true }).limit(200)
    : base.order("created_at", { ascending: false }).limit(200)

  const [sessRes, msgRes, promptRes, activeRes, pinnedDebt, recap, deadPaymentLinks] = await Promise.all([
    // C3: época (thread) CORRENTE da sessão — o reset 24h incrementa thread_epoch
    // e ARQUIVA as linhas velhas. Estado de espera (M11): o client reconstrói a
    // máquina de espera a partir de wait_state/wait_started_at. DEFENSIVO: se as
    // colunas não existirem, cai na leitura mínima (época 0, sem espera).
    (async () => {
      const ts = Date.now()
      try {
        const full = await supabase
          .from("negotiation_sessions")
          .select("thread_epoch, wait_state, wait_started_at")
          .eq("id", claims.sid)
          .eq("company_id", claims.cid)
          .maybeSingle()
        if (!full.error) return full.data as { thread_epoch?: number | null; wait_state?: string | null; wait_started_at?: string | null } | null
        const min = await supabase
          .from("negotiation_sessions")
          .select("thread_epoch")
          .eq("id", claims.sid)
          .eq("company_id", claims.cid)
          .maybeSingle()
        return (min.error ? null : min.data) as { thread_epoch?: number | null } | null
      } catch {
        return null
      } finally {
        mark("session", ts)
      }
    })(),
    (async () => {
      const ts = Date.now()
      const r = await q
      mark("messages", ts)
      return r
    })(),
    // A3 (§2.4 / G4 / N3): GERAÇÃO por mensagem — join EM MEMÓRIA com os
    // chat_prompts da sessão. R-22: answered_at alimenta `prompt_pending`.
    supabase
      .from("chat_prompts")
      .select("id, kind, status, created_at, answered_at")
      .eq("session_id", claims.sid)
      .order("created_at", { ascending: true })
      .limit(500),
    supabase
      .from("chat_prompts")
      .select("id, kind, question, buttons, status, thread_epoch, archived_at, created_at")
      .eq("session_id", claims.sid)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    // CARD FIXO do débito (C1 / R-11): best-effort (null → o card não renderiza).
    (async () => {
      const ts = Date.now()
      const r = await buildPinnedDebt(claims.sid, claims.cid)
      mark("pinned", ts)
      return r
    })(),
    // RECAPITULATIVO de retomada (C7 / R-17): só no 1º poll (since ausente).
    since
      ? Promise.resolve(null)
      : (async () => {
          const ts = Date.now()
          const r = await buildRecap(claims.sid, claims.cid)
          mark("recap", ts)
          return r
        })(),
    // QA round 1 (QAA1-07): links MORTOS também no poll incremental.
    deadPaymentLinkHrefs(supabase, claims.sid, claims.cid),
  ])

  const sessRow = sessRes
  const rawEpoch = sessRow?.thread_epoch
  const currentEpoch = typeof rawEpoch === "number" ? rawEpoch : 0
  const rawFetched = msgRes.data
  const rawMessages = since ? rawFetched : [...(rawFetched ?? [])].reverse()

  // Filtra a THREAD CORRENTE (C3): época corrente OU null (=época 0, compat) e
  // NÃO-arquivada. As linhas de épocas anteriores ficam preservadas no banco (o
  // painel/recap as leem), mas não voltam à tela da conversa nova.
  const inCurrentThread = (rawMessages ?? []).filter((m) => {
    const row = m as { thread_epoch?: number | null; archived_at?: string | null }
    if (row.archived_at != null) return false
    if (row.thread_epoch == null) return currentEpoch === 0
    return Number(row.thread_epoch) === currentEpoch
  })

  // Anexa o botão-link e o marcador de estágio (offers_snapshot). A1-R1 — LINK
  // MORTO na retomada: a ação de uma bolha cujo acordo já é TERMINAL sai com
  // `live:false` (texto fica como histórico; o client não renderiza Abrir/Copiar).
  const tDead = Date.now()
  const deadAgreementIds = await terminalAgreementIds(supabase, claims.cid, inCurrentThread)
  mark("liveness", tDead)
  const mapped = inCurrentThread.map((m) => {
    const snapshot = m.offers_snapshot as { message_action?: unknown; stage?: unknown; agreement_id?: unknown } | null
    const rawAction =
      snapshot && typeof snapshot === "object" && snapshot.message_action ? snapshot.message_action : null
    const action = withLiveness(rawAction, snapshot?.agreement_id, deadAgreementIds)
    const stage = snapshot && typeof snapshot === "object" && typeof snapshot.stage === "string" ? snapshot.stage : null
    const { offers_snapshot: _drop, archived_at: _arch, ...rest } = m as Record<string, unknown>
    return { ...rest, ...(action ? { action } : {}), ...(stage ? { stage } : {}) }
  })

  const promptRows = (promptRes.data ?? []) as Array<GenerationPromptRow & { answered_at?: string | null }>
  const messages = annotateMessageGenerations(
    mapped as Array<Record<string, unknown> & { prompt_id?: string | null; created_at?: string | null }>,
    promptRows as GenerationPromptRow[],
  )

  // C3: um prompt 'active' de época anterior é ignorado (não vaza na thread nova).
  const activePromptRaw = activeRes.data
  let activePrompt: Record<string, unknown> | null = null
  if (activePromptRaw) {
    const ap = activePromptRaw as {
      thread_epoch?: number | null
      archived_at?: string | null
    }
    const sameThread =
      ap.archived_at == null && (ap.thread_epoch == null ? currentEpoch === 0 : Number(ap.thread_epoch) === currentEpoch)
    if (sameThread) {
      const { thread_epoch: _e, archived_at: _a, ...rest } = activePromptRaw as Record<string, unknown>
      activePrompt = rest
    }
  }

  const waitRow = sessRow as { wait_state?: string | null; wait_started_at?: string | null } | null
  const waitState: string | null = waitRow?.wait_state ?? null
  const waitStartedAt: string | null = waitRow?.wait_started_at ?? null

  mark("total", t0)
  const res = NextResponse.json({
    ok: true,
    messages: messages ?? [],
    active_prompt: activePrompt ?? null,
    // QA round 4 (R-22): sem prompt ativo mas com a troca em curso (o último
    // prompt acabou de ser respondido e o sucessor ainda não foi gravado) — o
    // client MANTÉM o prompt da tela em vez de aplicar "nenhum".
    prompt_pending: activePrompt ? false : isPromptPending(promptRows, Date.parse(serverTime)),
    wait_state: waitState,
    wait_started_at: waitStartedAt,
    pinned_debt: pinnedDebt,
    recap,
    dead_payment_links: deadPaymentLinks,
    server_time: serverTime,
  })
  // QA round 4 (R-16/R-26, S7): etapas nomeadas para o QA separar servidor ×
  // rede × render. Sem PII.
  res.headers.set("Server-Timing", timing.join(", "))
  return res
}

/**
 * QA round 1 (QAA1-07) — hrefs das cobranças TERMINAIS (cancelada/estornada) do
 * cliente da sessão nesta empresa: invoice/payment/boleto/PIX. Isola por
 * customer_id + company_id (nunca cruza tenant). Best-effort: falha → [].
 */
async function deadPaymentLinkHrefs(
  supabase: ReturnType<typeof createServiceClient>,
  sessionId: string,
  companyId: string,
): Promise<string[]> {
  try {
    const { data: sess } = await supabase
      .from("negotiation_sessions")
      .select("customer_id")
      .eq("id", sessionId)
      .eq("company_id", companyId)
      .maybeSingle()
    const customerId = (sess as { customer_id?: string | null } | null)?.customer_id
    if (!customerId) return []
    const { data } = await supabase
      .from("agreements")
      .select("id, status, payment_status, asaas_payment_id, asaas_invoice_url, asaas_payment_url, asaas_boleto_url, asaas_pix_qrcode_url")
      .eq("customer_id", customerId)
      .eq("company_id", companyId)
      .not("asaas_payment_id", "is", null)
    const hrefs = new Set<string>()
    for (const ag of (data ?? []) as Array<AgreementLike & Record<string, unknown>>) {
      if (!isTerminalAgreement(ag)) continue
      for (const k of ["asaas_invoice_url", "asaas_payment_url", "asaas_boleto_url", "asaas_pix_qrcode_url"]) {
        const v = ag[k]
        if (typeof v === "string" && /^https?:\/\//i.test(v)) hrefs.add(v)
      }
    }
    return [...hrefs]
  } catch {
    return []
  }
}

/** offers_snapshot.agreement_id das bolhas com ação `open_payment_link`. */
function linkAgreementIds(rows: Array<{ offers_snapshot?: unknown }>): string[] {
  const ids = new Set<string>()
  for (const m of rows) {
    const snapshot = m.offers_snapshot as { message_action?: unknown; agreement_id?: unknown } | null
    if (!snapshot || typeof snapshot !== "object") continue
    const type = (snapshot.message_action as { type?: unknown } | null | undefined)?.type
    if (type !== "open_payment_link" || typeof snapshot.agreement_id !== "string" || !snapshot.agreement_id) continue
    ids.add(snapshot.agreement_id)
  }
  return [...ids]
}

/**
 * A1-R1 — ids dos acordos (das bolhas de link da thread) que já são TERMINAIS
 * (isTerminalAgreement: payment_status deleted/refunded/cancelled ou
 * status cancelled). Filtrado por company_id (nunca cruza tenant). Best-effort:
 * qualquer falha → conjunto vazio (a ação segue como está; compat).
 */
async function terminalAgreementIds(
  supabase: ReturnType<typeof createServiceClient>,
  companyId: string,
  rows: Array<{ offers_snapshot?: unknown }>,
): Promise<ReadonlySet<string>> {
  const ids = linkAgreementIds(rows)
  if (ids.length === 0) return new Set()
  try {
    const { data } = await supabase
      .from("agreements")
      .select("id, status, payment_status")
      .eq("company_id", companyId)
      .in("id", ids)
    const dead = new Set<string>()
    for (const ag of (data ?? []) as Array<AgreementLike & { id: string }>) {
      if (isTerminalAgreement(ag)) dead.add(ag.id)
    }
    return dead
  } catch {
    return new Set()
  }
}

/** Ação `open_payment_link` cujo acordo é terminal → `{...action, live:false}`; demais: como está. */
function withLiveness(action: unknown, agreementId: unknown, dead: ReadonlySet<string>): unknown {
  if (!action || typeof action !== "object") return action
  if ((action as { type?: unknown }).type !== "open_payment_link") return action
  if (typeof agreementId !== "string" || !dead.has(agreementId)) return action
  return { ...(action as Record<string, unknown>), live: false }
}
