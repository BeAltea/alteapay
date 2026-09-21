// T2 — convite de negociação por e-mail (mesmo link do chat, sem cobrança).
import { beforeEach, describe, expect, it, vi } from "vitest"

let sent: any[] = []
let sendResult: { success: boolean; jobId?: string; error?: string } = { success: true, jobId: "job_1" }

vi.mock("@/lib/notifications/email", () => ({
  sendEmail: async (p: any) => {
    sent.push(p)
    return sendResult
  },
}))

beforeEach(() => {
  sent = []
  sendResult = { success: true, jobId: "job_1" }
})

describe("buildEmailInviteHtml", () => {
  it("inclui o link do chat e o cedente, sem valores de cobrança", async () => {
    const { buildEmailInviteHtml } = await import("@/lib/journey/email-dispatch")
    const html = buildEmailInviteHtml({
      customerName: "Maria Silva",
      brandName: "AlteaPay",
      creditorName: "VMAX",
      link: "https://app.example.com/n/k7Qm3Xb9Rt",
    })
    expect(html).toContain("https://app.example.com/n/k7Qm3Xb9Rt")
    expect(html).toContain("VMAX")
    // corpo neutro de dívida: não expõe valor/boleto
    expect(html).not.toMatch(/R\$\s*\d/)
    expect(html.toLowerCase()).not.toContain("boleto")
    // usa o primeiro nome
    expect(html).toContain("Maria,")
  })
})

describe("dispatchEmailInvite", () => {
  it("rejeita e-mail inválido sem enfileirar", async () => {
    const { dispatchEmailInvite } = await import("@/lib/journey/email-dispatch")
    const r = await dispatchEmailInvite({
      to: "naoehemail",
      customerName: "X",
      brandName: "AlteaPay",
      creditorName: "VMAX",
      link: "https://app/n/abc",
      companyId: "co",
      customerId: "cust",
    })
    expect(r.ok).toBe(false)
    expect(r.error).toBe("email_invalido")
    expect(sent.length).toBe(0)
  })

  it("dryRun monta o corpo mas NÃO enfileira", async () => {
    const { dispatchEmailInvite } = await import("@/lib/journey/email-dispatch")
    const r = await dispatchEmailInvite({
      to: "cliente@dominio.com",
      customerName: "X",
      brandName: "AlteaPay",
      creditorName: "VMAX",
      link: "https://app/n/abc",
      companyId: "co",
      customerId: "cust",
      dryRun: true,
    })
    expect(r.ok).toBe(true)
    expect(r.previewed).toBe(true)
    expect(sent.length).toBe(0)
  })

  it("enfileira via SendGrid com metadata de convite e retorna jobId", async () => {
    const { dispatchEmailInvite } = await import("@/lib/journey/email-dispatch")
    const r = await dispatchEmailInvite({
      to: "cliente@dominio.com",
      customerName: "X",
      brandName: "AlteaPay",
      creditorName: "VMAX",
      link: "https://app/n/abc",
      companyId: "co",
      customerId: "cust",
    })
    expect(r.ok).toBe(true)
    expect(r.jobId).toBe("job_1")
    expect(sent.length).toBe(1)
    expect(sent[0].metadata.type).toBe("negotiation_invite")
    expect(sent[0].metadata.companyId).toBe("co")
    // o link vai no HTML
    expect(sent[0].html).toContain("https://app/n/abc")
  })

  it("propaga falha do provider como { ok:false }", async () => {
    const { dispatchEmailInvite } = await import("@/lib/journey/email-dispatch")
    sendResult = { success: false, error: "queue_down" }
    const r = await dispatchEmailInvite({
      to: "cliente@dominio.com",
      customerName: "X",
      brandName: "AlteaPay",
      creditorName: "VMAX",
      link: "https://app/n/abc",
      companyId: "co",
      customerId: "cust",
    })
    expect(r.ok).toBe(false)
    expect(r.error).toBe("queue_down")
  })
})
