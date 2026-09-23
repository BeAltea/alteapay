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
  /** "Permitir reenvio": ignora APENAS a janela de cooldown de contato — permite
   * disparar de novo ao mesmo devedor. As demais exclusões (supressão, cobrança
   * viva, sem contato, etc.) seguem valendo. Default false. */
  allowResend?: boolean
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

/** Desfechos de UM canal no resultado (para o resumo por canal do painel de
 * sucesso). `sent` = aceitos/enviados; `failed`/`suppressed`/`skipped` idem ao
 * contrato bruto. */
export interface ChannelResultSummary {
  channel: SendChannel
  sent: number
  failed: number
  suppressed: number
  skipped: number
}

/**
 * Resumo por CANAL a partir das linhas do resultado (painel de sucesso).
 * Conta cada (devedor, canal) pelo seu desfecho. Só inclui os canais que
 * aparecem no resultado (ordem canônica WhatsApp → e-mail). Puro e testável.
 */
export function summarizeByChannel(result: SendResponse): ChannelResultSummary[] {
  const byChannel = new Map<SendChannel, ChannelResultSummary>()
  for (const r of result.results) {
    if (r.channel !== "whatsapp" && r.channel !== "email") continue
    const acc =
      byChannel.get(r.channel) ??
      { channel: r.channel, sent: 0, failed: 0, suppressed: 0, skipped: 0 }
    acc[r.outcome] += 1
    byChannel.set(r.channel, acc)
  }
  return ALL_CHANNELS.filter((c) => byChannel.has(c)).map((c) => byChannel.get(c)!)
}

// ---------------------------------------------------------------------------
// Normalização defensiva + estado do painel (compartilhado UI ⇄ testes).
//
// O painel de sucesso NUNCA pode sumir: qualquer coisa que o servidor devolva
// (stream OU json, real OU dry-run, e ATÉ um payload parcial/vazio quando o
// evento `done` do stream se perde num proxy) é coagida aqui para um
// SendResponse válido, e o cabeçalho é decidido de forma pura e testável.
// ---------------------------------------------------------------------------

/** True se `x` é um SendResultRow minimamente plausível (defensivo a JSON solto). */
function isSendResultRow(x: unknown): x is SendResultRow {
  if (typeof x !== "object" || x === null) return false
  const r = x as Record<string, unknown>
  return (
    typeof r.customerId === "string" &&
    (r.outcome === "sent" || r.outcome === "failed" || r.outcome === "suppressed" || r.outcome === "skipped")
  )
}

/**
 * Coage QUALQUER payload (parcial, sem counts, sem results, ou até `null` quando
 * o stream terminou sem o evento `done`) num SendResponse íntegro. Nunca lança —
 * garante que o diálogo SEMPRE tem o que renderizar no painel. Quando os `counts`
 * não vierem (ou vierem incompletos), são recomputados das linhas. `fallback`
 * completa o que o servidor omitiu (ex.: o dryRun/channels que o cliente pediu).
 */
export function normalizeSendResult(
  raw: unknown,
  fallback?: { dryRun?: boolean; channels?: SendChannel[] },
): SendResponse {
  const obj = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>
  const results = Array.isArray(obj.results) ? obj.results.filter(isSendResultRow) : []
  const dryRun = typeof obj.dryRun === "boolean" ? obj.dryRun : fallback?.dryRun ?? false
  const channels =
    Array.isArray(obj.channels)
      ? (obj.channels.filter((c): c is SendChannel => c === "whatsapp" || c === "email"))
      : fallback?.channels
  // counts: usa os do servidor quando completos; senão recomputa das linhas
  // (fonte da verdade menos frágil que um contador que pode ter se perdido).
  const rawCounts = (typeof obj.counts === "object" && obj.counts !== null ? obj.counts : {}) as Record<string, unknown>
  const hasAllCounts = (["sent", "failed", "suppressed", "skipped"] as const).every(
    (k) => typeof rawCounts[k] === "number",
  )
  const counts = hasAllCounts
    ? {
        sent: rawCounts.sent as number,
        failed: rawCounts.failed as number,
        suppressed: rawCounts.suppressed as number,
        skipped: rawCounts.skipped as number,
      }
    : tallyOutcomes(results)
  return {
    dryRun,
    ...(channels ? { channels } : {}),
    ...(typeof obj.dedupe === "boolean" ? { dedupe: obj.dedupe } : {}),
    counts,
    results,
  }
}

/** Tom do cabeçalho do painel: sucesso (verde), atenção a falhas (âmbar) ou
 * simulação (azul). Base para o texto E a cor — puro e testável. */
export type SendPanelTone = "success" | "warning" | "dryRun"

export interface SendPanelHeadline {
  tone: SendPanelTone
  /** texto do cabeçalho (ex.: "✓ Envio concluído"). */
  title: string
  /** houve ao menos uma linha? (false → "Nenhum item foi processado"). */
  hasItems: boolean
}

/**
 * Decide o cabeçalho do painel a partir do resultado (já normalizado). Regras:
 *  - dryRun            → "Simulação concluída" (azul).
 *  - failed > 0        → "Envio com falhas"    (âmbar) — não esconde falha atrás
 *                        de um ✓ verde.
 *  - caso contrário    → "Envio concluído"     (verde).
 * Puro e testável (sem JSX). O ✓/⚠ fica no texto para o teste travar o símbolo.
 */
export function sendPanelHeadline(result: SendResponse): SendPanelHeadline {
  const hasItems = result.results.length > 0
  if (result.dryRun) return { tone: "dryRun", title: "Simulação concluída", hasItems }
  if ((result.counts.failed ?? 0) > 0) return { tone: "warning", title: "⚠ Envio com falhas", hasItems }
  return { tone: "success", title: "✓ Envio concluído", hasItems }
}

/** Estado de renderização do corpo do diálogo. Extraído para ser testável sem
 * jsdom: dado (sending, result), diz O QUE mostrar. A precedência é a mesma da
 * UI — enquanto envia, a barra; terminou, o painel; senão, o preview. */
export type SendDialogView = "progress" | "result" | "form"

export function resolveDialogView(state: { sending: boolean; result: SendResponse | null }): SendDialogView {
  if (state.sending) return "progress"
  if (state.result) return "result"
  return "form"
}
