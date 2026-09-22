"use client"

// Chat da jornada (pré-negociação): reconhecimento da dívida em UMA mensagem
// (saudação + resumo + pergunta Sim/Não). Sem ofertas/desconto e sem chat livre
// por ora — o fluxo é ver a dívida → reconhecer (Sim/Não) → mensagem final.
import { useEffect, useRef, useState } from "react"
import { PromptButtons, type ActivePrompt, type PromptClickResult } from "./prompt-buttons"

interface ChatMsg {
  id: string
  from: "customer" | "assistant"
  text: string
}

let msgSeq = 0
const nextId = () => `m${Date.now()}_${msgSeq++}`

export function JourneyChat() {
  // Sem saudação hardcoded: a 1ª (e única) mensagem inicial é o prompt de
  // reconhecimento, empurrado via /api/chat/messages (active_prompt).
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [ended, setEnded] = useState(false)
  const [activePrompt, setActivePrompt] = useState<ActivePrompt | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const sinceRef = useRef<string | null>(null)
  const seenIds = useRef<Set<string>>(new Set())

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" })
  }, [messages, activePrompt, ended])

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
      setActivePrompt(data?.active_prompt ?? null)
    } catch {
      /* silencioso */
    }
  }

  useEffect(() => {
    pollMessages()
    const startedAt = Date.now()
    const CAP_MS = 20 * 60 * 1000
    const interval = setInterval(() => {
      if (document.visibilityState !== "visible") return
      if (Date.now() - startedAt > CAP_MS) {
        clearInterval(interval)
        return
      }
      pollMessages()
    }, 2500)
    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Clique no reconhecimento (Sim/Não). O backend devolve `reply` (texto fixo
  // local), que exibimos como bolha do assistente. Depois, conversa encerrada:
  // não há chat livre nem ofertas/negociação neste momento.
  async function clickButton(promptId: string, buttonId: number): Promise<PromptClickResult> {
    try {
      const res = await fetch("/api/chat/button", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt_id: promptId, button_id: buttonId }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        if (typeof data?.reply === "string" && data.reply.trim()) {
          setMessages((m) => [...m, { id: nextId(), from: "assistant", text: data.reply }])
        }
        setActivePrompt(null)
        setEnded(true)
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
