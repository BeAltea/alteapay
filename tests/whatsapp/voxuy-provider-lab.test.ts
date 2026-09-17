// Laboratório (V7): exercita o VoxuyProvider no caminho MOCK_ALL_INTEGRATIONS=1
// (não sai do processo, mas valida o contrato do payload). Cobre idempotência de
// id, sendStopSignal, syncSuppression=stop e o fato de `accepted` nunca virar
// `delivered`.
import { beforeAll, describe, expect, it } from "vitest"

beforeAll(() => {
  process.env.MOCK_ALL_INTEGRATIONS = "1"
})

async function makeProvider() {
  const { VoxuyProvider } = await import("@/lib/whatsapp/voxuy/provider")
  return new VoxuyProvider()
}

const baseInput = {
  companyId: "co1",
  messageId: "11111111-2222-3333-4444-555555555555",
  to: "+5511912341234",
  customerName: "Fabio Silva",
  document: "12345678901",
  templateKey: "default",
  variables: {
    consult_url: "https://alteapay.com/c/AbC",
    optout_url: "https://alteapay.com/c/AbC/cancelar",
    block_url: "https://alteapay.com/c/AbC/bloquear",
    brand_name: "AlteaPay",
    sender_label: "AlteaPay",
    creditor_name: "VMAX",
    first_name: "Fabio",
  },
  voxuyPlanId: "plan_x",
  voxuyEvent: 63,
}

describe("VoxuyProvider — laboratório (mock)", () => {
  it("sem credencial não lança em mock e aceita a mensagem", async () => {
    const p = await makeProvider()
    const r = await p.sendCampaignMessage(baseInput)
    expect(r.accepted).toBe(true)
    // id externo estável = whatsapp_messages.id (idempotência de envio)
    expect(r.providerMessageId).toBe(baseInput.messageId)
  })

  it("reenviar com o MESMO messageId produz o MESMO id externo (atualiza, não duplica)", async () => {
    const p = await makeProvider()
    const a = await p.sendCampaignMessage(baseInput)
    const b = await p.sendCampaignMessage(baseInput)
    expect(a.providerMessageId).toBe(b.providerMessageId)
  })

  it("sendStopSignal aceita e usa id determinístico stop_<customer>_<epoch>", async () => {
    const p = await makeProvider()
    const r = await p.sendStopSignal!({
      companyId: "co1",
      phone: "+5511912341234",
      customerId: "cust-9",
      voxuyPlanId: "plan_x",
      voxuyEvent: 64,
      brandName: "AlteaPay",
      creditorName: "VMAX",
    })
    expect(r.accepted).toBe(true)
    expect(r.providerMessageId).toMatch(/^stop_cust-9_\d+$/)
  })

  it("syncSuppression é implementado como stop (não lança)", async () => {
    const p = await makeProvider()
    await expect(
      p.syncSuppression!({ phone: "+5511912341234", reason: "optout", companyId: "co1", customerId: "cust-9" }),
    ).resolves.toBeUndefined()
  })

  it("aceite NUNCA carrega status de entrega (accepted != delivered)", async () => {
    const p = await makeProvider()
    const r = await p.sendCampaignMessage(baseInput)
    // O provider só devolve accepted; nada de delivered/read no resultado.
    expect(r).not.toHaveProperty("delivered")
    expect(r.accepted).toBe(true)
    expect((r.raw as { mock?: boolean })?.mock).toBe(true)
  })
})

describe("jobId da fila (V8) — sem ':'", () => {
  it("o formato wa_<campaign>_<customer> não contém ':'", () => {
    const campaignId = "cmp-1"
    const customerId = "cus-2"
    const jobId = `wa_${campaignId}_${customerId}`
    expect(jobId).not.toContain(":")
    expect(jobId).toBe("wa_cmp-1_cus-2")
  })
})
