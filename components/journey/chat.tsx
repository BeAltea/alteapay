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
  dedupAssistantByContent,
  isNegotiateLabel,
  NEGOTIATION_PENDING_TEXT,
  prunePresentation,
  type ChatMsg,
  type MsgAction,
} from "./chat-display"
import { DebtCard, type PinnedDebtData } from "./debt-card"
import {
  DEGRADED_MENU_COPY,
  deriveWaitStep,
  elapsedSince,
  hydrateWaitState,
  resolveWaitView,
  shouldRenderEngineMsg,
  shouldShowTypingIndicator,
  waitStepCopy,
  type WaitState,
  type WaitStep,
} from "@/lib/journey/wait-machine"
import { interpretPaymentPoll, payLinkMessageText, shouldOfferProcessingExit } from "@/lib/journey/pay-poll"

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
  return { type: a.type, label, href }
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
  const [activePrompt, setActivePrompt] = useState<ActivePrompt | null>(null)
  // D2 — CARD FIXO (C1) e RECAP de retomada (C7): montados no servidor e entregues
  // no poll. O card vem a cada poll (imutável entre polls, sobrevive a reload); o
  // recap vem só no 1º poll (retomada). "Ver conversa completa" (R-41) expande o
  // histórico recolhido pela poda/teto.
  const [pinnedDebt, setPinnedDebt] = useState<PinnedDebtData | null>(null)
  const [recap, setRecap] = useState<{ text: string } | null>(null)
  const [historyExpanded, setHistoryExpanded] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const sinceRef = useRef<string | null>(null)
  const seenIds = useRef<Set<string>>(new Set())
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
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
  async function pollMessages() {
    if (modalRef.current) return // pausado enquanto o modal (inatividade/expiração) está aberto
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
      }> = Array.isArray(data?.messages) ? data.messages : []
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
        // Se havia uma bolha "preparando negociação" local e chegou a 1ª
        // mensagem real do assistente (resposta do n8n), removemos a optimistic
        // ao inserir a real — troca sem piscar duplicado.
        const optimisticId = pendingNegotiationRef.current
        const dropOptimistic = isAssistant && optimisticId !== null
        if (dropOptimistic) pendingNegotiationRef.current = null
        // A resposta do motor RESOLVE a espera (aguardando_motor OU menu_degradado
        // → negociando): remove a bolha de espera, encerra o tick, some o
        // indicador. Se estava degradado, a tardia ainda renderiza (menu_degradado
        // NÃO é absorvente) — só some o menu de degradação.
        if (isEngineMsg && (waitStateRef.current === "aguardando_motor" || waitStateRef.current === "menu_degradado")) {
          resolveWaitToNegotiating()
        }
        const action = safeMessageAction(m.action)
        // A1 (G1): a bolha do LINK persistida pelo servidor chegou pelo poll — é o
        // resultado do PAGAR (outcome), fonte única do painel. Se ainda estávamos
        // em "gerando" (POST em voo/abortado) ou em 'processing', o link resolve
        // a espera aqui mesmo: link_entregue (absorvente, M12), sem painel
        // duplicado (o client só renderiza o painel próprio quando NÃO há bolha).
        if (isAssistant && action?.type === "open_payment_link") {
          const local = waitStateRef.current
          if (local === "gerando_cobranca" || payResultRef.current?.status === "processing") {
            stopTick()
            waitStartedAtRef.current = null
            setPayResult({ status: "link", link: action.href, valor: null, vencimento_link: null, already_charged: false })
            setWaitState("link_entregue")
          }
        }
        setMessages((prev) => {
          const base = dropOptimistic ? prev.filter((x) => x.id !== optimisticId) : prev
          return [
            ...base,
            {
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
            },
          ]
        })
      }
      // Nunca sobrescreve o prompt depois de encerrado (preserva o histórico).
      if (!endedRef.current) setActivePrompt(data?.active_prompt ?? null)
    } catch {
      /* silencioso */
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
      pollMessages()
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
        el.focus({ preventScroll: false })
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
    }
    // OPTIMISTIC: ao Negociar, injeta já uma bolha "preparando sua negociação"
    // (antes do await). Feedback imediato de que o sistema está trabalhando
    // enquanto o backend dispara negotiation.start ao n8n e aguardamos a 1ª
    // resposta (chat.send) chegar via poll. NÃO persiste: é local e some quando a
    // resposta real aparece (ou em erro).
    // CLICK_NEGOCIAR → aguardando_motor: arma a máquina de espera (âncora local
    // enquanto o poll não traz o wait_started_at do servidor). O tick deriva os
    // degraus 1,2/4/10/15s. Só arma se ainda estava idle (2º clique é no-op — o
    // dedup por event_id no negotiation.start evita 2º start).
    if (isNegotiate) {
      if (waitStateRef.current === "idle" || waitStateRef.current === "menu_degradado") {
        waitStartedAtRef.current = new Date().toISOString()
        setWaitState("aguardando_motor")
        setWaitStep("d0_suppressed")
        startTick()
      }
      const optimisticId = `optimistic-neg-${Date.now()}`
      pendingNegotiationRef.current = optimisticId
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
      // PAGAR — o button/route.ts (D1) devolve o shape do payService (D3) NO
      // corpo do clique (com HTTP 200 mesmo em erro de negócio). Renderizamos o
      // resultado (link/processando/erro) aqui, sem depender do poll. O guard de
      // cobrança e a idempotência são do servidor; o client só exibe a copy §5.
      if (isPay && data && data.action === "pay") {
        applyPayResult(data)
        // O menu de 3 opções já foi respondido; o poll traz a bolha do link
        // (outcome) e o prompt pós-link persistidos pelo servidor (A1). O botão
        // sai do "..." (ok) — o painel deriva da mensagem persistida.
        setActivePrompt(null)
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
            clearPendingNegotiation()
            resetWaitToIdle()
          }
          // senão: mantém aguardando_motor; o poll trará wait_started_at do servidor.
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
        setPromptNotice(PROMPT_STALE_NOTICE)
        if (data?.active_prompt && typeof data.active_prompt === "object" && !endedRef.current) {
          setActivePrompt(data.active_prompt as ActivePrompt)
        }
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
      setPayResult({ status: "processing", link: null, valor: null, vencimento_link: null, already_charged: false })
      setWaitState("gerando_cobranca")
    }
    setActivePrompt(null)
    await pollMessages()
  }

  // Traduz o shape do payService (D3) em PayResult para render (§5.2/§5.3/§5.4).
  // NUNCA declara pago (M15): 'processing' (worker off) e 'link' apenas entregam o
  // link; a quitação é do webhook. Erro de negócio (ok:false) → menu acionável.
  function applyPayResult(data: Record<string, unknown>) {
    stopTick()
    waitStartedAtRef.current = null
    if (data.ok === true) {
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
  async function onWaitPayNow() {
    const pid = payActiveButtonId()
    if (activePrompt && pid != null) {
      await clickButton(activePrompt.id, pid, "Pagar")
      return
    }
    // Sem botão PAGAR ativo (menu consumido): re-emite o menu payável (M10) — não
    // apenas poll (que não repõe prompt respondido). O devedor reabre e paga.
    await reopenOptions()
  }
  // "Tentar as opções de novo" (A.5): re-emite o menu de 3 opções no servidor.
  async function onWaitRetryOptions() {
    await reopenOptions()
  }
  // "Falar com atendimento": reusa o botão de handoff (99) do prompt ativo se
  // houver; senão transfere direto ao atendimento no servidor (nunca beco sem
  // saída). Sem termos técnicos ao devedor.
  async function onWaitHandoff() {
    const h = activePrompt?.buttons?.find((x) => x.id === 99)
    if (activePrompt && h) {
      await clickButton(activePrompt.id, 99, h.label)
      return
    }
    await requestHandoffNoPrompt()
  }
  // "Tentar novamente" (§5.4, erro de cobrança): reusa o PAGAR ativo, senão repõe
  // o menu. Limpa o painel de erro antes.
  async function onPayRetry() {
    setPayResult(null)
    await onWaitPayNow()
  }
  // R-06 — "Voltar às opções" no erro de cobrança: limpa o painel de erro e reabre
  // o menu payável completo (Pagar/Negociar/Consultar/Não reconheço). Dá saída às
  // demais decisões básicas por 1 clique — não prende o devedor no par tentar/
  // atendimento. reopenOptions() re-emite o menu no servidor (nunca beco sem saída).
  async function onPayBackToOptions() {
    setPayResult(null)
    await reopenOptions()
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

  // D2 — PIPELINE DE APRESENTAÇÃO (§10.1), na ordem:
  //  1) filtra a bolha do prompt ATIVO (sua pergunta aparece no bloco de botões);
  //  2) PODA por classe (prunePresentation): system fora (R-16), superseded colapsa
  //     (menus antigos não empilham, R-13);
  //  3) dedup por conteúdo (só a última guidance idêntica);
  //  4) TETO de 20 (capHistory): guidance velho recolhe atrás de "ver conversa
  //     completa"; decision/outcome NUNCA recolhem (C8/R-15/R-41).
  const activePromptId = activePrompt && !ended ? activePrompt.id : null
  const visibleMessages = messages.filter(
    (m) => !(activePrompt && !ended && m.promptId && m.promptId === activePrompt.id),
  )
  const prunedMessages = prunePresentation(visibleMessages, activePromptId, waitState)
  const dedupedMessages = dedupAssistantByContent(prunedMessages)
  const capped = capHistory(dedupedMessages, activePromptId, waitState, { expanded: historyExpanded })
  // A1: há bolha persistida do link (ação open_payment_link) para o link corrente?
  const hasPersistedLink = messages.some(
    (m) =>
      m.from === "assistant" &&
      m.action?.type === "open_payment_link" &&
      (!payResult?.link || m.action.href === payResult.link),
  )
  // A1: só a ÚLTIMA bolha de link ganha o painel (Abrir/Copiar). Bolhas de links
  // anteriores (ex.: cobrança cancelada e recriada) ficam só como texto, sem
  // botão para um link que pode estar morto — o link vivo é sempre o mais recente.
  let latestPaymentLinkId: string | null = null
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.from === "assistant" && m.action?.type === "open_payment_link") {
      latestPaymentLinkId = m.id
      break
    }
  }

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
      {/* D2 — RECAP de retomada (C7/R-17): ACIMA do log, no lugar da repetição
          integral. Só aparece na retomada (recap != null vindo do 1º poll). */}
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
          re-anunciados em loop — a live region envolve só a copy. */}
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
        className="flex-1 space-y-3 overflow-y-auto rounded-lg bg-white p-3 shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-secondary)]/40"
        style={{ minHeight: 320 }}
      >
        {/* R-41 — "ver conversa completa": quando o teto (20) recolheu guidance
            velho, o controle expande o histórico. decision/outcome NUNCA são
            recolhidos (C8), então nunca ficam atrás deste botão. */}
        {capped.hasMore ? (
          <div className="flex justify-center">
            <button
              type="button"
              onClick={() => setHistoryExpanded(true)}
              className="inline-flex min-h-[44px] items-center rounded-md px-3 text-sm font-medium text-neutral-600 underline underline-offset-2 hover:text-neutral-800"
            >
              Ver conversa completa
            </button>
          </div>
        ) : null}
        {capped.visible.map((m) => (
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
                m.from === "assistant" && m.action?.type === "open_payment_link"
                  ? textWithoutUrl(m.text, m.action.href)
                  : m.text,
              )}
            </div>
            {/* A1 (N-D1-3/N-D1-8) — LINK DE PAGAMENTO: o painel deriva da bolha
                PERSISTIDA (fonte única, sobrevive ao reload): "Abrir link de
                pagamento" + "Copiar link". As ações seguintes (Voltar às opções /
                Falar com atendimento) vêm do prompt pós-link do servidor; "Já
                paguei" é a afordância sob esse prompt. */}
            {m.from === "assistant" && m.action?.type === "open_payment_link" && m.id === latestPaymentLinkId ? (
              <div className="mt-2 flex w-full max-w-[90%] flex-col gap-2 rounded-lg border border-neutral-200 bg-white p-3">
                <a
                  href={m.action.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={BRAND_FILL_STYLE}
                  className="inline-flex min-h-[44px] items-center justify-center rounded-md px-4 py-2 text-center text-sm font-semibold"
                >
                  {m.action.label}
                </a>
                <button
                  type="button"
                  onClick={() => onCopyLink((m.action as MsgAction).href)}
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
        ))}

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
            {/* R-03 (C13) — NUNCA um beco de 0-10s: durante TODA a espera
                (aguardando_motor, d0..d3) há ≥1 caminho de ação clicável, não só o
                indicador. Antes, os atalhos só apareciam aos 10s (d3) e entre 0-10s
                o menu de 3 opções tinha sumido (answered) → tela sem NENHUM botão de
                ação no ponto de maior intenção. Agora "Pagar agora" e "Falar com
                atendimento" ficam disponíveis desde o início da espera. As saídas
                NÃO cancelam a espera: o tick e o poll seguem (a resposta tardia do
                motor ainda resolve). Aos 10s (d3) a copy narrada acima muda para
                "está demorando", mas os botões já estavam lá. */}
            <div className="flex flex-wrap gap-2 pt-1">
              <button
                type="button"
                onClick={onWaitPayNow}
                style={BRAND_FILL_STYLE}
                className="min-h-[44px] rounded-md px-4 text-sm font-semibold"
              >
                Pagar agora
              </button>
              <button
                type="button"
                onClick={onWaitHandoff}
                className="min-h-[44px] rounded-md border border-neutral-300 px-4 text-sm font-semibold text-neutral-700 hover:bg-neutral-50"
              >
                Falar com atendimento
              </button>
            </div>
          </div>
        ) : null}

        {/* --- Degradação aos 15s (§4 / A.5): menu acionável, nunca "erro". --- */}
        {!ended && waitState === "menu_degradado" ? (
          <div className="flex flex-col items-start gap-2" role="status" aria-live="polite">
            <div className="max-w-[90%] whitespace-pre-line rounded-2xl rounded-bl-sm bg-neutral-100 px-3.5 py-2 text-sm text-neutral-800">
              {DEGRADED_MENU_COPY}
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              <button
                type="button"
                onClick={onWaitPayNow}
                style={BRAND_FILL_STYLE}
                className="min-h-[44px] rounded-md px-4 text-sm font-semibold"
              >
                Pagar à vista
              </button>
              <button
                type="button"
                onClick={onWaitRetryOptions}
                className="min-h-[44px] rounded-md border border-neutral-300 px-4 text-sm font-semibold text-neutral-700 hover:bg-neutral-50"
              >
                Tentar as opções de novo
              </button>
              <button
                type="button"
                onClick={onWaitHandoff}
                className="min-h-[44px] rounded-md border border-neutral-300 px-4 text-sm font-semibold text-neutral-700 hover:bg-neutral-50"
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
                  Estou gerando seu link de pagamento. Assim que estiver pronto, ele aparece aqui.
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
                      Está demorando um pouco mais que o normal para gerar o link. Você pode continuar aguardando ou falar com o nosso atendimento.
                    </div>
                    <button
                      type="button"
                      onClick={onWaitHandoff}
                      className="min-h-[44px] rounded-md border border-neutral-300 px-4 text-sm font-semibold text-neutral-700 hover:bg-neutral-50"
                    >
                      Falar com atendimento
                    </button>
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
                <div className="flex flex-wrap gap-2 pt-1">
                  <button
                    type="button"
                    onClick={onPayRetry}
                    style={BRAND_FILL_STYLE}
                    className="min-h-[44px] rounded-md px-4 text-sm font-semibold"
                  >
                    Tentar de novo
                  </button>
                  <button
                    type="button"
                    onClick={onPayBackToOptions}
                    className="min-h-[44px] rounded-md border border-neutral-300 px-4 text-sm font-semibold text-neutral-700 hover:bg-neutral-50"
                  >
                    Voltar às opções
                  </button>
                  <button
                    type="button"
                    onClick={onWaitHandoff}
                    className="min-h-[44px] rounded-md border border-neutral-300 px-4 text-sm font-semibold text-neutral-700 hover:bg-neutral-50"
                  >
                    Falar com atendimento
                  </button>
                </div>
              </>
            )}
          </div>
        ) : null}

        {activePrompt && !ended ? (
          // R8 — aria-live=off: os BOTÕES não entram no anúncio do log (evita
          // re-anúncio das labels em loop; A-07). group + aria-label dão contexto
          // ao leitor de tela; a navegação por teclado alcança os botões na ordem.
          <div className="pt-1" aria-live="off" role="group" aria-label="Opções de negociação">
            {/* A1 — aviso humano do 409 (prompt substituído): fica no pai para
                sobreviver à remontagem do bloco de botões. */}
            {promptNotice ? (
              <p className="mb-2 text-xs text-neutral-600" role="status" aria-live="polite">
                {promptNotice}
              </p>
            ) : null}
            {/* key por id do prompt: ao trocar de prompt (ex.: Consultar reabre o
                menu pós-consulta) o componente REMONTA, zerando o estado local
                'answered'/'pending' — sem isso o novo menu nasceria desabilitado. */}
            <PromptButtons key={activePrompt.id} prompt={activePrompt} onClick={clickButton} />
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
      </div>

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
