// D2 — CLASSES DE EXIBIÇÃO (§10.1 / C4 / R-10) + PODA (C5/C6/C8) + TETO (R-41).
// Testa a função PURA classifyMessage (lib/journey/display-class.ts) e o pipeline
// de apresentação (components/journey/chat-display.ts): prunePresentation, capHistory.
import { describe, expect, it } from "vitest"
import {
  DISPLAY_CLASSES,
  classifyMessage,
  isProtectedClass,
  type DisplayClass,
} from "@/lib/journey/display-class"
import {
  capHistory,
  classOf,
  prunePresentation,
  type ChatMsg,
} from "@/components/journey/chat-display"

// ============================================================================
// classifyMessage — mapeamento 1-para-1 dos sinais canônicos às 7 classes (R-10).
// ============================================================================
describe("classifyMessage (§10.1 / C4)", () => {
  it("role='customer' com button_id → decision (memória da escolha)", () => {
    expect(classifyMessage({ role: "customer", buttonId: 4 })).toBe("decision")
    expect(classifyMessage({ role: "customer", buttonId: 0 })).toBe("decision")
  })

  it("role='customer' sem button_id ainda é decision (escolha do devedor)", () => {
    expect(classifyMessage({ role: "customer" })).toBe("decision")
  })

  it("assistant com botão-link anexado (hasAction) → outcome (C8)", () => {
    expect(classifyMessage({ role: "assistant", hasAction: true })).toBe("outcome")
  })

  it("assistant com link de pagamento no texto → outcome (link persistido, C8)", () => {
    const msg = { role: "assistant", text: "Aqui está seu link: https://asaas/checkout/pay_1" }
    expect(classifyMessage(msg)).toBe("outcome")
  })

  it("assistant pergunta de prompt NÃO-ativo → superseded (menu substituído, C5)", () => {
    const msg = { role: "assistant", text: "Como deseja seguir?", promptId: "p-old" }
    expect(classifyMessage(msg, { activePromptId: "p-new" })).toBe("superseded")
  })

  it("assistant pergunta do prompt ATIVO → guidance (aparece no bloco de botões)", () => {
    const msg = { role: "assistant", text: "Como deseja seguir?", promptId: "p-1" }
    expect(classifyMessage(msg, { activePromptId: "p-1" })).toBe("guidance")
  })

  it("assistant comum (saudação/dados) sem prompt → guidance", () => {
    expect(classifyMessage({ role: "assistant", text: "Olá. Vou buscar as condições." })).toBe("guidance")
  })

  it("role='system' → system (nunca renderiza, R-16)", () => {
    expect(classifyMessage({ role: "system", text: "erro interno" })).toBe("system")
  })

  it("engine='n8n' em estado ABSORVENTE (link_entregue) → system (M12/R-16)", () => {
    const msg = { role: "assistant", engine: "n8n", text: "resposta tardia do motor" }
    expect(classifyMessage(msg, { waitState: "link_entregue" })).toBe("system")
    expect(classifyMessage(msg, { waitState: "nao_reconhecida" })).toBe("system")
  })

  it("engine='n8n' FORA de estado absorvente → guidance (renderiza normalmente)", () => {
    const msg = { role: "assistant", engine: "n8n", text: "vamos ver as condições" }
    expect(classifyMessage(msg, { waitState: "negociando" })).toBe("guidance")
    expect(classifyMessage(msg, { waitState: "aguardando_motor" })).toBe("guidance")
  })

  it("engine='n8n' com link → outcome mesmo (link sempre visível, C8)", () => {
    const msg = { role: "assistant", engine: "n8n", hasAction: true }
    // fora de estado absorvente: outcome
    expect(classifyMessage(msg, { waitState: "negociando" })).toBe("outcome")
  })

  it("toda mensagem cai em EXATAMENTE uma das 7 classes (0 sem classe)", () => {
    const samples: Array<Parameters<typeof classifyMessage>[0]> = [
      { role: "customer", buttonId: 4 },
      { role: "assistant", hasAction: true },
      { role: "assistant", text: "https://x/y" },
      { role: "assistant", promptId: "p", text: "?" },
      { role: "assistant", text: "guia" },
      { role: "system", text: "x" },
      { role: "assistant", engine: "n8n", text: "z" },
    ]
    for (const s of samples) {
      const cls = classifyMessage(s, { activePromptId: "other", waitState: "link_entregue" })
      expect(DISPLAY_CLASSES).toContain(cls)
    }
  })

  it("isProtectedClass: decision e outcome protegidos; guidance/superseded/system não", () => {
    expect(isProtectedClass("decision")).toBe(true)
    expect(isProtectedClass("outcome")).toBe(true)
    expect(isProtectedClass("guidance")).toBe(false)
    expect(isProtectedClass("superseded")).toBe(false)
    expect(isProtectedClass("system")).toBe(false)
  })
})

// helpers de ChatMsg
function cust(id: string, text: string, buttonId: number | null = 1): ChatMsg {
  return { id, from: "customer", text, action: null, promptId: null, buttonId, engine: null }
}
function asst(id: string, text: string, extra: Partial<ChatMsg> = {}): ChatMsg {
  return { id, from: "assistant", text, action: null, promptId: null, engine: null, buttonId: null, ...extra }
}

// ============================================================================
// prunePresentation — system fora (R-16), superseded colapsa (R-13). decision/
// outcome nunca somem (R-15).
// ============================================================================
describe("prunePresentation (§10.1)", () => {
  it("remove system (engine n8n em estado absorvente) — R-16", () => {
    const list = [
      asst("a1", "guia"),
      asst("n1", "resposta tardia", { engine: "n8n" }),
    ]
    // waitState absorvente → a n8n vira system e some
    const out = prunePresentation(list, null, "link_entregue")
    expect(out.map((m) => m.id)).toEqual(["a1"])
  })

  it("colapsa superseded: bolha-pergunta de menu não-ativo some (R-13/C5)", () => {
    const list = [
      asst("q_old", "Como deseja seguir?", { promptId: "p-old" }),
      asst("q_new", "Como deseja seguir?", { promptId: "p-new" }),
    ]
    // prompt ativo = p-new → q_old (p-old) é superseded e some; q_new fica
    const out = prunePresentation(list, "p-new", "idle")
    expect(out.map((m) => m.id)).toEqual(["q_new"])
  })

  it("NUNCA remove decision (cliente) nem outcome (link) — C8/R-15", () => {
    const list = [
      cust("c1", "Quero pagar — R$ 250,00", 4),
      asst("o1", "Aqui está seu link: https://asaas/pay_1"),
      asst("sys", "resposta tardia", { engine: "n8n" }),
    ]
    const out = prunePresentation(list, null, "link_entregue")
    // decision e outcome ficam; só a n8n absorvida (system) some
    expect(out.map((m) => m.id)).toEqual(["c1", "o1"])
  })
})

// ============================================================================
// capHistory — teto de 20 (Apêndice D.4); decision/outcome nunca recolhidos.
// ============================================================================
describe("capHistory (R-41 / Apêndice D.4=20)", () => {
  it("abaixo do teto: tudo visível, sem 'ver conversa completa'", () => {
    const list = Array.from({ length: 5 }, (_, i) => asst(`a${i}`, `msg ${i}`))
    const r = capHistory(list, null, "idle", { cap: 20 })
    expect(r.visible).toHaveLength(5)
    expect(r.hasMore).toBe(false)
  })

  it("acima do teto: guidance velho recolhe; visíveis = teto", () => {
    const list = Array.from({ length: 25 }, (_, i) => asst(`a${i}`, `guia ${i}`))
    const r = capHistory(list, null, "idle", { cap: 20 })
    // 20 guidance visíveis (as mais NOVAS), 5 recolhidas (as mais velhas)
    expect(r.visible).toHaveLength(20)
    expect(r.collapsed).toHaveLength(5)
    expect(r.hasMore).toBe(true)
    // recolhidas são as mais velhas (a0..a4)
    expect(r.collapsed.map((m) => m.id)).toEqual(["a0", "a1", "a2", "a3", "a4"])
    // ordem cronológica preservada nas visíveis
    expect(r.visible[0].id).toBe("a5")
  })

  it("decision/outcome NUNCA recolhem, mesmo acima do teto (C8)", () => {
    // 25 guidance + 1 decision velha + 1 outcome velho no início
    const decision = cust("dec", "Quero pagar — R$ 250,00", 4)
    const outcome = asst("out", "Seu link: https://asaas/pay")
    const guias = Array.from({ length: 25 }, (_, i) => asst(`g${i}`, `guia ${i}`))
    const list = [decision, outcome, ...guias]
    const r = capHistory(list, null, "idle", { cap: 20 })
    // decision e outcome permanecem visíveis (não gastam orçamento, nunca recolhem)
    expect(r.visible.some((m) => m.id === "dec")).toBe(true)
    expect(r.visible.some((m) => m.id === "out")).toBe(true)
    // as recolhidas são só guidance velhas
    expect(r.collapsed.every((m) => classOf(m, null, "idle") === "guidance")).toBe(true)
    expect(r.hasMore).toBe(true)
  })

  it("expanded=true devolve tudo visível (usuário clicou 'ver conversa completa')", () => {
    const list = Array.from({ length: 30 }, (_, i) => asst(`a${i}`, `guia ${i}`))
    const r = capHistory(list, null, "idle", { cap: 20, expanded: true })
    expect(r.visible).toHaveLength(30)
    expect(r.hasMore).toBe(false)
  })
})
