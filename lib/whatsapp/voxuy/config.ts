// Configuração validada do provider Voxuy (V1).
// - Leitura com zod; mensagem clara quando falta credencial.
// - NUNCA loga o valor de nenhum segredo (só o NOME da variável que faltou).
// - Sem credencial completa, o adapter recusa na construção (V1.3): a campanha
//   nem inicia (erro visível no painel), não falha silenciosamente.
//
// Fonte: Apêndice D. A URL de webhook vem INTEIRA da conta Voxuy (contém o
// `<codigo>`); §1.2 é explícito em NÃO montar a URL concatenando pedaços.

import { z } from "zod"

const envSchema = z.object({
  // URL completa de Integrações → API VOXUY (contém o <codigo> embutido).
  VOXUY_WEBHOOK_URL: z
    .string()
    .url("VOXUY_WEBHOOK_URL deve ser uma URL completa")
    .refine((u) => u.startsWith("https://"), "VOXUY_WEBHOOK_URL deve ser https"),
  // Campo `apiToken` do corpo (não é header).
  VOXUY_API_TOKEN: z.string().min(1, "VOXUY_API_TOKEN vazio"),
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
 * Lê e valida a config da Voxuy a partir do ambiente. Lança VoxuyConfigError
 * (com a LISTA DE NOMES faltantes, sem valores) quando incompleta.
 */
export function loadVoxuyConfig(env: NodeJS.ProcessEnv = process.env): VoxuyConfig {
  const parsed = envSchema.safeParse({
    VOXUY_WEBHOOK_URL: env.VOXUY_WEBHOOK_URL,
    VOXUY_API_TOKEN: env.VOXUY_API_TOKEN,
    VOXUY_TIMEOUT_MS: env.VOXUY_TIMEOUT_MS,
  })
  if (!parsed.success) {
    // Extrai só os NOMES dos campos com erro — jamais o valor.
    const missing = Array.from(
      new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "VOXUY"))),
    )
    throw new VoxuyConfigError(missing)
  }
  return {
    webhookUrl: parsed.data.VOXUY_WEBHOOK_URL,
    apiToken: parsed.data.VOXUY_API_TOKEN,
    timeoutMs: parsed.data.VOXUY_TIMEOUT_MS,
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
