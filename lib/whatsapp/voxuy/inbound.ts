// Mapeador de INBOUND da Voxuy (callback de SAÍDA da plataforma → nós).
//
// Contrato REAL documentado do callback Enterprise: a Voxuy NÃO envia eventos de
// `delivered`/`read` (não há confirmação de entrega/leitura na doc). O corpo
// carrega o CONTATO (para correlação) e, quando há venda, uma `transaction`:
//
//   {
//     "contact": {
//       "hash": "<hash do contato na Voxuy>",
//       "id": <int>,                    // id do contato na Voxuy
//       "name": "...", "phoneNumber": "+55...",
//       "invalidWhatsApp": true|false,  // número sem WhatsApp válido
//       "tags": [ ... ],
//       "customVariables": { ... }      // pode conter link_negociacao etc.
//     },
//     "transaction": { ... }            // presente só quando há transação
//   }
//
// Correlação: usamos `contact.hash` (ou `contact.id`) como providerMessageId —
// é o que a Voxuy nos devolve; o inbound-apply casa por provider_message_id.
// `invalidWhatsApp: true` vira um evento `failed` (número inválido). Nada de
// delivered/read é inventado. Formato desconhecido => [] e a rota grava o bruto
// (processed=false) para análise. Quando a Voxuy confirmar variações, só ESTE
// arquivo muda.

import { z } from "zod"
import type { NormalizedWhatsAppEvent } from "../provider"

// Callback Enterprise (contrato REAL). Todos os campos são defensivamente
// opcionais: um provedor externo pode omitir/renomear e a rota não pode cair.
const enterpriseContactSchema = z.object({
  hash: z.string().optional(),
  id: z.union([z.string(), z.number()]).optional(),
  name: z.string().optional(),
  phoneNumber: z.string().optional(),
  invalidWhatsApp: z.boolean().optional(),
  tags: z.array(z.unknown()).optional(),
  customVariables: z.record(z.unknown()).optional(),
})

const enterpriseInboundSchema = z.object({
  contact: enterpriseContactSchema,
  transaction: z.unknown().optional(),
})

// Contrato normalizado A.5 (interno/legado): mock e um passo intermediário no
// n8n podem emitir esse formato explícito de eventos.
const legacyInboundSchema = z.object({
  event: z.enum(["sent", "delivered", "read", "failed", "clicked", "optout", "block", "reply"]),
  message_ref: z.string().optional(),
  phone: z.string().optional(),
  button: z.enum(["consult", "optout", "block"]).optional(),
  occurred_at: z.string().optional(),
  text: z.string().optional(),
})

/** Correlação: hash preferido, senão id (string). "" se nenhum. */
function contactRef(contact: z.infer<typeof enterpriseContactSchema>): string {
  if (contact.hash) return contact.hash
  if (contact.id != null) return String(contact.id)
  return ""
}

/**
 * Normaliza o corpo bruto para NormalizedWhatsAppEvent[]. Puro: NÃO faz
 * autenticação (isso é da rota, que valida o segredo). Reconhece o callback
 * Enterprise REAL (contact/transaction) e o formato legado A.5. Corpo não-JSON
 * ou desconhecido => [] (a captura bruta fica com a rota).
 */
export function mapVoxuyInbound(rawBody: string, _headers?: Headers): NormalizedWhatsAppEvent[] {
  let json: unknown
  try {
    json = JSON.parse(rawBody)
  } catch {
    return []
  }

  // 1) Callback Enterprise REAL (tem `contact`).
  const ent = enterpriseInboundSchema.safeParse(json)
  if (ent.success && ent.data.contact) {
    const ref = contactRef(ent.data.contact)
    const at = new Date().toISOString()
    // Só sabemos derivar um evento acionável do `invalidWhatsApp`: número sem
    // WhatsApp válido => falha (não há delivered/read no contrato Enterprise).
    if (ent.data.contact.invalidWhatsApp === true) {
      return [{ type: "failed", providerMessageId: ref, at, error: "invalid_whatsapp" }]
    }
    // Sem sinal acionável: [] => a rota grava o bruto (processed=false).
    return []
  }

  // 2) Formato legado A.5 (eventos explícitos).
  const parsed = legacyInboundSchema.safeParse(json)
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
