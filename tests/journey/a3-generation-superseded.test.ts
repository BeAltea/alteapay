// A3 (§2.4 / G4 / N3) — SUPERSEDED POR GERAÇÃO. O servidor anota cada mensagem
// com a geração do prompt que a governa (annotateMessageGenerations); o
// classificador puro (classifyMessage) devolve `superseded` para gerações
// anteriores à do menu corrente — inclusive o eco do cliente e as mensagens do
// motor entre prompts —, mas NUNCA para um outcome (link/desfecho).
import { describe, expect, it } from "vitest"
import {
  CURRENT_GENERATION,
  annotateMessageGenerations,
  classifyMessage,
  generationOfKind,
  type GenerationPromptRow,
} from "@/lib/journey/display-class"
import {
  capHistory,
  classOf,
  currentGenerationOf,
  prunePresentation,
  type ChatMsg,
} from "@/components/journey/chat-display"

describe("generationOfKind (A3)", () => {
  it("kinds legados são gerações anteriores; o resto é a geração corrente", () => {
    expect(generationOfKind("debt_acknowledgement")).toBe(0)
    expect(generationOfKind("debt_consult")).toBe(1)
    expect(generationOfKind("debt_three_options")).toBe(CURRENT_GENERATION)
    expect(generationOfKind("offer_choice")).toBe(CURRENT_GENERATION)
    expect(generationOfKind("post_payment_link")).toBe(CURRENT_GENERATION)
    expect(generationOfKind("kind_futuro")).toBe(CURRENT_GENERATION)
    expect(generationOfKind(null)).toBe(CURRENT_GENERATION)
    expect(generationOfKind(undefined)).toBe(CURRENT_GENERATION)
  })
})

describe("classifyMessage com geração anterior → superseded (A3 / §2.4)", () => {
  const ctx = { activePromptId: "p-new", waitState: "idle" as const, currentGeneration: CURRENT_GENERATION }

  it("eco do cliente de geração anterior (Sim, reconheço / Consultar Dívida) → superseded", () => {
    expect(classifyMessage({ role: "customer", buttonId: 1, text: "Sim, reconheço", generation: 0 }, ctx)).toBe("superseded")
    expect(classifyMessage({ role: "customer", buttonId: 2, text: "Consultar Dívida", generation: 1 }, ctx)).toBe("superseded")
  })

  it("resposta do assistente sem prompt_id na janela de uma geração anterior → superseded", () => {
    const msg = { role: "assistant", text: "Aqui estão os dados da sua dívida: valor atualizado R$ 250,00", generation: 1 }
    expect(classifyMessage(msg, ctx)).toBe("superseded")
  })

  it("mensagem do motor (n8n) de geração anterior → superseded mesmo fora de estado absorvente", () => {
    const msg = { role: "assistant", engine: "n8n", text: "Muito obrigado pela confirmação!", generation: 1 }
    expect(classifyMessage(msg, { ...ctx, waitState: "idle" })).toBe("superseded")
  })

  it("pergunta de prompt de geração anterior → superseded (já era; continua)", () => {
    expect(classifyMessage({ role: "assistant", text: "Como deseja seguir?", promptId: "p-old", generation: 1 }, ctx)).toBe("superseded")
  })

  it("OUTCOME nunca é podado por geração: action, link no texto ou stage de resultado", () => {
    expect(classifyMessage({ role: "assistant", hasAction: true, generation: 0 }, ctx)).toBe("outcome")
    expect(classifyMessage({ role: "assistant", text: "Seu link: https://pay.example.test/c/9", generation: 0 }, ctx)).toBe("outcome")
    expect(classifyMessage({ role: "assistant", text: "Registramos…", stage: "not_recognized", generation: 1 }, ctx)).toBe("outcome")
  })

  it("mesma geração ou geração maior → classes normais (decision/guidance)", () => {
    expect(classifyMessage({ role: "customer", buttonId: 4, generation: CURRENT_GENERATION }, ctx)).toBe("decision")
    expect(classifyMessage({ role: "assistant", text: "guia", generation: CURRENT_GENERATION }, ctx)).toBe("guidance")
    expect(classifyMessage({ role: "assistant", text: "guia", generation: CURRENT_GENERATION + 1 }, ctx)).toBe("guidance")
  })

  it("sem anotação (generation null/undefined) ou sem geração corrente no contexto → regra desligada", () => {
    expect(classifyMessage({ role: "customer", buttonId: 1, text: "Sim, reconheço" }, ctx)).toBe("decision")
    expect(classifyMessage({ role: "customer", buttonId: 1, generation: null }, ctx)).toBe("decision")
    expect(classifyMessage({ role: "customer", buttonId: 1, generation: 0 }, { activePromptId: "p-new", waitState: "idle" })).toBe("decision")
    expect(classifyMessage({ role: "customer", buttonId: 1, generation: 0 }, { ...ctx, currentGeneration: null })).toBe("decision")
  })

  it("precedência: system (role/n8n absorvente) vem antes da geração", () => {
    expect(classifyMessage({ role: "system", text: "x", generation: 0 }, ctx)).toBe("system")
    expect(classifyMessage({ role: "assistant", engine: "n8n", text: "tardia", generation: 0 }, { ...ctx, waitState: "link_entregue" })).toBe("system")
  })
})

describe("annotateMessageGenerations (servidor, join em memória com chat_prompts)", () => {
  const prompts: GenerationPromptRow[] = [
    { id: "p-ack", kind: "debt_acknowledgement", status: "answered", created_at: "2026-09-01T10:00:00Z" },
    { id: "p-consult", kind: "debt_consult", status: "answered", created_at: "2026-09-01T11:00:00Z" },
    { id: "p-three-old", kind: "debt_three_options", status: "answered", created_at: "2026-09-02T09:00:00Z" },
    { id: "p-three", kind: "debt_three_options", status: "active", created_at: "2026-09-03T09:00:00Z" },
  ]

  it("mensagem com prompt_id conhecido herda kind e geração do prompt", () => {
    const [m] = annotateMessageGenerations([{ id: "a", prompt_id: "p-ack", created_at: "2026-09-01T10:00:10Z" }], prompts)
    expect(m.prompt_kind).toBe("debt_acknowledgement")
    expect(m.generation).toBe(0)
  })

  it("mensagem sem prompt_id é governada pelo ÚLTIMO prompt criado até ela (janela entre prompts)", () => {
    const out = annotateMessageGenerations(
      [
        { id: "n8n-1", prompt_id: null, created_at: "2026-09-01T10:30:00Z" }, // entre ack e consult → ack
        { id: "reply-1", prompt_id: null, created_at: "2026-09-01T11:30:00Z" }, // após consult → consult
        { id: "greet", prompt_id: null, created_at: "2026-09-02T09:00:05Z" }, // após three-old → corrente
      ],
      prompts,
    )
    expect(out.map((m) => [m.prompt_kind, m.generation])).toEqual([
      ["debt_acknowledgement", 0],
      ["debt_consult", 1],
      ["debt_three_options", CURRENT_GENERATION],
    ])
  })

  it("mensagem ANTES de qualquer prompt → geração corrente (nunca esconde por acidente)", () => {
    const [m] = annotateMessageGenerations([{ id: "x", prompt_id: null, created_at: "2026-08-31T00:00:00Z" }], prompts)
    expect(m.prompt_kind).toBeNull()
    expect(m.generation).toBe(CURRENT_GENERATION)
  })

  it("prompt governante ATIVO → geração corrente, mesmo que o kind seja legado (tenant no fluxo antigo, D14)", () => {
    const legacyActive: GenerationPromptRow[] = [
      { id: "p-ack", kind: "debt_acknowledgement", status: "active", created_at: "2026-09-01T10:00:00Z" },
    ]
    const [linked, windowed] = annotateMessageGenerations(
      [
        { id: "a", prompt_id: "p-ack", created_at: "2026-09-01T10:00:10Z" },
        { id: "b", prompt_id: null, created_at: "2026-09-01T10:00:20Z" },
      ],
      legacyActive,
    )
    expect(linked.generation).toBe(CURRENT_GENERATION)
    expect(windowed.generation).toBe(CURRENT_GENERATION)
    expect(linked.prompt_kind).toBe("debt_acknowledgement")
  })

  it("prompt_id desconhecido cai na regra por tempo; sem prompts → tudo corrente; preserva os campos", () => {
    const [m] = annotateMessageGenerations([{ id: "z", prompt_id: "nope", created_at: "2026-09-01T11:30:00Z", text: "t" }], prompts)
    expect(m.prompt_kind).toBe("debt_consult")
    expect(m.generation).toBe(1)
    expect(m.text).toBe("t")
    const [n] = annotateMessageGenerations([{ id: "z", prompt_id: "p-ack", created_at: "2026-09-01T11:30:00Z" }], [])
    expect(n.generation).toBe(CURRENT_GENERATION)
  })
})

function cust(id: string, text: string, buttonId: number, generation: number | null): ChatMsg {
  return { id, from: "customer", text, action: null, promptId: null, buttonId, engine: null, generation }
}
function asst(id: string, text: string, extra: Partial<ChatMsg> = {}): ChatMsg {
  return { id, from: "assistant", text, action: null, promptId: null, engine: null, buttonId: null, ...extra }
}

describe("currentGenerationOf (client)", () => {
  it("com menu ativo: a geração do kind do menu", () => {
    expect(currentGenerationOf([], "debt_three_options")).toBe(CURRENT_GENERATION)
    expect(currentGenerationOf([cust("c", "x", 1, 0)], "debt_consult")).toBe(1)
  })
  it("sem menu ativo: a maior geração vista; sem anotações → corrente", () => {
    expect(currentGenerationOf([cust("a", "x", 1, 0), cust("b", "y", 2, 1)], null)).toBe(1)
    expect(currentGenerationOf([asst("g", "guia")], null)).toBe(CURRENT_GENERATION)
  })
})

describe("prunePresentation / capHistory com geração (pipeline do client)", () => {
  it("poda as bolhas de gerações anteriores; a regra desligada (null) as mantém", () => {
    const list = [
      cust("c0", "Sim, reconheço", 1, 0),
      asst("g1", "Aqui estão os dados… R$ 250,00", { generation: 1 }),
      asst("n1", "Muito obrigado pela confirmação!", { engine: "n8n", generation: 1 }),
      cust("c2", "Detalhes da dívida", 2, CURRENT_GENERATION),
      asst("g2", "Este valor tem vencimento original em…", { generation: CURRENT_GENERATION }),
    ]
    expect(prunePresentation(list, "p-new", "idle", CURRENT_GENERATION).map((m) => m.id)).toEqual(["c2", "g2"])
    expect(prunePresentation(list, "p-new", "idle", null).map((m) => m.id)).toEqual(["c0", "g1", "n1", "c2", "g2"])
    expect(classOf(list[0], "p-new", "idle", CURRENT_GENERATION)).toBe("superseded")
    expect(classOf(list[0], "p-new", "idle")).toBe("decision")
  })

  it("capHistory não protege decision de geração anterior (não é memória útil)", () => {
    const old = cust("old", "Sim, reconheço", 1, 0)
    const guias = Array.from({ length: 25 }, (_, i) => asst(`g${i}`, `guia ${i}`, { generation: CURRENT_GENERATION }))
    const r = capHistory([old, ...guias], null, "idle", { cap: 20, currentGeneration: CURRENT_GENERATION })
    expect(r.visible.some((m) => m.id === "old")).toBe(false)
    expect(r.hasMore).toBe(true)
  })
})
