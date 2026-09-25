// D2 — ESPERA CONFIÁVEL. Lógica PURA da máquina de espera (§6.3 / Apêndice B /
// 02-design-estados.md). Testa os degraus derivados do tempo, a copy narrada, a
// supressão inicial do indicador, as saídas aos 10s, os estados ABSORVENTES da
// resposta tardia (M12) e a reidratação no reload (M11) — tudo sem React.
import { describe, expect, it } from "vitest"
import {
  DEGRADED_MENU_COPY,
  PERSISTED_WAIT_STATES,
  WAIT_STEP_MS,
  deriveWaitStep,
  elapsedSince,
  hydrateWaitState,
  isAbsorbingForEngineMsg,
  resolveWaitView,
  shouldRenderEngineMsg,
  shouldShowSlowExits,
  shouldShowTypingIndicator,
  waitStepCopy,
  type WaitState,
} from "@/lib/journey/wait-machine"

describe("deriveWaitStep — degraus 1,2/4/10/15s (limiares G1)", () => {
  it("t<1,2s → d0_suppressed (indicador SUPRIMIDO — resposta <1s não pisca)", () => {
    expect(deriveWaitStep(0)).toBe("d0_suppressed")
    expect(deriveWaitStep(800)).toBe("d0_suppressed")
    expect(deriveWaitStep(WAIT_STEP_MS.TYPING - 1)).toBe("d0_suppressed")
  })
  it("1,2s ≤ t < 4s → d1_typing (só o indicador, sem texto novo)", () => {
    expect(deriveWaitStep(WAIT_STEP_MS.TYPING)).toBe("d1_typing")
    expect(deriveWaitStep(2500)).toBe("d1_typing")
    expect(deriveWaitStep(WAIT_STEP_MS.NARRATED - 1)).toBe("d1_typing")
  })
  it("4s ≤ t < 10s → d2_narrated (troca a copy)", () => {
    expect(deriveWaitStep(WAIT_STEP_MS.NARRATED)).toBe("d2_narrated")
    expect(deriveWaitStep(7000)).toBe("d2_narrated")
    expect(deriveWaitStep(WAIT_STEP_MS.SLOW - 1)).toBe("d2_narrated")
  })
  it("10s ≤ t < 15s → d3_slow (abre saídas SEM cancelar a espera)", () => {
    expect(deriveWaitStep(WAIT_STEP_MS.SLOW)).toBe("d3_slow")
    expect(deriveWaitStep(12000)).toBe("d3_slow")
    expect(deriveWaitStep(WAIT_STEP_MS.DEGRADED - 1)).toBe("d3_slow")
  })
  it("t ≥ 15s → d4_degraded (encerra o visual → menu de degradação)", () => {
    expect(deriveWaitStep(WAIT_STEP_MS.DEGRADED)).toBe("d4_degraded")
    expect(deriveWaitStep(60000)).toBe("d4_degraded")
  })
  it("elapsed inválido/negativo/não-finito → d0 (nunca pula degraus)", () => {
    expect(deriveWaitStep(NaN)).toBe("d0_suppressed")
    expect(deriveWaitStep(-500)).toBe("d0_suppressed")
    // Infinity NÃO é um elapsed real → tratado como inválido (d0), não degrada.
    expect(deriveWaitStep(Infinity)).toBe("d0_suppressed")
  })
})

describe("elapsedSince — âncora única de tempo (wait_started_at)", () => {
  it("calcula ms desde o wait_started_at ISO", () => {
    const started = "2026-09-24T12:00:00.000Z"
    const now = Date.parse("2026-09-24T12:00:05.000Z")
    expect(elapsedSince(started, now)).toBe(5000)
  })
  it("wait_started_at ausente/nulo → 0", () => {
    expect(elapsedSince(null, Date.now())).toBe(0)
    expect(elapsedSince(undefined, Date.now())).toBe(0)
    expect(elapsedSince("não-é-data", Date.now())).toBe(0)
  })
  it("nunca negativo (relógio do cliente atrás do servidor)", () => {
    const started = "2026-09-24T12:00:10.000Z"
    const now = Date.parse("2026-09-24T12:00:05.000Z")
    expect(elapsedSince(started, now)).toBe(0)
  })
})

describe("indicador e saídas por degrau (M18 / §6.3)", () => {
  it("indicador 'digitando' SÓ de d1 em diante (supressão inicial em d0)", () => {
    expect(shouldShowTypingIndicator("d0_suppressed")).toBe(false)
    expect(shouldShowTypingIndicator("d1_typing")).toBe(true)
    expect(shouldShowTypingIndicator("d2_narrated")).toBe(true)
    expect(shouldShowTypingIndicator("d3_slow")).toBe(true)
    // em d4 o visual da espera é DESLIGADO (a UI mostra o menu de degradação)
    expect(shouldShowTypingIndicator("d4_degraded")).toBe(false)
  })
  it("saídas ['Pagar agora'/'Atendimento'] só em d3 e d4 (aos 10s+)", () => {
    expect(shouldShowSlowExits("d0_suppressed")).toBe(false)
    expect(shouldShowSlowExits("d1_typing")).toBe(false)
    expect(shouldShowSlowExits("d2_narrated")).toBe(false)
    expect(shouldShowSlowExits("d3_slow")).toBe(true)
    expect(shouldShowSlowExits("d4_degraded")).toBe(true)
  })
})

describe("copy narrada (03-copy.md §2/§4) — sem termos técnicos", () => {
  it("d0/d1 não têm texto próprio (eco A.2 do servidor permanece)", () => {
    expect(waitStepCopy("d0_suppressed")).toBe("")
    expect(waitStepCopy("d1_typing")).toBe("")
  })
  it("d2 = progresso narrado (consulta das condições)", () => {
    expect(waitStepCopy("d2_narrated")).toContain("consultando as condições")
  })
  it("d3 = 'demorando um pouco mais' + convite a resolver agora", () => {
    expect(waitStepCopy("d3_slow")).toContain("demorando um pouco mais")
  })
  it("nenhuma copy de espera cita n8n/HTTP/erro técnico/sistema externo", () => {
    const all = [
      waitStepCopy("d2_narrated"),
      waitStepCopy("d3_slow"),
      DEGRADED_MENU_COPY,
    ].join(" ")
    expect(all).not.toMatch(/n8n|http|erro|exception|timeout|api|status/i)
  })
  it("copy de degradação (T10/R-31) é POSITIVA e oferece caminhos reais, sem tom vendedor", () => {
    // T10: sem "não te impede de resolver hoje" (vendedor) e sem expor falha interna.
    expect(DEGRADED_MENU_COPY).not.toContain("não te impede de resolver hoje")
    // oferece os 3 caminhos: pagar à vista, tentar de novo, atendimento.
    expect(DEGRADED_MENU_COPY).toContain("pague o valor à vista")
    expect(DEGRADED_MENU_COPY).toMatch(/tente as opções de novo/i)
    expect(DEGRADED_MENU_COPY).toMatch(/atendimento/i)
    // enquadra positivo: "Você ainda pode resolver".
    expect(DEGRADED_MENU_COPY).toContain("Você ainda pode resolver")
  })
})

describe("resposta tardia (M12) — estados ABSORVENTES", () => {
  it("link_entregue/quitada/nao_reconhecida ABSORVEM a msg do motor (descarta)", () => {
    expect(isAbsorbingForEngineMsg("link_entregue")).toBe(true)
    expect(isAbsorbingForEngineMsg("quitada")).toBe(true)
    expect(isAbsorbingForEngineMsg("nao_reconhecida")).toBe(true)
    expect(shouldRenderEngineMsg("link_entregue")).toBe(false)
    expect(shouldRenderEngineMsg("quitada")).toBe(false)
    expect(shouldRenderEngineMsg("nao_reconhecida")).toBe(false)
  })
  it("menu_degradado NÃO é absorvente → a tardia RENDERIZA (ainda útil)", () => {
    expect(isAbsorbingForEngineMsg("menu_degradado")).toBe(false)
    expect(shouldRenderEngineMsg("menu_degradado")).toBe(true)
  })
  it("aguardando_motor/negociando renderizam a msg do motor (fluxo normal)", () => {
    expect(shouldRenderEngineMsg("aguardando_motor")).toBe(true)
    expect(shouldRenderEngineMsg("negociando")).toBe(true)
  })
})

describe("hydrateWaitState — reidratação segura no reload (M11)", () => {
  it("aceita só os estados persistíveis conhecidos", () => {
    for (const s of PERSISTED_WAIT_STATES) {
      expect(hydrateWaitState({ wait_state: s, wait_started_at: null })).toBe(s)
    }
  })
  it("wait_state null/ausente → idle (comportamento de hoje)", () => {
    expect(hydrateWaitState({ wait_state: null })).toBe("idle")
    expect(hydrateWaitState({})).toBe("idle")
    expect(hydrateWaitState(null)).toBe("idle")
  })
  it("estado desconhecido (coluna M-4 com valor estranho) → idle (nunca quebra)", () => {
    expect(hydrateWaitState({ wait_state: "negociando" })).toBe("idle") // não persistível
    expect(hydrateWaitState({ wait_state: "xpto" })).toBe("idle")
  })
})

describe("resolveWaitView — o que o client mostra no reload (§2)", () => {
  const base = Date.parse("2026-09-24T12:00:00.000Z")
  it("reabrir aos 8s de 'aguardando_motor' cai direto no degrau d2 (>=4s)", () => {
    const started = "2026-09-24T11:59:52.000Z" // 8s atrás
    const view = resolveWaitView("aguardando_motor", started, base)
    expect(view.state).toBe("aguardando_motor")
    expect(view.step).toBe("d2_narrated")
    expect(view.elapsedMs).toBe(8000)
  })
  it("reabrir após 15s de 'aguardando_motor' entra JÁ em menu_degradado (não recomeça a animação)", () => {
    const started = "2026-09-24T11:59:40.000Z" // 20s atrás
    const view = resolveWaitView("aguardando_motor", started, base)
    expect(view.state).toBe("menu_degradado")
    expect(view.step).toBe("d4_degraded")
  })
  it("reabrir recém-iniciado (<1,2s) mantém d0 (indicador suprimido)", () => {
    const started = "2026-09-24T11:59:59.500Z" // 0,5s atrás
    const view = resolveWaitView("aguardando_motor", started, base)
    expect(view.state).toBe("aguardando_motor")
    expect(view.step).toBe("d0_suppressed")
  })
  it("menu_degradado persistido reidrata em d4 (visual desligado)", () => {
    const view = resolveWaitView("menu_degradado", "2026-09-24T11:59:40.000Z", base)
    expect(view.state).toBe("menu_degradado")
    expect(view.step).toBe("d4_degraded")
  })
  it("estados de PAGAR/nao_reconhecida passam intactos (não são espera de tempo)", () => {
    for (const s of ["link_entregue", "erro_cobranca", "gerando_cobranca", "nao_reconhecida"] as WaitState[]) {
      const view = resolveWaitView(s, null, base)
      expect(view.state).toBe(s)
      expect(view.step).toBe("d0_suppressed")
    }
  })
})
