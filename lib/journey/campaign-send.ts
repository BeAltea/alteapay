// Processamento de UMA mensagem de campanha (chamado pelo whatsapp.worker).
// REVERIFICA supressão/elegibilidade (o estado pode ter mudado desde o
// enfileiramento), cria o token do link NA HORA (valor em claro nunca
// persiste), envia via provider e registra jornada + contadores.

import { createServiceClient } from "@/lib/supabase/service"
import { findBlockingAgreement } from "@/lib/asaas-idempotency"
import { getWhatsAppProvider, resolveDispatchMode } from "@/lib/whatsapp"
import { loadVoxuyApiConfig, coerceFlowId } from "@/lib/whatsapp/voxuy/config"
import { whatsappQueue } from "@/lib/queue/queues"
import { recordEvent } from "./events"
import { isSuppressed } from "./suppressions"
import { issueActionTokens } from "./tokens"
import { dispatchEmailInvite, dispatchRenderedEmail } from "./email-dispatch"
import {
  resolveNegotiationTemplate,
  renderTemplate,
  type ResolvedTemplate,
} from "@/lib/email/templates/resolve-default"
import {
  resolveDebtEmailContext,
  isPublicLinkAvailable,
  type DebtEmailContextEntry,
  type DebtEmailContext,
} from "@/lib/email/templates/render-context"
import {
  loadTenantHubConfig,
  evaluateHubChannels,
  type HubEligibilityResult,
  type HubMultiChannelResult,
  type HubChannel,
  type NegotiationSendMode,
} from "./campaigns"

function appBaseUrl(): string {
  // Remove barra(s) final(is): NEXT_PUBLIC_APP_URL pode vir "https://alteapay.com/"
  // e concatenar "/n/..." geraria "//n/..." (que cai no not-found).
  return (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/+$/, "")
}

/**
 * T3-2: monta o seletor do provider injetando o `voxuy_flow_id` do tenant.
 * - mock (default): devolve a string simples — nada carrega env/credencial.
 * - voxuy_api: carrega a base do env (loadVoxuyApiConfig) e sobrescreve o flowId
 *   com o do tenant (coerceFlowId), caindo no env só como fallback. Se a base
 *   estiver incompleta (VoxuyConfigError), devolve o seletor sem apiConfig: o
 *   construtor do VoxuyApiProvider valida e o erro vira `config` no envio (que
 *   pausa a campanha), em vez de estourar aqui.
 */
export function buildProviderSelector(
  providerRaw: string | null | undefined,
  tenantFlowId: unknown,
): string | { dispatchMode: string; apiConfig?: ReturnType<typeof loadVoxuyApiConfig> } {
  const mode = resolveDispatchMode(providerRaw)
  if (mode !== "voxuy_api") return providerRaw ?? "mock"
  const tFlow = coerceFlowId(tenantFlowId)
  try {
    // O flowId vem do TENANT (tenant_chat_config.voxuy_flow_id), não do env. Sem
    // injetá-lo aqui, loadVoxuyApiConfig lança VoxuyConfigError por falta de
    // VOXUY_FLOW_ID mesmo com o tenant configurado — e a mensagem ficaria `queued`.
    const base = loadVoxuyApiConfig(
      tFlow != null ? { ...process.env, VOXUY_FLOW_ID: String(tFlow) } : process.env,
    )
    return {
      dispatchMode: "voxuy_api",
      apiConfig: { ...base, flowId: tFlow ?? base.flowId },
    }
  } catch {
    // env base incompleta: deixa o VoxuyApiProvider validar e reportar como config.
    return { dispatchMode: "voxuy_api" }
  }
}

export async function processCampaignMessage(
  messageId: string,
): Promise<"sent" | "suppressed" | "failed" | "skipped" | "paused"> {
  const supabase = createServiceClient()
  const { data: msg } = await supabase
    .from("whatsapp_messages")
    .select("*, whatsapp_campaigns!inner(id, company_id, template_key, provider, status, counts)")
    .eq("id", messageId)
    .maybeSingle()
  if (!msg) return "skipped"
  // W2 — idempotência NOSSA: RELÊ o status ANTES de qualquer disparo e ABORTA se
  // a mensagem já foi aceita pelo provider (sent/accepted) ou já teve desfecho
  // (suppressed/failed). O UNIQUE(campaign_id,customer_id) é a trava DURA (dois
  // inserts colidem); este guard evita a 2ª CHAMADA ao provider quando o mesmo
  // (campaign,customer) é reprocessado (retry BullMQ, double-click no inline).
  if (msg.status !== "queued") return "skipped"
  const campaign = msg.whatsapp_campaigns as {
    id: string; company_id: string; template_key: string; provider: string; status: string; counts?: Record<string, unknown>
  }
  if (!["running", "scheduled"].includes(campaign.status)) return "skipped" // pausada/cancelada

  const companyId = campaign.company_id

  // ---- reverificação (estado pode ter mudado)
  const suppressed = await isSuppressed({
    companyId, channel: "whatsapp", phoneE164: msg.phone_e164, customerId: msg.customer_id,
  })
  let blockReason: string | null = suppressed ? "suprimido" : null
  if (!blockReason) {
    const { data: agreements } = await supabase
      .from("agreements")
      .select("id, asaas_payment_id, payment_status, asaas_status")
      .eq("customer_id", msg.customer_id)
      .eq("company_id", companyId)
      .not("asaas_payment_id", "is", null)
    if (findBlockingAgreement(agreements ?? [])) blockReason = "cobranca_viva"
  }
  if (blockReason) {
    await supabase.from("whatsapp_messages").update({
      status: "suppressed", error: blockReason,
      status_history: [...(msg.status_history ?? []), { at: new Date().toISOString(), to: "suppressed", reason: blockReason }],
    }).eq("id", messageId)
    await recordEvent({
      companyId, campaignId: campaign.id, messageId, customerId: msg.customer_id,
      type: "message.suppressed", actor: "system", payload: { reason: blockReason },
    })
    return "suppressed"
  }

  // ---- dados do cliente + config do tenant
  const [{ data: customer }, { data: cfg }, { data: company }] = await Promise.all([
    supabase.from("customers").select("name, document").eq("id", msg.customer_id).single(),
    supabase
      .from("tenant_chat_config")
      .select("link_ttl_hours, whatsapp_sender_label, branding, voxuy_plan_id, voxuy_events, voxuy_flow_id")
      .eq("company_id", companyId)
      .maybeSingle(),
    supabase.from("companies").select("name").eq("id", companyId).maybeSingle(),
  ])
  const branding = (cfg?.branding ?? {}) as { brand_name?: string; creditor_name?: string }
  const voxuyEvents = (cfg?.voxuy_events ?? {}) as { approach?: number | null; stop?: number | null; receipt?: number | null }
  const firstName = (customer?.name ?? "").trim().split(/\s+/)[0] ?? ""
  const brandName = branding.brand_name ?? "AlteaPay"
  const creditorName = branding.creditor_name ?? company?.name ?? brandName

  // ---- tokens de ação na hora do envio (V4: consult + optout + block)
  const { data: tokensExisting } = await supabase
    .from("chat_access_tokens")
    .select("id")
    .eq("message_id", messageId)
    .is("revoked_at", null)
  // reprocesso após falha de envio: revoga tokens anteriores e emite novos
  if (tokensExisting && tokensExisting.length > 0) {
    await supabase.from("chat_access_tokens")
      .update({ revoked_at: new Date().toISOString(), revoke_reason: "resend" })
      .in("id", tokensExisting.map((t) => t.id))
  }
  const tokens = await issueActionTokens({
    companyId,
    customerId: msg.customer_id,
    debtIds: msg.debt_id ? [msg.debt_id] : [],
    campaignId: campaign.id,
    messageId,
    ttlHours: cfg?.link_ttl_hours ?? 168,
  })
  // A mensagem aponta para o token de CONSULTA (V1: um único link).
  await supabase.from("whatsapp_messages").update({ access_token_id: tokens.consult.id }).eq("id", messageId)

  const base = appBaseUrl()
  // ---- envio
  // T3-2: quando o disparo é por API (voxuy_api), injeta o flowId POR-TENANT
  // (tenant_chat_config.voxuy_flow_id) no apiConfig; só cai no env VOXUY_FLOW_ID
  // como fallback. No default (mock) nada disso é carregado — nada sai.
  const provider = getWhatsAppProvider(buildProviderSelector(msg.provider, cfg?.voxuy_flow_id))
  const result = await provider.sendCampaignMessage({
    companyId,
    messageId,
    to: msg.phone_e164,
    customerName: customer?.name ?? "",
    document: (customer?.document ?? "").replace(/\D/g, ""),
    templateKey: campaign.template_key,
    variables: {
      // V1: a mensagem carrega o link único de consulta. optout_url/block_url
      // vão no metadata para o caso (V2) de a operação usar botões de URL.
      consult_url: `${base}/c/${tokens.consult.token}`,
      optout_url: `${base}/c/${tokens.optout.token}/cancelar`,
      block_url: `${base}/c/${tokens.block.token}/bloquear`,
      brand_name: brandName,
      sender_label: cfg?.whatsapp_sender_label ?? "AlteaPay",
      creditor_name: creditorName,
      first_name: firstName,
    },
    voxuyPlanId: cfg?.voxuy_plan_id ?? null,
    voxuyEvent: typeof voxuyEvents.approach === "number" ? voxuyEvents.approach : null,
  })

  const now = new Date().toISOString()
  if (result.accepted) {
    // V7: status HONESTO. A Voxuy responde 200 = "aceito para agendamento",
    // NÃO entregue. Só o mock (ciclo simulado) usa 'sent'. delivered/read
    // dependem de fonte real (provider_status_source != 'none').
    const isVoxuy = campaign.provider === "voxuy"
    const acceptedStatus = isVoxuy ? "accepted" : "sent"
    await supabase.from("whatsapp_messages").update({
      status: acceptedStatus,
      sent_at: now,
      ...(isVoxuy ? { accepted_at: now } : {}),
      provider_message_id: result.providerMessageId ?? null,
      provider_transaction_id: messageId,
      status_history: [...(msg.status_history ?? []), { at: now, to: acceptedStatus }],
    }).eq("id", messageId)
    await recordEvent({
      companyId, campaignId: campaign.id, messageId, customerId: msg.customer_id,
      type: isVoxuy ? "message.accepted" : "message.sent", actor: "system",
      payload: { channel: "whatsapp" },
    })
    return "sent"
  }

  // 429/5xx/timeout = retryável (§1.5): NÃO marca a mensagem como failed (ela
  // fica 'queued' para o BullMQ reprocessar com backoff); apenas propaga o erro.
  // O guard `msg.status !== "queued"` no topo garante idempotência do reprocesso.
  if (result.errorClass === "retryable") {
    await recordEvent({
      companyId, campaignId: campaign.id, messageId, customerId: msg.customer_id,
      type: "message.failed", actor: "system",
      payload: { channel: "whatsapp", transient: true, error: result.error ?? "retryable" },
    })
    throw new Error(`voxuy_retryable:${result.error ?? "unknown"}`)
  }

  // W2 — consumidor de pauseCampaign (§3). O provider sinaliza credencial
  // inválida (401/403/404) de DUAS formas: errorClass 'config' E o flag explícito
  // result.raw.pauseCampaign=true. Consumimos AMBOS: marcamos a campanha `paused`
  // com o motivo (counts.pause_reason, queryável — não há coluna dedicada) e
  // devolvemos "paused" para o chamador INLINE PARAR de iterar (não bater de novo
  // no provider com a mesma credencial inválida). O worker também recebe "paused"
  // e a próxima mensagem cai no guard `campaign.status not in (running,scheduled)`.
  const pauseFlag = (result.raw as { pauseCampaign?: boolean } | undefined)?.pauseCampaign === true
  const mustPause = result.errorClass === "config" || pauseFlag
  if (mustPause) {
    // reason SEM PII: só a classe do erro (nunca a message do provider, que pode
    // ser sensível, nem a URL-credencial).
    const pauseReason = `provider_config_error:${result.errorClass ?? "config"}`
    // O motivo vive em counts.pause_reason (queryável pela UI) — não há evento
    // dedicado `campaign.paused` no enum de jornada; a auditoria fica no
    // message.failed abaixo (errorClass) + o campo pause_reason da campanha.
    await supabase.from("whatsapp_campaigns")
      .update({
        status: "paused",
        counts: { ...(campaign.counts ?? {}), pause_reason: pauseReason, paused_at: now },
      })
      .eq("id", campaign.id)
      .in("status", ["running", "scheduled"])
  }
  await supabase.from("whatsapp_messages").update({
    status: "failed",
    error: result.error ?? "send_failed",
    provider_transaction_id: messageId,
    provider_trace_id: result.traceId ?? null,
    status_history: [...(msg.status_history ?? []), { at: now, to: "failed", error: result.error }],
  }).eq("id", messageId)
  await recordEvent({
    companyId, campaignId: campaign.id, messageId, customerId: msg.customer_id,
    type: "message.failed", actor: "system",
    payload: { channel: "whatsapp", error: result.error ?? "send_failed", errorClass: result.errorClass, traceId: result.traceId },
  })
  // Credencial inválida: devolve "paused" (não "failed") para o inline abortar o
  // laço. A mensagem em si fica 'failed' (registro do que ocorreu), mas o desfecho
  // de CONTROLE do laço é a pausa.
  return mustPause ? "paused" : "failed"
}

// ===========================================================================
// HUB DE ENVIO (link único) — orquestra o disparo por devedor E CANAL.
//
// Diferente do worker de campanha (processCampaignMessage), esta função dispara
// por CANAL (whatsapp → fila/inline; email → convite com o mesmo link) a partir
// do snapshot MULTI-CANAL da campanha do hub. Grava 1 whatsapp_messages por
// (campaign_id, customer_id, channel), jobId determinístico SEM ':' com o canal,
// journey_events e estágio. Cada canal é uma sequência independente (E3).
// ===========================================================================

/** Resultado por (devedor, canal) no hub. */
export interface HubSendItem {
  customerId: string
  channel?: "whatsapp" | "email"
  status: "sent" | "failed" | "suppressed" | "skipped"
  reason?: string
  messageId?: string
  jobId?: string
}

export interface HubSendResult {
  campaignId: string
  mode: NegotiationSendMode
  dispatchMode: "inline" | "queue"
  dryRun: boolean
  items: HubSendItem[]
  summary: { sent: number; failed: number; suppressed: number; skipped: number }
}

/** jobId determinístico SEM ':' (regra BullMQ). Inclui o canal para que os dois
 * canais do mesmo devedor tenham jobs distintos (E4). */
function hubJobId(campaignId: string, customerId: string, channel: HubChannel): string {
  return `hub_${channel}_${campaignId}_${customerId}`
}

/** Monta o link público único do cedente (/n/{code}). */
function publicLink(code: string | null): string | null {
  if (!code) return null
  return `${appBaseUrl()}/n/${code}`
}

/** Contexto de branding/link compartilhado por todos os envios de uma campanha. */
interface HubSendContext {
  campaignId: string
  companyId: string
  provider: string
  link: string | null
  brandName: string
  creditorName: string
  dispatchMode: "inline" | "queue"
  /** F4: template de negociação resolvido (cedente→global→builtin), 1x por campanha. */
  emailTemplate: ResolvedTemplate | null
  /** contato de suporte para a variável {{contato_suporte}} (branding/env). */
  supportContact: string
  /**
   * D1: contexto de DÉBITO por devedor (só quando o template resolvido tem
   * allow_debt_fields). Map<customerId, ok:true{ctx} | ok:false{reason}>. Null
   * quando o template não é de cobrança (nenhum dado de débito injetado).
   */
  debtContext: Map<string, DebtEmailContextEntry> | null
}

/**
 * Insere (idempotente por (campaign_id, customer_id, channel)) a whatsapp_messages
 * do canal e registra o evento `message.queued`. Retorna o id, ou um item de
 * skip (já registrado) / falha (insert falhou).
 */
async function ensureChannelMessage(
  supabase: ReturnType<typeof createServiceClient>,
  ctx: HubSendContext,
  d: { customerId: string; channel: HubChannel; debtIds?: string[]; phoneE164?: string },
): Promise<{ id: string } | { skipped: HubSendItem } | { failed: HubSendItem }> {
  const { data: existing } = await supabase
    .from("whatsapp_messages")
    .select("id, status")
    .eq("campaign_id", ctx.campaignId)
    .eq("customer_id", d.customerId)
    .eq("channel", d.channel)
    .maybeSingle()
  if (existing) {
    return { skipped: { customerId: d.customerId, channel: d.channel, status: "skipped", reason: "ja_registrado", messageId: existing.id } }
  }
  const { data: msg, error: msgErr } = await supabase
    .from("whatsapp_messages")
    .insert({
      company_id: ctx.companyId,
      campaign_id: ctx.campaignId,
      customer_id: d.customerId,
      debt_id: d.debtIds?.[0] ?? null,
      phone_e164: d.phoneE164 ?? "",
      provider: d.channel === "whatsapp" ? ctx.provider : "email",
      channel: d.channel,
      // espelho do canal no jsonb (queryável). Sem PII.
      provider_payload: { channel: d.channel },
      status: "queued",
    })
    .select("id")
    .single()
  if (msgErr || !msg) {
    return { failed: { customerId: d.customerId, channel: d.channel, status: "failed", reason: msgErr?.message ?? "insert_failed" } }
  }
  await recordEvent({
    companyId: ctx.companyId,
    campaignId: ctx.campaignId,
    messageId: msg.id,
    customerId: d.customerId,
    type: "message.queued",
    actor: "system",
    payload: { channel: d.channel },
  })
  return { id: msg.id }
}

/**
 * Envia UMA decisão de WhatsApp (fila ou inline). Isolado por canal.
 *
 * Devolve `{ item, paused }`. `paused=true` quando o INLINE recebeu credencial
 * inválida do provider (processCampaignMessage devolveu "paused"): o chamador
 * (runHubSend) PARA de iterar o canal WhatsApp (não bate de novo no provider
 * com a mesma credencial). No modo `queue` nunca pausa aqui (o worker consome).
 */
async function sendWhatsAppDecision(
  supabase: ReturnType<typeof createServiceClient>,
  ctx: HubSendContext,
  d: { customerId: string; debtIds?: string[]; phoneE164?: string },
): Promise<{ item: HubSendItem; paused: boolean }> {
  const ensured = await ensureChannelMessage(supabase, ctx, { ...d, channel: "whatsapp" })
  if ("skipped" in ensured) return { item: ensured.skipped, paused: false }
  if ("failed" in ensured) return { item: ensured.failed, paused: false }
  const messageId = ensured.id
  const jobId = hubJobId(ctx.campaignId, d.customerId, "whatsapp")
  if (ctx.dispatchMode === "queue") {
    await whatsappQueue.add(
      "campaign-message",
      { kind: "campaign-message", messageId },
      { jobId },
    )
    return {
      item: { customerId: d.customerId, channel: "whatsapp", status: "sent", reason: "queued", messageId, jobId },
      paused: false,
    }
  }
  const outcome = await processCampaignMessage(messageId)
  // "paused" (credencial inválida) → item 'failed' com motivo estável + sinal de
  // pausa para o laço abortar.
  const status: HubSendItem["status"] =
    outcome === "sent" ? "sent"
    : outcome === "suppressed" ? "suppressed"
    : outcome === "skipped" ? "skipped"
    : "failed"
  return {
    item: {
      customerId: d.customerId,
      channel: "whatsapp",
      status,
      messageId,
      ...(outcome === "paused" ? { reason: "campanha_pausada_credencial_invalida" } : {}),
    },
    paused: outcome === "paused",
  }
}

/** Primeiro nome do destinatário (para a variável {{primeiro_nome}}). Sem PII no log. */
function firstNameOf(name: string | null | undefined): string {
  return (name ?? "").trim().split(/\s+/)[0] ?? ""
}

/**
 * Monta o mapa de variáveis da ALLOWLIST para o render do template (F4). NUNCA
 * inclui valores/documentos do débito — só os campos neutros permitidos.
 */
function buildTemplateVars(ctx: HubSendContext, firstName: string): Record<string, string> {
  return {
    primeiro_nome: firstName,
    credor: ctx.creditorName,
    marca: ctx.brandName,
    // {{link_negociacao}} e {{link_descadastro}} apontam para o MESMO link opaco
    // do hub (/n/{code}); o opt-out acontece pós-login (sem rota dedicada).
    link_negociacao: ctx.link ?? "",
    link_descadastro: ctx.link ?? "",
    contato_suporte: ctx.supportContact,
    ano: String(new Date().getFullYear()),
  }
}

/**
 * Envia UMA decisão de e-mail (mesmo link /n/{code}). Isolado por canal.
 *
 * F4: ANTES de despachar, usa o template de negociação resolvido do cedente
 * (ctx.emailTemplate: cedente→global→builtin). Renderiza com a allowlist +
 * re-sanitiza. Se o template resolvido for de cedente/global, dispara o corpo
 * renderizado e GRAVA email_template_id + email_template_version_id na linha da
 * whatsapp_messages. Se for builtin (ou o render caiu para o builtin), usa o
 * convite embutido e as colunas ficam NULL.
 */
async function sendEmailDecision(
  supabase: ReturnType<typeof createServiceClient>,
  ctx: HubSendContext,
  d: { customerId: string; debtIds?: string[]; email?: string; firstName?: string },
): Promise<HubSendItem> {
  const ensured = await ensureChannelMessage(supabase, ctx, { customerId: d.customerId, channel: "email", debtIds: d.debtIds })
  if ("skipped" in ensured) return ensured.skipped
  if ("failed" in ensured) return ensured.failed
  const messageId = ensured.id

  if (!ctx.link) {
    await supabase.from("whatsapp_messages").update({ status: "failed", error: "sem_link_publico" }).eq("id", messageId)
    await recordEvent({
      companyId: ctx.companyId, campaignId: ctx.campaignId, messageId, customerId: d.customerId,
      type: "message.failed", actor: "system", payload: { channel: "email", reason: "sem_link_publico" },
    })
    return { customerId: d.customerId, channel: "email", status: "failed", reason: "sem_link_publico", messageId }
  }

  const firstName = d.firstName ?? ""
  const builtinCtx = {
    firstName,
    brandName: ctx.brandName,
    creditorName: ctx.creditorName,
    link: ctx.link,
  }

  // Resolve subject/html/text a partir do template do cedente (fallback embutido).
  const resolved = ctx.emailTemplate ?? { source: "builtin" as const, subject: "", preheader: "", html: "", text: "" }
  const needsDebtFields = resolved.source !== "builtin" && resolved.allowDebtFields === true

  // D1: template de COBRANÇA exige o contexto de débito do devedor. Falha FECHADA:
  // sem contexto ok:true, o devedor é EXCLUÍDO com o reason estável (nunca cai no
  // convite neutro nem envia campos vazios). O reason aparece no resultado do
  // envio (junto de sem_contato_para_o_canal etc.).
  let debtCtxValue: DebtEmailContext | undefined
  if (needsDebtFields) {
    const entry = ctx.debtContext?.get(d.customerId)
    if (!entry || !entry.ok) {
      const reason = entry && !entry.ok ? entry.reason : "sem_contexto_debito"
      await supabase.from("whatsapp_messages").update({ status: "skipped", error: reason }).eq("id", messageId)
      await recordEvent({
        companyId: ctx.companyId, campaignId: ctx.campaignId, messageId, customerId: d.customerId,
        type: "message.suppressed", actor: "system", payload: { channel: "email", reason },
      })
      return { customerId: d.customerId, channel: "email", status: "skipped", reason, messageId }
    }
    debtCtxValue = entry.ctx
  }

  let emailRes: { ok: boolean; jobId?: string; error?: string }
  // colunas de referência: preenchidas SÓ quando o template NÃO é builtin e o
  // render usou de fato o template (não caiu para o builtin).
  let templateId: string | null = null
  let versionId: string | null = null
  // grupos de variáveis injetados (auditoria C12, sem PII).
  let variableGroups: ("basic" | "debt")[] = ["basic"]

  if (resolved.source !== "builtin") {
    const rendered = renderTemplate(resolved, buildTemplateVars(ctx, firstName), builtinCtx, debtCtxValue)
    if (rendered.ok && !rendered.fellBackToBuiltin) {
      templateId = resolved.templateId ?? null
      versionId = resolved.versionId ?? null
      variableGroups = rendered.variableGroups ?? ["basic"]
      emailRes = await dispatchRenderedEmail({
        to: d.email ?? "",
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        link: ctx.link,
        companyId: ctx.companyId,
        customerId: d.customerId,
      })
    } else if (!rendered.ok && rendered.reason === "render_incomplete") {
      // FALHA FECHADA: token remanescente / cobrança sem contexto → NÃO envia.
      // Nunca cai no convite neutro (seria enviar sem os dados prometidos).
      const now = new Date().toISOString()
      await supabase.from("whatsapp_messages").update({
        status: "failed", error: "render_incomplete",
        status_history: [{ at: now, to: "failed", channel: "email", error: "render_incomplete" }],
      }).eq("id", messageId)
      await recordEvent({
        companyId: ctx.companyId, campaignId: ctx.campaignId, messageId, customerId: d.customerId,
        type: "message.failed", actor: "system", payload: { channel: "email", error: "render_incomplete" },
      })
      return { customerId: d.customerId, channel: "email", status: "failed", reason: "render_incomplete", messageId }
    } else {
      // render caiu para o builtin (variável proibida / sem links): usa o convite
      // embutido e mantém as colunas NULL. Convite neutro NÃO leva dados de débito.
      emailRes = await dispatchEmailInvite({
        to: d.email ?? "", customerName: firstName, brandName: ctx.brandName,
        creditorName: ctx.creditorName, link: ctx.link, companyId: ctx.companyId, customerId: d.customerId,
      })
    }
  } else {
    // builtin puro: convite embutido, colunas NULL.
    emailRes = await dispatchEmailInvite({
      to: d.email ?? "", customerName: firstName, brandName: ctx.brandName,
      creditorName: ctx.creditorName, link: ctx.link, companyId: ctx.companyId, customerId: d.customerId,
    })
  }

  const now = new Date().toISOString()
  if (emailRes.ok) {
    await supabase.from("whatsapp_messages").update({
      status: "sent", sent_at: now, provider_message_id: emailRes.jobId ?? null,
      email_template_id: templateId, email_template_version_id: versionId,
      variable_groups: variableGroups,
      status_history: [{ at: now, to: "sent", channel: "email" }],
    }).eq("id", messageId)
    await recordEvent({
      companyId: ctx.companyId, campaignId: ctx.campaignId, messageId, customerId: d.customerId,
      type: "message.sent", actor: "system",
      // C12: log com ids + grupos de variáveis. NUNCA nome/documento/valor/venc/e-mail.
      payload: {
        channel: "email",
        templateSource: templateId ? "template" : "builtin",
        template_id: templateId,
        template_version_id: versionId,
        variable_groups: variableGroups,
      },
    })
    return { customerId: d.customerId, channel: "email", status: "sent", messageId, jobId: emailRes.jobId }
  }
  await supabase.from("whatsapp_messages").update({
    status: "failed", error: emailRes.error ?? "email_failed",
    status_history: [{ at: now, to: "failed", channel: "email", error: emailRes.error }],
  }).eq("id", messageId)
  await recordEvent({
    companyId: ctx.companyId, campaignId: ctx.campaignId, messageId, customerId: d.customerId,
    type: "message.failed", actor: "system", payload: { channel: "email", error: emailRes.error },
  })
  return { customerId: d.customerId, channel: "email", status: "failed", reason: emailRes.error, messageId }
}

function tallySummary(items: HubSendItem[]): HubSendResult["summary"] {
  return {
    sent: items.filter((i) => i.status === "sent").length,
    failed: items.filter((i) => i.status === "failed").length,
    suppressed: items.filter((i) => i.status === "suppressed").length,
    skipped: items.filter((i) => i.status === "skipped").length,
  }
}

/**
 * Executa o envio do hub a partir do snapshot da campanha (já criada por
 * createHubCampaign). REVERIFICA cada devedor no envio (estado pode ter mudado) e
 * dispara por CANAL. Cada canal é uma SEQUÊNCIA INDEPENDENTE (E3): uma falha no
 * e-mail não afeta o WhatsApp e vice-versa. `dryRun` devolve o resultado completo
 * sem escrever nem enviar. `dispatchMode='inline'` dispara na request (com
 * teto/rate-limit no chamador); 'queue' enfileira o WhatsApp e envia e-mail direto.
 */
export async function runHubSend(input: {
  campaignId: string
  companyId: string
  dispatchMode: "inline" | "queue"
  dryRun: boolean
  /** Override explícito do dono: quando true, a reverificação de envio PULA apenas
   * a exclusão de cooldown (reenvio ao mesmo devedor dentro da janela de contato).
   * As demais exclusões (suprimido, sem_divida_aberta, cobranca_viva, caso_aberto,
   * valor_minimo, sem_contato) continuam valendo. Default false. */
  allowResend?: boolean
  /**
   * Progresso item-a-item do laço INLINE (streaming). Chamado UMA vez por item
   * REALMENTE processado no envio (não pelas exclusões pré-computadas nem pelo
   * dry-run), na ordem em que os itens são finalizados. `done` é a contagem
   * acumulada de itens processados; `total` é o total previsto de itens a
   * processar; `item` é o desfecho daquele (devedor, canal). Um erro do callback
   * é engolido (o envio nunca falha por causa do progresso). Opcional: sem ele,
   * o comportamento é idêntico ao de hoje. */
  onProgress?: (done: number, total: number, item: HubSendItem) => void | Promise<void>
}): Promise<HubSendResult> {
  const supabase = createServiceClient()
  const { data: campaign, error } = await supabase
    .from("whatsapp_campaigns")
    .select("*")
    .eq("id", input.campaignId)
    .eq("company_id", input.companyId)
    .single()
  if (error || !campaign) throw new Error("campanha não encontrada")

  const snapshot = campaign.selection_snapshot as {
    evaluated?: HubEligibilityResult[]
    channel_decisions?: HubMultiChannelResult[]
    channels?: HubChannel[]
    dedupe?: boolean
    send_mode?: NegotiationSendMode
  }
  const mode: NegotiationSendMode = snapshot?.send_mode ?? "whatsapp_chat"
  const channels: HubChannel[] =
    snapshot?.channels && snapshot.channels.length > 0 ? snapshot.channels : ["whatsapp", "email"]
  const dedupe = snapshot?.dedupe ?? false
  const hub = await loadTenantHubConfig(input.companyId)
  const link = publicLink(hub.publicLinkCode)

  const { data: company } = await supabase
    .from("companies")
    .select("name")
    .eq("id", input.companyId)
    .maybeSingle()
  const { data: cfg } = await supabase
    .from("tenant_chat_config")
    .select("branding, whatsapp_sender_label")
    .eq("company_id", input.companyId)
    .maybeSingle()
  const branding = (cfg?.branding ?? {}) as { brand_name?: string; creditor_name?: string; support_email?: string }
  const brandName = branding.brand_name ?? "AlteaPay"
  const creditorName = branding.creditor_name ?? company?.name ?? brandName
  const supportContact =
    branding.support_email ?? process.env.SENDGRID_FROM_EMAIL ?? "suporte@alteapay.com"

  // F4: resolve UMA vez por campanha o template de negociação por e-mail do
  // cedente (cedente→global→builtin). Só quando o canal e-mail está ativo e não é
  // dry run (o dry run não renderiza/envia). O builtin usa o link do hub.
  let emailTemplate: ResolvedTemplate | null = null
  if (channels.includes("email") && !input.dryRun) {
    emailTemplate = await resolveNegotiationTemplate(
      input.companyId,
      { brandName, creditorName, link: link ?? "" },
      supabase,
    )
  }

  // Reverifica TODO o snapshot no envio (multi-canal). O snapshot é congelado,
  // mas o mundo pode ter mudado (supressão/contato/dívida/cooldown/já contatado).
  const snapshotIds = Array.from(
    new Set((snapshot?.channel_decisions ?? []).map((r) => r.customerId)),
  )
  const reverified = await evaluateHubChannels({
    companyId: input.companyId,
    customerIds: snapshotIds,
    cooldownDays: hub.cooldownDays,
    minDebtValue: hub.minDebtValue,
    campaignId: input.campaignId,
    channels,
    dedupe,
    // Override explícito do dono: PULA apenas a exclusão de cooldown na reverificação.
    allowResend: input.allowResend ?? false,
  })

  const ctx: HubSendContext = {
    campaignId: input.campaignId,
    companyId: input.companyId,
    provider: campaign.provider,
    link,
    brandName,
    creditorName,
    dispatchMode: input.dispatchMode,
    emailTemplate,
    supportContact,
    debtContext: null,
  }

  // Nomes (só p/ {{primeiro_nome}}) dos devedores elegíveis por e-mail. Uma busca
  // em lote, sem outros dados (nunca documento/valor). Vazio quando não há e-mail.
  const emailFirstNames = new Map<string, string>()
  if (channels.includes("email") && !input.dryRun) {
    const emailIds = Array.from(
      new Set(
        reverified.flatMap((r) =>
          r.decisions.filter((x) => x.channel === "email" && x.eligible).map((x) => x.customerId),
        ),
      ),
    )
    if (emailIds.length > 0) {
      const { data: names } = await supabase
        .from("customers")
        .select("id, name")
        .eq("company_id", input.companyId)
        .in("id", emailIds)
      for (const c of (names ?? []) as { id: string; name: string | null }[]) {
        emailFirstNames.set(c.id, firstNameOf(c.name))
      }
    }
  }

  // D1: quando o template de e-mail resolvido é de COBRANÇA (allow_debt_fields),
  // monta o contexto de débito (nome/documento mascarado/valor/vencimento/qtd)
  // EM LOTE, reusando buildAckContext (C4) por devedor. A disponibilidade do link
  // é resolvida UMA vez: fora do ar → resolveDebtEmailContext marca TODOS com
  // link_indisponivel (bloqueia a campanha inteira). Cada devedor ok:false é
  // depois EXCLUÍDO no sendEmailDecision com o reason.
  if (emailTemplate?.allowDebtFields === true && channels.includes("email") && !input.dryRun) {
    const debtInputs = Array.from(
      reverified
        .flatMap((r) => r.decisions)
        .filter((x) => x.channel === "email" && x.eligible)
        .reduce((acc, x) => {
          if (!acc.has(x.customerId)) acc.set(x.customerId, { customerId: x.customerId, debtIds: x.debtIds ?? [] })
          return acc
        }, new Map<string, { customerId: string; debtIds: string[] }>())
        .values(),
    )
    if (debtInputs.length > 0) {
      const linkAvailable = await isPublicLinkAvailable(input.companyId)
      ctx.debtContext = await resolveDebtEmailContext(input.companyId, debtInputs, { linkAvailable })
    } else {
      ctx.debtContext = new Map()
    }
  }

  const items: HubSendItem[] = []

  // Exclusões por (devedor, canal) inelegível — reportadas uma vez cada. Supressão
  // vira suppressed; sem_contato_para_o_canal/priorizado_whatsapp/cooldown/etc. =
  // skipped (nunca troca silenciosa: o canal sempre aparece com o motivo).
  for (const r of reverified) {
    for (const d of r.decisions) {
      if (d.eligible) continue
      const status: HubSendItem["status"] = d.reason === "suprimido" ? "suppressed" : "skipped"
      items.push({ customerId: d.customerId, channel: d.channel, status, reason: d.reason })
    }
  }

  if (input.dryRun) {
    for (const r of reverified) {
      for (const d of r.decisions) {
        if (d.eligible) items.push({ customerId: d.customerId, channel: d.channel, status: "sent", reason: "dry_run" })
      }
    }
    return { campaignId: input.campaignId, mode, dispatchMode: input.dispatchMode, dryRun: input.dryRun, items, summary: tallySummary(items) }
  }

  // W2 (inline): a campanha precisa estar `running` ANTES do laço, porque o
  // envio INLINE do WhatsApp chama processCampaignMessage, que RECUSA (skipped)
  // qualquer campanha fora de running/scheduled. No modo queue isto também é
  // correto (o worker checa o mesmo guard). Só promove draft/scheduled → running
  // (nunca reabre uma campanha paused/cancelada por config-error anterior).
  await supabase
    .from("whatsapp_campaigns")
    .update({ status: "running", started_at: campaign.started_at ?? new Date().toISOString() })
    .eq("id", input.campaignId)
    .in("status", ["draft", "scheduled"])

  // ---- envio real, POR CANAL, em sequências INDEPENDENTES.
  // Cada canal roda seu próprio laço; um throw dentro de um canal é capturado e
  // vira item 'failed' daquele (devedor, canal), sem abortar o outro canal.
  //
  // §3: quando o WhatsApp devolve `paused` (credencial inválida, 401/403/404),
  // PARAMOS de iterar o canal WhatsApp neste envio (não bater de novo no provider
  // com a mesma credencial). A campanha já foi marcada `paused` dentro de
  // processCampaignMessage; os devedores restantes do canal ficam `skipped`
  // (motivo estável) — o e-mail (outro canal) segue normalmente (E3).
  //
  // Progresso (streaming): `total` é o nº de (devedor, canal) ELEGÍVEIS a
  // processar; `done` avança a cada item finalizado (incl. os `skipped` por
  // canal pausado), na ordem em que ocorrem. onProgress é opcional e best-effort
  // (um erro no callback nunca aborta o envio).
  const total = reverified.reduce(
    (acc, r) => acc + channels.reduce((a, ch) => a + (r.decisions.some((x) => x.channel === ch && x.eligible) ? 1 : 0), 0),
    0,
  )
  let done = 0
  const emitProgress = async (item: HubSendItem) => {
    done += 1
    if (!input.onProgress) return
    try {
      await input.onProgress(done, total, item)
    } catch {
      // o progresso é informativo: nunca deixa o envio falhar por causa dele.
    }
  }
  for (const channel of channels) {
    let channelPaused = false
    for (const r of reverified) {
      const d = r.decisions.find((x) => x.channel === channel && x.eligible)
      if (!d) continue
      if (channelPaused && channel === "whatsapp") {
        // canal já pausado neste envio: registra o restante sem chamar o provider.
        const item: HubSendItem = { customerId: d.customerId, channel, status: "skipped", reason: "campanha_pausada_credencial_invalida" }
        items.push(item)
        await emitProgress(item)
        continue
      }
      try {
        if (channel === "whatsapp") {
          const { item, paused } = await sendWhatsAppDecision(supabase, ctx, {
            customerId: d.customerId, debtIds: d.debtIds, phoneE164: d.phoneE164,
          })
          items.push(item)
          if (paused) channelPaused = true // trava: não chama o provider de novo
          await emitProgress(item)
        } else {
          const item = await sendEmailDecision(supabase, ctx, {
            customerId: d.customerId,
            debtIds: d.debtIds,
            email: d.email,
            firstName: emailFirstNames.get(d.customerId) ?? "",
          })
          items.push(item)
          await emitProgress(item)
        }
      } catch (e) {
        // isolamento entre canais (E3): a exceção não escapa e não afeta o outro.
        const item: HubSendItem = { customerId: d.customerId, channel, status: "failed", reason: (e as Error)?.message ?? "send_failed" }
        items.push(item)
        await emitProgress(item)
      }
    }
  }

  // status da campanha (não mexe se pausada por config-error do provider)
  await supabase
    .from("whatsapp_campaigns")
    .update({ status: "running", started_at: campaign.started_at ?? new Date().toISOString() })
    .eq("id", input.campaignId)
    .in("status", ["draft", "scheduled", "running"])

  return { campaignId: input.campaignId, mode, dispatchMode: input.dispatchMode, dryRun: input.dryRun, items, summary: tallySummary(items) }
}
