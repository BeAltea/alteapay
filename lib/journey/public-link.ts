// Resolução do LINK ÚNICO público /n/{code} (Hub §7).
//
// Diferente do token de campanha (/c/{token}, credencial forte por pessoa) e do
// slug genérico (/t/{slug}, revela o credor na URL), o link único é UM código
// opaco por cedente. O code NÃO é credencial de identidade — quem autentica é o
// documento (+ captcha/rate-limit). O code só endereça o tenant e a janela de
// campanha.
//
// Regras de disponibilidade (todas obrigatórias):
//   - code inexistente                       → indisponível (não revela nada)
//   - public_link_enabled = false            → indisponível
//   - public_link_valid_until no passado     → indisponível
// Em qualquer caso indisponível o chamador mostra a MESMA página neutra
// ("não há negociação disponível") — nunca um 404 que ajude a enumerar códigos.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

export interface PublicLinkTenant {
  companyId: string
  code: string
}

export type PublicLinkResult =
  | { ok: true; tenant: PublicLinkTenant }
  | { ok: false; reason: "not_found" | "disabled" | "expired" }

/** Códigos plausíveis: 6–64 alfanuméricos. Rejeita cedo lixo/injeção. */
function isPlausibleCode(code: string): boolean {
  return /^[A-Za-z0-9]{6,64}$/.test(code)
}

/**
 * Resolve o code → tenant respeitando a janela de campanha. Nunca lança para o
 * chamador: erro de infra vira `not_found` (indisponível, neutro).
 */
export async function resolvePublicLink(rawCode: string): Promise<PublicLinkResult> {
  const code = (rawCode ?? "").trim()
  if (!isPlausibleCode(code)) return { ok: false, reason: "not_found" }

  try {
    const supabase = createServiceClient()
    // Índice único parcial em public_link_code garante 0/1 linha.
    const { data, error } = await supabase
      .from("tenant_chat_config")
      .select("company_id, public_link_enabled, public_link_valid_until")
      .eq("public_link_code", code)
      .maybeSingle()

    if (error || !data) return { ok: false, reason: "not_found" }
    if (!data.public_link_enabled) return { ok: false, reason: "disabled" }
    if (data.public_link_valid_until) {
      const until = Date.parse(data.public_link_valid_until as string)
      if (Number.isFinite(until) && until < Date.now()) {
        return { ok: false, reason: "expired" }
      }
    }
    return { ok: true, tenant: { companyId: data.company_id, code } }
  } catch {
    return { ok: false, reason: "not_found" }
  }
}
