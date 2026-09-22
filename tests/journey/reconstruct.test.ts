// Helper puro de reconstrução de chat_messages a partir de journey_events das
// sessões antigas. Cobre: mapa evento→mensagem por tipo; recuperação do texto do
// assistente via chat_prompts; clique (button 1/0) com label do prompt; ofertas
// estruturadas; eventos sem texto → não-reconstituíveis (sem inventar conteúdo);
// idempotência (reconstruction_id determinístico) e ordenação estável.

import { describe, expect, it } from "vitest"
import {
  RECONSTRUCTION_PREFIX,
  mapEventsToChatMessages,
  reconstructedMarker,
  reconstructionIdFor,
  type ReconstructEvent,
  type ReconstructPrompt,
} from "@/lib/journey/reconstruct"

const ACK_PROMPT: ReconstructPrompt = {
  id: "p1",
  question:
    "VMAX · valor atualizado R$ 347,49, 2 fatura(s), vencimento mais antigo em 10/02/2025. Você reconhece esta cobrança em seu nome?",
  buttons: [
    { id: 0, label: "Não reconheço" },
    { id: 1, label: "Sim, reconheço" },
  ],
  n8n_execution_id: null,
}

const prompts = new Map<string, ReconstructPrompt>([[ACK_PROMPT.id, ACK_PROMPT]])

function ev(partial: Partial<ReconstructEvent> & Pick<ReconstructEvent, "id" | "event_type" | "occurred_at">): ReconstructEvent {
  return { actor: "system", payload: null, ...partial }
}

describe("mapEventsToChatMessages — mapa evento→mensagem", () => {
  it("chat.turn.assistant com prompt_id → mensagem do assistente = texto do prompt", () => {
    const { messages, skipped } = mapEventsToChatMessages(
      [ev({ id: "e1", event_type: "chat.turn.assistant", occurred_at: "2026-09-21T23:49:16Z", payload: { prompt: true, prompt_id: "p1" } })],
      prompts,
    )
    expect(skipped).toHaveLength(0)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      role: "assistant",
      text: ACK_PROMPT.question,
      button_id: null,
      prompt_id: "p1",
      created_at: "2026-09-21T23:49:16Z",
    })
  })

  it("chat.turn.customer com payload.text → mensagem do cliente", () => {
    const { messages } = mapEventsToChatMessages([
      ev({ id: "e2", event_type: "chat.turn.customer", occurred_at: "2026-09-21T23:50:00Z", actor: "customer", payload: { text: "quero pagar em 3x" } }),
    ])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ role: "customer", text: "quero pagar em 3x", button_id: null })
  })

  it("debt.acknowledged → clique do cliente (button 1) com label do prompt", () => {
    const { messages } = mapEventsToChatMessages(
      [ev({ id: "e3", event_type: "debt.acknowledged", occurred_at: "2026-09-21T23:51:00Z", actor: "customer", payload: { button_id: 1, prompt_id: "p1" } })],
      prompts,
    )
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ role: "customer", text: "Sim, reconheço", button_id: 1, prompt_id: "p1" })
  })

  it("debt.not_recognized → clique do cliente (button 0)", () => {
    const { messages } = mapEventsToChatMessages(
      [ev({ id: "e4", event_type: "debt.not_recognized", occurred_at: "2026-09-21T23:52:00Z", actor: "customer", payload: { button_id: 0, prompt_id: "p1" } })],
      prompts,
    )
    expect(messages[0]).toMatchObject({ role: "customer", text: "Não reconheço", button_id: 0 })
  })

  it("debt.acknowledged sem prompt disponível → usa label fixo Sim/Não (fiel ao botão)", () => {
    const { messages } = mapEventsToChatMessages([
      ev({ id: "e5", event_type: "debt.acknowledged", occurred_at: "2026-09-21T23:53:00Z", actor: "customer", payload: { button_id: 1 } }),
    ])
    expect(messages[0]).toMatchObject({ role: "customer", text: "Sim, reconheço", button_id: 1, prompt_id: null })
  })

  it("offer.presented estruturada → resumo sintético (só de campos estruturados)", () => {
    const { messages } = mapEventsToChatMessages([
      ev({ id: "e6", event_type: "offer.presented", occurred_at: "2026-09-21T23:54:00Z", payload: { offer_id: "o1", installments: 3, total: 300 } }),
    ])
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe("assistant")
    expect(messages[0].text).toContain("3x")
    expect(messages[0].text).toContain("R$")
  })
})

describe("mapEventsToChatMessages — não inventa conteúdo", () => {
  it("chat.turn.assistant SEM prompt_id e SEM texto → não-reconstituível", () => {
    const { messages, skipped } = mapEventsToChatMessages([
      ev({ id: "e7", event_type: "chat.turn.assistant", occurred_at: "2026-09-21T23:55:00Z", payload: { event: "engine_unavailable", engine_owner: "platform" } }),
    ])
    expect(messages).toHaveLength(0)
    expect(skipped).toEqual([{ id: "e7", event_type: "chat.turn.assistant", reason: "no_assistant_text" }])
  })

  it("chat.turn.assistant com prompt_id que não está no mapa → não-reconstituível", () => {
    const { messages, skipped } = mapEventsToChatMessages([
      ev({ id: "e8", event_type: "chat.turn.assistant", occurred_at: "2026-09-21T23:56:00Z", payload: { prompt_id: "desconhecido" } }),
    ])
    expect(messages).toHaveLength(0)
    expect(skipped[0]).toMatchObject({ id: "e8", reason: "prompt_unavailable" })
  })

  it("chat.turn.customer sem texto → não-reconstituível (não inventa)", () => {
    const { messages, skipped } = mapEventsToChatMessages([
      ev({ id: "e9", event_type: "chat.turn.customer", occurred_at: "2026-09-21T23:57:00Z", actor: "customer", payload: {} }),
    ])
    expect(messages).toHaveLength(0)
    expect(skipped[0]).toMatchObject({ reason: "no_customer_text" })
  })

  it("offer.presented sem estrutura de parcelas/total → não-reconstituível", () => {
    const { messages, skipped } = mapEventsToChatMessages([
      ev({ id: "e10", event_type: "offer.presented", occurred_at: "2026-09-21T23:58:00Z", payload: { offer_id: "o1" } }),
    ])
    expect(messages).toHaveLength(0)
    expect(skipped[0]).toMatchObject({ reason: "offer_not_structured" })
  })

  it("eventos de ciclo (auth/consent/session/payment) não viram mensagem", () => {
    const { messages, skipped } = mapEventsToChatMessages([
      ev({ id: "a", event_type: "auth.success", occurred_at: "2026-09-21T23:49:14Z", actor: "customer", payload: {} }),
      ev({ id: "b", event_type: "consent.given", occurred_at: "2026-09-21T23:49:13Z", actor: "customer", payload: { version: "journey-v1" } }),
      ev({ id: "c", event_type: "session.started", occurred_at: "2026-09-21T23:49:14Z", payload: { channel: "web_public_link" } }),
    ])
    expect(messages).toHaveLength(0)
    expect(skipped.map((s) => s.reason)).toEqual(["not_a_chat_turn", "not_a_chat_turn", "not_a_chat_turn"])
  })
})

describe("idempotência e ordenação", () => {
  it("reconstruction_id é determinístico por event id (dedupe estável entre execuções)", () => {
    const events = [ev({ id: 42, event_type: "chat.turn.assistant", occurred_at: "2026-09-21T23:49:16Z", payload: { prompt_id: "p1" } })]
    const a = mapEventsToChatMessages(events, prompts)
    const b = mapEventsToChatMessages(events, prompts)
    expect(a.messages[0].reconstruction_id).toBe(`${RECONSTRUCTION_PREFIX}42`)
    expect(a.messages[0].reconstruction_id).toBe(b.messages[0].reconstruction_id)
    expect(reconstructionIdFor(42)).toBe("reconstructed:42")
  })

  it("rodar o mesmo conjunto 2x produz exatamente as mesmas linhas (idempotente)", () => {
    const events: ReconstructEvent[] = [
      ev({ id: "e1", event_type: "chat.turn.assistant", occurred_at: "2026-09-21T23:49:16Z", payload: { prompt_id: "p1" } }),
      ev({ id: "e3", event_type: "debt.acknowledged", occurred_at: "2026-09-21T23:51:00Z", actor: "customer", payload: { button_id: 1, prompt_id: "p1" } }),
    ]
    const a = mapEventsToChatMessages(events, prompts)
    const b = mapEventsToChatMessages(events, prompts)
    expect(a.messages).toEqual(b.messages)
  })

  it("ordena por occurred_at (empate → id) para timeline estável", () => {
    const events: ReconstructEvent[] = [
      ev({ id: "z", event_type: "debt.acknowledged", occurred_at: "2026-09-21T23:51:00Z", actor: "customer", payload: { button_id: 1, prompt_id: "p1" } }),
      ev({ id: "a", event_type: "chat.turn.assistant", occurred_at: "2026-09-21T23:49:16Z", payload: { prompt_id: "p1" } }),
    ]
    const { messages } = mapEventsToChatMessages(events, prompts)
    expect(messages.map((m) => m.created_at)).toEqual([
      "2026-09-21T23:49:16Z",
      "2026-09-21T23:51:00Z",
    ])
  })
})

describe("marcador de origem reconstructed", () => {
  it("reconstructedMarker devolve o objeto para offers_snapshot", () => {
    const { messages } = mapEventsToChatMessages(
      [ev({ id: "e1", event_type: "chat.turn.assistant", occurred_at: "2026-09-21T23:49:16Z", payload: { prompt_id: "p1" } })],
      prompts,
    )
    expect(reconstructedMarker(messages[0])).toEqual({
      reconstructed: true,
      reconstruction_id: "reconstructed:e1",
      source_event_type: "chat.turn.assistant",
    })
  })
})
