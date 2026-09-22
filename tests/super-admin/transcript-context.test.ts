// Testes da montagem PURA do transcript com contexto (A2.3): timeline
// cronológica (mensagens + eventos + cliques de botão), explicação de sessão
// sem mensagem, e duração legível.

import { describe, expect, it } from "vitest"
import {
  buildTimeline,
  emptySessionExplanation,
  eventLabel,
  humanDuration,
  type TranscriptEventInput,
  type TranscriptMessageInput,
} from "@/lib/negotiation/transcript-context"

function msg(over: Partial<TranscriptMessageInput> & { id: string; created_at: string }): TranscriptMessageInput {
  return {
    role: "customer",
    text: "olá",
    button_id: null,
    prompt_id: null,
    n8n_execution_id: null,
    engine: null,
    latency_ms: null,
    ...over,
  }
}

describe("buildTimeline — cronológica, mensagens + eventos", () => {
  it("intercala mensagens e eventos em ordem de tempo", () => {
    const messages: TranscriptMessageInput[] = [
      msg({ id: "m1", created_at: "2026-09-21T10:00:00Z", role: "assistant", text: "Bem-vindo", engine: "n8n" }),
      msg({ id: "m2", created_at: "2026-09-21T10:02:00Z", role: "customer", text: "ok" }),
    ]
    const events: TranscriptEventInput[] = [
      { id: 1, event_type: "auth.success", actor: "system", occurred_at: "2026-09-21T09:59:00Z", payload: null },
      { id: 2, event_type: "agreement.created", actor: "system", occurred_at: "2026-09-21T10:05:00Z", payload: null },
    ]
    const items = buildTimeline(messages, events)
    expect(items.map((i) => i.key)).toEqual(["e:1", "m:m1", "m:m2", "e:2"])
    expect(items[0].label).toBe("Autenticado")
    expect(items[3].label).toBe("Acordo criado")
  })

  it("mensagem de clique de botão ganha rótulo com o button_id", () => {
    const items = buildTimeline(
      [msg({ id: "b", created_at: "2026-09-21T10:00:00Z", role: "customer", text: "Sim, reconheço", button_id: 1 })],
      [],
    )
    expect(items[0].label).toContain("botão 1")
    expect(items[0].buttonId).toBe(1)
  })

  it("engine e n8n_execution_id só saem para mensagens do assistente", () => {
    const items = buildTimeline(
      [
        msg({ id: "a", created_at: "2026-09-21T10:00:00Z", role: "assistant", engine: "n8n", n8n_execution_id: "exec-123" }),
        msg({ id: "c", created_at: "2026-09-21T10:01:00Z", role: "customer", engine: "n8n", n8n_execution_id: "exec-xxx" }),
      ],
      [],
    )
    expect(items[0].engine).toBe("n8n")
    expect(items[0].n8nExecutionId).toBe("exec-123")
    expect(items[1].engine).toBeNull()
  })

  it("esconde chat.turn.* (ruído já representado pelas mensagens)", () => {
    const items = buildTimeline(
      [],
      [
        { id: 1, event_type: "chat.turn.assistant", actor: "ai", occurred_at: "2026-09-21T10:00:00Z", payload: null },
        { id: 2, event_type: "chat.turn.customer", actor: "customer", occurred_at: "2026-09-21T10:01:00Z", payload: null },
        { id: 3, event_type: "consent.given", actor: "customer", occurred_at: "2026-09-21T10:02:00Z", payload: null },
      ],
    )
    expect(items).toHaveLength(1)
    expect(items[0].label).toBe("Consentimento LGPD")
  })

  it("empate de timestamp: mensagem antes do evento", () => {
    const at = "2026-09-21T10:00:00Z"
    const items = buildTimeline(
      [msg({ id: "m", created_at: at })],
      [{ id: 9, event_type: "debt.viewed", actor: "customer", occurred_at: at, payload: null }],
    )
    expect(items[0].kind).toBe("message")
    expect(items[1].kind).toBe("event")
  })
})

describe("eventLabel — pt-BR compreensível sem treino", () => {
  it("traduz os principais; desconhecido cai no próprio tipo", () => {
    expect(eventLabel("debt.acknowledged")).toBe("Dívida reconhecida")
    expect(eventLabel("payment.paid")).toBe("Pagamento confirmado")
    expect(eventLabel("evento.exotico")).toBe("evento.exotico")
  })
})

describe("emptySessionExplanation — sessão não abre vazia", () => {
  it("autenticada sem mensagem explica com data de autenticação", () => {
    const s = emptySessionExplanation({
      hasMessages: false,
      identityVerifiedAt: "2026-09-21T10:00:00Z",
      createdAt: "2026-09-21T09:00:00Z",
    })
    expect(s).toContain("Sessão autenticada")
    expect(s).toContain("Nenhuma mensagem trocada")
  })

  it("não autenticada sem mensagem explica com data de início", () => {
    const s = emptySessionExplanation({
      hasMessages: false,
      identityVerifiedAt: null,
      createdAt: "2026-09-21T09:00:00Z",
    })
    expect(s).toContain("Sessão iniciada")
    expect(s).toContain("não autenticada")
  })

  it("com mensagens → null (há timeline)", () => {
    expect(
      emptySessionExplanation({ hasMessages: true, identityVerifiedAt: null, createdAt: "x" }),
    ).toBeNull()
  })
})

describe("humanDuration — legível", () => {
  it("segundos, minutos e horas; sem fim → null", () => {
    expect(humanDuration("2026-09-21T10:00:00Z", "2026-09-21T10:00:45Z")).toBe("45s")
    expect(humanDuration("2026-09-21T10:00:00Z", "2026-09-21T10:03:00Z")).toBe("3min")
    expect(humanDuration("2026-09-21T10:00:00Z", "2026-09-21T10:03:20Z")).toBe("3min 20s")
    expect(humanDuration("2026-09-21T10:00:00Z", "2026-09-21T12:30:00Z")).toBe("2h 30min")
    expect(humanDuration("2026-09-21T10:00:00Z", null)).toBeNull()
  })
})
