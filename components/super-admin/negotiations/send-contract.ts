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

// ---------------------------------------------------------------------------
// Rótulos legíveis (A3.3): tradução dos códigos de `detail`/`reason` que o
// backend (lib/journey/campaigns + campaign-send) devolve por devedor, para
// exibição no resumo/lista de falhas SEM treino. Nunca contém PII (só código).
// ---------------------------------------------------------------------------
export const DETAIL_LABEL: Record<string, string> = {
  // exclusões (elegibilidade do hub) — vêm em suppressed/skipped
  sem_contato: "Sem contato válido (celular ou e-mail)",
  sem_celular_valido: "Sem celular válido",
  suprimido: "Contato suprimido (opt-out/bloqueio)",
  sem_divida_aberta: "Sem dívida em aberto",
  cobranca_viva: "Já possui cobrança viva",
  caso_aberto: "Já possui caso de negociação aberto",
  cooldown: "Em janela de espera (cooldown)",
  valor_minimo: "Abaixo do valor mínimo",
  telefone_duplicado: "Telefone repetido na seleção",
  ja_contatado_campanha: "Já contatado nesta campanha",
  ja_registrado: "Já registrado nesta campanha",
  // desfechos de envio
  dry_run: "Simulado (nada enviado)",
  queued: "Enfileirado para envio",
  sem_link_publico: "Cedente sem link único habilitado",
  email_failed: "Falha no envio do e-mail",
  send_failed: "Falha no envio",
  insert_failed: "Falha ao registrar o envio",
  network_error: "Erro de rede ao enviar",
  timeout: "Tempo esgotado ao enviar",
}

/** Traduz um código de `detail` para texto legível. Desconhecido → o próprio
 * código (nunca inventamos; nunca é PII, o backend só emite códigos). */
export function detailLabel(detail: string | null | undefined): string {
  if (!detail) return "—"
  return DETAIL_LABEL[detail] ?? detail
}

/**
 * Resumo por categoria de EXIBIÇÃO (A3.3). Diferente de `counts` (o contrato
 * bruto sent/failed/suppressed/skipped), separa "enviadas" de "simuladas": num
 * dry run TODO desfecho `sent` é simulação. Puro e testável.
 */
export interface SendDisplaySummary {
  enviadas: number
  simuladas: number
  falharam: number
  suprimidas: number
  ignoradas: number
}

export function summarizeForDisplay(result: SendResponse): SendDisplaySummary {
  const sent = result.counts.sent ?? 0
  return {
    enviadas: result.dryRun ? 0 : sent,
    simuladas: result.dryRun ? sent : 0,
    falharam: result.counts.failed ?? 0,
    suprimidas: result.counts.suppressed ?? 0,
    ignoradas: result.counts.skipped ?? 0,
  }
}

/** Linhas de FALHA (outcome === "failed"), com o motivo já legível. */
export function failureRows(
  result: SendResponse,
): Array<{ customerId: string; documentMasked: string; channel: string | null; reason: string }> {
  return result.results
    .filter((r) => r.outcome === "failed")
    .map((r) => ({
      customerId: r.customerId,
      documentMasked: r.documentMasked,
      channel: r.channel,
      reason: detailLabel(r.detail),
    }))
}
