// Contrato do envio de negociação (T5 desenvolve CONTRA esta forma; a API é dona
// de T2: POST /api/super-admin/negotiations/send-preview e /send). Tipos aqui
// para o diálogo de confirmação e o resultado por devedor não dependerem da
// implementação do backend — só do formato acordado.

export type SendMode = "whatsapp_chat" | "charge_email" | "both"

/** Corpo enviado para /send-preview e /send. A seleção transporta OU ids
 * explícitos OU os filtros + a contagem confirmada (nunca filtro vivo silencioso). */
export interface SendRequestBody {
  companyId: string
  /** ids explícitos de customers (seleção manual / página). */
  customerIds?: string[]
  /** OU: seleção "todos os N filtrados" — filtros de conteúdo + contagem confirmada. */
  allFiltered?: {
    filters: Record<string, unknown>
    expectedCount: number
  }
  mode: SendMode
  dryRun: boolean
}

export interface SendPreviewExcluded {
  customerId: string
  documentMasked: string
  reason: string // ex.: "suppressed", "no_contact", "paid", "already_live_charge"
}

/** Resposta de /send-preview: distribuição por canal + exclusões (sem enviar). */
export interface SendPreviewResponse {
  total: number
  byChannel: { whatsapp: number; email: number }
  withLiveCharge: number // informativo (§4.2)
  excluded: SendPreviewExcluded[]
  mode: SendMode
  /** modos permitidos pelo tenant (para habilitar a troca whatsapp_chat↔charge_email). */
  allowedModes: SendMode[]
  /** link /n/{code} a ser enviado (opaco por cedente). null = link único desabilitado. */
  publicLink: string | null
  /** link único habilitado no cedente (o publicLink pode ser null mesmo assim se faltar code). */
  linkEnabled?: boolean
}

export type SendOutcome = "sent" | "failed" | "suppressed" | "skipped"

export interface SendResultRow {
  customerId: string
  documentMasked: string
  channel: "whatsapp" | "email" | null
  outcome: SendOutcome
  detail?: string | null
}

/** Resposta de /send (dryRun ou real). Resultado POR DEVEDOR + contadores. */
export interface SendResponse {
  dryRun: boolean
  counts: Record<SendOutcome, number>
  results: SendResultRow[]
}

export function emptyOutcomeCounts(): Record<SendOutcome, number> {
  return { sent: 0, failed: 0, suppressed: 0, skipped: 0 }
}

export function tallyOutcomes(rows: SendResultRow[]): Record<SendOutcome, number> {
  const c = emptyOutcomeCounts()
  for (const r of rows) c[r.outcome] += 1
  return c
}
