// A2 (N-D2-6 / N-D5-9) — regra de EXIBIÇÃO (pura) do texto do motor (engine='n8n'):
// markdown sanitizado; fallback genérico do fluxo (nome de sistema / "opções
// válidas") nunca chega ao devedor; texto solto com um menu do assistido ATIVO
// vira nota discreta (não empurra nem "responde"); com prompt → bolha; estado
// absorvente → some (M12).
import { describe, expect, it } from "vitest"
import {
  engineTextDisplay,
  isGenericEngineFallback,
  PLATFORM_ASSISTED_KINDS,
  sanitizeEngineText,
} from "@/lib/journey/wait-machine"

describe("sanitizeEngineText", () => {
  it("remove **negrito**, __negrito__, *itálico*, `código` e # títulos; preserva o texto", () => {
    expect(sanitizeEngineText("Muito obrigado pela confirmação, **Fabio**!")).toBe("Muito obrigado pela confirmação, Fabio!")
    expect(sanitizeEngineText("__Atenção__: *hoje* tem `desconto`")).toBe("Atenção: hoje tem desconto")
    expect(sanitizeEngineText("# Título\n\n\n\nTexto  \n")).toBe("Título\n\nTexto")
    // não injeta HTML nem mexe em URLs
    expect(sanitizeEngineText("Veja https://x.y/z?a=1")).toBe("Veja https://x.y/z?a=1")
  })
})

describe("isGenericEngineFallback", () => {
  it("reconhece o fallback do fluxo (opções válidas / canal automático / nome de sistema)", () => {
    expect(isGenericEngineFallback("Olá! Este é o canal de atendimento automático da AlteaPay. Selecione uma das opções válidas.")).toBe(true)
    expect(isGenericEngineFallback("Por favor, selecione uma das opções válidas")).toBe(true)
    expect(isGenericEngineFallback("erro no workflow n8n")).toBe(true)
    expect(isGenericEngineFallback("Conseguimos uma condição especial para você")).toBe(false)
    expect(isGenericEngineFallback("")).toBe(false)
  })
})

describe("engineTextDisplay", () => {
  const base = { hasPrompt: false, activePromptKind: null, waitState: "idle" as const }

  it("estado absorvente → hidden (M12)", () => {
    expect(engineTextDisplay({ ...base, text: "Oi", waitState: "link_entregue" }).mode).toBe("hidden")
    expect(engineTextDisplay({ ...base, text: "Oi", waitState: "quitada" }).mode).toBe("hidden")
    expect(engineTextDisplay({ ...base, text: "Oi", waitState: "nao_reconhecida" }).mode).toBe("hidden")
  })

  it("fallback genérico → hidden, mesmo sem menu ativo", () => {
    expect(engineTextDisplay({ ...base, text: "Este é o canal de atendimento automático da **AlteaPay**" }).mode).toBe("hidden")
  })

  it("texto vazio após sanitizar → hidden", () => {
    expect(engineTextDisplay({ ...base, text: "   " }).mode).toBe("hidden")
  })

  it("texto solto com menu do assistido ATIVO (offer_choice / 3 opções / pós-link) → note, sanitizado", () => {
    for (const kind of PLATFORM_ASSISTED_KINDS) {
      const r = engineTextDisplay({ ...base, text: "Muito obrigado pela confirmação, **Fabio**!", activePromptKind: kind })
      expect(r.mode).toBe("note")
      expect(r.text).toBe("Muito obrigado pela confirmação, Fabio!")
    }
  })

  it("com prompt (n8n mandou botões) → bubble, mesmo com menu do assistido ativo", () => {
    const r = engineTextDisplay({ ...base, text: "Escolha **uma**", hasPrompt: true, activePromptKind: "offer_choice" })
    expect(r).toEqual({ mode: "bubble", text: "Escolha uma" })
  })

  it("sem menu do assistido ativo → bubble comum", () => {
    expect(engineTextDisplay({ ...base, text: "Vamos negociar sua dívida." }).mode).toBe("bubble")
    expect(engineTextDisplay({ ...base, text: "Vamos negociar sua dívida.", activePromptKind: "negotiation_l1" }).mode).toBe("bubble")
    expect(engineTextDisplay({ ...base, text: "Vamos negociar.", waitState: "aguardando_motor" }).mode).toBe("bubble")
  })
})
