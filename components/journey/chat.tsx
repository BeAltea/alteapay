"use client"

// Chat da jornada (pré-negociação): reconhecimento da dívida em UMA mensagem
// (saudação + resumo + pergunta Sim/Não). Sem ofertas/desconto e sem chat livre
// por ora — o fluxo é ver a dívida → reconhecer (Sim/Não) → mensagem final.
// - HISTÓRICO SEMPRE PRESERVADO: ao responder, a pergunta e a resposta escolhida
//   viram mensagens fixas (não somem da tela).
// - Timer de inatividade: 5min sem interação → volta para a tela de login do CHAT
//   (/n/{code}), NÃO o login da AlteaPay.
import { useCallback, useEffect, useRef, useState } from "react"
import { PromptButtons, type ActivePrompt, type PromptClickResult } from "./prompt-buttons"

interface MsgAction {
  type: string
  label: string
  href: string
}

interface ChatMsg {
  id: string
  from: "customer" | "assistant"
  text: string
  action?: MsgAction | null
}

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

let msgSeq = 0
const nextId = () => `m${Date.now()}_${msgSeq++}`

const IDLE_MS = 5 * 60_000 // 5 minutos sem interação

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
        action?: unknown
      }> = Array.isArray(data?.messages) ? data.messages : []
      for (const m of pushed) {
        if (seenIds.current.has(m.id)) continue
        seenIds.current.add(m.id)
        sinceRef.current = m.created_at
        setMessages((prev) => [
          ...prev,
          {
            id: m.id,
            from: m.role === "customer" ? "customer" : "assistant",
            text: m.text,
            action: safeExternalAction(m.action),
          },
        ])
      }
      // Nunca sobrescreve o prompt depois de encerrado (preserva o histórico).
      if (!endedRef.current) setActivePrompt(data?.active_prompt ?? null)
    } catch {
      /* silencioso */
    }
  }

  useEffect(() => {
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

  // "Continuar" do modal de inatividade: fecha o modal, re-arma o timer e retoma
  // o polling exatamente de onde parou (nada é perdido).
  function resumeFromIdle() {
    modalRef.current = null
    setIdleModalState(null)
    resetIdle()
    void pollMessages()
  }

  // Clique no reconhecimento (Sim/Não). PRESERVA o histórico: a pergunta e a
  // resposta escolhida viram mensagens fixas; o `reply` do backend (texto fixo
  // local) também. Depois, conversa encerrada — sem chat livre nem ofertas.
  async function clickButton(promptId: string, buttonId: number): Promise<PromptClickResult> {
    resetIdle()
    const current = activePrompt
    try {
      const res = await fetch("/api/chat/button", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt_id: promptId, button_id: buttonId }),
      })
      // Sessão do chat expirada/ausente → MODAL de reautenticação (não redireciona
      // sozinho). Com TTL de 30 dias isto praticamente não ocorre.
      if (res.status === 401) {
        stopPoll()
        modalRef.current = "expired"
        setIdleModalState("expired")
        return { ok: false, code: "unauthorized" }
      }
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        const chosen = current?.buttons.find((b) => b.id === buttonId)?.label ?? ""
        setMessages((m) => {
          const add: ChatMsg[] = []
          // 1) a pergunta (com o resumo da dívida) fica PERMANENTE no histórico
          if (current?.question) add.push({ id: nextId(), from: "assistant", text: current.question })
          // 2) a resposta escolhida pelo cliente
          if (chosen) add.push({ id: nextId(), from: "customer", text: chosen })
          // 3) o retorno do assistente
          if (typeof data?.reply === "string" && data.reply.trim())
            add.push({ id: nextId(), from: "assistant", text: data.reply })
          return [...m, ...add]
        })
        endedRef.current = true
        setActivePrompt(null)
        setEnded(true)
        stopPoll() // encerrado: não busca mais (evita duplicar a resposta do servidor)
        return { ok: true }
      }
      // 409 prompt_not_active: recarrega o prompt ativo atual.
      if (res.status === 409 && data?.code === "prompt_not_active") {
        await pollMessages()
      }
      return { ok: false, code: data?.code }
    } catch {
      return { ok: false }
    }
  }

  return (
    <div className="flex flex-1 flex-col gap-3">
      <div
        ref={scrollRef}
        className="flex-1 space-y-3 overflow-y-auto rounded-lg bg-white p-3 shadow-sm"
        style={{ minHeight: 320 }}
      >
        {messages.map((m) => (
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
                  ? "max-w-[85%] rounded-2xl rounded-br-sm px-3.5 py-2 text-sm text-white"
                  : "max-w-[85%] rounded-2xl rounded-bl-sm bg-neutral-100 px-3.5 py-2 text-sm text-neutral-800"
              }
            >
              {m.text}
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
            <PromptButtons prompt={activePrompt} onClick={clickButton} />
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
