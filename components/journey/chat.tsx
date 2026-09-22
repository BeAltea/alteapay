"use client"

// Chat da jornada (pré-negociação): reconhecimento da dívida em UMA mensagem
// (saudação + resumo + pergunta Sim/Não). Sem ofertas/desconto e sem chat livre
// por ora — o fluxo é ver a dívida → reconhecer (Sim/Não) → mensagem final.
// - HISTÓRICO SEMPRE PRESERVADO: ao responder, a pergunta e a resposta escolhida
//   viram mensagens fixas (não somem da tela).
// - Timer de inatividade: 60s sem interação → volta para a tela de login do CHAT
//   (/n/{code}), NÃO o login da AlteaPay.
import { useCallback, useEffect, useRef, useState } from "react"
import { PromptButtons, type ActivePrompt, type PromptClickResult } from "./prompt-buttons"

interface ChatMsg {
  id: string
  from: "customer" | "assistant"
  text: string
}

let msgSeq = 0
const nextId = () => `m${Date.now()}_${msgSeq++}`

const IDLE_MS = 60_000

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

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" })
  }, [messages, activePrompt, ended])

  // Timer de inatividade: 60s sem interação → tela de login do CHAT (não AlteaPay).
  const goToChatLogin = useCallback(() => {
    // /n/{code}/chat → /n/{code}  (o formulário de CPF do próprio chat)
    const parent = window.location.pathname.replace(/\/chat\/?$/, "") || "/"
    window.location.href = parent
  }, [])

  const resetIdle = useCallback(() => {
    if (idleRef.current) clearTimeout(idleRef.current)
    idleRef.current = setTimeout(goToChatLogin, IDLE_MS)
  }, [goToChatLogin])

  useEffect(() => {
    const events: (keyof WindowEventMap)[] = [
      "mousemove", "mousedown", "keydown", "touchstart", "scroll", "click",
    ]
    const onActivity = () => resetIdle()
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
    try {
      const url = sinceRef.current
        ? `/api/chat/messages?since=${encodeURIComponent(sinceRef.current)}`
        : "/api/chat/messages"
      const res = await fetch(url)
      if (!res.ok) return
      const data = await res.json()
      const pushed: Array<{ id: string; role: string; text: string; created_at: string; button_id: number | null }> =
        Array.isArray(data?.messages) ? data.messages : []
      for (const m of pushed) {
        if (seenIds.current.has(m.id)) continue
        seenIds.current.add(m.id)
        sinceRef.current = m.created_at
        setMessages((prev) => [
          ...prev,
          { id: m.id, from: m.role === "customer" ? "customer" : "assistant", text: m.text },
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
    const startedAt = Date.now()
    const CAP_MS = 20 * 60 * 1000
    pollRef.current = setInterval(() => {
      if (document.visibilityState !== "visible") return
      if (Date.now() - startedAt > CAP_MS) {
        stopPoll()
        return
      }
      pollMessages()
    }, 2500)
    return () => stopPoll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
            className={m.from === "customer" ? "flex justify-end" : "flex justify-start"}
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
          </div>
        ))}

        {activePrompt && !ended ? (
          <div className="pt-1">
            <PromptButtons prompt={activePrompt} onClick={clickButton} />
          </div>
        ) : null}
      </div>
    </div>
  )
}
