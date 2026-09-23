// Painel de resultado do envio (send-dialog) — lógica PURA e testável.
//
// Regressão do bug "após a barra de progresso, nada é exibido": o painel de
// resultado precisa SEMPRE aparecer após qualquer envio (stream OU json, real OU
// dry-run) e mesmo quando o servidor devolve um payload parcial/vazio (ex.: o
// evento `done` do stream se perde num proxy). Estas funções são o coração da
// decisão de render/resumo e vivem em send-contract.ts justamente para poderem
// ser exercitadas aqui sem jsdom.

import { describe, expect, it } from "vitest"
import {
  normalizeSendResult,
  resolveDialogView,
  sendPanelHeadline,
  summarizeByChannel,
  summarizeForDisplay,
  type SendResponse,
} from "@/components/super-admin/negotiations/send-contract"

// resultado real "feliz": 2 aceitos no WhatsApp, 1 enviado + 1 falha no e-mail.
const REAL: SendResponse = {
  dryRun: false,
  channels: ["whatsapp", "email"],
  counts: { sent: 3, failed: 1, suppressed: 0, skipped: 0 },
  results: [
    { customerId: "c1", documentMasked: "***.**", channel: "whatsapp", outcome: "sent" },
    { customerId: "c2", documentMasked: "***.**", channel: "whatsapp", outcome: "sent" },
    { customerId: "c3", documentMasked: "***.**", channel: "email", outcome: "sent" },
    { customerId: "c4", documentMasked: "***.**", channel: "email", outcome: "failed", detail: "email_failed" },
  ],
}

describe("resolveDialogView — precedência barra → painel → formulário", () => {
  it("sending=true → 'progress' (mostra a barra)", () => {
    expect(resolveDialogView({ sending: true, result: null })).toBe("progress")
  })

  it("sending=false + result → 'result' (barra some, painel aparece)", () => {
    expect(resolveDialogView({ sending: false, result: REAL })).toBe("result")
  })

  it("sending=false + sem result → 'form' (volta ao formulário; permite novo envio)", () => {
    expect(resolveDialogView({ sending: false, result: null })).toBe("form")
  })

  it("a barra NUNCA prende o painel: assim que sending baixa e há result, é 'result'", () => {
    // simula a transição do fim do envio (o bug era o painel não aparecer aqui).
    expect(resolveDialogView({ sending: false, result: normalizeSendResult(REAL) })).toBe("result")
  })
})

describe("sendPanelHeadline — cabeçalho certo por desfecho", () => {
  it("envio real sem falha → '✓ Envio concluído' (sucesso)", () => {
    const h = sendPanelHeadline({ ...REAL, counts: { sent: 3, failed: 0, suppressed: 0, skipped: 0 } })
    expect(h.tone).toBe("success")
    expect(h.title).toContain("✓")
    expect(h.title).toMatch(/conclu/i)
  })

  it("envio real com falha → '⚠ Envio com falhas' (atenção; não esconde a falha)", () => {
    const h = sendPanelHeadline(REAL)
    expect(h.tone).toBe("warning")
    expect(h.title).toContain("⚠")
    expect(h.title).toMatch(/falha/i)
  })

  it("dry-run → 'Simulação concluída' (mesmo com 'falha' simulada, é simulação)", () => {
    const h = sendPanelHeadline({ ...REAL, dryRun: true })
    expect(h.tone).toBe("dryRun")
    expect(h.title).toMatch(/simula/i)
  })

  it("resultado vazio → sucesso, hasItems=false (o painel diz 'nenhum item')", () => {
    const h = sendPanelHeadline(normalizeSendResult({ dryRun: false, results: [] }))
    expect(h.tone).toBe("success")
    expect(h.hasItems).toBe(false)
  })
})

describe("normalizeSendResult — SEMPRE devolve um SendResponse íntegro", () => {
  it("payload completo passa intacto", () => {
    const n = normalizeSendResult(REAL)
    expect(n.counts).toEqual(REAL.counts)
    expect(n.results.length).toBe(4)
    expect(n.dryRun).toBe(false)
  })

  it("null (stream sem evento `done`) → resultado vazio válido usando o fallback", () => {
    const n = normalizeSendResult(null, { dryRun: false, channels: ["whatsapp"] })
    expect(n.results).toEqual([])
    expect(n.counts).toEqual({ sent: 0, failed: 0, suppressed: 0, skipped: 0 })
    expect(n.dryRun).toBe(false)
    expect(n.channels).toEqual(["whatsapp"])
  })

  it("counts ausentes/parciais → RECOMPUTA das linhas (não confia em contador perdido)", () => {
    const n = normalizeSendResult({
      dryRun: false,
      results: [
        { customerId: "a", documentMasked: "***", channel: "whatsapp", outcome: "sent" },
        { customerId: "b", documentMasked: "***", channel: "email", outcome: "failed" },
        { customerId: "c", documentMasked: "***", channel: "email", outcome: "skipped" },
      ],
      // counts propositalmente ausente
    })
    expect(n.counts).toEqual({ sent: 1, failed: 1, suppressed: 0, skipped: 1 })
  })

  it("descarta linhas malformadas (defensivo a JSON solto), preserva as válidas", () => {
    const n = normalizeSendResult({
      dryRun: false,
      results: [
        { customerId: "a", documentMasked: "***", channel: "whatsapp", outcome: "sent" },
        { nope: true }, // sem customerId/outcome → descartada
        { customerId: "b", outcome: "banana" }, // outcome inválido → descartada
      ],
    })
    expect(n.results.length).toBe(1)
    expect(n.results[0].customerId).toBe("a")
    expect(n.counts.sent).toBe(1)
  })

  it("fallback preenche dryRun quando o servidor omite (o painel sabe que é simulação)", () => {
    const n = normalizeSendResult({ results: [] }, { dryRun: true })
    expect(n.dryRun).toBe(true)
  })

  it("nunca lança para entradas absurdas (string, número, array)", () => {
    for (const bad of ["x", 42, [], undefined as unknown]) {
      const n = normalizeSendResult(bad)
      expect(Array.isArray(n.results)).toBe(true)
      expect(n.counts).toEqual({ sent: 0, failed: 0, suppressed: 0, skipped: 0 })
    }
  })
})

describe("resumo por canal do painel (sem PII)", () => {
  it("summarizeByChannel conta por (devedor, canal) na ordem canônica", () => {
    const by = summarizeByChannel(REAL)
    expect(by.map((c) => c.channel)).toEqual(["whatsapp", "email"])
    expect(by[0]).toMatchObject({ channel: "whatsapp", sent: 2, failed: 0 })
    expect(by[1]).toMatchObject({ channel: "email", sent: 1, failed: 1 })
  })

  it("summarizeForDisplay separa enviadas de simuladas conforme dryRun", () => {
    expect(summarizeForDisplay(REAL)).toMatchObject({ enviadas: 3, simuladas: 0, falharam: 1 })
    expect(summarizeForDisplay({ ...REAL, dryRun: true })).toMatchObject({ enviadas: 0, simuladas: 3 })
  })
})
