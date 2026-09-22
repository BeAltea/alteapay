// Contrato do envio de negociação (T5 desenvolve CONTRA esta forma; a API é dona
// de T2: POST /api/super-admin/negotiations/send-preview e /send). Tipos aqui
// para o diálogo de confirmação e o resultado por devedor não dependerem da
// implementação do backend — só do formato acordado.

export type SendMode = "whatsapp_chat" | "charge_email" | "both"

/** Canal de contato do hub do link único. */
export type SendChannel = "whatsapp" | "email"

/** Todos os canais na ordem canônica de exibição. */
export const ALL_CHANNELS: SendChannel[] = ["whatsapp", "email"]

/** Corpo enviado para /send-preview e /send. A seleção transporta OU ids
 * explícitos OU os filtros + a contagem confirmada (nunca filtro vivo silencioso).
 *
 * F1: a escolha agora é por CANAL (WhatsApp/e-mail), não por forma de pagamento.
 * `channels` lista os canais marcados no diálogo (ambos por padrão). `dedupe`
 * = "não duplicar": quem tem os dois contatos recebe SÓ por WhatsApp. */
export interface SendRequestBody {
  companyId: string
  /** ids explícitos de customers (seleção manual / página). */
  customerIds?: string[]
  /** OU: seleção "todos os N filtrados" — filtros de conteúdo + contagem confirmada. */
  allFiltered?: {
    filters: Record<string, unknown>
    expectedCount: number
  }
  /** Canais marcados (default: ambos). Vazio → nada a enviar. */
  channels?: SendChannel[]
  /** "Não duplicar": quem tem os dois contatos vai só por WhatsApp (default false). */
  dedupe?: boolean
  dryRun: boolean
  /** A1: chave de idempotência (1x por abertura do diálogo). Double-click/retry com
   * a mesma chave reusam a mesma campanha — não duplicam o envio (incl. e-mail real). */
  idempotencyKey?: string | null
}

export interface SendPreviewExcluded {
  customerId: string
  documentMasked: string
  reason: string // ex.: "suprimido", "sem_contato_para_o_canal", "sem_divida_aberta", "cooldown"
}

/** Contagens de UM canal no preview: quantos recebem e quantos foram excluídos. */
export interface ChannelPreview {
  /** devedores que receberão por este canal. */
  eligible: number
  /** devedores excluídos DESTE canal, por-devedor, com motivo. */
  excluded: SendPreviewExcluded[]
}

/** Resposta de /send-preview: distribuição POR CANAL + cruzamento (sem enviar). */
export interface SendPreviewResponse {
  /** canais avaliados (os marcados no diálogo). */
  channels: SendChannel[]
  /** "não duplicar" aplicado neste preview. */
  dedupe: boolean
  /** total de DEVEDORES distintos que receberão por ao menos um canal. */
  total: number
  /** contagens por canal (elegíveis + excluídos por-devedor). */
  perChannel: Record<SendChannel, ChannelPreview>
  /** CRUZAMENTO: devedores que receberão pelos DOIS canais (só quando ambos
   * marcados e dedupe OFF; com dedupe ON é sempre 0 — vão só por WhatsApp). */
  bothCount: number
  /** quantos têm os DOIS contatos válidos (independe de dedupe) — destaque. */
  hasBothContacts: number
  withLiveCharge: number // informativo (§4.2)
  /** link /n/{code} a ser enviado (opaco por cedente). null = link único desabilitado. */
  publicLink: string | null
  /** link único habilitado no cedente (o publicLink pode ser null mesmo assim se faltar code). */
  linkEnabled?: boolean
  /** WhatsApp em modo simulado (provider=mock) — badge no diálogo. */
  whatsappSimulated?: boolean
  /** F4: qual template o e-mail usará (padrão do cedente / global / convite embutido). */
  emailTemplate?: EmailTemplateInfo
}

/** F4: fonte + nome do template de e-mail que será usado no envio. */
export interface EmailTemplateInfo {
  /** cedente = padrão do cedente; global = padrão global; builtin = convite embutido. */
  source: "cedente" | "global" | "builtin"
  /** nome do template (ou "Convite padrão AlteaPay" no builtin). */
  name: string
}

export type SendOutcome = "sent" | "failed" | "suppressed" | "skipped"

/** Resultado de UM (devedor, canal). Um devedor com os dois contatos gera DOIS. */
export interface SendResultRow {
  customerId: string
  documentMasked: string
  channel: SendChannel | null
  outcome: SendOutcome
  detail?: string | null
}

/** Resposta de /send (dryRun ou real). Resultado POR (DEVEDOR, CANAL) + contadores. */
export interface SendResponse {
  dryRun: boolean
  /** canais efetivamente processados. */
  channels?: SendChannel[]
  dedupe?: boolean
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
  sem_contato_para_o_canal: "Sem contato para o canal escolhido",
  sem_celular_valido: "Sem celular válido",
  sem_email_valido: "Sem e-mail válido",
  priorizado_whatsapp: "Priorizado no WhatsApp (não duplicado)",
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
