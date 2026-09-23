// Configuração validada do provider Voxuy.
// - Leitura com zod; mensagem clara quando falta credencial.
// - NUNCA loga o valor de nenhum segredo (só o NOME da variável que faltou).
//   A URL do Enterprise (VOXUY_WEBHOOK_URL) É A CREDENCIAL (contém o companyId
//   embutido): também é segredo e NUNCA aparece em log, nem em mensagem de erro.
// - Sem credencial completa, o adapter recusa na construção (V1.3): a campanha
//   nem inicia (erro visível no painel), não falha silenciosamente.
//
// A URL de webhook vem INTEIRA do painel da Voxuy (contém o companyId): NÃO
// montar concatenando pedaços.

import { z } from "zod"

// Formato CANÔNICO da URL-credencial do Enterprise. A URL É A CREDENCIAL
// (contém o companyId embutido) → tratamos como SEGREDO e NUNCA a logamos.
// Além de segredo, o formato é FIXO: host `webhooks.voxuy.com`, path
// `/voxuyapi/<uuid>` (36 chars hex/hífen). Qualquer outra coisa é recusada na
// CONSTRUÇÃO (protege contra host errado / URL colada de outro lugar). A
// mensagem de erro NUNCA contém a URL — só diz "formato inesperado".
export const VOXUY_WEBHOOK_URL_RE = /^https:\/\/webhooks\.voxuy\.com\/voxuyapi\/[0-9a-f-]{36}$/

/**
 * Valida a URL-credencial contra o formato canônico. Devolve `true`/`false`
 * SEM NUNCA ecoar a URL. Use na construção do provider (enterprise_v1) para
 * recusar host/format errados antes de qualquer disparo.
 */
export function isCanonicalVoxuyWebhookUrl(url: string | null | undefined): boolean {
  return typeof url === "string" && VOXUY_WEBHOOK_URL_RE.test(url)
}

const envSchema = z.object({
  // URL completa de Integrações → API da Voxuy (contém o companyId embutido).
  // No Enterprise ela É A CREDENCIAL (não há apiToken/Bearer no corpo).
  VOXUY_WEBHOOK_URL: z
    .string()
    .url("VOXUY_WEBHOOK_URL deve ser uma URL completa")
    .refine((u) => u.startsWith("https://"), "VOXUY_WEBHOOK_URL deve ser https"),
  // Campo `apiToken` do corpo — LEGADO (dialeto transaction_v1); o Enterprise
  // NÃO usa apiToken (a conta é identificada pela URL).
  VOXUY_API_TOKEN: z.string().min(1, "VOXUY_API_TOKEN vazio").optional(),
  VOXUY_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
})

export interface VoxuyConfig {
  webhookUrl: string
  apiToken: string
  timeoutMs: number
}

export class VoxuyConfigError extends Error {
  constructor(public readonly missing: string[]) {
    super(
      `Voxuy não configurado: verifique ${missing.join(", ")} (valores nunca são logados).`,
    )
    this.name = "VoxuyConfigError"
  }
}

/**
 * Lê e valida a config LEGADA (transaction_v1) da Voxuy a partir do ambiente.
 * Lança VoxuyConfigError (com a LISTA DE NOMES faltantes, sem valores) quando
 * incompleta. Usada pelo VoxuyProvider (adapter transaction original).
 */
export function loadVoxuyConfig(env: NodeJS.ProcessEnv = process.env): VoxuyConfig {
  const parsed = envSchema.safeParse({
    VOXUY_WEBHOOK_URL: env.VOXUY_WEBHOOK_URL,
    VOXUY_API_TOKEN: env.VOXUY_API_TOKEN,
    VOXUY_TIMEOUT_MS: env.VOXUY_TIMEOUT_MS,
  })
  const missing: string[] = []
  if (!parsed.success) {
    for (const i of parsed.error.issues) missing.push(String(i.path[0] ?? "VOXUY"))
  }
  // transaction_v1 exige apiToken (o Enterprise não).
  if (parsed.success && !parsed.data.VOXUY_API_TOKEN) missing.push("VOXUY_API_TOKEN")
  if (missing.length) throw new VoxuyConfigError(Array.from(new Set(missing)))
  return {
    webhookUrl: parsed.data!.VOXUY_WEBHOOK_URL,
    apiToken: parsed.data!.VOXUY_API_TOKEN!,
    timeoutMs: parsed.data!.VOXUY_TIMEOUT_MS,
  }
}

/** Rate limit da fila (não documentado pela Voxuy; limiter conservador L5). */
export function voxuyRateLimitPerSec(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.WHATSAPP_RATE_LIMIT_PER_SEC ?? "5")
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 5
}

/** Segredo da rota de captura inbound (Netlify). Vazio => rota recusa tudo. */
export function voxuyInboundSecret(env: NodeJS.ProcessEnv = process.env): string {
  return env.VOXUY_INBOUND_SECRET ?? ""
}

/**
 * Nome do header que carrega o segredo do callback (a Voxuy não faz HMAC).
 * Configurável porque não sabemos qual header o painel permite; default
 * `x-alteapay-webhook-secret`. A query `?s=<segredo>` é sempre aceita como
 * alternativa (URL com segredo).
 */
export function voxuyInboundSecretHeader(env: NodeJS.ProcessEnv = process.env): string {
  return (env.VOXUY_INBOUND_SECRET_HEADER ?? "x-alteapay-webhook-secret").toLowerCase()
}

// ===========================================================================
// Config do disparo POR API (Hub de negociações / link único).
//
// Dialetos:
//   - enterprise_v1 (DEFAULT, contrato REAL verificado): POST na URL-credencial
//     (VOXUY_WEBHOOK_URL) com corpo { flowId, contact:{ name, phoneNumber,
//     variables } }. SEM apiToken/Bearer/header próprio: a conta é identificada
//     pela URL. flowId (inteiro) vem de tenant_chat_config.voxuy_flow_id senão
//     env VOXUY_FLOW_ID.
//   - transaction_v1 (LEGADO): contrato do produto antigo (apiToken/planId/
//     customEvent + paymentType=99). Mantido para retrocompatibilidade.
//   - custom: request+template JSON vindos do tenant_chat_config
//     (voxuy_request_config / voxuy_payload_template), resolvidos por placeholder.
//
// O modo de disparo do tenant (whatsapp_dispatch_mode = voxuy_api|mock) é lido
// pela fábrica (lib/whatsapp/index.ts). Aqui só carregamos a config do provider
// quando o modo é voxuy_api e NÃO estamos em mock.
// ===========================================================================

export type VoxuyDialect = "enterprise_v1" | "transaction_v1" | "custom"

/** Dialeto default: o contrato Enterprise verificado. */
export const DEFAULT_VOXUY_DIALECT: VoxuyDialect = "enterprise_v1"

export interface VoxuyCustomDialectConfig {
  /** {method,url,headers} do POST (voxuy_request_config). */
  request: { method: string; url: string; headers: Record<string, string> }
  /** Template JSON do corpo (voxuy_payload_template) com placeholders {{...}}. */
  payloadTemplate: unknown
  /** flowId opcional (dialeto custom pode referenciar {{flowId}}). */
  flowId?: string
}

export interface VoxuyApiConfig {
  dialect: VoxuyDialect
  /** URL-credencial do POST (VOXUY_WEBHOOK_URL). É SEGREDO — nunca logar. */
  webhookUrl?: string
  /** LEGADO (transaction_v1): campo `apiToken` do corpo. Enterprise não usa. */
  apiToken?: string
  timeoutMs: number
  /** voxuy_plan_id do tenant (transaction_v1). */
  planId?: string | null
  /**
   * flowId (inteiro) do Enterprise: tenant_chat_config.voxuy_flow_id senão
   * env VOXUY_FLOW_ID. Obrigatório no enterprise_v1 (fora do mock).
   */
  flowId?: number | null
  /** Config do dialeto custom (só quando dialect === 'custom'). */
  custom?: VoxuyCustomDialectConfig
}

const requestConfigSchema = z.object({
  method: z.string().default("POST"),
  url: z.string().url("voxuy_request_config.url deve ser uma URL"),
  headers: z.record(z.string()).default({}),
})

/**
 * Config do dialeto custom vinda do tenant (jsonb). Aceita as duas colunas
 * assumidas (voxuy_request_config, voxuy_payload_template) já parseadas. Lança
 * VoxuyConfigError com os NOMES faltantes quando incompleta.
 */
export function parseVoxuyCustomConfig(
  requestConfig: unknown,
  payloadTemplate: unknown,
  flowId?: string,
): VoxuyCustomDialectConfig {
  const missing: string[] = []
  const req = requestConfigSchema.safeParse(requestConfig ?? {})
  if (!req.success) missing.push("VOXUY_REQUEST_CONFIG")
  if (payloadTemplate == null || (typeof payloadTemplate !== "object" && typeof payloadTemplate !== "string")) {
    missing.push("VOXUY_PAYLOAD_TEMPLATE")
  }
  if (missing.length) throw new VoxuyConfigError(missing)
  return {
    request: {
      method: req.success ? req.data.method : "POST",
      url: req.success ? req.data.url : "",
      headers: req.success ? req.data.headers : {},
    },
    payloadTemplate,
    flowId,
  }
}

/** Coerção defensiva de flowId (string do env / inteiro do tenant) => número. */
export function coerceFlowId(raw: unknown): number | null {
  if (raw == null || raw === "") return null
  const n = typeof raw === "number" ? raw : Number(raw)
  return Number.isInteger(n) ? n : null
}

/**
 * Carrega a config do disparo por API. O dialeto vem de VOXUY_DIALECT
 * (default `enterprise_v1`). Para os dialetos enterprise_v1/custom a
 * request/template REAIS por-tenant vêm do tenant_chat_config em runtime (o
 * loader por-tenant monta o VoxuyApiConfig e injeta via construtor do
 * VoxuyApiProvider); este loader por-env cobre o default e serve de base. Lança
 * VoxuyConfigError (só NOMES) quando falta credencial.
 *
 * ESTADO Fase 0 (2026-09-23): `VOXUY_WEBHOOK_URL` está AUSENTE no Netlify e
 * `voxuy_flow_id` é NULL na VMAX → o gate NÃO liga; o disparo permanece `mock`
 * (nada sai do processo). O contrato enterprise_v1 abaixo está PRONTO e testado;
 * ligar exige só (1) VOXUY_WEBHOOK_URL, (2) voxuy_flow_id do tenant e (3) trocar
 * whatsapp_dispatch_mode=voxuy_api. Sem isso, este loader recusa (VoxuyConfigError)
 * e a fábrica cai no MockWhatsAppProvider — comportamento seguro por padrão.
 */
export function loadVoxuyApiConfig(env: NodeJS.ProcessEnv = process.env): VoxuyApiConfig {
  const dialect: VoxuyDialect =
    env.VOXUY_DIALECT === "custom"
      ? "custom"
      : env.VOXUY_DIALECT === "transaction_v1"
        ? "transaction_v1"
        : DEFAULT_VOXUY_DIALECT
  const timeoutMs = (() => {
    const raw = Number(env.VOXUY_TIMEOUT_MS ?? "10000")
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 10_000
  })()
  const apiToken = env.VOXUY_API_TOKEN
  const webhookUrl = env.VOXUY_WEBHOOK_URL
  const flowId = coerceFlowId(env.VOXUY_FLOW_ID)

  const missing: string[] = []
  // A URL-credencial é exigida por enterprise_v1 (é a credencial) e por
  // transaction_v1. O dialeto custom traz a URL do próprio request_config.
  // enterprise_v1: EXIGE o formato canônico (host webhooks.voxuy.com +
  // /voxuyapi/<uuid>) — recusa host errado. transaction_v1 (legado) usa outra
  // forma de URL, então só exige https. A mensagem nunca contém a URL.
  if (dialect === "enterprise_v1") {
    if (!isCanonicalVoxuyWebhookUrl(webhookUrl)) missing.push("VOXUY_WEBHOOK_URL")
  } else if (dialect === "transaction_v1") {
    if (!webhookUrl || !webhookUrl.startsWith("https://")) missing.push("VOXUY_WEBHOOK_URL")
  }
  if (dialect === "transaction_v1" && !apiToken) missing.push("VOXUY_API_TOKEN")
  // flowId pode vir do tenant (voxuy_flow_id); o loader por-env só falha se
  // NENHUMA fonte tiver o flowId. O construtor por-tenant revalida com o tenant.
  if (dialect === "enterprise_v1" && flowId == null) missing.push("VOXUY_FLOW_ID")
  if (missing.length) throw new VoxuyConfigError(missing)

  return {
    dialect,
    webhookUrl,
    apiToken,
    timeoutMs,
    planId: env.VOXUY_PLAN_ID ?? null,
    flowId,
  }
}
