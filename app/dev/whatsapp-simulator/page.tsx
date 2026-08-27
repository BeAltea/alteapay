"use client"

// Simulador local de WhatsApp (dev/mock): envia envelopes Cloud API sintéticos
// ao webhook real e exibe as respostas do provider mock. É por aqui que se
// valida o fluxo WhatsApp → identidade → reconhecimento → link → chatbot
// sem nenhuma conexão externa.

import { useCallback, useEffect, useRef, useState } from "react"
import { Loader2, Send, Smartphone } from "lucide-react"

type SimMessage = { direction: "in" | "out"; text: string; at: string }

export default function WhatsAppSimulatorPage() {
  const [phone, setPhone] = useState("5511988887777")
  const [input, setInput] = useState("")
  const [messages, setMessages] = useState<SimMessage[]>([])
  const [sending, setSending] = useState(false)
  const seenRef = useRef<Set<string>>(new Set())
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  const pollOutbox = useCallback(async () => {
    try {
      const resp = await fetch(`/api/dev/whatsapp-simulator/outbox?phone=${phone}`)
      const data = await resp.json()
      if (!data.success) return
      const fresh: SimMessage[] = []
      for (const m of data.messages as Array<{ text: string; id: string; at: string }>) {
        if (seenRef.current.has(m.id)) continue
        seenRef.current.add(m.id)
        fresh.push({ direction: "in", text: m.text, at: m.at })
      }
      if (fresh.length) setMessages((prev) => [...prev, ...fresh])
    } catch {
      /* worker ainda processando */
    }
  }, [phone])

  useEffect(() => {
    const t = setInterval(pollOutbox, 2000)
    return () => clearInterval(t)
  }, [pollOutbox])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || sending) return
    setInput("")
    setMessages((prev) => [...prev, { direction: "out", text, at: new Date().toISOString() }])
    setSending(true)
    try {
      await fetch("/api/dev/whatsapp-simulator/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: phone, text }),
      })
    } finally {
      setSending(false)
    }
  }, [input, phone, sending])

  return (
    <div className="mx-auto flex h-dvh max-w-md flex-col bg-[#ECE5DD]">
      <header className="flex items-center gap-3 bg-[#075E54] px-4 py-3 text-white">
        <Smartphone className="h-5 w-5" />
        <div className="flex-1">
          <div className="text-sm font-semibold">Simulador WhatsApp (mock)</div>
          <input
            value={phone}
            onChange={(e) => {
              setPhone(e.target.value)
              seenRef.current.clear()
              setMessages([])
            }}
            className="w-44 rounded bg-white/20 px-1 text-xs outline-none"
            aria-label="Telefone simulado"
          />
        </div>
        {sending && <Loader2 className="h-4 w-4 animate-spin" />}
      </header>

      <div className="flex-1 overflow-y-auto p-3">
        <div className="flex flex-col gap-2">
          <div className="self-center rounded bg-[#FEF3C7] px-3 py-1 text-center text-[11px] text-amber-800">
            Ambiente local — envelopes assinados com o secret mock; nenhuma conexão com a Meta.
          </div>
          {messages.map((m, i) => (
            <div
              key={i}
              className={`max-w-[80%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm shadow ${
                m.direction === "out" ? "self-end bg-[#DCF8C6]" : "self-start bg-white"
              }`}
            >
              {m.text}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      </div>

      <form
        className="flex items-center gap-2 bg-[#F0F0F0] p-2"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Mensagem do devedor…"
          className="flex-1 rounded-full border bg-white px-4 py-2 text-sm outline-none"
          aria-label="Mensagem"
        />
        <button type="submit" disabled={sending || !input.trim()} className="rounded-full bg-[#075E54] p-2.5 text-white disabled:opacity-50" aria-label="Enviar">
          <Send className="h-4 w-4" />
        </button>
      </form>
    </div>
  )
}
