// Propagação de headers custom até o corpo do SendGrid (mail/send).
//
// Testa a função pura `buildSendGridRequestBody` do email.worker sem subir o
// worker BullMQ nem tocar Redis: mockamos `../worker-manager` (o import do
// módulo registra um Worker) e o mock-mode.
import { describe, expect, it, vi } from "vitest"

// registerWorker retorna um objeto com .on() para não quebrar o encadeamento
// (`emailWorker.on('completed', ...)`) no topo do módulo do worker.
vi.mock("@/lib/queue/worker-manager", () => ({
  WorkerManager: {
    registerWorker: () => ({ on: () => {} }),
  },
}))

vi.mock("@/lib/integrations/mock-mode", () => ({
  isMockMode: () => false,
  mockHex: () => "deadbeef",
}))

const baseFrom = { email: "cobranca@alteapay.com", name: "AlteaPay" }

describe("buildSendGridRequestBody", () => {
  it("inclui headers custom no corpo do mail/send quando fornecidos", async () => {
    const { buildSendGridRequestBody } = await import("@/lib/queue/workers/email.worker")
    const body = buildSendGridRequestBody(
      {
        to: "cliente@dominio.com",
        subject: "Negociação disponível - VMAX",
        html: "<p>oi</p>",
        headers: {
          "List-Unsubscribe": "<https://app/n/abc>",
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      },
      baseFrom,
    )
    expect(body.headers).toEqual({
      "List-Unsubscribe": "<https://app/n/abc>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    })
  })

  it("não adiciona a chave headers quando ausente ou vazia (compat com chamadas antigas)", async () => {
    const { buildSendGridRequestBody } = await import("@/lib/queue/workers/email.worker")

    const noHeaders = buildSendGridRequestBody(
      { to: "cliente@dominio.com", subject: "s", html: "<p>x</p>" },
      baseFrom,
    )
    expect("headers" in noHeaders).toBe(false)

    const emptyHeaders = buildSendGridRequestBody(
      { to: "cliente@dominio.com", subject: "s", html: "<p>x</p>", headers: {} },
      baseFrom,
    )
    expect("headers" in emptyHeaders).toBe(false)
  })

  it("mantém personalizations, from, subject, content e reply_to", async () => {
    const { buildSendGridRequestBody } = await import("@/lib/queue/workers/email.worker")
    const body = buildSendGridRequestBody(
      {
        to: ["a@x.com", "b@x.com"],
        subject: "assunto",
        html: "<p>corpo</p>",
        text: "corpo",
        replyTo: "reply@alteapay.com",
      },
      baseFrom,
    )
    expect(body.personalizations).toEqual([
      { to: [{ email: "a@x.com" }] },
      { to: [{ email: "b@x.com" }] },
    ])
    expect(body.from).toEqual(baseFrom)
    expect(body.subject).toBe("assunto")
    expect(body.reply_to).toEqual({ email: "reply@alteapay.com" })
    expect(body.content).toEqual([
      { type: "text/plain", value: "corpo" },
      { type: "text/html", value: "<p>corpo</p>" },
    ])
  })
})
