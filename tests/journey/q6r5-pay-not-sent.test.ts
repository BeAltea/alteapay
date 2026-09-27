// QA rodada 5 (Q6r5-01) — rede cai no clique do PAGAR: o POST nunca chega ao
// servidor, a recuperação entra em 'processing' retomado e o poll devolve o
// MESMO menu clicado. Antes, o menu voltava em silêncio (G1). Agora o menu
// conduz com um aviso humano. Regra pura (pay-poll.ts) + wire-up (chat.tsx).
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { decidePayResume, PAY_NOT_SENT_MIN_MS, PAY_NOT_SENT_NOTICE, PAY_NOT_SENT_OFFER_NOTICE } from "@/lib/journey/pay-poll"

const base = {
  serverWaitState: null,
  localWaitState: "gerando_cobranca",
  payInFlight: false,
  resumed: true,
  hasActivePrompt: true,
  linkDelivered: false,
  msSinceClick: PAY_NOT_SENT_MIN_MS,
}

describe("Q6r5-01 regra pura — decidePayResume com clique não recebido", () => {
  it("menu clicado ainda ativo + espera retomada do Pagar → settle_idle_not_sent", () => {
    expect(decidePayResume({ ...base, clickNotReceived: true })).toBe("settle_idle_not_sent")
  })

  it("cedo demais desde o clique (POST lento ainda pode chegar) → segue esperando (Dev B #1)", () => {
    expect(decidePayResume({ ...base, clickNotReceived: true, msSinceClick: PAY_NOT_SENT_MIN_MS - 1 })).toBe("none")
    expect(decidePayResume({ ...base, clickNotReceived: true, msSinceClick: undefined })).toBe("none")
    expect(PAY_NOT_SENT_MIN_MS).toBeGreaterThanOrEqual(10_000)
  })

  it("prompt diferente do clicado (o servidor consumiu o clique) → settle_idle, como antes", () => {
    expect(decidePayResume({ ...base, clickNotReceived: false })).toBe("settle_idle")
    expect(decidePayResume(base)).toBe("settle_idle")
  })

  it("nunca sobrepõe estados do servidor, POST em voo nem link entregue", () => {
    expect(decidePayResume({ ...base, clickNotReceived: true, serverWaitState: "gerando_cobranca" })).toBe("none")
    expect(decidePayResume({ ...base, clickNotReceived: true, payInFlight: true })).toBe("none")
    expect(decidePayResume({ ...base, clickNotReceived: true, linkDelivered: true })).toBe("none")
    expect(decidePayResume({ ...base, clickNotReceived: true, hasActivePrompt: false })).toBe("none")
  })

  it("erro local com o menu na tela continua settle_idle (Q2r2-02 intacto)", () => {
    expect(decidePayResume({ ...base, localWaitState: "erro_cobranca", clickNotReceived: true })).toBe("settle_idle")
  })

  it("os avisos seguem a carta de voz: humanos, sem código, sem afirmar cobrança, com o caminho de volta", () => {
    for (const n of [PAY_NOT_SENT_NOTICE, PAY_NOT_SENT_OFFER_NOTICE]) {
      expect(n).toMatch(/^Não consegui gerar o link agora\./)
      expect(n).not.toMatch(/[!—]|erro|error|cobrança|\d{3}/i)
    }
    expect(PAY_NOT_SENT_NOTICE).toMatch(/Pagar/)
    expect(PAY_NOT_SENT_OFFER_NOTICE).toMatch(/opção/)
  })
})

describe("Q6r5-01 client (chat.tsx) — wire-up (leitura do fonte)", () => {
  const src = readFileSync(join(__dirname, "..", "..", "components", "journey", "chat.tsx"), "utf8")

  it("o clique do Pagar guarda o prompt clicado e o reconcile compara com o prompt ativo", () => {
    expect(src).toContain("payClickedPromptIdRef.current = promptId")
    const rec = src.slice(src.indexOf("function reconcilePayWait("), src.indexOf("useEffect(() => {\n    // MONTAGEM"))
    expect(rec).toContain("clickNotReceived:")
    expect(rec).toContain("activePromptRef.current?.id === payClickedPromptIdRef.current")
  })

  it("settle_idle_not_sent volta ao menu e mostra o aviso (Pagar ou parcela)", () => {
    const rec = src.slice(src.indexOf("function reconcilePayWait("), src.indexOf("useEffect(() => {\n    // MONTAGEM"))
    expect(rec).toContain('decision === "settle_idle_not_sent"')
    expect(rec).toContain("wasOffer ? PAY_NOT_SENT_OFFER_NOTICE : PAY_NOT_SENT_NOTICE")
    expect(rec).toContain('setWaitState("idle")')
    expect(rec).toContain("msSinceClick:")
  })

  it("o aviso some com link, espera retomada ou erro do servidor; o clique é esquecido no desfecho (Dev B #2/#4)", () => {
    const rec = src.slice(src.indexOf("function reconcilePayWait("), src.indexOf("useEffect(() => {\n    // MONTAGEM"))
    expect(rec).toContain('if (liveLinkSeen || decision === "resume_generating" || decision === "show_error") clearNotSentNotice()')
    const apply = src.slice(src.indexOf("function applyPayResult("), src.indexOf("function clearWaitForPayFailure("))
    expect(apply).toContain("forgetPayClick()")
    const reset = src.slice(src.indexOf("function resetWaitToIdle("), src.indexOf("function clearLinkLocalState("))
    expect(reset).toContain("forgetPayClick()")
  })
})
