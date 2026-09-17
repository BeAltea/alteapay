import { MockWhatsAppProvider } from "./mock"
import { VoxuyProvider } from "./voxuy/provider"
import { mapVoxuyInbound } from "./voxuy/inbound"
import type { NormalizedWhatsAppEvent, WhatsAppProvider } from "./provider"

export * from "./provider"

/**
 * Resolve o provider para ENVIO: preferência do tenant
 * (tenant_chat_config.whatsapp_provider), senão env WHATSAPP_PROVIDER, senão
 * mock. Em produção o default é SEMPRE mock até a Voxuy ser configurada por
 * tenant (D14/V-trilho). O construtor do VoxuyProvider valida credenciais e
 * RECUSA (lança VoxuyConfigError) quando incompleto (V1.3) — a campanha nem
 * inicia, o erro aparece no painel em vez de falhar silenciosamente.
 */
export function getWhatsAppProvider(tenantProvider?: string | null): WhatsAppProvider {
  const name = tenantProvider ?? process.env.WHATSAPP_PROVIDER ?? "mock"
  if (name === "voxuy") return new VoxuyProvider()
  return new MockWhatsAppProvider()
}

/**
 * Parse de INBOUND sem exigir credenciais de envio. A rota de captura só
 * precisa normalizar o corpo; construir o VoxuyProvider inteiro (que valida
 * VOXUY_WEBHOOK_URL/TOKEN) seria acoplamento indevido — a captura tem que
 * funcionar mesmo antes das credenciais de envio existirem.
 */
export async function parseInboundFor(
  providerName: string,
  rawBody: string,
  headers: Headers,
): Promise<NormalizedWhatsAppEvent[]> {
  if (providerName === "voxuy") return mapVoxuyInbound(rawBody, headers)
  return new MockWhatsAppProvider().parseInboundEvent(rawBody)
}
