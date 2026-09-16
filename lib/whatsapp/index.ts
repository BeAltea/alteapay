import { MockWhatsAppProvider } from "./mock"
import { VoxuyProvider } from "./voxuy"
import type { WhatsAppProvider } from "./provider"

export * from "./provider"

/**
 * Resolve o provider: preferência do tenant (tenant_chat_config.whatsapp_provider),
 * senão env WHATSAPP_PROVIDER, senão mock. Em produção o default é SEMPRE mock
 * até a Voxuy ser configurada (D14).
 */
export function getWhatsAppProvider(tenantProvider?: string | null): WhatsAppProvider {
  const name = tenantProvider ?? process.env.WHATSAPP_PROVIDER ?? "mock"
  if (name === "voxuy") return new VoxuyProvider()
  return new MockWhatsAppProvider()
}
