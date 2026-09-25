"use client"

// Chat da jornada: o prompt inicial oferece DOIS botões — "Consultar Dívida" e
// "Negociar Dívida":
//   - Consultar → mostra os dados da dívida (valor atualizado, vencimento, nº de
//     faturas) e reabre o menu (Negociar / Não reconheço a dívida);
//   - Negociar  → mostra os dados E inicia a negociação no n8n (fallback assistido);
//   - Não reconheço → caminho de contestação.
// - HISTÓRICO SEMPRE PRESERVADO: pergunta, clique, dados e respostas vêm do
//   servidor (chat_messages) — a sessão reaberta reconstrói o contexto COMPLETO,
//   e mesmo já tendo reconhecido antes, o menu Consultar/Negociar reabre (nunca
//   trava num estado morto).
// - Timer de inatividade: 5min sem interação → volta para a tela de login do CHAT
//   (/n/{code}), NÃO o login da AlteaPay.
import { useCallback, useEffect, useRef, useState } from "react"
import { PromptButtons, PROMPT_STALE_NOTICE, type ActivePrompt, type PromptClickResult } from "./prompt-buttons"
import {
  capHistory,
  collapseConsecutiveDecisions,
  currentGenerationOf,
  dedupAssistantByContent,
  isLivePaymentLink,
  isNegotiateLabel,
  latestLivePaymentLinkId,
  NEGOTIATION_PENDING_TEXT,
  paymentLinkActionOf,
  placeAfterCustomerEcho,
  prunePresentation,
  resolvePromptForRender,
  splitResumeHistory,
  type ChatMsg,
  type MsgAction,
} from "./chat-display"
import { OUTCOME_STAGES } from "@/lib/journey/display-class"
import {
  createInFlightGuard,
  PROCESSING_CHOICE_NOTICE,
  staleClickFeedback,
  toRenderablePrompt,
} from "@/lib/journey/click-feedback"
import { isStalePoll, type PollStamp } from "@/lib/journey/poll-order"
import { DebtCard, type PinnedDebtData } from "./debt-card"
import {
  DEGRADED_MENU_COPY,
  deriveWaitStep,
  elapsedSince,
  engineTextDisplay,
  hydrateWaitState,
  negotiateWaitOnResponse,
  resolveWaitView,
  shouldRenderEngineMsg,
  shouldShowTypingIndicator,
  shouldShowWaitHandoffExit,
  WAIT_EXITS_ARM_MS,
  waitStepCopy,
  type WaitState,
  type WaitStep,
} from "@/lib/journey/wait-machine"
import {
  decidePayResume,
  interpretPaymentPoll,
  isPayWaitState,
  PAY_PROCESSING_SLOW_TEXT,
  PAY_PROCESSING_TEXT,
  PAY_RESUME_GENERATING_TEXT,
  payLinkMessageText,
  shouldOfferProcessingExit,
} from "@/lib/journey/pay-poll"

// D2 — ESPERA CONFIÁVEL: a máquina de espera (§6.3) é client-side sobre o polling
// atual. A lógica PURA (degraus, copy, absorventes, reidratação) vive em
// lib/journey/wait-machine.ts (testável em node); aqui só o wire-up React (timers,
// estado, render acessível). O clique NEGOCIAR arma a espera; a resposta do n8n
// (mensagem engine='n8n' no poll) resolve para 'negociando'; 15s sem resposta
// degrada para um menu acionável SEM cancelar o polling/outbox. NUNCA mostra erro
// técnico/HTTP/"n8n" ao devedor.

// Estado do PAGAR renderizado na UI (link com copiar / processando / erro). O
// button/route.ts (D1) devolve o shape do payService (D3) no POST do clique — o
// chat o guarda aqui para renderizar a §5.2/§5.3/§5.4 da copy. Sem PII.
interface PayResult {
  status: "link" | "processing" | "error"
  link: string | null
  valor: number | null
  vencimento_link: string | null
  already_charged: boolean
  /** A1: só true quando o SERVIDOR respondeu ok:false (erro de negócio) — é a
   *  única situação em que "Nenhuma cobrança foi criada" é verdade. Timeout/rede
   *  NUNCA afirmam isso (a cobrança pode ter sido criada). */
  confirmedNotCreated?: boolean
  /** QA round 2 (QAB1-H1): o estado nasceu de REIDRATAÇÃO (reload durante o
   *  Pagar) ou de recuperação de transporte — copy "Ainda estou gerando…" e o
   *  servidor é a autoridade (decidePayResume). */
  resumed?: boolean
}

const TICK_MS = 250 // granularidade da troca de copy (menor que o poll de 2500ms)
// A1 (G1): o POST de cobrança NUNCA é abortado em 8s — o caminho válido pode levar
// vários segundos (ASAAS + persistência). Abort próprio do PAGAR, generoso; após
// PAY_LONG_WAIT_MS a copy da espera muda ("Ainda estou gerando…").
const PAY_ABORT_MS = 45_000
const PAY_LONG_WAIT_MS = 8_000
const CLICK_ABORT_MS = 8_000

/** A4/N-D5-2 (R-23): TODO elemento preenchido com a marca usa a cor de texto
 *  ADAPTATIVA (--brand-secondary-fg, preto/branco por luminância — contrast.ts),
 *  nunca branco fixo: sobre o secundário claro da VMAX (#EAB308) branco dá 1,92:1. */
const BRAND_FILL_STYLE = {
  backgroundColor: "var(--brand-secondary)",
  color: "var(--brand-secondary-fg, #ffffff)",
} as const

// ChatMsg / MsgAction e os helpers puros de exibição (dedup por conteúdo, rótulo
// Negociar, texto do indicador) vivem em ./chat-display para serem testados no
// ambiente node do vitest. Ver comentário lá.
//
// prompt_id da bolha (quando é a mensagem do prompt): enquanto o prompt está
// 'active' a pergunta aparece no bloco de botões — a bolha persistida é omitida
// no render p/ não duplicar; respondido o prompt (sem active_prompt) a bolha
// reaparece e mantém o resumo no histórico.

/** Só aceitamos links http(s) — nunca javascript:/relativos suspeitos. Dois tipos:
 *  external_link (ex.: quitação → #contato) e open_payment_link (A1: a bolha do
 *  link de pagamento persistida carrega a ação — o painel deriva DELA). */
function safeMessageAction(raw: unknown): MsgAction | null {
  if (!raw || typeof raw !== "object") return null
  const a = raw as Record<string, unknown>
  if (a.type !== "external_link" && a.type !== "open_payment_link") return null
  const label = typeof a.label === "string" ? a.label : ""
  const href = typeof a.href === "string" ? a.href : ""
  if (!label || !/^https?:\/\//i.test(href)) return null
  // A1-R1: `live:false` = o servidor cruzou o acordo da bolha e a cobrança já
  // não está viva (cancelada/estornada). Só propagamos o sinal negativo.
  return { type: a.type, label, href, ...(a.live === false ? { live: false } : {}) }
}

/** A1 (N-D1-8): a bolha do link persistida traz a URL crua numa linha própria
 *  (histórico/painel); na tela o botão "Abrir link de pagamento" já a carrega —
 *  removemos a linha da URL do texto exibido para o link não aparecer 2x. */
function textWithoutUrl(text: string, href: string): string {
  return text
    .split("\n")
    .filter((line) => line.trim() !== href.trim())
    .join("\n")
    .trim()
}

/** A2 — prompt devolvido no CORPO do POST do clique (mesmo shape do GET
 *  active_prompt). Só aceita o que o PromptButtons consegue renderizar. */
function asActivePrompt(raw: unknown): ActivePrompt | null {
  // QA round 2: regra pura em lib/journey/click-feedback.ts (mesma usada pelo
  // feedback do 409/duplicate — staleClickFeedback).
  return toRenderablePrompt(raw) as ActivePrompt | null
}

/** Só http(s) — nunca javascript:/data:. Usado para auto-linkar URLs no histórico. */
function isSafeHttpUrl(raw: string): boolean {
  return /^https?:\/\/\S+$/i.test(raw)
}

/** Auto-linka URLs http(s) "cruas" numa fatia de texto (R7): a mensagem do link
 *  de pagamento é PERSISTIDA como texto (com a URL numa linha) para sobreviver ao
 *  reload/reuso — ao restaurar do histórico ela precisa voltar clicável. Só
 *  http(s); nunca injeta HTML. Retorna nós React. */
function linkifyUrls(text: string, keyBase: string) {
  return text.split(/(https?:\/\/\S+)/g).map((chunk, i) =>
    isSafeHttpUrl(chunk) ? (
      <a
        key={`${keyBase}-a-${i}`}
        href={chunk}
        target="_blank"
        rel="noopener noreferrer"
        className="break-all font-medium text-neutral-800 underline underline-offset-2"
      >
        {chunk}
      </a>
    ) : (
      <span key={`${keyBase}-t-${i}`}>{chunk}</span>
    ),
  )
}

/** Render simples de **negrito** (o n8n envia markdown) + auto-link de URLs
 *  http(s) (R7 — link persistido no histórico volta clicável). Preserva quebras
 *  de linha via whitespace-pre-line na bolha. Não injeta HTML. */
function renderRichText(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.length > 4 && part.startsWith("**") && part.endsWith("**") ? (
      <strong key={i}>{part.slice(2, -2)}</strong>
    ) : (
      <span key={i}>{linkifyUrls(part, `p${i}`)}</span>
    ),
  )
}

const IDLE_MS = 5 * 60_000 // 5 minutos sem interação
const KEEPALIVE_MS = 10 * 60_000 // renova o cookie a cada 10min (só aba visível)

export function JourneyChat() {
  // Sem saudação hardcoded: a 1ª (e única) mensagem inicial é o prompt de
  // reconhecimento, empurrado via /api/chat/messages (active_prompt).
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [ended, setEnded] = useState(false)
  const [activePrompt, setActivePromptRaw] = useState<ActivePrompt | null>(null)
  // Espelho do prompt ativo para os callbacks assíncronos (poll/reconciliação).
  const activePromptRef = useRef<ActivePrompt | null>(null)
  const setActivePrompt = useCallback((p: ActivePrompt | null) => {
    activePromptRef.current = p
    setActivePromptRaw(p)
  }, [])
  // QA round 2 (QAB1-H2): aviso "Já estou processando a sua escolha." — um clique
  // tardio (409 sem active_prompt / duplicate sem prompt) enquanto o vencedor
  // ainda processa. Fica FORA do bloco de botões (que some) e sai quando o
  // próximo prompt/outcome chega pelo poll. Nunca reabilita o mesmo menu.
  const [processingNotice, setProcessingNotice] = useState<string | null>(null)
  // D2 — CARD FIXO (C1) e RECAP de retomada (C7): montados no servidor e entregues
  // no poll. O card vem a cada poll (imutável entre polls, sobrevive a reload); o
  // recap vem só no 1º poll (retomada). "Ver conversa completa" (R-41) expande o
  // histórico recolhido pela poda/teto.
  const [pinnedDebt, setPinnedDebt] = useState<PinnedDebtData | null>(null)
  const [recap, setRecap] = useState<{ text: string } | null>(null)
  const [historyExpanded, setHistoryExpanded] = useState(false)
  // A3 — RETOMADA (§2.2): instante do MENU CORRENTE no 1º poll da retomada (recap
  // != null). Tudo o que veio ANTES fica recolhido atrás de "Ver conversa
  // completa", salvo o último outcome (link/acordo/desfecho). Fixado UMA vez por
  // montagem (o que chega depois, via poll, é conversa nova e aparece).
  const [resumeCutoffAt, setResumeCutoffAt] = useState<string | null>(null)
  const resumeInitRef = useRef(false)
  // A3 (G7) — bloco do menu (FORA do log): alvo do scrollIntoView pós-login.
  const menuRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const sinceRef = useRef<string | null>(null)
  const seenIds = useRef<Set<string>>(new Set())
  // A2 — prompts já CONSUMIDOS por um clique (respondidos no servidor). Um poll
  // que estava em voo antes do clique ainda pode trazê-los como active_prompt e
  // sobrescrever o prompt novo renderizado do corpo do POST (as parcelas); esses
  // ids são ignorados na re-hidratação.
  const consumedPromptIds = useRef<Set<string>>(new Set())
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // QA round 1 (QAA1-08): um poll em voo lento (> 2,5 s no mobile) fazia o tick
  // seguinte disparar um 2º GET completo (sem `since`) em paralelo — dois GETs
  // "sem since" em 3 s na evidência. O tick do intervalo NÃO enfileira outro
  // poll enquanto um está em voo; chamadas explícitas (pós-clique) seguem.
  const pollInFlightRef = useRef(false)
  // QA round 1 (QAA1-07): hrefs das cobranças TERMINAIS do cliente, atualizados
  // a CADA poll (inclusive incremental) — a bolha do link cancelado perde
  // Abrir/Copiar no ciclo seguinte, sem F5.
  const [deadLinkHrefs, setDeadLinkHrefs] = useState<ReadonlySet<string>>(() => new Set())
  const idleRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const endedRef = useRef(false)
  // Modal de inatividade (5min) / sessão expirada — NUNCA redireciona sozinho
  // perdendo o histórico. O usuário decide (Continuar / Entrar novamente).
  const [idleModal, setIdleModalState] = useState<null | "idle" | "expired">(null)
  const modalRef = useRef<null | "idle" | "expired">(null)
  // Bolha local "trabalhando" injetada ao clicar Negociar, antes de a resposta
  // do n8n chegar via poll. Guardamos o id sintético para removê-la quando a
  // primeira mensagem assistant real da negociação chegar (ou em erro).
  const pendingNegotiationRef = useRef<string | null>(null)
  // QA round 2 (QAA2-01): id da bolha otimista do Negociar que ainda espera o
  // ECO "Negociar" persistido — ao chegar o eco, a otimista é recolocada logo
  // depois dele (ordem do banco: eco → confirmação → parcelas).
  const optimisticAwaitingEchoRef = useRef<string | null>(null)
  // QA round 2 (QAB1-H1): o POST do Pagar desta aba está em voo (o clique
  // governa o estado; o poll não o repõe) / o estado de PAGAR local nasceu de
  // reidratação ou recuperação (o servidor é a autoridade).
  const payInFlightRef = useRef(false)
  const payResumedRef = useRef(false)
  // QA round 2 (QAA2-06 / QAB1-H4): sequência de disparo dos polls e carimbo da
  // última resposta APLICADA — uma resposta mais antiga é ignorada por inteiro.
  const pollSeqRef = useRef(0)
  const lastAppliedPollRef = useRef<PollStamp | null>(null)
  // QA round 2 (QAB1-H5): guarda de clique duplo dos atalhos do painel de pagamento.
  const shortcutGuardRef = useRef(createInFlightGuard())

  // --- Máquina de espera (D2, §6.3) ----------------------------------------
  // waitState: estado DECIDIDO (idle/aguardando_motor/menu_degradado/…). O degrau
  // visual (d0..d4) é derivado do tempo (waitStep) e não é estado. waitStartedAt é
  // a âncora única (do servidor no reload; do relógio no clique). Refs espelham o
  // estado para os callbacks de timer/poll (que não veem o valor do closure).
  const [waitState, setWaitStateRaw] = useState<WaitState>("idle")
  const [waitStep, setWaitStep] = useState<WaitStep>("d0_suppressed")
  const waitStateRef = useRef<WaitState>("idle")
  const waitStartedAtRef = useRef<string | null>(null)
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // QA round 1 (QAA1-01, BLOQUEANTE): as SAÍDAS dos blocos de espera/degradação/
  // erro/processing ficam INERTES por WAIT_EXITS_ARM_MS depois de o bloco
  // aparecer — um toque duplo nunca acerta uma ação que acabou de nascer sob o
  // ponteiro. O instante do clique em Negociar ancora a espera quando (e só
  // quando) o servidor responde sem parcelas.
  const [waitExitsArmed, setWaitExitsArmed] = useState(false)
  const negotiateClickedAtRef = useRef<number | null>(null)
  // Resultado do PAGAR (link/processando/erro) renderizado abaixo do histórico.
  const [payResult, setPayResult] = useState<PayResult | null>(null)
  const [copied, setCopied] = useState(false)
  // A1 — aviso humano do 409 (prompt substituído), acima do bloco de botões. Vive
  // no pai (não no PromptButtons) para sobreviver à remontagem por key={id}.
  const [promptNotice, setPromptNotice] = useState<string | null>(null)
  const payResultRef = useRef<PayResult | null>(null)
  payResultRef.current = payResult
  // A1 — copy progressiva do PAGAR: após PAY_LONG_WAIT_MS sem resposta, "Ainda
  // estou gerando o seu link de pagamento."
  const [payLongWait, setPayLongWait] = useState(false)
  const payLongWaitRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // R3 — poll do link quando a cobrança volta 'processing' (worker gerando).
  // payPollRef: timer do poll; payPollAttempts: nº de tentativas (para oferecer a
  // saída acionável após o teto, nunca espera muda infinita).
  const payPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [payPollAttempts, setPayPollAttempts] = useState(0)
  // R8 — foco/anúncio do resumo pós-login: quando a 1ª mensagem do assistente
  // (resumo) e/ou o menu de 3 opções aparecem, movemos o foco para a região do
  // resumo uma única vez, para o leitor de tela anunciá-la (M18).
  const summaryFocusRef = useRef<HTMLDivElement | null>(null)
  const summaryFocusedRef = useRef(false)

  const setWaitState = useCallback((s: WaitState) => {
    waitStateRef.current = s
    setWaitStateRaw(s)
  }, [])

  // Recalcula o degrau a partir de waitStartedAt; aos 15s, degrada (menu_degradado)
  // SEM parar o polling/outbox. Só age enquanto 'aguardando_motor'.
  const recomputeWaitStep = useCallback(() => {
    if (waitStateRef.current !== "aguardando_motor") return
    const elapsed = elapsedSince(waitStartedAtRef.current, Date.now())
    const step = deriveWaitStep(elapsed)
    setWaitStep(step)
    if (step === "d4_degraded") {
      // Transição por TEMPO → menu_degradado. Persistência no servidor é
      // responsabilidade do backend no reload; aqui é só o visual do client.
      setWaitState("menu_degradado")
      stopTick()
    }
  }, [setWaitState])

  function stopTick() {
    if (tickRef.current) {
      clearInterval(tickRef.current)
      tickRef.current = null
    }
  }

  const startTick = useCallback(() => {
    stopTick()
    recomputeWaitStep()
    tickRef.current = setInterval(recomputeWaitStep, TICK_MS)
  }, [recomputeWaitStep])

  // Resposta do motor chegou → sai da espera para 'negociando' (fluxo normal de
  // turnos). Remove a bolha de espera (o indicador some porque waitState deixa de
  // ser aguardando_motor/menu_degradado) e encerra o tick.
  const resolveWaitToNegotiating = useCallback(() => {
    stopTick()
    waitStartedAtRef.current = null
    setWaitStep("d0_suppressed")
    setWaitState("negociando")
  }, [setWaitState])

  // Reidrata a espera a partir do estado do servidor (M11). Só age quando o
  // servidor tem uma espera persistida (wait_state != null) OU quando ela já foi
  // resolvida no servidor (wait_state null enquanto o client ainda mostrava
  // aguardando_motor/menu_degradado — reconcilia). NÃO sobrepõe estados locais de
  // PAGAR (gerando_cobranca/link_entregue/erro_cobranca) nem o clique em curso.
  const rehydrateWait = useCallback(
    (serverWaitState: string | null, serverWaitStartedAt: string | null) => {
      const local = waitStateRef.current
      // Estados do PAGAR e desfechos são governados localmente pelo clique/poll de
      // pagamento — o poll de mensagens não os altera.
      if (local === "gerando_cobranca" || local === "link_entregue" || local === "erro_cobranca") return
      // QA round 2 (QAB1-H1): um estado de PAGAR persistido pelo servidor
      // (gerando_cobranca/erro_cobranca) é reconciliado por reconcilePayWait,
      // DEPOIS de aplicar mensagens/prompt do mesmo poll — não aqui.
      if (isPayWaitState(serverWaitState)) return
      if (serverWaitState) {
        const view = resolveWaitView(
          hydrateWaitState({ wait_state: serverWaitState, wait_started_at: serverWaitStartedAt }),
          serverWaitStartedAt,
          Date.now(),
        )
        // Só (re)arma a espera se o client não está já num estado mais avançado
        // (negociando vence uma espera obsoleta do servidor). Evita "voltar" ao
        // spinner depois que a resposta já chegou.
        if (local === "negociando") return
        waitStartedAtRef.current = serverWaitStartedAt
        setWaitStep(view.step)
        setWaitState(view.state)
        if (view.state === "aguardando_motor") startTick()
        else stopTick()
        return
      }
      // Servidor sem espera (wait_state null): se o client ainda mostrava a espera,
      // significa que o servidor já a resolveu (motor respondeu / limpeza) → some.
      if (local === "aguardando_motor" || local === "menu_degradado") {
        resolveWaitToNegotiating()
      }
    },
    [resolveWaitToNegotiating, setWaitState, startTick],
  )

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" })
  }, [messages, activePrompt, ended])

  // Reautenticação do CHAT (só quando o usuário confirma no modal de expiração):
  // /n/{code}/chat → /n/{code} (o formulário de CPF do próprio chat). NUNCA o
  // login da AlteaPay, e NUNCA automático.
  const goToChatLogin = useCallback(() => {
    const parent = window.location.pathname.replace(/\/chat\/?$/, "") || "/"
    window.location.href = parent
  }, [])

  // Inatividade: 5min sem interação → MODAL "Continuar" (a página NÃO expira nem
  // reseta; o histórico fica salvo). Só re-arma se não há modal aberto e a
  // conversa não encerrou.
  const resetIdle = useCallback(() => {
    if (idleRef.current) clearTimeout(idleRef.current)
    idleRef.current = setTimeout(() => {
      if (endedRef.current) return
      modalRef.current = "idle"
      setIdleModalState("idle")
    }, IDLE_MS)
  }, [])

  useEffect(() => {
    const events: (keyof WindowEventMap)[] = [
      "mousemove", "mousedown", "keydown", "touchstart", "scroll", "click",
    ]
    const onActivity = () => {
      if (!modalRef.current && !endedRef.current) resetIdle()
    }
    events.forEach((e) => window.addEventListener(e, onActivity, { passive: true }))
    resetIdle()
    return () => {
      events.forEach((e) => window.removeEventListener(e, onActivity))
      if (idleRef.current) clearTimeout(idleRef.current)
    }
  }, [resetIdle])

  function stopPoll() {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  // Polling das mensagens da sessão + prompt ativo (o reconhecimento é a 1ª
  // interação). Para em visibilitychange e tem teto de 20min. Sem PII.
  // `skipIfInFlight` (tick do intervalo): não empilha um 2º GET enquanto o
  // anterior não voltou (QAA1-08); chamadas explícitas pós-clique sempre rodam.
  async function pollMessages(opts?: { skipIfInFlight?: boolean }) {
    if (modalRef.current) return // pausado enquanto o modal (inatividade/expiração) está aberto
    if (opts?.skipIfInFlight && pollInFlightRef.current) return
    pollInFlightRef.current = true
    // QA round 2 (QAA2-06 / QAB1-H4): carimbo de disparo deste poll.
    const seq = ++pollSeqRef.current
    try {
      const url = sinceRef.current
        ? `/api/chat/messages?since=${encodeURIComponent(sinceRef.current)}`
        : "/api/chat/messages"
      const res = await fetch(url)
      // Sessão do chat expirada/ausente → MODAL de reautenticação (não redireciona
      // sozinho, NUNCA o login da AlteaPay). Com TTL de 30 dias isto é raro.
      if (res.status === 401) {
        stopPoll()
        modalRef.current = "expired"
        setIdleModalState("expired")
        return
      }
      if (!res.ok) return
      const data = await res.json()
      // QA round 2 (QAA2-06 / QAB1-H4): POLLS FORA DE ORDEM — uma resposta mais
      // antiga que a última aplicada (server_time; empate/ausência → sequência
      // local) é ignorada por inteiro: mensagens, prompt, espera e links mortos.
      // Nada se perde (as linhas vêm ascendentes e `since` só avança com a
      // resposta aplicada); o prompt na tela nunca regride ao obsoleto.
      const stamp: PollStamp = { seq, serverTime: typeof data?.server_time === "string" ? data.server_time : null }
      if (isStalePoll(stamp, lastAppliedPollRef.current)) return
      lastAppliedPollRef.current = stamp
      // M11: reidrata a máquina de espera a partir do estado do servidor (vem no
      // 1º poll e nos seguintes). Um reload durante a espera restaura o degrau.
      rehydrateWait(data?.wait_state ?? null, data?.wait_started_at ?? null)
      // D2 — CARD FIXO (C1): vem a cada poll (imutável entre polls). Best-effort: se
      // o servidor não montou (null), o card some e o chat segue. Não é linha de
      // chat_messages — mora fora do log.
      if (data?.pinned_debt && typeof data.pinned_debt === "object") {
        setPinnedDebt(data.pinned_debt as PinnedDebtData)
      } else if (data?.pinned_debt === null) {
        setPinnedDebt(null)
      }
      // D2 — RECAP (C7): só o 1º poll (retomada) traz recap != null. Guardamos para
      // renderizar o bloco acima do log no lugar da repetição integral.
      if (data?.recap && typeof data.recap === "object" && typeof data.recap.text === "string") {
        setRecap({ text: data.recap.text })
      }
      // QA round 1 (QAA1-07): cobranças terminais do cliente — vem a cada poll.
      const deadHrefs: ReadonlySet<string> = Array.isArray(data?.dead_payment_links)
        ? new Set((data.dead_payment_links as unknown[]).filter((h): h is string => typeof h === "string"))
        : deadLinkHrefs
      if (Array.isArray(data?.dead_payment_links)) setDeadLinkHrefs(deadHrefs)
      // A3 — RETOMADA: no 1º poll COM recap, o corte é o created_at do menu
      // corrente (sem prompt ativo, o relógio do servidor). Sem recap (1º login,
      // nenhuma decisão ainda) não há corte — nada é recolhido.
      if (!resumeInitRef.current) {
        resumeInitRef.current = true
        if (data?.recap && typeof data.recap === "object") {
          const ap = data?.active_prompt as { created_at?: unknown } | null | undefined
          const cut =
            ap && typeof ap.created_at === "string"
              ? ap.created_at
              : typeof data?.server_time === "string"
                ? data.server_time
                : new Date().toISOString()
          setResumeCutoffAt(cut)
        }
      }
      const pushed: Array<{
        id: string
        role: string
        text: string
        created_at: string
        button_id: number | null
        prompt_id?: string | null
        action?: unknown
        engine?: string | null
        stage?: string | null
        generation?: number | null
      }> = Array.isArray(data?.messages) ? data.messages : []
      // QA round 2 (QAB1-H1): este poll trouxe uma bolha de link VIVO?
      let liveLinkSeen = false
      for (const m of pushed) {
        if (seenIds.current.has(m.id)) continue
        const isAssistant = m.role !== "customer"
        // "Resposta do motor" = mensagem do assistente gravada com engine='n8n'
        // (chat-send do papel B). Distingue a resposta do CÉREBRO das nossas
        // próprias bolhas (eco A.2, narração — engine != 'n8n').
        const isEngineMsg = isAssistant && m.engine === "n8n"
        // M12 — resposta TARDIA em estado ABSORVENTE (link_entregue/quitada/
        // nao_reconhecida): DESCARTA a bolha do motor (nunca reabre negociação,
        // nunca aparece após pagamento). Anteparo CLIENT (defensivo); o servidor é
        // o autoritativo. Marca como vista para não reavaliar no próximo poll.
        if (isEngineMsg && !shouldRenderEngineMsg(waitStateRef.current)) {
          seenIds.current.add(m.id)
          sinceRef.current = m.created_at
          continue
        }
        seenIds.current.add(m.id)
        sinceRef.current = m.created_at
        // A2 (N-D2-6 / §2.3): texto do motor SEM prompt (sem botões) NÃO conta como
        // condução — não derruba a bolha de confirmação nem resolve a espera; só
        // um prompt acionável (mensagem ligada a um prompt) o faz.
        const engineTextOnly = isEngineMsg && !m.prompt_id
        // Se havia uma bolha "preparando negociação" local e chegou a 1ª
        // mensagem real do assistente (nossa confirmação persistida — mesmo texto —
        // ou um prompt do n8n), removemos a optimistic ao inserir a real — troca
        // sem piscar duplicado.
        const optimisticId = pendingNegotiationRef.current
        const dropOptimistic = isAssistant && optimisticId !== null && !engineTextOnly
        if (dropOptimistic) pendingNegotiationRef.current = null
        // A resposta ACIONÁVEL do motor RESOLVE a espera (aguardando_motor OU
        // menu_degradado → negociando): remove a bolha de espera, encerra o tick,
        // some o indicador. Se estava degradado, a tardia ainda renderiza
        // (menu_degradado NÃO é absorvente) — só some o menu de degradação.
        if (isEngineMsg && !engineTextOnly && (waitStateRef.current === "aguardando_motor" || waitStateRef.current === "menu_degradado")) {
          resolveWaitToNegotiating()
        }
        const action = safeMessageAction(m.action)
        // A1 (G1): a bolha do LINK persistida pelo servidor chegou pelo poll — é o
        // resultado do PAGAR (outcome), fonte única do painel. Se ainda estávamos
        // em "gerando" (POST em voo/abortado) ou em 'processing', o link resolve
        // a espera aqui mesmo: link_entregue (absorvente, M12), sem painel
        // duplicado (o client só renderiza o painel próprio quando NÃO há bolha).
        // A1-R1: uma bolha de link MORTO (live:false — acordo cancelado) é só
        // histórico: nunca resolve a espera nem vira "link entregue".
        if (isAssistant && action && isLivePaymentLink(action, deadHrefs)) {
          liveLinkSeen = true
          const local = waitStateRef.current
          if (local === "gerando_cobranca" || payResultRef.current?.status === "processing") {
            stopTick()
            waitStartedAtRef.current = null
            payResumedRef.current = false
            setPayResult({ status: "link", link: action.href, valor: null, vencimento_link: null, already_charged: false })
            setWaitState("link_entregue")
          }
        }
        // QA round 2 (QAB1-H2): chegou um OUTCOME ligado a um clique (ação/stage
        // de resultado) → o "Já estou processando a sua escolha." já foi atendido.
        if (isAssistant && (action || (typeof m.stage === "string" && OUTCOME_STAGES.has(m.stage)))) {
          setProcessingNotice(null)
        }
        if (dropOptimistic && optimisticAwaitingEchoRef.current === optimisticId) optimisticAwaitingEchoRef.current = null
        // QA round 2 (QAA2-01): o ECO do clique (customer + button_id) recoloca a
        // bolha otimista do Negociar logo DEPOIS dele — a ordem do banco.
        const echoReorderId = !isAssistant && typeof m.button_id === "number" ? optimisticAwaitingEchoRef.current : null
        if (echoReorderId) optimisticAwaitingEchoRef.current = null
        const incoming: ChatMsg = {
          id: m.id,
          from: isAssistant ? "assistant" : "customer",
          text: m.text,
          action,
          promptId: m.prompt_id ?? null,
          // sinais p/ a poda por classe (§10.1): engine distingue system;
          // button_id distingue decision (eco do clique); stage marca
          // outcome/greeting (A1).
          engine: m.engine ?? null,
          buttonId: m.button_id ?? null,
          stage: m.stage ?? null,
          // A3: geração anotada pelo servidor (poda §2.4) e instante da
          // linha (a retomada recolhe o que veio antes do menu corrente).
          generation: typeof m.generation === "number" ? m.generation : null,
          createdAt: typeof m.created_at === "string" ? m.created_at : null,
        }
        setMessages((prev) => {
          const base = dropOptimistic ? prev.filter((x) => x.id !== optimisticId) : prev
          return echoReorderId ? placeAfterCustomerEcho(base, echoReorderId, incoming) : [...base, incoming]
        })
      }
      // Nunca sobrescreve o prompt depois de encerrado (preserva o histórico).
      // A2: um poll em voo desde antes do clique pode trazer o prompt já
      // consumido — não sobrescreve o prompt novo (ex.: as parcelas do corpo).
      if (!endedRef.current) {
        const ap = data?.active_prompt ?? null
        const apId = ap && typeof ap === "object" ? (ap as { id?: unknown }).id : null
        if (!(typeof apId === "string" && consumedPromptIds.current.has(apId))) setActivePrompt(ap)
        // QA round 2 (QAB1-H2): chegou o prompt seguinte → o aviso de
        // processamento já foi atendido.
        if (ap) setProcessingNotice(null)
      }
      // QA round 2 (QAB1-H1): reconcilia o estado de PAGAR persistido pelo
      // servidor (reload durante a cobrança) DEPOIS de aplicar mensagens/prompt.
      reconcilePayWait(data?.wait_state ?? null, liveLinkSeen)
    } catch {
      /* silencioso */
    } finally {
      pollInFlightRef.current = false
    }
  }

  // QA round 2 (QAB1-H1) — RELOAD DURANTE O PAGAR: o servidor persiste
  // wait_state='gerando_cobranca' antes da cobrança e limpa/'erro_cobranca' ao
  // final. A cada poll, a regra pura decidePayResume (pay-poll.ts) decide:
  //  - resume_generating → copy "Ainda estou gerando o seu link de pagamento." +
  //    poll de GET /api/chat/payment (o efeito do 'processing') até o link/prompt
  //    ou o teto (~60 s) com [Voltar às opções] [Falar com atendimento];
  //  - show_error → painel de erro com saídas (sem afirmar "nenhuma cobrança");
  //  - settle_idle → o servidor concluiu (outcome + menu vieram): o menu conduz.
  // Um POST do Pagar em voo nesta aba nunca é sobreposto (payInFlightRef).
  function reconcilePayWait(serverWaitState: string | null, liveLinkSeen: boolean) {
    const decision = decidePayResume({
      serverWaitState,
      localWaitState: waitStateRef.current,
      payInFlight: payInFlightRef.current,
      resumed: payResumedRef.current,
      hasActivePrompt: !!activePromptRef.current,
      linkDelivered: liveLinkSeen,
    })
    if (decision === "resume_generating") {
      stopTick()
      waitStartedAtRef.current = null
      payResumedRef.current = true
      setPayPollAttempts(0)
      setCopied(false)
      setPayResult({ status: "processing", link: null, valor: null, vencimento_link: null, already_charged: false, resumed: true })
      setWaitState("gerando_cobranca")
    } else if (decision === "show_error") {
      stopTick()
      waitStartedAtRef.current = null
      payResumedRef.current = true
      setPayResult({ status: "error", link: null, valor: null, vencimento_link: null, already_charged: false, confirmedNotCreated: false, resumed: true })
      setWaitState("erro_cobranca")
    } else if (decision === "settle_idle") {
      payResumedRef.current = false
      setPayResult(null)
      setWaitState("idle")
    }
  }

  useEffect(() => {
    // MONTAGEM = HISTÓRICO COMPLETO: sinceRef começa null, então este 1º poll faz
    // GET /api/chat/messages SEM `since` → o servidor devolve TODAS as mensagens da
    // sessão (ascending, limit 200), não só a última. O dedup por id (seenIds) e o
    // avanço de sinceRef garantem que os polls seguintes só tragam o que é novo.
    pollMessages()
    // Sem teto de tempo: a página NÃO pode expirar. Só pausa quando a aba não
    // está visível ou quando o modal (inatividade/expiração) está aberto.
    pollRef.current = setInterval(() => {
      if (document.visibilityState !== "visible") return
      if (modalRef.current) return
      pollMessages({ skipIfInFlight: true })
    }, 2500)
    return () => {
      stopPoll()
      stopTick() // encerra o tick da espera ao desmontar (sem timer órfão)
      stopPayPoll() // R3 — encerra o poll do link de pagamento
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // KEEP-ALIVE: enquanto a aba está aberta e visível, renova o cookie a cada
  // 10min para o `exp` do JWT NUNCA vencer em uso — a sessão da negociação não
  // pode cair sozinha. Só dispara com a aba visível (não gasta request em aba
  // de fundo) e não roda depois de encerrada a conversa. Um 401 aqui (cookie já
  // inválido) abre o MODAL "Entrar novamente" — nunca redireciona sozinho.
  useEffect(() => {
    async function keepAlive() {
      if (document.visibilityState !== "visible") return
      if (endedRef.current || modalRef.current) return
      try {
        const res = await fetch("/api/chat/keepalive", { method: "POST" })
        if (res.status === 401) {
          stopPoll()
          modalRef.current = "expired"
          setIdleModalState("expired")
        }
      } catch {
        /* silencioso: uma falha de rede não derruba a sessão; tenta de novo depois */
      }
    }
    // Renova também ao voltar o foco à aba (cobre o sono longo entre intervalos).
    const onVisible = () => {
      if (document.visibilityState === "visible") void keepAlive()
    }
    const id = setInterval(() => {
      void keepAlive()
    }, KEEPALIVE_MS)
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      clearInterval(id)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [])

  // "Continuar" do modal de inatividade: fecha o modal, re-arma o timer e retoma
  // o polling exatamente de onde parou (nada é perdido).
  function resumeFromIdle() {
    modalRef.current = null
    setIdleModalState(null)
    resetIdle()
    void pollMessages()
  }

  function stopPayPoll() {
    if (payPollRef.current) {
      clearInterval(payPollRef.current)
      payPollRef.current = null
    }
  }

  // R3 — POLL DO LINK EM `processing`: quando a cobrança volta 'processing' (o
  // worker ainda está gerando o link, CHARGE_MODE=queue), a UI NÃO fica muda:
  // consulta GET /api/chat/payment a cada 2,5s até o link aparecer e então troca
  // a bolha "gerando…" pelo link (§5.2). Passado o teto (~60s), a UI oferece a
  // saída "Falar com atendimento" (renderizada abaixo) — nunca espera infinita.
  // NUNCA declara pago (M15): 'ready' só significa que o link existe.
  useEffect(() => {
    if (ended || payResult?.status !== "processing") {
      stopPayPoll()
      return
    }
    let cancelled = false
    async function pollPayment() {
      if (modalRef.current) return
      try {
        const res = await fetch("/api/chat/payment")
        if (!res.ok) return
        const data = await res.json().catch(() => null)
        const out = interpretPaymentPoll(data)
        if (cancelled) return
        if (out.status === "ready") {
          stopPayPoll()
          setPayResult({
            status: "link",
            link: out.link,
            valor: out.valor,
            vencimento_link: out.vencimentoLink,
            already_charged: false,
          })
          setWaitState("link_entregue")
        } else {
          setPayPollAttempts((n) => n + 1)
        }
      } catch {
        /* silencioso: uma falha de rede não derruba a espera; tenta de novo */
      }
    }
    // Dispara já uma vez e depois a cada 2,5s (mesmo ritmo do poll de mensagens).
    void pollPayment()
    payPollRef.current = setInterval(() => {
      if (document.visibilityState !== "visible") return
      void pollPayment()
    }, 2500)
    return () => {
      cancelled = true
      stopPayPoll()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payResult?.status, ended])

  // QA round 1 (QAA1-01) — ARMING das saídas: sempre que um bloco com saídas
  // (espera/degradação/erro de cobrança/processing) entra em cena, as suas ações
  // ficam inertes por WAIT_EXITS_ARM_MS (disabled + pointer-events:none). Um
  // 2º toque de um toque duplo (100–300 ms) nunca acerta uma ação recém-nascida.
  // QA round 2 (B6 M-1): a saída de handoff que NASCE em d3 ganha o próprio
  // arming (dep = visibilidade dessa saída, não o degrau — senão "Pagar agora"
  // ficaria inerte a cada troca d1/d2/d3).
  const waitHandoffExitVisible = waitState === "aguardando_motor" && shouldShowWaitHandoffExit(waitStep)
  useEffect(() => {
    setWaitExitsArmed(false)
    const t = setTimeout(() => setWaitExitsArmed(true), WAIT_EXITS_ARM_MS)
    return () => clearTimeout(t)
  }, [waitState, payResult?.status, waitHandoffExitVisible])

  // R8 — ao aparecer o resumo pós-login + menu de 3 opções, move o foco para a
  // região do resumo UMA vez, para o leitor de tela anunciá-la (M18). Só quando
  // já há conteúdo e um prompt ativo (o menu). Não re-anuncia em loop.
  useEffect(() => {
    if (summaryFocusedRef.current) return
    if (ended) return
    if (messages.length === 0 && !activePrompt) return
    const el = summaryFocusRef.current
    if (!el) return
    summaryFocusedRef.current = true
    // rAF para garantir que o nó já está no DOM antes de focar.
    requestAnimationFrame(() => {
      try {
        // A3 (N2/G7): NUNCA rola ao focar — com preventScroll:false o foco
        // rolava a janela ao topo do log e escondia card e recap. O menu (fora
        // do log) é trazido à vista só se não estiver visível.
        el.focus({ preventScroll: true })
        menuRef.current?.scrollIntoView({ block: "nearest" })
      } catch {
        /* noop */
      }
    })
  }, [messages.length, activePrompt, ended])

  // Remove a bolha optimistic "preparando negociação" (se houver). Chamada nos
  // caminhos de erro do clique — não faz sentido manter "preparando" se o clique
  // falhou; o PromptButtons já mostra "toque de novo". No SUCESSO NÃO limpamos
  // aqui: a bolha só sai quando a 1ª resposta real do n8n chega no poll.
  function clearPendingNegotiation() {
    const id = pendingNegotiationRef.current
    if (!id) return
    pendingNegotiationRef.current = null
    if (optimisticAwaitingEchoRef.current === id) optimisticAwaitingEchoRef.current = null
    setMessages((prev) => prev.filter((m) => m.id !== id))
  }

  // Clique num prompt de botões (Consultar/Negociar/Não reconheço). HISTÓRICO VEM
  // DO SERVIDOR: o servidor persiste em chat_messages a pergunta, o clique do
  // cliente, os dados da dívida e a resposta — então NÃO empurramos bolhas locais
  // (evita duplicar). Um poll logo após o POST traz tudo + o PRÓXIMO prompt (se
  // houver). Assim uma sessão reaberta reconstrói o contexto completo.
  //
  // EXCEÇÃO — indicador optimistic ao Negociar: uma bolha LOCAL "preparando
  // negociação" é injetada no clique (antes do await) só para dar feedback de
  // "trabalhando" enquanto o backend dispara negotiation.start ao n8n e
  // aguardamos a 1ª resposta chegar. Não é persistida; some quando a resposta
  // real aparece (no poll) ou em erro. Não colide com o histórico do servidor.
  //
  // NÃO encerramos mais o chat no clique: o fluxo continua (Consultar reabre o
  // menu Negociar/Não reconheço; Negociar entra na negociação n8n). O polling
  // segue vivo e o active_prompt reflete o estado real do servidor. Só marcamos
  // 'ended' quando a rota sinaliza um desfecho terminal (transferência a humano)
  // — nunca num passo intermediário do fluxo.
  async function clickButton(
    promptId: string,
    buttonId: number,
    buttonLabel: string,
  ): Promise<PromptClickResult> {
    resetIdle()
    const isNegotiate = isNegotiateLabel(buttonLabel)
    // R1 — ESCOLHA DE PARCELA: no prompt 'offer_choice' um item de lista (2..97,
    // não a volta[98]/atendimento[99]) seleciona uma oferta da matriz → o servidor
    // gera o link ASAAS (action:'pay'). Trata-se como um PAGAR (gera cobrança):
    // mostra "gerando link" e renderiza o resultado no painel de pagamento.
    const isOfferSelect =
      activePrompt?.kind === "offer_choice" && buttonId >= 2 && buttonId <= 97
    // PAGAR: button_id=4 (BTN_PAY do menu de 3 opções) OU rótulo "Pagar …" (os
    // atalhos "Pagar {valor} agora" [d3] e "Pagar {valor} à vista" [degradação]
    // também disparam o pagamento) OU seleção de uma parcela da matriz. Detecção
    // por label/kind cobre todos os pontos.
    const isPay =
      buttonId === 4 || isOfferSelect || /^\s*(quero pagar|pagar)\b/i.test(buttonLabel)
    // CLICK_PAGAR → gerando_cobranca (Apêndice B). Some qualquer espera de
    // negociação anterior (o devedor escolheu pagar) e mostra "gerando link".
    if (isPay) {
      stopTick()
      waitStartedAtRef.current = null
      setWaitStep("d0_suppressed")
      setWaitState("gerando_cobranca")
      setPayResult(null)
      setCopied(false)
      setPayPollAttempts(0) // R3 — zera o contador do poll de 'processing'
      // QA round 2 (QAB1-H1): o clique governa o estado até o POST resolver.
      payInFlightRef.current = true
      payResumedRef.current = false
    }
    // OPTIMISTIC: ao Negociar, injeta já uma bolha "preparando sua negociação"
    // (antes do await). Feedback imediato de que o sistema está trabalhando
    // enquanto o backend dispara negotiation.start ao n8n e aguardamos a 1ª
    // resposta (chat.send) chegar via poll. NÃO persiste: é local e some quando a
    // resposta real aparece (ou em erro).
    // CLICK_NEGOCIAR: QA round 1 (QAA1-01, BLOQUEANTE) — o clique NÃO arma mais a
    // espera. Com as parcelas no corpo do POST (A2) não há espera nenhuma; e o
    // bloco de espera renderizado no instante do clique nascia sob o ponteiro
    // (o 2º toque de um toque duplo caía em "Falar com atendimento"). A espera
    // (aguardando_motor) só arma quando o servidor responde SEM parcelas
    // (negotiateWaitOnResponse) ou quando o poll reidrata wait_state — ancorada
    // no instante do clique (os degraus 1,2/4/10/15 s continuam corretos).
    if (isNegotiate) {
      negotiateClickedAtRef.current = Date.now()
      const optimisticId = `optimistic-neg-${Date.now()}`
      pendingNegotiationRef.current = optimisticId
      optimisticAwaitingEchoRef.current = optimisticId // QAA2-01: reordena ao chegar o eco
      setMessages((prev) => [
        ...prev,
        { id: optimisticId, from: "assistant", text: NEGOTIATION_PENDING_TEXT, action: null, promptId: null },
      ])
    }
    // GARANTIA DE VIVACIDADE: o backend responde o clique rápido (o kickoff n8n
    // roda em background — C1), mas ainda blindamos o cliente contra um servidor
    // lento/rede presa com um AbortController. Sem isto, um fetch pendurado
    // deixaria a Promise do onClick sem resolver e o botão travado em "..." para
    // sempre. Com o timeout, o "..." SEMPRE resolve e o PromptButtons reabilita os
    // botões e mostra um aviso ("conexão lenta, toque de novo").
    const controller = new AbortController()
    // 8s cobre folgadamente Consultar/Negociar/Voltar. O PAGAR (A1/G1) tem abort
    // próprio e generoso (PAY_ABORT_MS): um POST de cobrança NUNCA é abortado em
    // 8s — e, se abortar, consultamos o servidor antes de afirmar qualquer coisa.
    const timeoutId = setTimeout(() => controller.abort(), isPay ? PAY_ABORT_MS : CLICK_ABORT_MS)
    if (isPay) startPayLongWait()
    setPromptNotice(null)
    setProcessingNotice(null)
    try {
      const res = await fetch("/api/chat/button", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt_id: promptId, button_id: buttonId }),
        signal: controller.signal,
      })
      // Sessão do chat expirada/ausente → MODAL de reautenticação (não redireciona
      // sozinho). Com TTL de 30 dias isto praticamente não ocorre.
      if (res.status === 401) {
        clearPendingNegotiation()
        if (isPay) clearWaitForPayFailure()
        else if (isNegotiate) resetWaitToIdle()
        stopPoll()
        modalRef.current = "expired"
        setIdleModalState("expired")
        return { ok: false, code: "unauthorized" }
      }
      const data = await res.json().catch(() => ({}))
      // A2: o prompt clicado foi consumido no servidor (200) ou já era obsoleto
      // (409) — um poll atrasado não o repõe por cima do prompt novo.
      if (res.ok || res.status === 409) consumedPromptIds.current.add(promptId)
      // QA round 1 (QAA1-01) — o servidor ignorou um handoff como TOQUE DUPLO:
      // nada mudou no servidor; só reconcilia pelo poll (nunca reabre menu por
      // cima das parcelas, nunca encerra).
      if (res.ok && data?.ignored === "double_tap") {
        clearPendingNegotiation()
        await pollMessages()
        return { ok: true }
      }
      // QA round 1 (QAA1-06) — CLIQUE DUPLICADO (o mesmo botão já respondeu este
      // prompt há instantes): sem efeito novo. PAGAR: o outro pedido está
      // gerando/gerou o link — consulta o servidor e segue em 'processing' até a
      // bolha do link chegar (nunca "gerando" eterno, nunca 2ª cobrança). Demais:
      // re-hidrata com o prompt ativo do corpo.
      if (res.ok && data?.duplicate === true) {
        if (isPay) {
          await recoverPayAfterTransportFailure()
          return { ok: true }
        }
        const dupPrompt = asActivePrompt(data?.prompt)
        if (dupPrompt && !endedRef.current) setActivePrompt(dupPrompt)
        else if (staleClickFeedback(data) === "processing") {
          // QA round 2 (QAB1-H2): o 1º clique ainda não reabriu o menu — aviso
          // humano + poll até o próximo prompt/outcome (nunca mudo).
          setActivePrompt(null)
          setProcessingNotice(PROCESSING_CHOICE_NOTICE)
        }
        await pollMessages()
        return { ok: true }
      }
      // PAGAR — o button/route.ts (D1) devolve o shape do payService (D3) NO
      // corpo do clique (com HTTP 200 mesmo em erro de negócio). Renderizamos o
      // resultado (link/processando/erro) aqui, sem depender do poll. O guard de
      // cobrança e a idempotência são do servidor; o client só exibe a copy §5.
      if (isPay && data && data.action === "pay") {
        applyPayResult(data)
        // O menu de 3 opções já foi respondido; o poll traz a bolha do link
        // (outcome) e o prompt pós-link persistidos pelo servidor (A1). O botão
        // sai do "..." (ok) — o painel deriva da mensagem persistida. QA round 1
        // (QAA1-02): sem link resolvível o corpo traz o MENU CURTO ativo →
        // renderiza na hora (nunca uma tela sem botão). O prompt pós-link continua
        // chegando pelo poll junto da bolha (evita duplicar Voltar/Falar/Já paguei
        // ao lado do painel-fallback do client no intervalo até o poll).
        const payPrompt = asActivePrompt(data?.prompt)
        setActivePrompt(payPrompt && payPrompt.kind !== "post_payment_link" && !endedRef.current ? payPrompt : null)
        await pollMessages()
        return { ok: true }
      }
      if (res.ok) {
        // NEGOCIAR — dois desfechos (R1):
        //  (a) offers_presented=true → o servidor JÁ apresentou as PARCELAS DA
        //      MATRIZ como um prompt 'offer_choice' (fallback assistido). NÃO há
        //      espera: saímos do aguardando_motor otimista e limpamos a bolha
        //      "preparando" — as parcelas aparecem no poll seguinte como botões,
        //      ação imediatamente disponível (sem spinner de 15s).
        //  (b) sem offers (wait_state='aguardando_motor') → mantém a espera D2
        //      armada; o poll traz wait_started_at do servidor e, aos 15s, o menu
        //      de degradação (M10).
        if (data?.action === "negotiate") {
          if (data?.offers_presented === true) {
            const offerPrompt = asActivePrompt(data?.prompt)
            resetWaitToIdle()
            setPromptNotice(null)
            if (offerPrompt && !endedRef.current) {
              // A2 (G2): as PARCELAS vêm no corpo do POST → renderiza NA HORA, sem
              // depender do poll de 2,5 s. A bolha otimista "Certo…" vira histórico
              // (o dedup por conteúdo a colapsa com a persistida quando o poll chegar);
              // nenhuma mensagem posterior a derruba (ref limpa). O poll segue em
              // paralelo para trazer eco + bolhas persistidas.
              pendingNegotiationRef.current = null
              setActivePrompt(offerPrompt)
              void pollMessages()
              return { ok: true }
            }
            // compat: servidor antigo sem `prompt` no corpo → o poll traz as parcelas.
            clearPendingNegotiation()
          } else if (negotiateWaitOnResponse(data)) {
            // Sem parcelas (sem faixa de matriz / falha): SÓ AGORA arma a espera
            // D2, ancorada no instante do clique (degraus corretos); as saídas do
            // bloco nascem inertes (arming) e o handoff só existe a partir de d3.
            armNegotiationWait()
          }
        }
        // A2 — prompt genérico (criado pelo n8n) / fallback do assistido: quando o
        // servidor devolve o prompt seguinte no corpo (menu reaberto ou o ativo),
        // renderiza já — nunca uma tela sem caminho enquanto o poll não chega.
        const bodyPrompt = asActivePrompt(data?.prompt)
        if (bodyPrompt && !endedRef.current && data?.action !== "consult" && data?.action !== "not_recognized") {
          setActivePrompt(bodyPrompt)
          void pollMessages()
          return { ok: true }
        }
        // FEEDBACK IMEDIATO <1s (R-01/R-02, C13): renderiza a resposta do servidor
        // NA HORA (do corpo do POST), sem depender do timing do poll de 2,5s. Cobre
        // os cliques cujo desfecho é uma bolha de texto do assistente:
        //   - consult  (CONSULTAR): vencimento + cedente;
        //   - not_recognized (NAO_RECONHECO): copy do cedente + volta;
        //   - back_to_options (VOLTAR): resumo do menu reaberto.
        // O dedup por conteúdo (chat-display) colapsa esta bolha local com a
        // persistida que o poll trouxer (mesmo texto) — nunca duplica, nunca some.
        // Sem esta injeção, sob rede ruim o clique ficava mudo até o poll voltar.
        // A1: back_to_options NÃO injeta bolha — o menu curto ("Como prefere
        // seguir?") que o poll traz É o feedback; injetar a pergunta duplicaria.
        const immediateReplyActions = new Set(["consult", "not_recognized"])
        if (
          typeof data?.action === "string" &&
          immediateReplyActions.has(data.action) &&
          typeof data?.reply === "string" &&
          data.reply
        ) {
          const replyText = data.reply as string
          setMessages((prev) => [
            ...prev,
            { id: `${data.action}-${Date.now()}`, from: "assistant", text: replyText, action: null, promptId: null },
          ])
        }
        // O prompt clicado já foi respondido (answered) no servidor. Limpamos o
        // prompt local para não travar a UI num prompt morto e puxamos o estado:
        // mensagens novas (dados da dívida + resposta) + o novo active_prompt (o
        // menu pós-consulta, quando houver). O poll re-hidrata activePrompt.
        // NÃO limpamos a optimistic aqui: a resposta do n8n costuma vir num poll
        // seguinte, não neste — a bolha "preparando" fica até ela chegar.
        setActivePrompt(null)
        await pollMessages()
        // Desfecho terminal: só uma transferência a humano encerra a conversa.
        // Consultar/Negociar/Não reconheço mantêm o chat vivo (menu ou negociação).
        if (data?.transferred === true) {
          endedRef.current = true
          setEnded(true)
          stopPoll()
        }
        return { ok: true }
      }
      // A1 (N-D3-3/N-D1-4) — 409 prompt_stale/prompt_not_active NUNCA é mudo: o
      // prompt clicado foi substituído (2ª aba, poll atrasado). Re-hidrata com o
      // active_prompt do corpo (mesmo shape do GET) E com um poll fresco, mostra o
      // aviso humano e devolve o code para o PromptButtons também avisar. Nunca
      // reabilita o mesmo menu em silêncio.
      if (res.status === 409 && (data?.code === "prompt_stale" || data?.code === "prompt_not_active")) {
        clearPendingNegotiation()
        if (isPay) resetWaitToIdle() // prompt já consumido: não trava em gerando_cobranca
        else if (isNegotiate) resetWaitToIdle()
        // QA round 2 (QAB1-H2): 409 SEM active_prompt = o vencedor (outra aba/POST
        // concorrente) ainda processa e não criou o prompt seguinte. Nunca mudo,
        // nunca o mesmo menu reabilitado: "Já estou processando a sua escolha." +
        // poll até o próximo prompt/outcome. O bloco de botões some (consumido).
        if (staleClickFeedback(data) === "processing") {
          setPromptNotice(null)
          setActivePrompt(null)
          setProcessingNotice(PROCESSING_CHOICE_NOTICE)
          await pollMessages()
          return { ok: true }
        }
        setPromptNotice(PROMPT_STALE_NOTICE)
        const stalePrompt = asActivePrompt(data?.active_prompt)
        if (stalePrompt && !endedRef.current) setActivePrompt(stalePrompt)
        await pollMessages()
        return { ok: false, code: "prompt_stale" }
      }
      // Demais erros (404/409/422/5xx): devolve o code p/ o PromptButtons avisar
      // o cliente e reabilitar os botões (o loading para no finally do filho).
      // Para o PAGAR, um 5xx NÃO confirma "nenhuma cobrança criada" — consulta o
      // servidor antes de qualquer afirmação.
      clearPendingNegotiation()
      if (isPay) {
        await recoverPayAfterTransportFailure()
        return { ok: true }
      }
      if (isNegotiate) resetWaitToIdle()
      return { ok: false, code: typeof data?.code === "string" ? data.code : "error" }
    } catch (err) {
      // AbortError = estouramos o nosso timeout (servidor lento) → code "timeout"
      // para o PromptButtons mostrar "conexão lenta, toque de novo". Demais erros
      // de rede caem em code genérico. Em ambos, o botão SAI do "..." e a bolha
      // optimistic é removida. A1: ANTES de reabilitar, re-hidrata o estado (o
      // servidor pode ter respondido o clique) — nunca reabilita em silêncio um
      // prompt que já foi consumido. O PAGAR nunca afirma "nenhuma cobrança foi
      // criada" por timeout/rede: consulta GET /api/chat/payment e segue em
      // 'processing' (poll) até o link aparecer (ou oferecer atendimento).
      clearPendingNegotiation()
      if (isPay) {
        await recoverPayAfterTransportFailure()
        return { ok: true }
      }
      if (isNegotiate) resetWaitToIdle()
      await pollMessages()
      if (err instanceof DOMException && err.name === "AbortError") {
        return { ok: false, code: "timeout" }
      }
      return { ok: false, code: "network" }
    } finally {
      clearTimeout(timeoutId)
      stopPayLongWait()
      if (isPay) payInFlightRef.current = false
    }
  }

  // A1 — copy progressiva do PAGAR (timer local; some quando há resultado).
  function startPayLongWait() {
    stopPayLongWait()
    setPayLongWait(false)
    payLongWaitRef.current = setTimeout(() => setPayLongWait(true), PAY_LONG_WAIT_MS)
  }
  function stopPayLongWait() {
    if (payLongWaitRef.current) {
      clearTimeout(payLongWaitRef.current)
      payLongWaitRef.current = null
    }
    setPayLongWait(false)
  }

  // A1 (G1) — falha de TRANSPORTE no PAGAR (timeout/rede/5xx): o servidor pode ter
  // criado a cobrança. Antes de dizer qualquer coisa, consulta GET /api/chat/
  // payment: link pronto → entrega o link; senão fica em 'processing' (o poll R3
  // segue até o link ou oferece atendimento). NUNCA "Nenhuma cobrança foi criada".
  async function recoverPayAfterTransportFailure() {
    stopTick()
    waitStartedAtRef.current = null
    let ready = false
    try {
      const res = await fetch("/api/chat/payment", { cache: "no-store" })
      if (res.ok) {
        const out = interpretPaymentPoll(await res.json().catch(() => null))
        if (out.status === "ready") {
          ready = true
          setPayResult({ status: "link", link: out.link, valor: out.valor, vencimento_link: out.vencimentoLink, already_charged: false })
          setWaitState("link_entregue")
        }
      }
    } catch {
      /* silencioso: cai no processing/poll abaixo */
    }
    if (!ready) {
      // QA round 2 (QAB1-H1): o servidor é a autoridade daqui em diante (o
      // wait_state persistido decide: link/erro/menu pelo poll).
      payResumedRef.current = true
      setPayResult({ status: "processing", link: null, valor: null, vencimento_link: null, already_charged: false, resumed: true })
      setWaitState("gerando_cobranca")
    }
    setActivePrompt(null)
    await pollMessages()
  }

  // QA round 1 (QAA1-01) — arma a espera D2 quando o servidor respondeu ao
  // Negociar SEM parcelas. Âncora = instante do clique (não o da resposta), para
  // os degraus 1,2/4/10/15 s valerem desde o toque. Só arma a partir de idle/
  // degradado (um estado de PAGAR ou 'negociando' nunca é sobreposto).
  function armNegotiationWait() {
    const local = waitStateRef.current
    if (local !== "idle" && local !== "menu_degradado") return
    const anchor = negotiateClickedAtRef.current ?? Date.now()
    waitStartedAtRef.current = new Date(anchor).toISOString()
    setWaitStep(deriveWaitStep(elapsedSince(waitStartedAtRef.current, Date.now())))
    setWaitState("aguardando_motor")
    startTick()
  }

  // Traduz o shape do payService (D3) em PayResult para render (§5.2/§5.3/§5.4).
  // NUNCA declara pago (M15): 'processing' (worker off) e 'link' apenas entregam o
  // link; a quitação é do webhook. Erro de negócio (ok:false) → menu acionável.
  function applyPayResult(data: Record<string, unknown>) {
    stopTick()
    waitStartedAtRef.current = null
    payResumedRef.current = false
    if (data.ok === true) {
      // QA round 1 (QAA1-02): cobrança já existente SEM link resolvível — o
      // servidor persistiu o outcome humano + menu curto (vêm no poll/corpo).
      // Não há "link entregue" nem painel: volta ao idle e deixa o menu conduzir.
      if (!data.link && data.processing !== true && data.already_charged === true) {
        setPayResult(null)
        setWaitState("idle")
        return
      }
      const processing = data.processing === true && !data.link
      setPayResult({
        status: processing ? "processing" : "link",
        link: typeof data.link === "string" ? data.link : null,
        valor: typeof data.valor === "number" ? data.valor : null,
        vencimento_link: typeof data.vencimento_link === "string" ? data.vencimento_link : null,
        already_charged: data.already_charged === true,
      })
      // link_entregue é ABSORVENTE (M12): a resposta tardia do motor é descartada.
      setWaitState(processing ? "gerando_cobranca" : "link_entregue")
    } else {
      // Erro de negócio (rótulo curto do servidor) → copy humana §5.4 (nunca o
      // rótulo cru). Menu [Tentar novamente] [Falar com atendimento].
      // A1: só aqui (ok:false do SERVIDOR) "Nenhuma cobrança foi criada" é verdade.
      setPayResult({ status: "error", link: null, valor: null, vencimento_link: null, already_charged: false, confirmedNotCreated: true })
      setWaitState("erro_cobranca")
    }
  }

  // Falha de transporte no PAGAR (401/sessão): cai no menu de erro §5.4 (nunca
  // beco sem saída, nunca erro técnico), SEM afirmar que nenhuma cobrança foi
  // criada (o servidor pode ter cobrado).
  function clearWaitForPayFailure() {
    stopTick()
    waitStartedAtRef.current = null
    setPayResult({ status: "error", link: null, valor: null, vencimento_link: null, already_charged: false, confirmedNotCreated: false })
    setWaitState("erro_cobranca")
  }

  // Volta a espera ao idle (NEGOCIAR falhou/consumido): o devedor pode reabrir o
  // menu e tentar de novo. Não mexe em payResult.
  function resetWaitToIdle() {
    stopTick()
    waitStartedAtRef.current = null
    setWaitStep("d0_suppressed")
    setWaitState("idle")
  }

  // --- Ações dos atalhos da espera/degradação (§6.3 d3 / §4 A.5) -----------
  // CAMINHO REAL SEMPRE (M10): quando o menu de 3 opções já foi consumido (ex.: o
  // devedor clicou "Quero negociar" e o prompt ficou answered/sumiu), NÃO há
  // prompt ativo para reusar. Antes, os atalhos caíam em resetWaitToIdle()+
  // pollMessages() — mas o poll NÃO repõe um prompt já respondido, deixando a tela
  // MORTA (D2 BLOQUEANTE). Agora reabrimos o menu payável no servidor via
  // /api/chat/reopen (trilha D1, sem prompt_id) e o poll seguinte traz o menu de
  // volta — "Pagar à vista"/"Tentar as opções de novo" sempre têm botão real.

  // Re-publica o menu de 3 opções no servidor (payável) e re-hidrata a UI. Sai da
  // espera para idle e puxa o novo active_prompt. Best-effort: mesmo em erro de
  // rede o poll reconcilia o estado.
  async function reopenOptions() {
    resetWaitToIdle()
    try {
      await fetch("/api/chat/reopen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reopen_options" }),
      })
    } catch {
      /* silencioso: o poll abaixo reconcilia mesmo sem a re-emissão */
    }
    await pollMessages()
  }

  // R5 — "Já paguei / enviar comprovante": registra o payment_claim no servidor
  // (POST /api/chat/reopen {action:'payment_claim'}) — a equipe confere. NÃO declara
  // pago (D6/M15). O servidor persiste a orientação ao devedor e REABRE o menu de 3
  // opções (nunca beco sem saída, M7); o poll seguinte traz a bolha de orientação +
  // o menu de volta. Best-effort: em erro de rede, o poll reconcilia. Não encerra a
  // conversa (diferente do handoff). Guarda contra clique duplo com um flag local.
  const [claimSent, setClaimSent] = useState(false)
  async function requestPaymentClaim() {
    if (claimSent) return
    setClaimSent(true)
    resetIdle()
    try {
      await fetch("/api/chat/reopen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "payment_claim" }),
      })
    } catch {
      /* silencioso: o poll abaixo reconcilia a orientação + o menu reaberto */
    }
    await pollMessages()
  }

  // Handoff SEM prompt ativo: transfere ao atendimento direto no servidor e
  // encerra a conversa (desfecho terminal). Reusa o mesmo endpoint de reopen.
  async function requestHandoffNoPrompt() {
    try {
      const res = await fetch("/api/chat/reopen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "handoff" }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data?.transferred === true) {
        endedRef.current = true
        setEnded(true)
        stopTick()
        stopPoll()
        return
      }
      // QA round 1 (QAA1-01): o servidor tratou o handoff como TOQUE DUPLO (< 2 s
      // após um clique válido). Nada a repor: o clique original está em curso
      // (as parcelas/outcome chegam pelo poll). Reabrir o menu aqui superporia o
      // prompt novo (as parcelas nunca apareceriam).
      if (res.ok && data?.ignored === "double_tap") {
        await pollMessages()
        return
      }
    } catch {
      /* silencioso: cai no reopen do menu abaixo (o handoff também está lá) */
    }
    // Não confirmou a transferência: repõe o menu para o devedor não ficar preso.
    await reopenOptions()
  }

  // "Pagar {valor}" (agora / à vista): reusa o botão PAGAR do prompt ativo se ele
  // ainda existir (id 4); senão RE-ABRE o menu (o PAGAR volta e o devedor conclui).
  // NUNCA cobra 2x: o caminho de cobrança e a idempotência são do servidor.
  function payActiveButtonId(): number | null {
    const b = activePrompt?.buttons?.find((x) => x.id === 4)
    return b ? b.id : null
  }
  // QA round 2 (QAB1-H5): TODOS os atalhos do painel (espera/degradação/erro/
  // link/processing) passam pela mesma guarda de clique duplo — um 2º toque com
  // um atalho em voo é ignorado (nunca 2 POST /api/chat/reopen). O núcleo de
  // cada ação fica sem guarda para poder ser composto (onPayRetry → payNow).
  async function payNowCore() {
    const pid = payActiveButtonId()
    if (activePrompt && pid != null) {
      await clickButton(activePrompt.id, pid, "Pagar")
      return
    }
    // Sem botão PAGAR ativo (menu consumido): re-emite o menu payável (M10) — não
    // apenas poll (que não repõe prompt respondido). O devedor reabre e paga.
    await reopenOptions()
  }
  async function onWaitPayNow() {
    await shortcutGuardRef.current.run(payNowCore)
  }
  // "Tentar as opções de novo" (A.5): re-emite o menu de 3 opções no servidor.
  async function onWaitRetryOptions() {
    await shortcutGuardRef.current.run(reopenOptions)
  }
  // "Falar com atendimento": reusa o botão de handoff (99) do prompt ativo se
  // houver; senão transfere direto ao atendimento no servidor (nunca beco sem
  // saída). Sem termos técnicos ao devedor.
  async function onWaitHandoff() {
    await shortcutGuardRef.current.run(async () => {
      const h = activePrompt?.buttons?.find((x) => x.id === 99)
      if (activePrompt && h) {
        await clickButton(activePrompt.id, 99, h.label)
        return
      }
      await requestHandoffNoPrompt()
    })
  }
  // "Tentar novamente" (§5.4, erro de cobrança): reusa o PAGAR ativo, senão repõe
  // o menu. Limpa o painel de erro antes.
  async function onPayRetry() {
    await shortcutGuardRef.current.run(async () => {
      setPayResult(null)
      await payNowCore()
    })
  }
  // R-06 — "Voltar às opções" no erro de cobrança: limpa o painel de erro e reabre
  // o menu payável completo (Pagar/Negociar/Consultar/Não reconheço). Dá saída às
  // demais decisões básicas por 1 clique — não prende o devedor no par tentar/
  // atendimento. reopenOptions() re-emite o menu no servidor (nunca beco sem saída).
  async function onPayBackToOptions() {
    await shortcutGuardRef.current.run(async () => {
      setPayResult(null)
      await reopenOptions()
    })
  }
  // Copiar o link de pagamento (§5.2). Best-effort; sem quebrar se o clipboard
  // não estiver disponível.
  async function onCopyLink(link: string) {
    try {
      await navigator.clipboard?.writeText(link)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* silencioso: o link continua visível/clicável na tela */
    }
  }

  // D2/A3 — PIPELINE DE APRESENTAÇÃO (§10.1 / §2.2 / §2.4), na ordem:
  //  1) filtra a bolha do prompt ATIVO (sua pergunta aparece no bloco de botões);
  //  2) PODA por classe (prunePresentation): system fora (R-16), superseded colapsa
  //     (menus antigos não empilham, R-13) — inclusive GERAÇÕES ANTERIORES do fluxo
  //     (A3: Sim/Não → Consultar/Negociar), pela geração anotada pelo servidor;
  //  3) COLAPSO de decisions consecutivas iguais (A3): cliques repetidos sem outcome
  //     entre eles viram um;
  //  4) dedup por conteúdo (só a última guidance idêntica);
  //  5) RETOMADA (A3): tudo o que veio antes do menu corrente fica recolhido atrás
  //     de "Ver conversa completa", salvo o último outcome (link/acordo/desfecho);
  //  6) TETO de 20 (capHistory): guidance velho recolhe; decision/outcome NUNCA
  //     recolhem (C8/R-15/R-41).
  // "Ver conversa completa" desliga a regra de geração (as gerações anteriores
  // voltam a renderizar) e o corte da retomada.
  const activePromptId = activePrompt && !ended ? activePrompt.id : null
  const currentGeneration = historyExpanded
    ? null
    : currentGenerationOf(messages, activePrompt && !ended ? activePrompt.kind : null)
  // A2 (N-D2-6 / N-D5-9) — texto do motor (engine='n8n') sem prompt: regra de
  // exibição pura (wait-machine.engineTextDisplay): 'hidden' (fallback genérico /
  // estado absorvente) sai do log; 'note' (menu do assistido ativo) vira nota
  // discreta acima do bloco de botões; 'bubble' é a bolha comum. Markdown e nome
  // de sistema nunca chegam ao devedor.
  const engineDisplayOf = (m: ChatMsg) =>
    m.from === "assistant" && m.engine === "n8n"
      ? engineTextDisplay({ text: m.text, hasPrompt: !!m.promptId, activePromptKind: activePromptId ? activePrompt?.kind : null, waitState })
      : null
  const visibleMessages = messages.filter(
    (m) =>
      !(activePrompt && !ended && m.promptId && m.promptId === activePrompt.id) &&
      engineDisplayOf(m)?.mode !== "hidden",
  )
  const prunedMessages = prunePresentation(visibleMessages, activePromptId, waitState, currentGeneration)
  const collapsedDecisions = collapseConsecutiveDecisions(prunedMessages, activePromptId, waitState, currentGeneration)
  const dedupedMessages = dedupAssistantByContent(collapsedDecisions)
  const resume = splitResumeHistory(dedupedMessages, {
    cutoffAt: resumeCutoffAt,
    expanded: historyExpanded,
    activePromptId,
    waitState,
    currentGeneration,
  })
  const capped = capHistory(resume.visible, activePromptId, waitState, {
    expanded: historyExpanded,
    currentGeneration,
  })
  const hiddenCount = resume.collapsed.length + capped.collapsed.length
  // A3 (§2.2) + A4 (B3-F1): uma só pergunta na tela — se a frase do prompt já é
  // a última bolha visível do assistente (T2 = S7 acima das parcelas) ou já fecha
  // a saudação de retorno ("… Como prefere seguir?"), o bloco vem só com os
  // botões. Composição pura em chat-display.resolvePromptForRender.
  const promptForRender =
    activePrompt && !ended ? resolvePromptForRender(activePrompt, capped.visible, recap?.text) : activePrompt
  // A1: há bolha persistida do link (ação open_payment_link VIVA) para o link
  // corrente? QA round 1 (QAA1-08/QAA1-07): a ação deriva da bolha persistida
  // (paymentLinkActionOf — também quando o shape chegou sem message_action) e a
  // vivacidade cruza `live:false` + os hrefs terminais do poll (deadLinkHrefs).
  const hasPersistedLink = messages.some((m) => {
    const a = paymentLinkActionOf(m)
    return isLivePaymentLink(a, deadLinkHrefs) && (!payResult?.link || a!.href === payResult.link)
  })
  // A1: só a ÚLTIMA bolha de link VIVO ganha o painel (Abrir/Copiar). Bolhas de
  // links anteriores (cobrança cancelada e recriada) e bolhas cujo acordo o
  // servidor marcou como terminal (action.live === false — A1-R1, ou href em
  // dead_payment_links — QAA1-07) ficam só como texto: nenhum botão para um
  // link morto, nem na retomada após cancelamento, nem no poll seguinte.
  const latestPaymentLinkId = latestLivePaymentLinkId(messages, deadLinkHrefs)
  // Classes das saídas de espera/erro: inertes até o arming (QAA1-01).
  const exitBtnGuard = waitExitsArmed ? "" : " pointer-events-none opacity-60"

  return (
    <div className="flex flex-1 flex-col gap-3">
      {/* Sair do CHAT: volta para a tela de CPF/CNPJ (/n/{code}), NUNCA o login
          da plataforma (/auth/login). Reusa goToChatLogin. */}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={goToChatLogin}
          className="inline-flex min-h-[44px] items-center rounded-md px-3 text-sm font-medium text-neutral-600 hover:bg-neutral-100 hover:text-neutral-800"
        >
          Sair
        </button>
      </div>
      {/* D2 — CARD FIXO do débito (C1/R-11): FORA do log (não é linha de chat),
          aparece 1x no topo, imutável entre polls, sobrevive a reload. O valor mora
          aqui (e nos outcomes), não nas guidance/perguntas (R-12). D3 estiliza. */}
      <DebtCard debt={pinnedDebt} />
      {/* D2/A3 — SAUDAÇÃO DE RETORNO (§2.2, C7/R-17): ACIMA do log, no lugar da
          repetição integral e da saudação original (recolhida). Só na retomada
          (recap != null vindo do 1º poll). Uma só saudação na tela. */}
      {recap && !ended ? (
        <div
          role="status"
          aria-live="polite"
          className="rounded-lg border border-neutral-200 bg-neutral-50 px-3.5 py-2 text-sm text-neutral-700"
        >
          {recap.text}
        </div>
      ) : null}
      {/* R8 — a região de mensagens é um log acessível: o resumo pós-login e as
          respostas do assistente são anunciados ao leitor de tela (aria-live
          polite, só adições), e a região recebe FOCO uma vez após o login (M18).
          Os BOTÕES ficam num bloco com aria-live=off (abaixo) para não serem
          re-anunciados em loop — a live region envolve só a copy.
          A3 (G7/N2): o log tem ALTURA LIMITADA e rola POR DENTRO (é ele que o
          auto-scroll rola); o menu fica logo abaixo, FORA do log — em 360×800 o
          primeiro botão de ação está na tela sem rolar. Sem flex-1: o log cresce
          só com o conteúdo (até o teto), não engole o espaço da tela. */}
      <div
        ref={(node) => {
          scrollRef.current = node
          summaryFocusRef.current = node
        }}
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        aria-atomic="false"
        aria-label="Conversa de negociação"
        tabIndex={-1}
        className="min-h-[96px] max-h-[42dvh] space-y-3 overflow-y-auto rounded-lg bg-white p-3 shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-secondary)]/40 sm:max-h-[58dvh]"
      >
        {capped.visible.map((m) => {
          const engineDisplay = engineDisplayOf(m)
          // A2: nota discreta do motor (texto solto com o assistido ativo) — sem
          // bolha, sem markdown, não "responde" nem empurra o menu.
          if (engineDisplay?.mode === "note") {
            return (
              <div key={m.id} className="flex flex-col items-start">
                <p className="max-w-[85%] whitespace-pre-line px-1 text-xs italic text-neutral-500">
                  {engineDisplay.text}
                </p>
              </div>
            )
          }
          return (
          <div
            key={m.id}
            className={m.from === "customer" ? "flex justify-end" : "flex flex-col items-start"}
          >
            <div
              style={m.from === "customer" ? BRAND_FILL_STYLE : undefined}
              className={
                m.from === "customer"
                  ? "max-w-[85%] whitespace-pre-line rounded-2xl rounded-br-sm px-3.5 py-2 text-sm"
                  : "max-w-[85%] whitespace-pre-line rounded-2xl rounded-bl-sm bg-neutral-100 px-3.5 py-2 text-sm text-neutral-800"
              }
            >
              {renderRichText(
                engineDisplay
                  ? engineDisplay.text
                  : paymentLinkActionOf(m)
                    ? textWithoutUrl(m.text, (paymentLinkActionOf(m) as MsgAction).href)
                    : m.text,
              )}
            </div>
            {/* A1 (N-D1-3/N-D1-8) — LINK DE PAGAMENTO: o painel deriva da bolha
                PERSISTIDA (fonte única, sobrevive ao reload): "Abrir link de
                pagamento" + "Copiar link". As ações seguintes (Voltar às opções /
                Falar com atendimento) vêm do prompt pós-link do servidor; "Já
                paguei" é a afordância sob esse prompt. QA round 1: a ação vem de
                paymentLinkActionOf (bolha persistida, qualquer viewport) e só a
                ÚLTIMA bolha VIVA (latestLivePaymentLinkId) ganha o painel. */}
            {m.id === latestPaymentLinkId && paymentLinkActionOf(m) ? (
              <div className="mt-2 flex w-full max-w-[90%] flex-col gap-2 rounded-lg border border-neutral-200 bg-white p-3">
                <a
                  href={(paymentLinkActionOf(m) as MsgAction).href}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={BRAND_FILL_STYLE}
                  className="inline-flex min-h-[44px] items-center justify-center rounded-md px-4 py-2 text-center text-sm font-semibold"
                >
                  {(paymentLinkActionOf(m) as MsgAction).label}
                </a>
                <button
                  type="button"
                  onClick={() => onCopyLink((paymentLinkActionOf(m) as MsgAction).href)}
                  className="min-h-[44px] rounded-md border border-neutral-300 px-4 py-2 text-sm font-semibold text-neutral-700 hover:bg-neutral-50"
                >
                  {copied ? "Link copiado!" : "Copiar link"}
                </button>
              </div>
            ) : null}
            {/* Botão-link externo anexado à bolha (ex.: quitação → #contato). */}
            {m.from === "assistant" && m.action && m.action.type === "external_link" ? (
              <a
                href={m.action.href}
                target="_blank"
                rel="noopener noreferrer"
                style={BRAND_FILL_STYLE}
                className="mt-2 inline-flex min-h-[44px] items-center rounded-md px-4 py-2 text-sm font-semibold"
              >
                {m.action.label}
              </a>
            ) : null}
          </div>
          )
        })}

        {/* --- Máquina de espera (§6.3): indicador acessível + copy narrada + saídas --- */}
        {!ended && waitState === "aguardando_motor" ? (
          <div className="flex flex-col items-start gap-2">
            {/* Copy narrada por degrau (d2/d3 reescrevem a bolha de espera; d0/d1
                não têm texto próprio — o eco A.2 do servidor permanece acima). */}
            {waitStepCopy(waitStep) ? (
              <div className="max-w-[85%] whitespace-pre-line rounded-2xl rounded-bl-sm bg-neutral-100 px-3.5 py-2 text-sm text-neutral-800">
                {waitStepCopy(waitStep)}
              </div>
            ) : null}
            {/* Indicador "digitando" — só de d1 em diante (supressão inicial <1,2s).
                aria-live="polite" + role="status" para o leitor de tela (M18). */}
            {shouldShowTypingIndicator(waitStep) ? (
              <div
                role="status"
                aria-live="polite"
                aria-label="Buscando as condições de pagamento"
                className="inline-flex items-center gap-1.5 rounded-2xl rounded-bl-sm bg-neutral-100 px-3.5 py-2.5"
              >
                <span className="sr-only">Buscando as condições de pagamento…</span>
                <span className="h-2 w-2 animate-bounce rounded-full bg-neutral-400 [animation-delay:-0.3s]" />
                <span className="h-2 w-2 animate-bounce rounded-full bg-neutral-400 [animation-delay:-0.15s]" />
                <span className="h-2 w-2 animate-bounce rounded-full bg-neutral-400" />
              </div>
            ) : null}
            {/* R-03 (C13) — durante a espera (aguardando_motor) há ≥1 caminho de
                ação: "Pagar agora" desde o início. QA round 1 (QAA1-01,
                BLOQUEANTE): este bloco só existe DEPOIS de o servidor responder sem
                parcelas (nunca no instante do clique, nunca sob o ponteiro); as
                saídas nascem INERTES por WAIT_EXITS_ARM_MS (disabled +
                pointer-events:none) e "Falar com atendimento" só aparece a partir
                do degrau d3 (10 s) — um toque duplo nunca transfere ao atendimento.
                As saídas NÃO cancelam a espera: o tick e o poll seguem (a resposta
                tardia do motor ainda resolve). */}
            <div className="flex flex-wrap gap-2 pt-1" data-wait-exits={waitExitsArmed ? "armed" : "arming"}>
              <button
                type="button"
                onClick={onWaitPayNow}
                disabled={!waitExitsArmed}
                aria-disabled={!waitExitsArmed}
                style={BRAND_FILL_STYLE}
                className={"min-h-[44px] rounded-md px-4 text-sm font-semibold" + exitBtnGuard}
              >
                Pagar agora
              </button>
              {shouldShowWaitHandoffExit(waitStep) ? (
                <button
                  type="button"
                  onClick={onWaitHandoff}
                  disabled={!waitExitsArmed}
                  aria-disabled={!waitExitsArmed}
                  className={"min-h-[44px] rounded-md border border-neutral-300 px-4 text-sm font-semibold text-neutral-700 hover:bg-neutral-50" + exitBtnGuard}
                >
                  Falar com atendimento
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* --- Degradação aos 15s (§4 / A.5): menu acionável, nunca "erro". --- */}
        {!ended && waitState === "menu_degradado" ? (
          <div className="flex flex-col items-start gap-2" role="status" aria-live="polite">
            <div className="max-w-[90%] whitespace-pre-line rounded-2xl rounded-bl-sm bg-neutral-100 px-3.5 py-2 text-sm text-neutral-800">
              {DEGRADED_MENU_COPY}
            </div>
            {/* QA round 1 (QAA1-01): saídas inertes até o arming (WAIT_EXITS_ARM_MS). */}
            <div className="flex flex-wrap gap-2 pt-1" data-wait-exits={waitExitsArmed ? "armed" : "arming"}>
              <button
                type="button"
                onClick={onWaitPayNow}
                disabled={!waitExitsArmed}
                aria-disabled={!waitExitsArmed}
                style={BRAND_FILL_STYLE}
                className={"min-h-[44px] rounded-md px-4 text-sm font-semibold" + exitBtnGuard}
              >
                Pagar à vista
              </button>
              <button
                type="button"
                onClick={onWaitRetryOptions}
                disabled={!waitExitsArmed}
                aria-disabled={!waitExitsArmed}
                className={"min-h-[44px] rounded-md border border-neutral-300 px-4 text-sm font-semibold text-neutral-700 hover:bg-neutral-50" + exitBtnGuard}
              >
                Tentar as opções de novo
              </button>
              <button
                type="button"
                onClick={onWaitHandoff}
                disabled={!waitExitsArmed}
                aria-disabled={!waitExitsArmed}
                className={"min-h-[44px] rounded-md border border-neutral-300 px-4 text-sm font-semibold text-neutral-700 hover:bg-neutral-50" + exitBtnGuard}
              >
                Falar com atendimento
              </button>
            </div>
          </div>
        ) : null}

        {/* --- Gerando cobrança (§5.1 / A.4) --- */}
        {!ended && waitState === "gerando_cobranca" && !payResult ? (
          <div role="status" aria-live="polite" className="flex flex-col items-start">
            <div className="max-w-[85%] rounded-2xl rounded-bl-sm bg-neutral-100 px-3.5 py-2 text-sm text-neutral-800">
              {/* A1: copy progressiva — após PAY_LONG_WAIT_MS sem resposta. */}
              {payLongWait
                ? "Ainda estou gerando o seu link de pagamento."
                : "Certo. Estou gerando seu link de pagamento."}
            </div>
          </div>
        ) : null}

        {/* --- Resultado do PAGAR: link (com copiar) / processando / erro ---
            A1: o painel do LINK só renderiza como FALLBACK quando a bolha
            persistida (com ação open_payment_link) ainda não chegou pelo poll —
            a bolha é a fonte única (sem copy duplicada, N-D1-8). */}
        {!ended && payResult && !(payResult.status === "link" && hasPersistedLink) ? (
          <div className="flex flex-col items-start gap-2" role="status" aria-live="polite">
            {payResult.status === "link" ? (
              <>
                <div className="max-w-[90%] whitespace-pre-line rounded-2xl rounded-bl-sm bg-neutral-100 px-3.5 py-2 text-sm text-neutral-800">
                  {/* A4 (S14/S15, N-D5-8): a MESMA função da bolha persistida
                      (lib/journey/pay-poll.ts) — nenhuma copy duplicada. link:null
                      porque o botão "Abrir link de pagamento" abaixo já o carrega. */}
                  {payLinkMessageText({
                    link: null,
                    valor: payResult.valor,
                    vencimentoLink: payResult.vencimento_link,
                    alreadyCharged: payResult.already_charged,
                  })}
                </div>
                {payResult.link ? (
                  <div className="flex w-full max-w-[90%] flex-col gap-2 rounded-lg border border-neutral-200 bg-white p-3">
                    <a
                      href={payResult.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={BRAND_FILL_STYLE}
                      className="inline-flex min-h-[44px] items-center justify-center rounded-md px-4 py-2 text-center text-sm font-semibold"
                    >
                      Abrir link de pagamento
                    </a>
                    <button
                      type="button"
                      onClick={() => onCopyLink(payResult.link as string)}
                      className="min-h-[44px] rounded-md border border-neutral-300 px-4 py-2 text-sm font-semibold text-neutral-700 hover:bg-neutral-50"
                    >
                      {copied ? "Link copiado!" : "Copiar link"}
                    </button>
                  </div>
                ) : null}
                {/* R-05 (C13) — link_entregue NÃO é beco absorvente: além de abrir/
                    copiar, o devedor tem caminhos de RETORNO. Antes, entregue o link,
                    o painel só mostrava Abrir/Copiar — quem quisesse trocar de opção,
                    avisar que já pagou ou falar com humano ficava preso e abandonava.
                    "Voltar às opções" re-emite o menu payável no servidor (reopen);
                    "Já paguei" registra o claim (sem declarar pago); "Falar com
                    atendimento" transfere. NÃO cancela nem recobra: a idempotência é
                    do servidor (nunca 2ª cobrança). */}
                <div className="flex flex-wrap gap-2 pt-1">
                  <button
                    type="button"
                    onClick={onWaitRetryOptions}
                    className="min-h-[44px] rounded-md border border-neutral-300 px-4 text-sm font-semibold text-neutral-700 hover:bg-neutral-50"
                  >
                    Voltar às opções
                  </button>
                  {!claimSent ? (
                    <button
                      type="button"
                      onClick={requestPaymentClaim}
                      className="min-h-[44px] rounded-md border border-neutral-300 px-4 text-sm font-semibold text-neutral-700 hover:bg-neutral-50"
                    >
                      Já paguei este valor
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={onWaitHandoff}
                    className="min-h-[44px] rounded-md border border-neutral-300 px-4 text-sm font-semibold text-neutral-700 hover:bg-neutral-50"
                  >
                    Falar com atendimento
                  </button>
                </div>
              </>
            ) : payResult.status === "processing" ? (
              <>
                <div className="max-w-[90%] whitespace-pre-line rounded-2xl rounded-bl-sm bg-neutral-100 px-3.5 py-2 text-sm text-neutral-800">
                  {/* QA round 2 (QAB1-H1): espera RETOMADA (reload durante o Pagar /
                      recuperação) usa a copy progressiva; a nascida aqui, a do R3. */}
                  {payResult.resumed ? PAY_RESUME_GENERATING_TEXT : PAY_PROCESSING_TEXT}
                </div>
                {/* R3 — inline "digitando" para o processing não parecer travado. */}
                <div
                  className="inline-flex items-center gap-1.5 rounded-2xl rounded-bl-sm bg-neutral-100 px-3.5 py-2.5"
                  aria-hidden="true"
                >
                  <span className="h-2 w-2 animate-bounce rounded-full bg-neutral-400 [animation-delay:-0.3s]" />
                  <span className="h-2 w-2 animate-bounce rounded-full bg-neutral-400 [animation-delay:-0.15s]" />
                  <span className="h-2 w-2 animate-bounce rounded-full bg-neutral-400" />
                </div>
                {/* R3 — passado o teto (~60s) sem link, oferece saída acionável
                    (nunca espera muda infinita). O poll segue vivo em paralelo. */}
                {shouldOfferProcessingExit(payPollAttempts) ? (
                  <div className="flex flex-col items-start gap-2 pt-1">
                    <div className="max-w-[90%] whitespace-pre-line rounded-2xl rounded-bl-sm bg-neutral-100 px-3.5 py-2 text-sm text-neutral-800">
                      {PAY_PROCESSING_SLOW_TEXT}
                    </div>
                    {/* QA round 2 (QAB1-H1): teto do poll → saída humana com DOIS
                        caminhos: voltar às opções (reabre o menu) ou atendimento. */}
                    <div className="flex flex-wrap gap-2" data-wait-exits={waitExitsArmed ? "armed" : "arming"}>
                      <button
                        type="button"
                        onClick={onPayBackToOptions}
                        disabled={!waitExitsArmed}
                        aria-disabled={!waitExitsArmed}
                        className={"min-h-[44px] rounded-md border border-neutral-300 px-4 text-sm font-semibold text-neutral-700 hover:bg-neutral-50" + exitBtnGuard}
                      >
                        Voltar às opções
                      </button>
                      <button
                        type="button"
                        onClick={onWaitHandoff}
                        disabled={!waitExitsArmed}
                        aria-disabled={!waitExitsArmed}
                        className={"min-h-[44px] rounded-md border border-neutral-300 px-4 text-sm font-semibold text-neutral-700 hover:bg-neutral-50" + exitBtnGuard}
                      >
                        Falar com atendimento
                      </button>
                    </div>
                  </div>
                ) : null}
              </>
            ) : (
              <>
                <div className="max-w-[90%] whitespace-pre-line rounded-2xl rounded-bl-sm bg-neutral-100 px-3.5 py-2 text-sm text-neutral-800">
                  {/* T11 / R-32: tranquilização de duplicidade ("Nenhuma cobrança
                      foi criada.") ANTES das ações; frases curtas, sem código/erro
                      técnico exposto. */}
                  {payResult.confirmedNotCreated
                    ? "Não consegui gerar o link agora. Nenhuma cobrança foi criada."
                    : "Não consegui gerar o link agora."}
                </div>
                {/* R-06 (C13) — erro_cobranca NÃO prende o devedor entre "tentar de
                    novo" (que pode falhar de novo) e um atendimento: além de Tentar
                    novamente e Atendimento, "Voltar às opções" reabre o menu payável
                    completo (Pagar/Negociar/Consultar/Não reconheço) por 1 clique. A
                    copy "nenhuma cobrança foi criada" (acima) tranquiliza sobre
                    duplicidade; onWaitRetryOptions limpa o painel de erro via reopen. */}
                {/* QA round 1 (QAA1-01): saídas inertes até o arming (WAIT_EXITS_ARM_MS). */}
                <div className="flex flex-wrap gap-2 pt-1" data-wait-exits={waitExitsArmed ? "armed" : "arming"}>
                  <button
                    type="button"
                    onClick={onPayRetry}
                    disabled={!waitExitsArmed}
                    aria-disabled={!waitExitsArmed}
                    style={BRAND_FILL_STYLE}
                    className={"min-h-[44px] rounded-md px-4 text-sm font-semibold" + exitBtnGuard}
                  >
                    Tentar de novo
                  </button>
                  <button
                    type="button"
                    onClick={onPayBackToOptions}
                    disabled={!waitExitsArmed}
                    aria-disabled={!waitExitsArmed}
                    className={"min-h-[44px] rounded-md border border-neutral-300 px-4 text-sm font-semibold text-neutral-700 hover:bg-neutral-50" + exitBtnGuard}
                  >
                    Voltar às opções
                  </button>
                  <button
                    type="button"
                    onClick={onWaitHandoff}
                    disabled={!waitExitsArmed}
                    aria-disabled={!waitExitsArmed}
                    className={"min-h-[44px] rounded-md border border-neutral-300 px-4 text-sm font-semibold text-neutral-700 hover:bg-neutral-50" + exitBtnGuard}
                  >
                    Falar com atendimento
                  </button>
                </div>
              </>
            )}
          </div>
        ) : null}

      </div>

      {/* QA round 2 (QAB1-H2) — aviso de processamento FORA do bloco de botões:
          o clique tardio consumiu o menu e o vencedor ainda processa; o poll
          traz o próximo prompt/outcome e o aviso some. Nunca uma tela muda. */}
      {processingNotice && !ended ? (
        <p className="px-1 text-sm text-neutral-600" role="status" aria-live="polite">
          {processingNotice}
        </p>
      ) : null}

      {activePrompt && !ended ? (
        // R8 — aria-live=off: os BOTÕES não entram no anúncio do log (evita
        // re-anúncio das labels em loop; A-07). group + aria-label dão contexto
        // ao leitor de tela; a navegação por teclado alcança os botões na ordem.
        // A3 (G7): o menu fica FORA do log, logo após card / saudação de retorno /
        // outcome — visível sem rolar; ref para o scrollIntoView pós-login.
        <div ref={menuRef} className="pt-1" aria-live="off" role="group" aria-label="Opções de negociação">
          {/* A1 — aviso humano do 409 (prompt substituído): fica no pai para
              sobreviver à remontagem do bloco de botões. */}
          {promptNotice ? (
            <p className="mb-2 text-xs text-neutral-600" role="status" aria-live="polite">
              {promptNotice}
            </p>
          ) : null}
          {/* key por id do prompt: ao trocar de prompt (ex.: Consultar reabre o
              menu pós-consulta) o componente REMONTA, zerando o estado local
              'answered'/'pending' — sem isso o novo menu nasceria desabilitado.
              A3: promptForRender = o prompt ativo sem a pergunta quando a saudação
              de retorno já a faz (uma só pergunta na tela). */}
          <PromptButtons key={activePrompt.id} prompt={promptForRender ?? activePrompt} onClick={clickButton} />
          {/* R5 — afordância "Já paguei": secundária/discreta, disponível no menu de
              3 opções (payável). Registra o payment_claim (conferência da equipe),
              sem declarar pago; o servidor reabre o menu em seguida. Some após o
              clique (claimSent) para não empilhar.
              R-36 — COERÊNCIA em nao_reconhecida: o prompt de VOLTA do "Não
              reconheço" também é kind 'debt_three_options', mas traz só o botão
              [98] (sem PAGAR). Oferecer "Já paguei" a quem acabou de dizer que NÃO
              reconhece o débito é incoerente (C13/C14). Por isso só mostramos a
              afordância quando o menu é o MENU PAYÁVEL de fato — tem o botão PAGAR
              (id 4) —, não o menu-volta de contestação. */}
          {((activePrompt.kind === "debt_three_options" && activePrompt.buttons.some((b) => b.id === 4)) ||
            activePrompt.kind === "post_payment_link") &&
          !claimSent ? (
            <button
              type="button"
              onClick={requestPaymentClaim}
              className="mt-1 inline-flex min-h-[44px] items-center px-1 text-sm font-medium text-neutral-600 underline underline-offset-2 hover:text-neutral-800"
            >
              Já paguei este valor
            </button>
          ) : null}
        </div>
      ) : null}

      {/* A3 (§2.2 / R-41) — "Ver conversa completa": discreto, abaixo do menu, e
          SEMPRE que houver algo recolhido (retomada e/ou teto de 20) — não só
          acima de 20. Expandido → "Recolher conversa"; enquanto expandido, as
          gerações anteriores voltam a renderizar (regra de geração desligada). */}
      {hiddenCount > 0 || historyExpanded ? (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => setHistoryExpanded((v) => !v)}
            aria-expanded={historyExpanded}
            className="inline-flex min-h-[44px] items-center rounded-md px-3 text-sm font-medium text-neutral-600 underline underline-offset-2 hover:text-neutral-800"
          >
            {historyExpanded ? "Recolher conversa" : "Ver conversa completa"}
          </button>
        </div>
      ) : null}

      {idleModal ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-sm rounded-xl bg-white p-6 text-center shadow-xl">
            {idleModal === "idle" ? (
              <>
                <p className="text-base font-semibold text-neutral-800">Você ainda está aí?</p>
                <p className="mt-2 text-sm text-neutral-600">
                  Sua conversa continua salva. Toque em <strong>Continuar</strong> para retomar de onde parou,
                  ou em <strong>Sair</strong> para encerrar.
                </p>
                <button
                  type="button"
                  onClick={resumeFromIdle}
                  style={BRAND_FILL_STYLE}
                  className="mt-5 min-h-[44px] w-full rounded-md px-4 py-2.5 text-sm font-semibold"
                >
                  Continuar
                </button>
                <button
                  type="button"
                  onClick={goToChatLogin}
                  className="mt-2 min-h-[44px] w-full rounded-md border border-neutral-300 px-4 py-2.5 text-sm font-semibold text-neutral-600 hover:bg-neutral-50"
                >
                  Sair
                </button>
              </>
            ) : (
              <>
                <p className="text-base font-semibold text-neutral-800">Sessão encerrada</p>
                <p className="mt-2 text-sm text-neutral-600">
                  Por segurança, entre novamente com seu CPF/CNPJ para continuar a negociação.
                </p>
                <button
                  type="button"
                  onClick={goToChatLogin}
                  style={BRAND_FILL_STYLE}
                  className="mt-5 min-h-[44px] w-full rounded-md px-4 py-2.5 text-sm font-semibold"
                >
                  Entrar novamente
                </button>
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}
