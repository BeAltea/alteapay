// Fallback SEM Redis: EMAIL_SEND_MODE=inline envia direto via SendGrid e NÃO
// toca a fila (emailQueue). Prova que um lote pequeno envia com o Upstash fora.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// A fila é mockada para LANÇAR (simula Upstash inacessível). Se o caminho inline
// tocasse a fila, o envio falharia — o teste garante que NÃO toca.
const addSpy = vi.fn(async () => {
  throw new Error("Redis indisponível (Upstash fora)")
})
vi.mock("@/lib/queue", () => ({
  emailQueue: { add: addSpy, addBulk: addSpy, getJobCounts: vi.fn(async () => ({})) },
}))

const sendDirectSpy = vi.fn(async () => ({ success: true, messageId: "sg-inline-123" }))
vi.mock("@/lib/notifications/sendgrid", () => ({
  sendEmailViaSendGrid: sendDirectSpy,
}))

describe("sendEmail — fallback inline sem Redis", () => {
  const prev = process.env.EMAIL_SEND_MODE
  beforeEach(() => {
    addSpy.mockClear()
    sendDirectSpy.mockClear()
    process.env.EMAIL_SEND_MODE = "inline"
  })
  afterEach(() => {
    process.env.EMAIL_SEND_MODE = prev
  })

  it("envia direto via SendGrid e NÃO enfileira", async () => {
    const { sendEmail } = await import("@/lib/notifications/email")
    const r = await sendEmail({
      to: "fabiofmb71@gmail.com",
      subject: "Teste inline",
      html: "<p>Olá <a href='https://alteapay.com/n/abc'>negociar</a></p>",
    })
    expect(r.success).toBe(true)
    expect(r.messageId).toBe("sg-inline-123")
    expect(sendDirectSpy).toHaveBeenCalledTimes(1)
    expect(addSpy).not.toHaveBeenCalled() // a fila (Redis) nunca é tocada
  })

  it("propaga headers (List-Unsubscribe) no inline", async () => {
    const { sendEmail } = await import("@/lib/notifications/email")
    await sendEmail({
      to: "fabiofmb71@gmail.com",
      subject: "Teste",
      html: "<p>x</p>",
      headers: { "List-Unsubscribe": "<https://alteapay.com/u/x>" },
    })
    expect(sendDirectSpy).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { "List-Unsubscribe": "<https://alteapay.com/u/x>" } }),
    )
  })

  it("com Redis fora, o inline NÃO propaga a exceção da fila", async () => {
    const { sendEmail } = await import("@/lib/notifications/email")
    const r = await sendEmail({ to: "x@y.com", subject: "s", html: "<p>h</p>" })
    expect(r.success).toBe(true) // não travou no add() que lança
  })
})
