import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"

import { syntheticDob } from "@/lib/negotiation/whatsapp-flow"

describe("canal WhatsApp dormante", () => {
  it("syntheticDob replica exatamente o algoritmo do agente (platform_data._training_dob)", () => {
    // sha256(doc): year=1955+h[0]%45, month=1+h[1]%12, day=1+h[2]%28
    const doc = "11144477735"
    const h = createHash("sha256").update(doc).digest()
    const expected = `${1955 + (h[0] % 45)}-${String(1 + (h[1] % 12)).padStart(2, "0")}-${String(
      1 + (h[2] % 28),
    ).padStart(2, "0")}`
    expect(syntheticDob(doc)).toBe(expected)
    // formatação do documento não altera a DOB (digits-only, regra 3)
    expect(syntheticDob("111.444.777-35")).toBe(expected)
  })

  it("flag OFF força provider mock mesmo com meta_cloud selecionado", async () => {
    process.env.WHATSAPP_CHANNEL_ENABLED = "0"
    process.env.WHATSAPP_BSP_PROVIDER = "meta_cloud"
    const { getWhatsAppProvider } = await import("@/lib/notifications/whatsapp")
    expect(getWhatsAppProvider().name).toBe("mock")
  })

  it("meta_cloud sem credenciais falha explicitamente no envio", async () => {
    const { MetaCloudProvider } = await import("@/lib/notifications/whatsapp/meta-cloud-provider")
    const provider = new MetaCloudProvider()
    await expect(provider.sendMessage({ to: "5511999998888", text: "oi" })).rejects.toThrow(
      /sem credenciais reais/,
    )
  })

  it("parser meta_cloud extrai mensagens do envelope Cloud API", async () => {
    const { MetaCloudProvider } = await import("@/lib/notifications/whatsapp/meta-cloud-provider")
    const provider = new MetaCloudProvider()
    const inbound = provider.parseInboundWebhook({
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  { from: "5511988887777", id: "wamid.1", timestamp: "1700000000", text: { body: "olá" } },
                ],
              },
            },
          ],
        },
      ],
    })
    expect(inbound).toEqual([
      { from: "5511988887777", text: "olá", messageId: "wamid.1", timestamp: "1700000000" },
    ])
  })
})
