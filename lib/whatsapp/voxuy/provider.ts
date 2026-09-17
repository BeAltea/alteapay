// Adapter Voxuy (V2). Contrato REAL e verificado (Apêndice A do
// PROMPT_VOXUY_2026-09-17). A API é só de ENTRADA: fazemos POST de uma
// transação e a Voxuy agenda um funil já cadastrado na conta. A plataforma
// controla QUANDO disparar, PARA QUEM e QUAIS variáveis — nunca o texto.
//
// Trilhos inegociáveis:
// - ZERO PII para a Voxuy além de primeiro nome + telefone + link + marca (V6).
//   Nunca clientDocument, valor, e-mail, endereço.
// - payload validado por zod de SAÍDA (garante paymentType=99, status=99,
//   date=null, value/totalValue=null, ausência de clientDocument).
// - buildMetadata REJEITA qualquer chave não prevista (evita PII acidental).
// - id = whatsapp_messages.id => idempotência de envio (reenviar atualiza).
// - respostas tratadas por classe (§1.5): 200 sucesso, 400 validação (guarda
//   traceId), 401/403 config (pausa a campanha), 429/5xx/timeout retryável.

import { z } from "zod"
import { isMockMode } from "@/lib/integrations/mock-mode"
import type {
  NormalizedWhatsAppEvent,
  SendCampaignMessageInput,
  SendResult,
  SendStopSignalInput,
  WhatsAppProvider,
} from "../provider"
import { loadVoxuyConfig, VoxuyConfigError, type VoxuyConfig } from "./config"
import { ALTEAPAY_ORDER_STATUS, ALTEAPAY_PAYMENT_TYPE } from "./enums"
import { mapVoxuyInbound } from "./inbound"

// ---- metadata: EXATAMENTE as chaves do Apêndice B.2, nada mais ----------
export const ALLOWED_METADATA_KEYS = [
  "consult_url",
  "optout_url",
  "block_url",
  "brand_name",
  "creditor_name",
  "first_name",
] as const
export type VoxuyMetadataKey = (typeof ALLOWED_METADATA_KEYS)[number]

export interface BuildMetadataInput {
  consult_url: string
  brand_name: string
  creditor_name: string
  first_name: string
  optout_url?: string
  block_url?: string
}

/**
 * Monta o objeto `metadata` da Voxuy. REJEITA qualquer chave não prevista
 * (defesa contra PII acidental): o teste que falha se alguém adicionar uma
 * chave nova sem revisar mora exatamente aqui (checklist §5).
 */
export function buildMetadata(input: Record<string, unknown>): Record<VoxuyMetadataKey, string> {
  const out: Partial<Record<VoxuyMetadataKey, string>> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue
    if (!(ALLOWED_METADATA_KEYS as readonly string[]).includes(key)) {
      throw new Error(`buildMetadata: chave não permitida em metadata: "${key}"`)
    }
    if (typeof value !== "string") {
      throw new Error(`buildMetadata: valor de "${key}" deve ser string`)
    }
    out[key as VoxuyMetadataKey] = value
  }
  if (!out.consult_url) throw new Error("buildMetadata: consult_url obrigatório")
  if (!out.brand_name) throw new Error("buildMetadata: brand_name obrigatório")
  return out as Record<VoxuyMetadataKey, string>
}

// ---- zod de SAÍDA do payload (barra qualquer regressão de PII/valor) -----
const metadataSchema = z
  .object({
    consult_url: z.string().url(),
    optout_url: z.string().url().optional(),
    block_url: z.string().url().optional(),
    brand_name: z.string().min(1),
    creditor_name: z.string().optional(),
    first_name: z.string().optional(),
  })
  .strict() // qualquer chave extra => erro (dupla trava com buildMetadata)

const payloadSchema = z
  .object({
    apiToken: z.string().min(1),
    id: z.string().min(1),
    planId: z.string().min(1),
    customEvent: z.number().int(),
    // Constantes de contrato: SEMPRE 99 (§1.3/§1.4).
    paymentType: z.literal(ALTEAPAY_PAYMENT_TYPE),
    status: z.literal(ALTEAPAY_ORDER_STATUS),
    clientName: z.string(),
    clientPhoneNumber: z.string().regex(/^\+\d{8,15}$/, "E.164"),
    clientEmail: z.null(),
    // V6: NUNCA CPF/CNPJ para a Voxuy.
    clientDocument: z.null(),
    // Mensagem não leva valor (§1.3). Comentário de centavos em enums.ts.
    value: z.null(),
    freight: z.null(),
    freightType: z.null(),
    totalValue: z.null(),
    // §1.3: data anterior à criação da licença não agenda mensagens => sempre null.
    date: z.null(),
    // Campos nativos de pagamento reservados para funil futuro (V9): null agora.
    checkoutUrl: z.null(),
    paymentLine: z.null(),
    boletoUrl: z.null(),
    pixQrCode: z.null(),
    pixUrl: z.null(),
    metadata: metadataSchema,
  })
  .strict()

export type VoxuyTransactionPayload = z.infer<typeof payloadSchema>

export interface BuildPayloadInput {
  apiToken: string
  id: string
  planId: string
  customEvent: number
  clientName: string
  clientPhoneNumber: string
  metadata: BuildMetadataInput
}

/** Monta o payload canônico (Apêndice A.4) e valida com o zod de saída. */
export function buildTransactionPayload(input: BuildPayloadInput): VoxuyTransactionPayload {
  const payload = {
    apiToken: input.apiToken,
    id: input.id,
    planId: input.planId,
    customEvent: input.customEvent,
    paymentType: ALTEAPAY_PAYMENT_TYPE,
    status: ALTEAPAY_ORDER_STATUS,
    clientName: input.clientName,
    clientPhoneNumber: input.clientPhoneNumber,
    clientEmail: null,
    clientDocument: null,
    value: null,
    freight: null,
    freightType: null,
    totalValue: null,
    date: null,
    checkoutUrl: null,
    paymentLine: null,
    boletoUrl: null,
    pixQrCode: null,
    pixUrl: null,
    metadata: buildMetadata(input.metadata as unknown as Record<string, unknown>),
  }
  return payloadSchema.parse(payload)
}

// ---- classificação de resposta (§1.5) ------------------------------------
export interface VoxuyResponseOutcome {
  accepted: boolean
  errorClass?: "config" | "retryable" | "validation" | "unexpected"
  traceId?: string
  errorFields?: string[]
  note?: string
}

const isSuccessBody = (body: unknown): boolean => {
  if (body && typeof body === "object") {
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      // "Success" com S maiúsculo, tratado case-insensitive (§1.5).
      if (k.toLowerCase() === "success") return v !== false
    }
  }
  return false
}

/** Interpreta status HTTP + corpo em um veredito (sem lançar). */
export function classifyVoxuyResponse(
  httpStatus: number,
  body: unknown,
  bodyIsJson: boolean,
): VoxuyResponseOutcome {
  if (httpStatus === 200) {
    if (bodyIsJson && isSuccessBody(body)) return { accepted: true }
    // 200 com corpo inesperado: considerar sucesso, mas sinalizar (§1.5).
    return { accepted: true, note: "unexpected_body" }
  }
  if (httpStatus === 400) {
    const obj = (body ?? {}) as { traceId?: unknown; errors?: Record<string, unknown> }
    const traceId = typeof obj.traceId === "string" ? obj.traceId : undefined
    const errorFields = obj.errors && typeof obj.errors === "object" ? Object.keys(obj.errors) : undefined
    return { accepted: false, errorClass: "validation", traceId, errorFields }
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return { accepted: false, errorClass: "config" }
  }
  if (httpStatus === 429 || httpStatus >= 500) {
    return { accepted: false, errorClass: "retryable" }
  }
  return { accepted: false, errorClass: "unexpected" }
}

// ---- o provider ----------------------------------------------------------
export class VoxuyProvider implements WhatsAppProvider {
  name = "voxuy" as const
  private readonly config: VoxuyConfig | null

  constructor(config?: VoxuyConfig) {
    // Em mock não exigimos credenciais (laboratório). Fora do mock, a config
    // é validada na construção: sem credencial completa o adapter recusa (V1.3)
    // e a campanha nem inicia — erro visível, não silencioso.
    if (config) {
      this.config = config
    } else if (isMockMode("voxuy")) {
      this.config = null
    } else {
      this.config = loadVoxuyConfig() // lança VoxuyConfigError se incompleto
    }
  }

  private async post(payload: VoxuyTransactionPayload): Promise<SendResult> {
    if (isMockMode("voxuy") || !this.config) {
      // Laboratório: valida o payload (garante o contrato) mas NÃO sai do processo.
      payloadSchema.parse(payload)
      return { accepted: true, providerMessageId: payload.id, raw: { mock: true } }
    }
    const cfg = this.config
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs)
    try {
      const res = await fetch(cfg.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      const text = await res.text()
      let parsed: unknown
      let bodyIsJson = true
      try {
        parsed = JSON.parse(text)
      } catch {
        bodyIsJson = false
        parsed = { nonJson: true }
      }
      const outcome = classifyVoxuyResponse(res.status, parsed, bodyIsJson)
      // Log estruturado sem PII: nunca o corpo com telefone.
      console.log(
        `[voxuy] send id=${payload.id} http=${res.status} accepted=${outcome.accepted}` +
          (outcome.traceId ? ` traceId=${outcome.traceId}` : "") +
          (outcome.errorFields ? ` fields=${outcome.errorFields.join(",")}` : "") +
          (outcome.note ? ` note=${outcome.note}` : ""),
      )
      if (outcome.accepted) {
        return {
          accepted: true,
          providerMessageId: payload.id,
          raw: { httpStatus: res.status, note: outcome.note },
        }
      }
      return {
        accepted: false,
        providerMessageId: payload.id,
        error: `HTTP ${res.status}`,
        errorClass: outcome.errorClass,
        traceId: outcome.traceId,
        errorFields: outcome.errorFields,
        raw: { httpStatus: res.status, traceId: outcome.traceId, errorFields: outcome.errorFields },
      }
    } catch (err) {
      const aborted = (err as Error).name === "AbortError"
      console.log(`[voxuy] send id=${payload.id} ${aborted ? "timeout" : "network_error"}`)
      return {
        accepted: false,
        providerMessageId: payload.id,
        error: aborted ? "timeout" : "network_error",
        errorClass: "retryable",
      }
    } finally {
      clearTimeout(timer)
    }
  }

  async sendCampaignMessage(input: SendCampaignMessageInput): Promise<SendResult> {
    const planId = input.voxuyPlanId ?? ""
    const customEvent = input.voxuyEvent ?? null
    if (!isMockMode("voxuy")) {
      if (!planId) return { accepted: false, error: "VOXUY_PLAN_ID_MISSING", errorClass: "config" }
      if (customEvent == null) return { accepted: false, error: "VOXUY_EVENT_MISSING", errorClass: "config" }
    }
    let payload: VoxuyTransactionPayload
    try {
      payload = buildTransactionPayload({
        apiToken: this.config?.apiToken ?? "mock",
        id: input.messageId,
        planId: planId || "mock",
        customEvent: customEvent ?? 0,
        clientName: input.variables.first_name ?? input.customerName.trim().split(/\s+/)[0] ?? "",
        clientPhoneNumber: input.to,
        metadata: {
          consult_url: input.variables.consult_url,
          brand_name: input.variables.brand_name,
          creditor_name: input.variables.creditor_name ?? input.variables.brand_name,
          first_name: input.variables.first_name ?? input.customerName.trim().split(/\s+/)[0] ?? "",
          optout_url: input.variables.optout_url,
          block_url: input.variables.block_url,
        },
      })
    } catch (err) {
      return { accepted: false, error: (err as Error).message, errorClass: "validation" }
    }
    return this.post(payload)
  }

  async sendStopSignal(input: SendStopSignalInput): Promise<SendResult> {
    const planId = input.voxuyPlanId ?? ""
    const customEvent = input.voxuyEvent ?? null
    if (!isMockMode("voxuy")) {
      if (!planId) return { accepted: false, error: "VOXUY_PLAN_ID_MISSING", errorClass: "config" }
      if (customEvent == null) return { accepted: false, error: "VOXUY_STOP_EVENT_MISSING", errorClass: "config" }
    }
    // id determinístico (Apêndice A.4): stop_<customerId>_<epoch>.
    const id = `stop_${input.customerId}_${Date.now()}`
    let payload: VoxuyTransactionPayload
    try {
      // metadata mínimo no encerramento: só marca/credor.
      payload = buildTransactionPayload({
        apiToken: this.config?.apiToken ?? "mock",
        id,
        planId: planId || "mock",
        customEvent: customEvent ?? 0,
        clientName: "",
        clientPhoneNumber: input.phone,
        metadata: {
          consult_url: "https://alteapay.com/", // placeholder neutro (obrigatório pelo schema)
          brand_name: input.brandName ?? "AlteaPay",
          creditor_name: input.creditorName ?? input.brandName ?? "AlteaPay",
          first_name: "",
        },
      })
    } catch (err) {
      return { accepted: false, error: (err as Error).message, errorClass: "validation" }
    }
    return this.post(payload)
  }

  async syncSuppression(input: {
    phone: string
    reason: "optout" | "blocked"
    companyId?: string
    customerId?: string
  }): Promise<void> {
    // A Voxuy não tem blacklist (L2): "sincronizar supressão" é reforçar o
    // cancelamento do funil via evento stop. Sem evento/plan não faz nada.
    await this.sendStopSignal({
      companyId: input.companyId ?? "",
      phone: input.phone,
      customerId: input.customerId ?? "unknown",
    })
  }

  async parseInboundEvent(rawBody: string, headers: Headers): Promise<NormalizedWhatsAppEvent[]> {
    return mapVoxuyInbound(rawBody, headers)
  }
}
