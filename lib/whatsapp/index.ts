import { MockWhatsAppProvider } from "./mock"
import { VoxuyProvider } from "./voxuy/provider"
import { VoxuyApiProvider } from "./voxuy/api-provider"
import { mapVoxuyInbound } from "./voxuy/inbound"
import type { VoxuyApiConfig } from "./voxuy/config"
import type { NormalizedWhatsAppEvent, WhatsAppProvider } from "./provider"

export * from "./provider"

/**
 * Modo de disparo do WhatsApp por tenant (tenant_chat_config.whatsapp_dispatch_mode):
 *   - `voxuy_api`: dispara pela API da Voxuy (VoxuyApiProvider; dialeto default
 *     `enterprise_v1` — contrato REAL verificado; legados `transaction_v1`/`custom`).
 *   - `mock`: nada sai do processo (DEFAULT, inclusive em produção).
 * Campos existentes em tenant_chat_config (dono: T1): whatsapp_dispatch_mode,
 * voxuy_request_config, voxuy_payload_template, voxuy_plan_id, voxuy_events,
 * voxuy_flow_id (integer).
 */
export type WhatsAppDispatchMode = "voxuy_api" | "mock"

export interface WhatsAppProviderSelector {
  /** whatsapp_dispatch_mode do tenant (ou undefined => usa env/default). */
  dispatchMode?: string | null
  /**
   * Compat: whatsapp_provider legado ('voxuy'|'mock'). Se dispatchMode não vier,
   * 'voxuy' é tratado como voxuy_api. Mantém o adapter transaction antigo vivo.
   */
  provider?: string | null
  /** Config completa do disparo por API (dialeto custom montado a partir do tenant). */
  apiConfig?: VoxuyApiConfig
}

/**
 * Resolve o modo de disparo efetivo. Ordem: dispatchMode do tenant →
 * whatsapp_provider legado → env WHATSAPP_DISPATCH_MODE → env WHATSAPP_PROVIDER
 * → mock. O DEFAULT é SEMPRE mock (nada é enviado sem configuração explícita),
 * inclusive em produção.
 */
export function resolveDispatchMode(sel?: string | WhatsAppProviderSelector | null): WhatsAppDispatchMode {
  const s: WhatsAppProviderSelector =
    typeof sel === "string" || sel == null ? { dispatchMode: sel ?? undefined } : sel
  const raw =
    s.dispatchMode ??
    s.provider ??
    process.env.WHATSAPP_DISPATCH_MODE ??
    process.env.WHATSAPP_PROVIDER ??
    "mock"
  // 'voxuy' (provider legado) e 'voxuy_api' significam disparo por API.
  if (raw === "voxuy_api" || raw === "voxuy") return "voxuy_api"
  return "mock"
}

/**
 * Resolve o provider para ENVIO. Aceita:
 *   - string legada (whatsapp_provider: 'voxuy'|'mock'), OU
 *   - seletor por-tenant ({ dispatchMode, provider, apiConfig }).
 *
 * Em produção o default é SEMPRE mock até o tenant configurar
 * whatsapp_dispatch_mode=voxuy_api (D14/V-trilho). Quando ativo, o dialeto
 * default do VoxuyApiProvider é `enterprise_v1` (contrato REAL). O construtor do
 * VoxuyApiProvider valida credenciais e RECUSA (lança VoxuyConfigError) quando
 * incompleto (V1.3) — a campanha nem inicia; o erro aparece no painel em vez de
 * falhar silenciosamente.
 */
export function getWhatsAppProvider(sel?: string | WhatsAppProviderSelector | null): WhatsAppProvider {
  const mode = resolveDispatchMode(sel)
  if (mode === "voxuy_api") {
    const apiConfig = typeof sel === "object" && sel ? sel.apiConfig : undefined
    return new VoxuyApiProvider(apiConfig)
  }
  return new MockWhatsAppProvider()
}

/**
 * Compat: mantém o VoxuyProvider (adapter transaction original) acessível para
 * chamadores que já o instanciavam diretamente. Novos callers devem usar
 * getWhatsAppProvider (fábrica) — que hoje devolve o VoxuyApiProvider.
 */
export { VoxuyProvider, VoxuyApiProvider }

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
