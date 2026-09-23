// VoxuyApiProvider — disparo por API da Voxuy (Hub de negociações / link único).
//
// O envio da jornada é POR API. Este provider fala TRÊS dialetos, escolhidos por
// CONFIGURAÇÃO do tenant; o modo padrão em produção é `mock` (nada sai do
// processo sem credencial):
//
//   - `enterprise_v1` (DEFAULT — contrato REAL verificado na doc oficial):
//     POST na URL-credencial (VOXUY_WEBHOOK_URL, que CONTÉM o companyId → a URL
//     é a credencial). SEM apiToken, SEM Bearer, SEM header próprio. Corpo:
//       { flowId: <int>, contact: { name, phoneNumber, variables: {
//         link_negociacao, primeiro_nome, credor } } }
//     Só abordagem (SEM transaction/valores/document/email). Resposta:
//       {"success": true}  HTTP 200 => accepted
//       {"success": false, "message": "..."} HTTP 400 => failed (validation)
//     `success` é minúsculo — validado case-insensitive.
//   - `transaction_v1` (LEGADO, não-default): contrato do produto antigo
//     (apiToken/planId/customEvent, paymentType=99). Reusa
//     buildTransactionPayload/classifyVoxuyResponse (provider.ts).
//   - `custom`: template JSON por tenant (voxuy_payload_template) + request
//     config (voxuy_request_config = {method,url,headers}). Placeholder
//     DESCONHECIDO => erro de CONFIGURAÇÃO visível (nunca falha silenciosa).
//
// Trilhos inegociáveis (todos os dialetos):
//   - ZERO PII para a Voxuy além de 1º nome + telefone E.164 + link + marca.
//   - `assertFinalPayloadSafe` valida o payload FINAL: proíbe document/cpf e
//     QUALQUER valor monetário não-nulo; exige E.164 no telefone (inclusive no
//     contact.phoneNumber aninhado do enterprise_v1).
//   - timeout VOXUY_TIMEOUT_MS (default 10000); 1 tentativa por job.
//   - classificação: 200+success => accepted; 400 => failed(validation) com a
//     message truncada; 401/403 => failed(config)+pauseCampaign; 429/5xx/timeout
//     => failed retryável.
//   - log estruturado SEM PII (nunca telefone/nome completo) e SEM a URL
//     (a URL é segredo — contém o companyId).

import { z } from "zod"
import { isMockMode } from "@/lib/integrations/mock-mode"
import type {
  NormalizedWhatsAppEvent,
  SendCampaignMessageInput,
  SendResult,
  SendStopSignalInput,
  WhatsAppProvider,
} from "../provider"
import {
  buildTransactionPayload,
  classifyVoxuyResponse,
  type VoxuyResponseOutcome,
} from "./provider"
import {
  isCanonicalVoxuyWebhookUrl,
  loadVoxuyApiConfig,
  VoxuyConfigError,
  type VoxuyApiConfig,
  type VoxuyDialect,
} from "./config"
import { mapVoxuyInbound } from "./inbound"

// ---------------------------------------------------------------------------
// Contrato do resultado do dialeto (interno). O provider traduz para SendResult.
// ---------------------------------------------------------------------------
interface DialectDispatch {
  /** URL de destino do POST. NUNCA logada (é segredo no enterprise_v1). */
  url: string
  method: string
  headers: Record<string, string>
  /** Corpo final, JÁ validado pelo zod do dialeto. */
  body: unknown
  /** id externo (idempotência NOSSA) — devolvido no SendResult. */
  externalId: string
}

// firstName defensivo: nunca sai o nome completo.
const firstNameOf = (input: SendCampaignMessageInput): string =>
  (input.variables.first_name ?? input.customerName ?? "").trim().split(/\s+/)[0] ?? ""

// ---------------------------------------------------------------------------
// zod do payload FINAL comum a TODOS os dialetos (defesa de saída).
// Não é `.strict()` (o dialeto `custom` pode ter chaves arbitrárias do tenant),
// mas PROÍBE document/cpf/valores monetários não-nulos e EXIGE E.164 nos campos
// de telefone conhecidos (inclusive contact.phoneNumber). É a última trava antes
// de sair do processo.
// ---------------------------------------------------------------------------
const E164 = /^\+\d{8,15}$/
const forbiddenNonNull = (name: string) =>
  z.unknown().refine((v) => v === undefined || v === null, {
    message: `${name} deve ser null (nunca enviar valor)`,
  })

// `variables` do enterprise_v1: EXATAMENTE as 3 chaves previstas — nada além.
// `.strict()` faz qualquer chave extra (ex.: cpf/valor colado por engano) virar
// erro de validação ANTES de sair do processo (defesa de saída, W1.2).
const enterpriseVariablesGuardSchema = z
  .object({
    link_negociacao: z.string(),
    primeiro_nome: z.string(),
    credor: z.string(),
  })
  .strict()

// contact aninhado do enterprise_v1: telefone E.164 obrigatório, sem document.
// Quando `variables` está presente, é validado ESTRITO (só as 3 chaves).
const contactGuardSchema = z
  .object({
    phoneNumber: z.string().regex(E164, "contact.phoneNumber deve ser E.164"),
    document: forbiddenNonNull("contact.document"),
    cpf: forbiddenNonNull("contact.cpf"),
    email: forbiddenNonNull("contact.email"),
    variables: enterpriseVariablesGuardSchema.optional(),
  })
  .passthrough()

const finalGuardSchema = z
  .object({
    // Se o telefone existir no corpo, TEM que ser E.164.
    clientPhoneNumber: z.string().regex(E164, "clientPhoneNumber deve ser E.164").optional(),
    phone: z.string().regex(E164, "phone deve ser E.164").optional(),
    // PII e valores: proibidos com conteúdo.
    clientDocument: forbiddenNonNull("clientDocument"),
    document: forbiddenNonNull("document"),
    cpf: forbiddenNonNull("cpf"),
    value: forbiddenNonNull("value"),
    totalValue: forbiddenNonNull("totalValue"),
    freight: forbiddenNonNull("freight"),
    amount: forbiddenNonNull("amount"),
    // enterprise_v1: valida o contato aninhado quando presente.
    contact: contactGuardSchema.optional(),
    // enterprise_v1 NÃO leva transação: se vier, é regressão (barra).
    transaction: forbiddenNonNull("transaction"),
  })
  .passthrough()

/**
 * Valida o corpo FINAL (qualquer dialeto). Lança ZodError com os NOMES dos
 * campos (nunca valores). Rejeita document/cpf/valor não-nulo, telefone fora de
 * E.164 (topo E contact.phoneNumber) e transaction não-nula.
 */
export function assertFinalPayloadSafe(body: unknown): void {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    finalGuardSchema.parse(body)
  }
  // Corpo não-objeto (string/array) do dialeto custom é responsabilidade do
  // template; o guard só se aplica a objetos JSON.
}

// ---------------------------------------------------------------------------
// enterprise_v1 — o dialeto DEFAULT (contrato REAL verificado).
// ---------------------------------------------------------------------------
export interface EnterpriseContactVariables {
  link_negociacao: string
  primeiro_nome: string
  credor: string
}

export interface EnterprisePayload {
  flowId: number
  contact: {
    name: string
    phoneNumber: string
    variables: EnterpriseContactVariables
  }
}

/**
 * Monta o corpo enterprise_v1: { flowId, contact:{ name, phoneNumber,
 * variables:{ link_negociacao, primeiro_nome, credor } } }. SEM document/email,
 * SEM transação/valores. `variables` carrega EXATAMENTE as 3 chaves previstas.
 */
export function buildEnterprisePayload(args: {
  flowId: number
  firstName: string
  phoneE164: string
  link: string
  creditorName: string
}): EnterprisePayload {
  return {
    flowId: args.flowId,
    contact: {
      name: args.firstName,
      phoneNumber: args.phoneE164,
      variables: {
        link_negociacao: args.link,
        primeiro_nome: args.firstName,
        credor: args.creditorName,
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Placeholders do dialeto `custom`.
// ---------------------------------------------------------------------------
const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g

export class VoxuyTemplateError extends Error {
  constructor(public readonly unknownKeys: string[]) {
    super(
      `voxuy_payload_template: placeholder(s) desconhecido(s): ${unknownKeys.join(", ")}. ` +
        `Corrija a configuração do tenant (erro de configuração, não de envio).`,
    )
    this.name = "VoxuyTemplateError"
  }
}

/**
 * Resolve os placeholders `{{chave}}` no template (string ou objeto/array
 * recursivo). Placeholder desconhecido => VoxuyTemplateError (erro de CONFIG,
 * não de envio). Valores substituídos são sempre strings.
 */
export function resolveTemplate(
  template: unknown,
  vars: Record<string, string>,
): { resolved: unknown; unknownKeys: string[] } {
  const unknown = new Set<string>()

  const resolveString = (s: string): string =>
    s.replace(PLACEHOLDER_RE, (_m, key: string) => {
      if (Object.prototype.hasOwnProperty.call(vars, key)) return vars[key]
      unknown.add(key)
      return `{{${key}}}` // preserva para o erro apontar o lugar
    })

  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return resolveString(node)
    if (Array.isArray(node)) return node.map(walk)
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        out[k] = walk(v)
      }
      return out
    }
    return node
  }

  const resolved = walk(template)
  return { resolved, unknownKeys: [...unknown] }
}

/**
 * Conjunto de variáveis disponíveis para o dialeto `custom`. NUNCA inclui
 * documento/valor. Inclui as 3 variáveis do enterprise_v1 como aliases para
 * templates que queiram imitar o corpo Enterprise.
 */
export function templateVars(args: {
  flowId: string
  messageId: string
  phone: string
  firstName: string
  link: string
  brandName: string
  creditorName: string
  apiToken?: string
  planId?: string
}): Record<string, string> {
  return {
    // legado (transaction/custom antigos)
    apiToken: args.apiToken ?? "",
    planId: args.planId ?? "",
    flowId: args.flowId,
    messageId: args.messageId,
    phone: args.phone,
    firstName: args.firstName,
    link: args.link,
    brandName: args.brandName,
    creditorName: args.creditorName,
    // aliases enterprise_v1
    link_negociacao: args.link,
    primeiro_nome: args.firstName,
    credor: args.creditorName,
  }
}

// ---------------------------------------------------------------------------
// O provider
// ---------------------------------------------------------------------------
export class VoxuyApiProvider implements WhatsAppProvider {
  name = "voxuy" as const
  private readonly config: VoxuyApiConfig | null

  constructor(config?: VoxuyApiConfig) {
    // Em mock não exigimos credencial (produção default = mock). Fora do mock,
    // a config é validada na construção: incompleta => VoxuyConfigError e a
    // campanha nem inicia (erro visível no painel), nunca falha silenciosa.
    if (config) {
      this.config = config
    } else if (isMockMode("voxuy")) {
      this.config = null
    } else {
      this.config = loadVoxuyApiConfig()
    }
  }

  get dialect(): VoxuyDialect {
    return this.config?.dialect ?? "enterprise_v1"
  }

  // -- monta o disparo conforme o dialeto (sem sair do processo) -------------
  private buildDispatch(input: SendCampaignMessageInput): DialectDispatch {
    const dialect = this.dialect
    const firstName = firstNameOf(input)
    const brandName = input.variables.brand_name
    const creditorName = input.variables.creditor_name ?? brandName
    const link = input.variables.consult_url

    if (dialect === "enterprise_v1") {
      // A URL É A CREDENCIAL (contém o companyId). Formato CANÔNICO obrigatório
      // (host webhooks.voxuy.com + /voxuyapi/<uuid>) — recusa host errado. Sem
      // apiToken/Bearer. VoxuyConfigError nunca ecoa a URL (só o NOME).
      const url = this.config?.webhookUrl ?? "https://mock.local/voxuy"
      if (!isMockMode("voxuy")) {
        if (!isCanonicalVoxuyWebhookUrl(this.config?.webhookUrl)) {
          throw new VoxuyConfigError(["VOXUY_WEBHOOK_URL"])
        }
      }
      const flowId = this.config?.flowId ?? (isMockMode("voxuy") ? 0 : null)
      if (flowId == null) throw new VoxuyConfigError(["VOXUY_FLOW_ID"])
      const payload = buildEnterprisePayload({
        flowId,
        firstName,
        phoneE164: input.to,
        link,
        creditorName,
      })
      assertFinalPayloadSafe(payload)
      return {
        url,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        externalId: input.messageId,
      }
    }

    if (dialect === "custom") {
      const custom = this.config?.custom
      if (!custom && !isMockMode("voxuy")) {
        throw new VoxuyConfigError(["VOXUY_REQUEST_CONFIG", "VOXUY_PAYLOAD_TEMPLATE"])
      }
      const requestUrl = custom?.request.url ?? this.config?.webhookUrl ?? "https://mock.local/voxuy"
      const method = custom?.request.method ?? "POST"
      const headers = { "Content-Type": "application/json", ...(custom?.request.headers ?? {}) }
      const template = custom?.payloadTemplate ?? { messageId: "{{messageId}}", phone: "{{phone}}" }
      const vars = templateVars({
        apiToken: this.config?.apiToken ?? "",
        planId: this.config?.planId ?? input.voxuyPlanId ?? "",
        flowId: custom?.flowId ?? (this.config?.flowId != null ? String(this.config.flowId) : ""),
        messageId: input.messageId,
        phone: input.to,
        firstName,
        link,
        brandName,
        creditorName,
      })
      const { resolved, unknownKeys } = resolveTemplate(template, vars)
      if (unknownKeys.length > 0) throw new VoxuyTemplateError(unknownKeys)
      // headers também podem ter placeholders (ex.: Authorization Bearer token).
      const { resolved: resolvedHeaders } = resolveTemplate(headers, vars)
      assertFinalPayloadSafe(resolved)
      return {
        url: requestUrl,
        method,
        headers: resolvedHeaders as Record<string, string>,
        body: resolved,
        externalId: input.messageId,
      }
    }

    // dialect === "transaction_v1" (LEGADO): reusa o builder canônico que já
    // trava PII/valor e exige E.164 — fonte da verdade do contrato antigo.
    const apiToken = this.config?.apiToken ?? "mock"
    const planId = this.config?.planId ?? input.voxuyPlanId ?? ""
    const customEvent = input.voxuyEvent ?? null
    if (!isMockMode("voxuy")) {
      if (!planId) throw new VoxuyConfigError(["VOXUY_PLAN_ID"])
      if (customEvent == null) throw new VoxuyConfigError(["VOXUY_EVENT"])
    }
    const payload = buildTransactionPayload({
      apiToken,
      id: input.messageId,
      planId: planId || "mock",
      customEvent: customEvent ?? 0,
      clientName: firstName,
      clientPhoneNumber: input.to,
      metadata: {
        consult_url: link,
        brand_name: brandName,
        creditor_name: creditorName,
        first_name: firstName,
        optout_url: input.variables.optout_url,
        block_url: input.variables.block_url,
      },
    })
    assertFinalPayloadSafe(payload)
    return {
      url: this.config?.webhookUrl ?? "https://mock.local/voxuy",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      externalId: input.messageId,
    }
  }

  // -- executa o disparo (1 tentativa; timeout; classificação) ---------------
  private async dispatch(d: DialectDispatch): Promise<SendResult> {
    if (isMockMode("voxuy") || !this.config) {
      // Produção default = mock: valida o corpo (garante o contrato) mas NÃO
      // sai do processo. Nada é enviado sem credencial.
      assertFinalPayloadSafe(d.body)
      return { accepted: true, providerMessageId: d.externalId, raw: { mock: true, dialect: this.dialect } }
    }
    const timeoutMs = this.config.timeoutMs
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(d.url, {
        method: d.method,
        headers: d.headers,
        body: typeof d.body === "string" ? d.body : JSON.stringify(d.body),
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
      const outcome = this.classify(res.status, parsed, bodyIsJson)
      this.log(d.externalId, res.status, outcome)
      return this.toSendResult(d.externalId, res.status, outcome)
    } catch (err) {
      const aborted = (err as Error).name === "AbortError"
      // NUNCA logar d.url (segredo). Só o id e o dialeto.
      console.log(`[voxuy-api] send id=${d.externalId} dialect=${this.dialect} ${aborted ? "timeout" : "network_error"}`)
      return {
        accepted: false,
        providerMessageId: d.externalId,
        error: aborted ? "timeout" : "network_error",
        errorClass: "retryable",
      }
    } finally {
      clearTimeout(timer)
    }
  }

  // -- classificação: enterprise_v1 tem envelope próprio; legados reusam ------
  private classify(httpStatus: number, body: unknown, bodyIsJson: boolean): VoxuyResponseOutcome {
    if (this.dialect === "enterprise_v1") return classifyEnterpriseResponse(httpStatus, body, bodyIsJson)
    return classifyVoxuyResponse(httpStatus, body, bodyIsJson)
  }

  // -- log estruturado SEM PII e SEM a URL (a URL é segredo) ------------------
  private log(externalId: string, httpStatus: number, outcome: VoxuyResponseOutcome): void {
    console.log(
      `[voxuy-api] send id=${externalId} dialect=${this.dialect} http=${httpStatus} ` +
        `accepted=${outcome.accepted}` +
        (outcome.errorClass ? ` class=${outcome.errorClass}` : "") +
        (outcome.traceId ? ` traceId=${outcome.traceId}` : "") +
        (outcome.errorFields ? ` fields=${outcome.errorFields.join(",")}` : "") +
        (outcome.note ? ` note=${outcome.note}` : ""),
    )
  }

  // -- traduz o veredito em SendResult ---------------------------------------
  private toSendResult(externalId: string, httpStatus: number, outcome: VoxuyResponseOutcome): SendResult {
    if (outcome.accepted) {
      return {
        accepted: true,
        providerMessageId: externalId,
        raw: { httpStatus, dialect: this.dialect, note: outcome.note },
      }
    }
    // 401/403: credencial errada => pausar a campanha (não resolve repetindo).
    const pauseCampaign = outcome.errorClass === "config"
    return {
      accepted: false,
      providerMessageId: externalId,
      error: `HTTP ${httpStatus}`,
      errorClass: outcome.errorClass,
      traceId: outcome.traceId,
      errorFields: outcome.errorFields,
      raw: {
        httpStatus,
        dialect: this.dialect,
        pauseCampaign,
        traceId: outcome.traceId,
        errorFields: outcome.errorFields,
        // message do 400 já truncada e potencialmente sensível.
        note: outcome.note,
      },
    }
  }

  async sendCampaignMessage(input: SendCampaignMessageInput): Promise<SendResult> {
    let d: DialectDispatch
    try {
      d = this.buildDispatch(input)
    } catch (err) {
      // Erros de CONFIGURAÇÃO (template/credencial) => visíveis, não retryáveis.
      const isConfig = err instanceof VoxuyConfigError || err instanceof VoxuyTemplateError
      return {
        accepted: false,
        providerMessageId: input.messageId,
        error: (err as Error).message,
        errorClass: isConfig ? "config" : "validation",
        raw: isConfig ? { pauseCampaign: true } : undefined,
      }
    }
    return this.dispatch(d)
  }

  // Encerramento de funil (V3). No enterprise_v1 NÃO há evento `stop`
  // documentado — a supressão autoritativa é NOSSA (contact_suppressions); o
  // stop-signal externo só faz sentido no dialeto legado transaction_v1.
  async sendStopSignal(input: SendStopSignalInput): Promise<SendResult> {
    if (this.dialect === "enterprise_v1") {
      // Sem contrato de stop no Enterprise: no-op aceito (a supressão é NOSSA).
      return { accepted: true, providerMessageId: `stop_${input.customerId}_${Date.now()}`, raw: { noop: true, dialect: this.dialect } }
    }
    const planId = this.config?.planId ?? input.voxuyPlanId ?? ""
    const customEvent = input.voxuyEvent ?? null
    if (!isMockMode("voxuy")) {
      if (!planId) return { accepted: false, error: "VOXUY_PLAN_ID_MISSING", errorClass: "config" }
      if (customEvent == null) return { accepted: false, error: "VOXUY_STOP_EVENT_MISSING", errorClass: "config" }
    }
    const id = `stop_${input.customerId}_${Date.now()}`
    let payload
    try {
      payload = buildTransactionPayload({
        apiToken: this.config?.apiToken ?? "mock",
        id,
        planId: planId || "mock",
        customEvent: customEvent ?? 0,
        clientName: "",
        clientPhoneNumber: input.phone,
        metadata: {
          consult_url: "https://alteapay.com/",
          brand_name: input.brandName ?? "AlteaPay",
          creditor_name: input.creditorName ?? input.brandName ?? "AlteaPay",
          first_name: "",
        },
      })
    } catch (err) {
      return { accepted: false, error: (err as Error).message, errorClass: "validation" }
    }
    assertFinalPayloadSafe(payload)
    return this.dispatch({
      url: this.config?.webhookUrl ?? "https://mock.local/voxuy",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      externalId: id,
    })
  }

  async syncSuppression(input: {
    phone: string
    reason: "optout" | "blocked"
    companyId?: string
    customerId?: string
  }): Promise<void> {
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

// ---------------------------------------------------------------------------
// Classificação de resposta do enterprise_v1.
//   200 + { success: true }  => accepted   (`success` case-insensitive)
//   200 + { success: false } => failed (validation) com a message truncada
//   400 + { success: false, message } => failed (validation) + message truncada
//   401/403 => config (pausa a campanha)
//   429/5xx/timeout/network => retryável
// A `message` é truncada e tratada como POTENCIALMENTE SENSÍVEL (não vai para
// campos estruturados; só nota curta).
// ---------------------------------------------------------------------------
const MESSAGE_MAX = 200

function truncate(s: string): string {
  return s.length > MESSAGE_MAX ? `${s.slice(0, MESSAGE_MAX)}…` : s
}

/** Lê `success` case-insensitive (o Enterprise usa minúsculo). */
function readSuccessFlag(body: unknown): boolean | undefined {
  if (body && typeof body === "object") {
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (k.toLowerCase() === "success") return v !== false
    }
  }
  return undefined
}

/** Lê `message` (curta, potencialmente sensível) do corpo Enterprise. */
function readMessage(body: unknown): string | undefined {
  if (body && typeof body === "object") {
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (k.toLowerCase() === "message" && typeof v === "string") return truncate(v)
    }
  }
  return undefined
}

export function classifyEnterpriseResponse(
  httpStatus: number,
  body: unknown,
  bodyIsJson: boolean,
): VoxuyResponseOutcome {
  const success = bodyIsJson ? readSuccessFlag(body) : undefined
  const message = bodyIsJson ? readMessage(body) : undefined

  if (httpStatus === 200) {
    if (success === true) return { accepted: true }
    if (success === false) {
      // 200 + success:false: a Voxuy recusou; tratamos como validação.
      return { accepted: false, errorClass: "validation", note: message }
    }
    // 200 sem envelope reconhecível: aceito, mas sinaliza.
    return { accepted: true, note: "unexpected_body" }
  }
  if (httpStatus === 400) {
    // 400 => validação; guarda a message truncada (não valores estruturados).
    return { accepted: false, errorClass: "validation", note: message }
  }
  if (httpStatus === 401 || httpStatus === 403 || httpStatus === 404) {
    // 404 = URL de integração não encontrada → credencial/endpoint inválido:
    // fatal, pausa a campanha (runbook Apêndice C), não repete com a mesma URL.
    return { accepted: false, errorClass: "config" }
  }
  if (httpStatus === 429 || httpStatus >= 500) {
    return { accepted: false, errorClass: "retryable" }
  }
  return { accepted: false, errorClass: "unexpected" }
}
