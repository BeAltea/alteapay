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
import { PromptButtons, type ActivePrompt, type PromptClickResult } from "./prompt-buttons"
import {
  dedupAssistantByContent,
  isNegotiateLabel,
  NEGOTIATION_PENDING_TEXT,
  type ChatMsg,
  type MsgAction,
} from "./chat-display"

// ChatMsg / MsgAction e os helpers puros de exibição (dedup por conteúdo, rótulo
// Negociar, texto do indicador) vivem em ./chat-display para serem testados no
// ambiente node do vitest. Ver comentário lá.
//
// prompt_id da bolha (quando é a mensagem do prompt): enquanto o prompt está
// 'active' a pergunta aparece no bloco de botões — a bolha persistida é omitida
// no render p/ não duplicar; respondido o prompt (sem active_prompt) a bolha
// reaparece e mantém o resumo no histórico.

/** Só aceitamos links externos http(s) — nunca javascript:/relativos suspeitos. */
function safeExternalAction(raw: unknown): MsgAction | null {
  if (!raw || typeof raw !== "object") return null
  const a = raw as Record<string, unknown>
  if (a.type !== "external_link") return null
  const label = typeof a.label === "string" ? a.label : ""
  const href = typeof a.href === "string" ? a.href : ""
  if (!label || !/^https?:\/\//i.test(href)) return null
  return { type: "external_link", label, href }
}

/** Render simples de **negrito** (o n8n envia markdown). Preserva quebras de linha
 *  via whitespace-pre-line na bolha. Não injeta HTML. */
function renderRichText(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.length > 4 && part.startsWith("**") && part.endsWith("**") ? (
      <strong key={i}>{part.slice(2, -2)}</strong>
    ) : (
      <span key={i}>{part}</span>
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
  const scrollRef = useRef<HTMLDivElement>(null)
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
      const pushed: Array<{
        id: string
        role: string
        text: string
        created_at: string
        button_id: number | null
        prompt_id?: string | null
        action?: unknown
      }> = Array.isArray(data?.messages) ? data.messages : []
      for (const m of pushed) {
        if (seenIds.current.has(m.id)) continue
        seenIds.current.add(m.id)
        sinceRef.current = m.created_at
        const isAssistant = m.role !== "customer"
        // Se havia uma bolha "preparando negociação" local e chegou a 1ª
        // mensagem real do assistente (resposta do n8n), removemos a optimistic
        // ao inserir a real — troca sem piscar duplicado.
        const optimisticId = pendingNegotiationRef.current
        const dropOptimistic = isAssistant && optimisticId !== null
        if (dropOptimistic) pendingNegotiationRef.current = null
        setMessages((prev) => {
          const base = dropOptimistic ? prev.filter((x) => x.id !== optimisticId) : prev
          return [
            ...base,
            {
              id: m.id,
              from: isAssistant ? "assistant" : "customer",
              text: m.text,
              action: safeExternalAction(m.action),
              promptId: m.prompt_id ?? null,
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
    return () => stopPoll()
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
    // OPTIMISTIC: ao Negociar, injeta já uma bolha "preparando sua negociação"
    // (antes do await). Feedback imediato de que o sistema está trabalhando
    // enquanto o backend dispara negotiation.start ao n8n e aguardamos a 1ª
    // resposta (chat.send) chegar via poll. NÃO persiste: é local e some quando a
    // resposta real aparece (ou em erro).
    if (isNegotiate) {
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
    // 8s: cobre folgadamente o caminho feliz (build+persist ~1-2s) e ainda dá
    // margem se o kickoff ainda estiver awaitado (5s) num runtime não-corrigido —
    // nesse caso, com Negociar, o optimistic acima já mostrou "preparando", então
    // um abort não deixa a tela muda. Para Consultar (que não chama n8n) é folga
    // enorme. Acima disso o cliente desiste em vez de prender o botão por 15s.
    const timeoutId = setTimeout(() => controller.abort(), 8_000)
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
        stopPoll()
        modalRef.current = "expired"
        setIdleModalState("expired")
        return { ok: false, code: "unauthorized" }
      }
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
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
      // 409 prompt_not_active: recarrega o prompt ativo atual (o PromptButtons será
      // remontado via key={activePrompt.id} e não mostra aviso neste caso).
      if (res.status === 409 && data?.code === "prompt_not_active") {
        clearPendingNegotiation()
        await pollMessages()
        return { ok: false, code: "prompt_not_active" }
      }
      // Demais erros (404/409/422/5xx): devolve o code p/ o PromptButtons avisar
      // o cliente e reabilitar os botões (o loading para no finally do filho).
      clearPendingNegotiation()
      return { ok: false, code: typeof data?.code === "string" ? data.code : "error" }
    } catch (err) {
      // AbortError = estouramos o nosso timeout (servidor lento) → code "timeout"
      // para o PromptButtons mostrar "conexão lenta, toque de novo". Demais erros
      // de rede caem em code genérico. Em ambos, o botão SAI do "..." e a bolha
      // optimistic é removida (o clique não avançou).
      clearPendingNegotiation()
      if (err instanceof DOMException && err.name === "AbortError") {
        return { ok: false, code: "timeout" }
      }
      return { ok: false, code: "network" }
    } finally {
      clearTimeout(timeoutId)
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
          className="rounded-md px-3 py-1.5 text-xs font-medium text-neutral-500 hover:text-neutral-800 hover:bg-neutral-100"
        >
          Sair
        </button>
      </div>
      <div
        ref={scrollRef}
        className="flex-1 space-y-3 overflow-y-auto rounded-lg bg-white p-3 shadow-sm"
        style={{ minHeight: 320 }}
      >
        {dedupAssistantByContent(
          // 1º filtra a bolha do prompt ATIVO (sua pergunta já aparece no bloco de
          // botões abaixo — omitida aqui para não duplicar; respondido o prompt,
          // sem active_prompt, ela reaparece). 2º deduplica por conteúdo, mantendo
          // a ÚLTIMA ocorrência de cada texto assistant idêntico ("Aqui estão os
          // dados...", saudação re-bootstrapada) → "só a última resposta".
          messages.filter(
            (m) => !(activePrompt && !ended && m.promptId && m.promptId === activePrompt.id),
          ),
        ).map((m) => (
          <div
            key={m.id}
            className={m.from === "customer" ? "flex justify-end" : "flex flex-col items-start"}
          >
            <div
              style={
                m.from === "customer"
                  ? { backgroundColor: "var(--brand-secondary)" }
                  : undefined
              }
              className={
                m.from === "customer"
                  ? "max-w-[85%] whitespace-pre-line rounded-2xl rounded-br-sm px-3.5 py-2 text-sm text-white"
                  : "max-w-[85%] whitespace-pre-line rounded-2xl rounded-bl-sm bg-neutral-100 px-3.5 py-2 text-sm text-neutral-800"
              }
            >
              {renderRichText(m.text)}
            </div>
            {/* Botão-link externo anexado à bolha (ex.: quitação → #contato). */}
            {m.from === "assistant" && m.action ? (
              <a
                href={m.action.href}
                target="_blank"
                rel="noopener noreferrer"
                style={{ backgroundColor: "var(--brand-secondary)" }}
                className="mt-2 inline-block rounded-md px-4 py-2 text-sm font-semibold text-white"
              >
                {m.action.label}
              </a>
            ) : null}
          </div>
        ))}

        {activePrompt && !ended ? (
          <div className="pt-1">
            {/* key por id do prompt: ao trocar de prompt (ex.: Consultar reabre o
                menu pós-consulta) o componente REMONTA, zerando o estado local
                'answered'/'pending' — sem isso o novo menu nasceria desabilitado. */}
            <PromptButtons key={activePrompt.id} prompt={activePrompt} onClick={clickButton} />
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
                  Sua conversa continua salva. Toque em <strong>Continuar</strong> para retomar de onde parou.
                </p>
                <button
                  type="button"
                  onClick={resumeFromIdle}
                  style={{ backgroundColor: "var(--brand-secondary)" }}
                  className="mt-5 w-full rounded-md px-4 py-2.5 text-sm font-semibold text-white"
                >
                  Continuar
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
                  style={{ backgroundColor: "var(--brand-secondary)" }}
                  className="mt-5 w-full rounded-md px-4 py-2.5 text-sm font-semibold text-white"
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
