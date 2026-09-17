// Mapeador de INBOUND da Voxuy (V5). A doc oficial é 100% de entrada: NÃO há
// contrato de webhook de saída (L1). Este mapeador reconhece SÓ o contrato
// normalizado PROPOSTO no Apêndice A.5 (útil para o mock e para um passo
// intermediário no n8n) e NADA MAIS. Formato desconhecido devolve [] e a rota
// grava o payload bruto em whatsapp_provider_events (processed=false) para
// análise. Quando a Voxuy confirmar o formato real, só ESTE arquivo muda.

import { z } from "zod"
import type { NormalizedWhatsAppEvent } from "../provider"

// Apêndice A.5 (proposto, não confirmado pela Voxuy):
// { event: "delivered|read|clicked|optout|block|failed|reply",
//   message_ref, phone, button: "consult|optout|block", occurred_at, raw }
const inboundSchema = z.object({
  event: z.enum([
    "sent",
    "delivered",
    "read",
    "failed",
    "clicked",
    "optout",
    "block",
    "reply",
  ]),
  message_ref: z.string().optional(),
  phone: z.string().optional(),
  button: z.enum(["consult", "optout", "block"]).optional(),
  occurred_at: z.string().optional(),
  text: z.string().optional(),
})

/**
 * Normaliza o corpo bruto para NormalizedWhatsAppEvent[]. Puro: NÃO faz
 * autenticação (isso é da rota, que valida VOXUY_INBOUND_SECRET). Corpo
 * não-JSON ou fora do contrato A.5 => [] (captura bruta fica com a rota).
 */
export function mapVoxuyInbound(rawBody: string, _headers?: Headers): NormalizedWhatsAppEvent[] {
  let json: unknown
  try {
    json = JSON.parse(rawBody)
  } catch {
    return []
  }
  const parsed = inboundSchema.safeParse(json)
  if (!parsed.success) return []
  const ev = parsed.data
  const at = ev.occurred_at ?? new Date().toISOString()
  switch (ev.event) {
    case "sent":
    case "delivered":
    case "read":
    case "failed":
      return [{ type: ev.event, providerMessageId: ev.message_ref ?? "", at }]
    case "clicked":
      return [{ type: "clicked", providerMessageId: ev.message_ref ?? "", button: ev.button ?? "consult", at }]
    case "optout":
    case "block":
      return [{ type: ev.event, phone: ev.phone ?? "", at }]
    case "reply":
      return [{ type: "reply", phone: ev.phone ?? "", text: ev.text ?? "", at }]
    default:
      return []
  }
}
