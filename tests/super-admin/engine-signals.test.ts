// X4: painel de sessão — sinais de engine/fallback e contadores de turno.
// Lógica PURA (sem banco): classifica journey_events em sinais de fallback e
// deriva os contadores do topo. As três fontes de fallback:
//   chat.engine_error, chat.engine_invalid_action e chat.turn.assistant com
//   payload.event='engine_unavailable'.

import { describe, it, expect } from "vitest"
import {
  computeEngineSignals,
  computeTurnCounters,
  type EngineEventRow,
} from "@/lib/journey/history"

describe("computeEngineSignals", () => {
  it("sessão sem fallback: tudo zero, hadFallback=false", () => {
    const events: EngineEventRow[] = [
      { event_type: "chat.turn.assistant", occurred_at: "2026-09-21T10:00:00Z", payload: { latency_ms: 120 } },
      { event_type: "chat.turn.customer", occurred_at: "2026-09-21T10:00:05Z", payload: null },
    ]
    const sig = computeEngineSignals(events)
    expect(sig.hadFallback).toBe(false)
    expect(sig.engineErrors).toBe(0)
    expect(sig.invalidActions).toBe(0)
    expect(sig.engineUnavailable).toBe(0)
    expect(sig.fallbackAt).toEqual([])
  })

  it("conta chat.engine_error como fallback", () => {
    const sig = computeEngineSignals([
      { event_type: "chat.engine_error", occurred_at: "2026-09-21T10:01:00Z", payload: null },
    ])
    expect(sig.hadFallback).toBe(true)
    expect(sig.engineErrors).toBe(1)
    expect(sig.fallbackAt).toEqual(["2026-09-21T10:01:00Z"])
  })

  it("conta chat.engine_invalid_action como ação recusada (fallback)", () => {
    const sig = computeEngineSignals([
      { event_type: "chat.engine_invalid_action", occurred_at: "2026-09-21T10:02:00Z", payload: { action: "payment.create" } },
    ])
    expect(sig.hadFallback).toBe(true)
    expect(sig.invalidActions).toBe(1)
    expect(sig.engineErrors).toBe(0)
  })

  it("engine_unavailable só quando é chat.turn.assistant com payload.event correto", () => {
    const sig = computeEngineSignals([
      // este conta:
      { event_type: "chat.turn.assistant", occurred_at: "2026-09-21T10:03:00Z", payload: { event: "engine_unavailable", engine_owner: "platform" } },
      // este NÃO conta (é a transição de dono, não fallback):
      { event_type: "chat.turn.assistant", occurred_at: "2026-09-21T10:03:10Z", payload: { event: "negotiation.start", engine_owner: "n8n" } },
      // este NÃO conta (assistant normal):
      { event_type: "chat.turn.assistant", occurred_at: "2026-09-21T10:03:20Z", payload: { latency_ms: 90 } },
    ])
    expect(sig.engineUnavailable).toBe(1)
    expect(sig.hadFallback).toBe(true)
    expect(sig.fallbackAt).toEqual(["2026-09-21T10:03:00Z"])
  })

  it("agrega múltiplos sinais e ordena os timestamps", () => {
    const sig = computeEngineSignals([
      { event_type: "chat.engine_invalid_action", occurred_at: "2026-09-21T10:05:00Z", payload: null },
      { event_type: "chat.engine_error", occurred_at: "2026-09-21T10:04:00Z", payload: null },
      { event_type: "chat.turn.assistant", occurred_at: "2026-09-21T10:06:00Z", payload: { event: "engine_unavailable" } },
    ])
    expect(sig.engineErrors).toBe(1)
    expect(sig.invalidActions).toBe(1)
    expect(sig.engineUnavailable).toBe(1)
    expect(sig.fallbackAt).toEqual([
      "2026-09-21T10:04:00Z",
      "2026-09-21T10:05:00Z",
      "2026-09-21T10:06:00Z",
    ])
  })

  it("payload null/ausente nunca quebra a classificação", () => {
    const sig = computeEngineSignals([
      { event_type: "chat.turn.assistant", occurred_at: "2026-09-21T10:07:00Z", payload: null },
    ])
    expect(sig.hadFallback).toBe(false)
  })
})

describe("computeTurnCounters", () => {
  const msgs = [
    { role: "customer" as const },
    { role: "assistant" as const },
    { role: "customer" as const },
    { role: "assistant" as const },
    { role: "system" as const }, // não conta como turno de cliente nem assistente
  ]

  it("conta turnos de cliente e assistente; fallback e recusa vêm dos sinais", () => {
    const sig = computeEngineSignals([
      { event_type: "chat.engine_error", occurred_at: "2026-09-21T10:00:00Z", payload: null },
      { event_type: "chat.turn.assistant", occurred_at: "2026-09-21T10:00:10Z", payload: { event: "engine_unavailable" } },
      { event_type: "chat.engine_invalid_action", occurred_at: "2026-09-21T10:00:20Z", payload: null },
    ])
    const tc = computeTurnCounters(msgs, sig)
    expect(tc.customerTurns).toBe(2)
    expect(tc.assistantTurns).toBe(2)
    // fallback = engine_error + engine_unavailable (falhas técnicas de turno)
    expect(tc.fallbackTurns).toBe(2)
    // recusa = invalid_action (o servidor barrou a ação, reply ainda exibido)
    expect(tc.refusedActions).toBe(1)
  })

  it("sem sinais: fallback/recusa zerados, turnos preservados", () => {
    const tc = computeTurnCounters(msgs, computeEngineSignals([]))
    expect(tc).toEqual({ customerTurns: 2, assistantTurns: 2, fallbackTurns: 0, refusedActions: 0 })
  })
})
