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

  // C3: época (thread) CORRENTE da sessão — o reset 24h incrementa thread_epoch e
  // ARQUIVA as linhas velhas (não deleta). Filtramos a época corrente aqui para a
  // conversa nova começar limpa; painel/reconstrução/recap leem todas as épocas à
  // parte. DEFENSIVO: se thread_epoch não existir (20260935 pendente em prod), a
  // leitura cai em 0 e o filtro no client é no-op (compat total). Nunca PII.
  let currentEpoch = 0
  try {
    const { data: sessRow } = await supabase
      .from("negotiation_sessions")
      .select("thread_epoch")
      .eq("id", claims.sid)
      .eq("company_id", claims.cid)
      .maybeSingle()
    const raw = (sessRow as { thread_epoch?: number | null } | null)?.thread_epoch
    currentEpoch = typeof raw === "number" ? raw : 0
  } catch {
    currentEpoch = 0
  }

  let q = supabase
    .from("chat_messages")
    .select("id, role, text, button_id, prompt_id, n8n_execution_id, engine, offers_snapshot, thread_epoch, archived_at, created_at")
    .eq("session_id", claims.sid)
    .eq("company_id", claims.cid)
    .order("created_at", { ascending: true })
    .limit(200)
  if (since) q = q.gt("created_at", since)
  const { data: rawMessages } = await q

  // Filtra a THREAD CORRENTE (C3): época corrente OU null (=época 0, compat) e
  // NÃO-arquivada. As linhas de épocas anteriores ficam preservadas no banco (o
  // painel/recap as leem), mas não voltam à tela da conversa nova. Best-effort: se
  // as colunas não existirem, thread_epoch/archived_at vêm undefined → tudo passa.
  const inCurrentThread = (rawMessages ?? []).filter((m) => {
    const row = m as { thread_epoch?: number | null; archived_at?: string | null }
    if (row.archived_at != null) return false
    if (row.thread_epoch == null) return currentEpoch === 0
    return Number(row.thread_epoch) === currentEpoch
  })

  // Anexa o botão-link (ex.: quitação → #contato; link de pagamento) quando a
  // mensagem o carrega em offers_snapshot.message_action, e o marcador de
  // estágio (offers_snapshot.stage: greeting | detail | payment_link |
  // not_recognized | payment_claim — A1) que a poda/retomada usa. A UI renderiza
  // a ação como <a> abaixo da bolha; offers_snapshot cru não vaza. Sem PII.
  const mapped = inCurrentThread.map((m) => {
    const snapshot = m.offers_snapshot as { message_action?: unknown; stage?: unknown } | null
    const action =
      snapshot && typeof snapshot === "object" && snapshot.message_action ? snapshot.message_action : null
    const stage = snapshot && typeof snapshot === "object" && typeof snapshot.stage === "string" ? snapshot.stage : null
    const { offers_snapshot: _drop, archived_at: _arch, ...rest } = m as Record<string, unknown>
    return { ...rest, ...(action ? { action } : {}), ...(stage ? { stage } : {}) }
  })

  // A3 (§2.4 / G4 / N3): GERAÇÃO por mensagem — join EM MEMÓRIA com os
  // chat_prompts da sessão (kind/status/created_at): cada mensagem ganha
  // `prompt_kind` (o prompt que a governa: o seu prompt_id ou o último criado
  // até ela) e `generation` (derivada do kind; prompt ativo = corrente). O client
  // poda gerações anteriores (Sim/Não → Consultar/Negociar → 3 opções) sem
  // migration nem arquivamento; painel/auditoria continuam lendo tudo. Sem PII.
  const { data: promptRows } = await supabase
    .from("chat_prompts")
    .select("id, kind, status, created_at")
    .eq("session_id", claims.sid)
    .order("created_at", { ascending: true })
    .limit(500)
  const messages = annotateMessageGenerations(
    mapped as Array<Record<string, unknown> & { prompt_id?: string | null; created_at?: string | null }>,
    (promptRows ?? []) as GenerationPromptRow[],
  )

  const { data: activePromptRaw } = await supabase
    .from("chat_prompts")
    .select("id, kind, question, buttons, status, thread_epoch, archived_at, created_at")
    .eq("session_id", claims.sid)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  // C3: um prompt 'active' de época anterior (não deveria existir — o reset o
  // supersede) é ignorado para não vazar na thread nova. Best-effort: colunas
  // ausentes → passa (compat). Devolve sem os campos internos de época.
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

  // Estado de espera (M11 — onda "3 opções", trilha D2): o client reconstrói a
  // máquina de espera (degraus 1,2/4/10/15s) a partir destes dois campos + o
  // relógio local, então um reload durante a espera restaura o degrau. Zero
  // request extra — vem junto do 1º poll. DEFENSIVO: se as colunas M-4 ainda não
  // existirem em produção (aplicadas só no G6), o SELECT erra → devolvemos null e
  // a UI só não restaura o degrau (nunca quebra o poll). Nunca é PII.
  let waitState: string | null = null
  let waitStartedAt: string | null = null
  const { data: waitRow, error: waitErr } = await supabase
    .from("negotiation_sessions")
    .select("wait_state, wait_started_at")
    .eq("id", claims.sid)
    .eq("company_id", claims.cid)
    .maybeSingle()
  if (!waitErr && waitRow) {
    waitState = (waitRow as { wait_state?: string | null }).wait_state ?? null
    waitStartedAt = (waitRow as { wait_started_at?: string | null }).wait_started_at ?? null
  }

  // CARD FIXO do débito (C1 / R-11): bloco pinned montado no servidor a cada poll
  // (imutável entre polls; sobrevive a reload). Reusa buildAckContext (mesma fonte
  // canônica do resumo — D3 ALTO: valor do card = valor cobrado). Best-effort: se
  // falhar, pinned_debt=null e o card não renderiza, mas o chat funciona (nunca
  // derruba o poll). Só computa se houver dívida associada à sessão. Sem PII.
  const pinnedDebt = await buildPinnedDebt(claims.sid, claims.cid)

  // RECAPITULATIVO de retomada (C7 / R-17): só no 1º poll (since ausente =
  // carregamento inicial/retomada). Nos polls incrementais não repetimos o recap.
  // Montado no servidor a partir das bolhas PRESERVADAS (C3) → idêntico após F5.
  const recap = since ? null : await buildRecap(claims.sid, claims.cid)

  return NextResponse.json({
    ok: true,
    messages: messages ?? [],
    active_prompt: activePrompt ?? null,
    wait_state: waitState,
    wait_started_at: waitStartedAt,
    pinned_debt: pinnedDebt,
    recap,
    server_time: new Date().toISOString(),
  })
}
