import type { WhatsAppProvider } from "./types"
import { MockWhatsAppProvider } from "./mock-provider"
import { Dialog360Provider } from "./dialog360-provider"
import { MetaCloudProvider } from "./meta-cloud-provider"

let instance: WhatsAppProvider | null = null

/**
 * Provider selected by WHATSAPP_BSP_PROVIDER (mock | 360dialog | meta_cloud).
 * Canal dormante: enquanto WHATSAPP_CHANNEL_ENABLED != "1", o provider é
 * SEMPRE mock — nenhum envio real é possível, independente da seleção.
 */
export function getWhatsAppProvider(): WhatsAppProvider {
  if (instance) return instance
  const channelEnabled = process.env.WHATSAPP_CHANNEL_ENABLED === "1"
  const provider = channelEnabled
    ? (process.env.WHATSAPP_BSP_PROVIDER ?? "mock").toLowerCase()
    : "mock"
  switch (provider) {
    case "mock":
      instance = new MockWhatsAppProvider()
      break
    case "360dialog":
      instance = new Dialog360Provider()
      break
    case "meta_cloud":
      instance = new MetaCloudProvider()
      break
    default:
      throw new Error(`unknown WHATSAPP_BSP_PROVIDER "${provider}" (mock | 360dialog | meta_cloud)`)
  }
  return instance
}

export type { WhatsAppProvider, WhatsAppMessage, WhatsAppSendResult, InboundWhatsAppMessage } from "./types"
