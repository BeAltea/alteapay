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
//
// ---------------------------------------------------------------------------
// CONTRATO DE OPT-OUT (achado 7.2) — o que o Fabio configura no nó Webhook.
// ---------------------------------------------------------------------------
// Quando o devedor clica "Sair da lista"/"Cancelar Recebimento" no fluxo Voxuy,
// a Voxuy bloqueia do lado DELA, mas NÃO tem blacklist consultável (L2). Para a
// AlteaPay saber, o nó **Webhook** do fluxo (após os botões de saída) chama esta
// rota EM MODO PERSONALIZADO, incluindo um campo custom que sinaliza o opt-out.
//
// Reconhecemos o opt-out quando o payload traz, na RAIZ ou aninhado em `contact`
// /`transaction`:
//   - um campo `evento` (ou `event`) com valor (case-insensitive, sem acento):
//       optout | opt_out | opt-out | unsubscribe | sair | blacklist | descadastro
//   - OU um campo booleano de saída verdadeiro: `optout`/`opt_out`/`unsubscribe`
//     /`descadastro`/`sair`/`blacklist` = true (ou "true"/"1"/"sim"/"yes").
//
// Correlação: derivamos o telefone (E.164) de `contact.phoneNumber` (ou `phone`
// /`phoneNumber` na raiz) e o `contactRef` de `contact.hash`/`contact.id`. Um
// opt-out reconhecido vira `{ type:"contactOptout", phoneE164, contactRef }`; o
// inbound-apply registra a supressão do NÚMERO no canal WhatsApp (idempotente).
//
// NOTA: `evento` (raiz) tem prioridade sobre o `event` do formato legado A.5;
// só cai no legado quando NÃO há sinal de opt-out enterprise.

import { z } from "zod"
import type { NormalizedWhatsAppEvent } from "../provider"
import { toE164Mobile } from "@/lib/journey/campaigns"

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

// ---------------------------------------------------------------------------
// OPT-OUT (achado 7.2): reconhecimento tolerante do sinal de saída do funil.
// ---------------------------------------------------------------------------

/** Valores do campo `evento`/`event` que significam "pare de me mandar". */
const OPTOUT_EVENT_VALUES = new Set([
  "optout",
  "opt_out",
  "opt-out",
  "unsubscribe",
  "sair",
  "blacklist",
  "descadastro",
])

/** Nomes de campo booleano que, quando verdadeiros, significam opt-out. */
const OPTOUT_FLAG_KEYS = ["optout", "opt_out", "unsubscribe", "descadastro", "sair", "blacklist"] as const

/** Normaliza para minúsculas sem acento/espaços (tolerância de formato). */
function normToken(v: unknown): string {
  return String(v ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // remove marcas de acento combinantes
    .trim()
    .toLowerCase()
}

/** true quando o valor bruto representa um booleano "verdadeiro" tolerante. */
function isTruthyFlag(v: unknown): boolean {
  if (v === true) return true
  const t = normToken(v)
  return t === "true" || t === "1" || t === "sim" || t === "yes"
}

/** Extrai o telefone (string) de um nível do payload, se houver. */
function pickPhoneRaw(rec: Record<string, unknown> | undefined): string | null {
  if (!rec) return null
  const cand = rec.phoneNumber ?? rec.phone ?? rec.telefone ?? rec.whatsapp
  return typeof cand === "string" && cand.trim() ? cand : null
}

/**
 * Detecta o sinal de opt-out em QUALQUER nível conhecido (raiz, `contact`,
 * `transaction`). Tolerante: aceita o campo `evento`/`event` com valor de saída
 * OU um flag booleano de saída verdadeiro. Devolve true na primeira ocorrência.
 */
function detectOptout(json: Record<string, unknown>): boolean {
  const levels: Array<Record<string, unknown>> = [json]
  for (const key of ["contact", "transaction"]) {
    const nested = json[key]
    if (nested && typeof nested === "object") levels.push(nested as Record<string, unknown>)
  }
  for (const level of levels) {
    // campo `evento`/`event` com valor de saída
    const eventVal = level.evento ?? level.event ?? level.tipo ?? level.action
    if (OPTOUT_EVENT_VALUES.has(normToken(eventVal))) return true
    // flag booleano de saída
    for (const flag of OPTOUT_FLAG_KEYS) {
      if (flag in level && isTruthyFlag(level[flag])) return true
    }
  }
  return false
}

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
 * Correlação para o opt-out (achado 7.2): hash/id do `contact` (ou da raiz).
 * Devolve "" quando nenhum ref está presente (o inbound-apply ainda casa por
 * telefone, quando derivável).
 */
function optoutContactRef(json: Record<string, unknown>): string {
  const contact = (json.contact && typeof json.contact === "object" ? json.contact : json) as Record<string, unknown>
  if (typeof contact.hash === "string" && contact.hash) return contact.hash
  if (contact.id != null) return String(contact.id)
  if (typeof json.hash === "string" && json.hash) return json.hash
  if (json.id != null) return String(json.id)
  return ""
}

/** Telefone bruto do opt-out: `contact.phoneNumber` senão nível-raiz. */
function optoutPhoneRaw(json: Record<string, unknown>): string | null {
  const contact = (json.contact && typeof json.contact === "object" ? json.contact : undefined) as
    | Record<string, unknown>
    | undefined
  return pickPhoneRaw(contact) ?? pickPhoneRaw(json)
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
  if (json == null || typeof json !== "object" || Array.isArray(json)) return []
  const obj = json as Record<string, unknown>

  // 0) OPT-OUT do fluxo Voxuy (achado 7.2): o devedor pediu para parar. Vem do nó
  // Webhook em MODO PERSONALIZADO (campo custom `evento`/`event` com valor de
  // saída, ou um flag booleano de saída, em qualquer nível raiz/contact/
  // transaction). Correlação por telefone (E.164, quando derivável) e/ou
  // contactRef.
  //
  // PRECEDÊNCIA: o formato legado A.5 (schema com `event` enum estrito) é
  // reconhecido ANTES — um `{event:"optout",...}` legado bem-formado continua no
  // caminho legado (mesma semântica de supressão downstream). A detecção
  // tolerante abaixo só cobre a forma CUSTOM que NÃO é um evento A.5 válido.
  const isLegacyA5 = legacyInboundSchema.safeParse(json).success
  if (!isLegacyA5 && detectOptout(obj)) {
    const at = new Date().toISOString()
    const phoneE164 = toE164Mobile(optoutPhoneRaw(obj))
    return [{ type: "contactOptout", phoneE164, contactRef: optoutContactRef(obj), at }]
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
