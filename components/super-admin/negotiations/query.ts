// Consulta server-side da lista de negociações (T5). server-only.
//
// Fonte primária: negotiation_state (projeção de T1) — carrega estágio, canal,
// cobrança viva, procedência do provedor, e as correlações. Junta:
//   - customers (nome, documento MASCARADO na saída, contact_profile)
//   - companies (cedente / brand)
//   - debts (valor em aberto + aging, agregado por customer)
//   - contact_suppressions (flag "suprimido" para o filtro/coluna)
//   - whatsapp_campaigns (nome da campanha)
//
// PAGINAÇÃO REAL server-side (follow-up de performance): a página de dados NÃO
// materializa mais o universo filtrado. Ela pede ao banco só a fatia
// `range(offset, offset+limit-1)` de negotiation_state (ordenada por stage_rank/
// updated_at no BANCO, usando idx_neg_state_company_rank / _updated) e resolve os
// satélites SÓ para as linhas da página (em lote, sem N+1).
//
// Filtros classificam-se em dois grupos:
//   • ESTADO (baratos, expressos no próprio negotiation_state): company, stage,
//     channel, campaign, has_live_charge, janela de última atividade (updated_at).
//   • SATÉLITE (dependem de customers/debts/contact_suppressions): contactProfile,
//     suppressed, aging, valor, busca por documento mascarado. Quando ALGUM
//     satélite está ativo, resolvemos PRIMEIRO o conjunto de customerIds que casa
//     (varredura chunked das tabelas satélite) e restringimos negotiation_state a
//     esses ids (`.in("customer_id", …)`). ESSE mesmo conjunto de ids alimenta a
//     página, os contadores e o total — por isso os três SEMPRE fecham (§5).
//
// Contadores por estágio: consulta de AGREGAÇÃO separada que lê APENAS a coluna
// `stage` (com os mesmos filtros / restrição de ids) — nunca materializa a linha
// completa nem resolve satélite para o universo inteiro. Documento NUNCA sai em
// claro (maskDocument). Volume 3196.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { maskDocument } from "@/lib/journey/document"
import { maskName } from "@/lib/negotiation/pii"
import { stageRank } from "@/lib/journey/negotiation-state"
import type { ContactProfile } from "./stages"
import type { NegotiationFilters } from "./filters"

const PAGE_SIZE = 1000
const IN_CHUNK = 300

export interface NegotiationRow {
  customerId: string
  companyId: string
  cedente: string | null
  nameMasked: string
  documentMasked: string
  contactProfile: ContactProfile | null
  channel: string | null
  stage: string
  stageRank: number
  stageAt: string | null
  lastActivityAt: string | null
  openAmount: number
  agingDays: number | null
  hasLiveCharge: boolean
  providerStatusSource: string
  campaignId: string | null
  campaignName: string | null
  suppressed: boolean
  /** código do link único do cedente (tenant_chat_config.public_link_code). null
   * quando o cedente não tem code ou o link único está desabilitado. Usado para
   * o botão "Copiar link" (nunca um link placeholder). */
  publicLinkCode: string | null
  /** Já recebeu negociação por WhatsApp? Último envio bem-sucedido (accepted/sent/
   * delivered/read) em whatsapp_messages com channel='whatsapp'. null = nunca. */
  lastWhatsappSentAt: string | null
  /** Idem para o canal e-mail (whatsapp_messages.channel='email'). null = nunca. */
  lastEmailSentAt: string | null
}

export interface NegotiationListResult {
  rows: NegotiationRow[]
  total: number // total filtrado (todas as páginas)
  byStage: Record<string, number> // contadores por estágio sobre o TOTAL filtrado
  page: number
  pageSize: number
}

function agingFrom(dueDate: string | null): number | null {
  if (!dueDate) return null
  const due = Date.parse(dueDate)
  if (!Number.isFinite(due)) return null
  const diff = Date.now() - due
  return Math.max(0, Math.floor(diff / 86_400_000))
}

function chunk<T>(arr: T[], size = IN_CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/**
 * Status de whatsapp_messages que contam como "já enviado" para o devedor. A
 * mensagem já deixou a plataforma: aceita pelo provedor (`accepted`), disparada
 * (`sent`) ou confirmada adiante (`delivered`/`read`). `queued`/`failed`/
 * `suppressed` NÃO contam (nunca chegou a sair). Fonte: coluna `status` de
 * whatsapp_messages (migrations 20260916/20260917).
 */
const SENT_MESSAGE_STATUSES = ["accepted", "sent", "delivered", "read"] as const

/** Último envio bem-sucedido por canal (whatsapp | email), por customer. */
interface LastSendByChannel {
  whatsapp: string | null
  email: string | null
}

/** Intersecta um conjunto (possivelmente ainda-null = "sem restrição") com outro. */
function intersect(base: Set<string> | null, add: Set<string>): Set<string> {
  if (base === null) return add
  const out = new Set<string>()
  for (const id of add) if (base.has(id)) out.add(id)
  return out
}

// ------------------------------------------------------------------
// Filtros
// ------------------------------------------------------------------

/** Há algum filtro que só pode ser avaliado nos satélites (não em negotiation_state)? */
function hasSatelliteFilter(f: NegotiationFilters): boolean {
  return (
    f.contactProfiles.length > 0 ||
    f.suppressed != null ||
    f.agingMin != null ||
    f.agingMax != null ||
    f.valueMin != null ||
    f.valueMax != null ||
    !!(f.search && f.search.trim())
  )
}

/**
 * Aplica os filtros de ESTADO (baratos) a um builder de negotiation_state.
 * Inclui a janela de última atividade (updated_at) — activitySince/activityUntil.
 */
function applyStateFilters(q: any, f: NegotiationFilters): any {
  if (f.companyId) q = q.eq("company_id", f.companyId)
  if (f.stages.length) q = q.in("stage", f.stages)
  if (f.channel) q = q.eq("channel", f.channel)
  if (f.campaignId) q = q.eq("campaign_id", f.campaignId)
  if (f.hasLiveCharge != null) q = q.eq("has_live_charge", f.hasLiveCharge)
  if (f.activitySince) q = q.gte("updated_at", f.activitySince)
  if (f.activityUntil) q = q.lte("updated_at", `${f.activityUntil}T23:59:59.999Z`)
  return q
}

// ------------------------------------------------------------------
// Resolução do conjunto de customerIds que casa os filtros SATÉLITE
// ------------------------------------------------------------------

/**
 * Restrição resolvida a partir dos filtros satélite:
 *   - restrict: conjunto POSITIVO de customerIds elegíveis (null = sem restrição
 *     positiva, i.e. o filtro não enumera um universo — ver `exclude`).
 *   - exclude: conjunto NEGATIVO a remover (usado por `suppressed=false` sem um
 *     universo positivo prévio — não dá para enumerar "todos menos estes" sem
 *     varrer tudo, então excluímos os suprimidos do resultado de
 *     negotiation_state em vez de materializar o complemento).
 *
 * Sem estado de módulo: tudo trafega no retorno (seguro sob concorrência).
 */
interface SatelliteRestriction {
  restrict: Set<string> | null
  exclude: Set<string> | null
}

/**
 * Quando algum filtro satélite está ativo, resolve server-side o conjunto de
 * customerIds que casa TODOS eles. Cada filtro restringe (interseção) o conjunto;
 * `restrict=null` significa "ainda sem restrição positiva". Escopado por company
 * quando informado.
 *
 * Este caminho PODE varrer as tabelas satélite (chunked/paginado), mas nunca
 * materializa a linha completa da lista — resolve só ids. É a fonte única do
 * universo satélite que alimenta página + contadores (por isso fecham).
 *
 * NOTA sobre aging/valor: dependem da AGREGAÇÃO de debts por customer (soma do
 * aberto + vencimento mais antigo). Não dá para expressar isso numa única query
 * PostgREST; então agregamos debts por customer (chunked pelo subconjunto já
 * restrito, ou paginado por company quando ainda não há subconjunto) e filtramos
 * o conjunto.
 */
async function resolveSatelliteCustomerIds(
  f: NegotiationFilters,
): Promise<SatelliteRestriction> {
  const supabase = createServiceClient()
  let acc: Set<string> | null = null
  let exclude: Set<string> | null = null

  const search = f.search?.trim() || null
  const wantAgingOrValue =
    f.agingMin != null || f.agingMax != null || f.valueMin != null || f.valueMax != null

  // --- contact_profile (customers.contact_profile) ---
  // Predicado = (company_id = X AND contact_profile IN (...)) — casa EXATAMENTE o
  // índice composto idx_customers_company_contact_profile (company_id,
  // contact_profile) da migration 20260922_hub_link_status.sql. Multi-valor via
  // `.in(...)` (NUNCA regex/like em runtime): o planner resolve o IN como um
  // Bitmap Index Scan sobre esse índice (uma sonda por valor, todas com o mesmo
  // prefixo company_id). Verificado por EXPLAIN em introspecção: Index/Bitmap Scan
  // using idx_customers_company_contact_profile (sem Seq Scan). `select id` só lê
  // a coluna indexável de retorno — nenhum PII trafega nesta resolução.
  if (f.contactProfiles.length) {
    const ids = new Set<string>()
    let page = 0
    for (;;) {
      let q = (supabase as any)
        .from("customers")
        .select("id")
        .in("contact_profile", f.contactProfiles)
      if (f.companyId) q = q.eq("company_id", f.companyId)
      q = q.range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
      const { data } = await q
      const rows = (data ?? []) as Array<{ id: string }>
      for (const r of rows) if (r.id) ids.add(r.id)
      if (rows.length < PAGE_SIZE) break
      page++
    }
    acc = intersect(acc, ids)
  }

  // --- suppressed (contact_suppressions.active) ---
  if (f.suppressed != null) {
    const suppressedIds = new Set<string>()
    let page = 0
    for (;;) {
      let q = (supabase as any)
        .from("contact_suppressions")
        .select("customer_id")
        .eq("active", true)
      if (f.companyId) q = q.eq("company_id", f.companyId)
      q = q.range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
      const { data } = await q
      const rows = (data ?? []) as Array<{ customer_id: string | null }>
      for (const r of rows) if (r.customer_id) suppressedIds.add(r.customer_id)
      if (rows.length < PAGE_SIZE) break
      page++
    }
    if (f.suppressed) {
      // quer os suprimidos → restrição POSITIVA.
      acc = intersect(acc, suppressedIds)
    } else if (acc !== null) {
      // quer os NÃO-suprimidos e já há universo positivo → remove os suprimidos.
      const kept = new Set<string>()
      for (const id of acc) if (!suppressedIds.has(id)) kept.add(id)
      acc = kept
    } else {
      // NÃO-suprimidos sem universo positivo prévio → guarda como EXCLUSÃO.
      exclude = suppressedIds
    }
  }

  // --- aging / valor (agrega debts por customer) ---
  if (wantAgingOrValue) {
    const agg = await aggregateDebts(f.companyId, acc)
    const ids = new Set<string>()
    for (const [customerId, a] of agg) {
      if (exclude && exclude.has(customerId)) continue
      const aging = agingFrom(a.oldestDue)
      if (f.agingMin != null && (aging == null || aging < f.agingMin)) continue
      if (f.agingMax != null && (aging == null || aging > f.agingMax)) continue
      if (f.valueMin != null && a.open < f.valueMin) continue
      if (f.valueMax != null && a.open > f.valueMax) continue
      ids.add(customerId)
    }
    // aging/valor produzem um universo POSITIVO — a exclusão já foi aplicada nele.
    acc = intersect(acc, ids)
    exclude = null
  }

  // --- busca por documento MASCARADO (customers.document → maskDocument) ---
  // O documento é armazenado em claro no banco mas NUNCA sai em claro; a busca é
  // sobre a forma mascarada. Como o mascaramento não é expresso em SQL,
  // resolvemos sobre o universo já restringido (acc). Sem restrição prévia e com
  // companyId, varremos os customers da company; sem companyId nem restrição,
  // varremos por página (cap) — caso raro (busca global sem cedente).
  if (search) {
    const ids = new Set<string>()
    const scanScope = acc ? Array.from(acc) : null
    if (scanScope) {
      for (const part of chunk(scanScope)) {
        const { data } = await (supabase as any)
          .from("customers")
          .select("id, document")
          .in("id", part)
        for (const r of (data ?? []) as Array<{ id: string; document: string | null }>) {
          if (maskDocument(r.document).includes(search)) ids.add(r.id)
        }
      }
    } else {
      let page = 0
      for (;;) {
        let q = (supabase as any).from("customers").select("id, document")
        if (f.companyId) q = q.eq("company_id", f.companyId)
        q = q.range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
        const { data } = await q
        const rows = (data ?? []) as Array<{ id: string; document: string | null }>
        for (const r of rows) if (maskDocument(r.document).includes(search)) ids.add(r.id)
        if (rows.length < PAGE_SIZE) break
        page++
      }
    }
    // busca produz universo POSITIVO — aplica a exclusão pendente, se houver.
    if (exclude) {
      for (const id of exclude) ids.delete(id)
      exclude = null
    }
    acc = intersect(acc, ids)
  }

  // acc=null + exclude!=null → só o pedido de NÃO-suprimidos: a página/contadores
  // restringem negotiation_state removendo `exclude`.
  return { restrict: acc, exclude }
}

/**
 * Agrega debts (aberto + vencimento mais antigo) por customer. Escopado por
 * company quando informado; restringido a `only` quando fornecido (chunked por
 * ids — evita varrer a company inteira quando já há um subconjunto). Retorna só
 * customers COM debt em aberto (aging/valor não fazem sentido sem debt).
 */
async function aggregateDebts(
  companyId: string | null,
  only: Set<string> | null,
): Promise<Map<string, { open: number; oldestDue: string | null }>> {
  const supabase = createServiceClient()
  const debtAgg = new Map<string, { open: number; oldestDue: string | null }>()

  const consume = (rows: Array<{
    customer_id: string
    amount: number | null
    due_date: string | null
    status: string | null
  }>) => {
    for (const d of rows) {
      const status = (d.status ?? "").toLowerCase()
      if (status === "paid" || status === "written_off") continue
      const open = Number(d.amount ?? 0)
      const prev = debtAgg.get(d.customer_id) ?? { open: 0, oldestDue: null }
      prev.open += Number.isFinite(open) ? open : 0
      if (d.due_date && (!prev.oldestDue || d.due_date < prev.oldestDue)) {
        prev.oldestDue = d.due_date
      }
      debtAgg.set(d.customer_id, prev)
    }
  }

  if (only) {
    for (const part of chunk(Array.from(only))) {
      const { data } = await (supabase as any)
        .from("debts")
        .select("customer_id, amount, due_date, status")
        .in("customer_id", part)
      consume((data ?? []) as any)
    }
    return debtAgg
  }

  // sem subconjunto: pagina por company (obrigatório para não varrer tudo).
  let page = 0
  for (;;) {
    let q = (supabase as any)
      .from("debts")
      .select("customer_id, amount, due_date, status")
    if (companyId) q = q.eq("company_id", companyId)
    q = q.range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
    const { data } = await q
    const rows = (data ?? []) as any[]
    consume(rows)
    if (rows.length < PAGE_SIZE) break
    page++
  }
  return debtAgg
}

/**
 * Último envio de negociação POR CANAL (whatsapp/email) por customer, restrito ao
 * conjunto de customers da página (chunked por ids — nunca varre a tabela inteira).
 * Lê whatsapp_messages e agrega o max(queued_at) entre os status de sucesso
 * (SENT_MESSAGE_STATUSES). Retorna só quem tem PELO MENOS um envio; o resto fica
 * ausente do Map (= "nunca enviado").
 *
 * PAGINAÇÃO (>1000): cada chunk de ids é lido com `.range()` paginado — um customer
 * pode ter várias mensagens (várias campanhas × 2 canais), então o número de linhas
 * por chunk pode passar de 1000. Sem `.range()` o Supabase truncaria em silêncio.
 * Ordena por queued_at desc no banco só como conveniência; a agregação toma o MAX
 * de qualquer forma (robusto se a ordenação não vier garantida através dos chunks).
 */
async function loadLastSendByChannel(
  customerIds: string[],
): Promise<Map<string, LastSendByChannel>> {
  const supabase = createServiceClient()
  const out = new Map<string, LastSendByChannel>()
  if (customerIds.length === 0) return out

  for (const part of chunk(customerIds)) {
    let page = 0
    for (;;) {
      const { data, error } = await (supabase as any)
        .from("whatsapp_messages")
        .select("customer_id, channel, status, queued_at")
        .in("customer_id", part)
        .in("status", SENT_MESSAGE_STATUSES as unknown as string[])
        .order("queued_at", { ascending: false })
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
      if (error) throw new Error(`whatsapp_messages(last-send): ${error.message}`)
      const rows = (data ?? []) as Array<{
        customer_id: string | null
        channel: string | null
        status: string | null
        queued_at: string | null
      }>
      for (const r of rows) {
        if (!r.customer_id || !r.queued_at) continue
        const ch = r.channel === "email" ? "email" : "whatsapp"
        const cur = out.get(r.customer_id) ?? { whatsapp: null, email: null }
        const prev = cur[ch]
        if (!prev || r.queued_at > prev) cur[ch] = r.queued_at
        out.set(r.customer_id, cur)
      }
      if (rows.length < PAGE_SIZE) break
      page++
    }
  }
  return out
}

// ------------------------------------------------------------------
// Satélites SÓ da página (nunca do universo inteiro)
// ------------------------------------------------------------------

/**
 * Carrega, em lote, os satélites SÓ para os customers da página pedida:
 *   - customers: nome, documento, contact_profile
 *   - debts: soma do valor em aberto + vencimento mais antigo (chunked por ids)
 *   - suppressions: existe supressão ativa?
 *   - companies / tenant_chat_config / whatsapp_campaigns
 */
async function loadPageSatellites(
  companyIds: string[],
  customerIds: string[],
  campaignIds: string[],
) {
  const supabase = createServiceClient()

  const customerById = new Map<
    string,
    { name: string | null; document: string | null; contact_profile: ContactProfile | null }
  >()
  for (const part of chunk(customerIds)) {
    const { data } = await (supabase as any)
      .from("customers")
      .select("id, name, document, contact_profile")
      .in("id", part)
    for (const c of data ?? []) {
      customerById.set(c.id, {
        name: c.name ?? null,
        document: c.document ?? null,
        contact_profile: (c.contact_profile as ContactProfile | null) ?? null,
      })
    }
  }

  const companyById = new Map<string, string>()
  for (const part of chunk(Array.from(new Set(companyIds)))) {
    const { data } = await (supabase as any).from("companies").select("id, name").in("id", part)
    for (const c of data ?? []) companyById.set(c.id, c.name)
  }

  // link único por cedente (tenant_chat_config). code só é exposto quando o link
  // está habilitado — senão o botão "Copiar link" fica desabilitado (sem link
  // quebrado). Isolado por company (uma linha de config por company).
  const publicLinkByCompany = new Map<string, string | null>()
  for (const part of chunk(Array.from(new Set(companyIds)))) {
    const { data } = await (supabase as any)
      .from("tenant_chat_config")
      .select("company_id, public_link_code, public_link_enabled")
      .in("company_id", part)
    for (const c of data ?? []) {
      const enabled = c.public_link_enabled ?? false
      publicLinkByCompany.set(c.company_id, enabled && c.public_link_code ? c.public_link_code : null)
    }
  }

  const campaignById = new Map<string, string>()
  const validCampaignIds = campaignIds.filter(Boolean)
  if (validCampaignIds.length) {
    for (const part of chunk(Array.from(new Set(validCampaignIds)))) {
      const { data } = await (supabase as any)
        .from("whatsapp_campaigns")
        .select("id, name")
        .in("id", part)
      for (const c of data ?? []) campaignById.set(c.id, c.name)
    }
  }

  // debts: agrega valor em aberto + vencimento mais antigo (SÓ a página).
  const debtAgg = await aggregateDebts(null, new Set(customerIds))

  // suppressions: customer com supressão ativa (SÓ a página).
  const suppressed = new Set<string>()
  for (const part of chunk(customerIds)) {
    const { data } = await (supabase as any)
      .from("contact_suppressions")
      .select("customer_id, active")
      .in("customer_id", part)
      .eq("active", true)
    for (const s of data ?? []) if (s.customer_id) suppressed.add(s.customer_id)
  }

  // último envio de negociação por canal (whatsapp/email) — SÓ a página.
  const lastSendByChannel = await loadLastSendByChannel(customerIds)

  return {
    customerById,
    companyById,
    campaignById,
    debtAgg,
    suppressed,
    publicLinkByCompany,
    lastSendByChannel,
  }
}

function buildRow(
  r: any,
  sat: Awaited<ReturnType<typeof loadPageSatellites>>,
): NegotiationRow {
  const cust = sat.customerById.get(r.customer_id)
  const agg = sat.debtAgg.get(r.customer_id) ?? { open: 0, oldestDue: null }
  const aging = agingFrom(agg.oldestDue)
  const lastSend = sat.lastSendByChannel.get(r.customer_id) ?? { whatsapp: null, email: null }
  return {
    customerId: r.customer_id,
    companyId: r.company_id,
    cedente: sat.companyById.get(r.company_id) ?? null,
    nameMasked: maskName(cust?.name ?? null),
    documentMasked: maskDocument(cust?.document ?? null),
    contactProfile: cust?.contact_profile ?? null,
    channel: r.channel ?? null,
    stage: r.stage ?? "not_started",
    stageRank: r.stage_rank ?? stageRank(r.stage ?? "not_started"),
    stageAt: r.stage_at ?? null,
    lastActivityAt: r.updated_at ?? null,
    openAmount: agg.open,
    agingDays: aging,
    hasLiveCharge: !!r.has_live_charge,
    providerStatusSource: r.provider_status_source ?? "none",
    campaignId: r.campaign_id ?? null,
    campaignName: r.campaign_id ? (sat.campaignById.get(r.campaign_id) ?? null) : null,
    suppressed: sat.suppressed.has(r.customer_id),
    publicLinkCode: sat.publicLinkByCompany.get(r.company_id) ?? null,
    lastWhatsappSentAt: lastSend.whatsapp,
    lastEmailSentAt: lastSend.email,
  }
}

// ------------------------------------------------------------------
// Contadores por estágio — AGREGAÇÃO sem materializar a linha
// ------------------------------------------------------------------

/**
 * Contadores por estágio sobre o universo filtrado, SEM materializar a linha
 * completa. Lê APENAS a coluna `stage` de negotiation_state (com os mesmos
 * filtros de estado + a mesma restrição de ids satélite), paginando. Como usa
 * EXATAMENTE o mesmo predicado que a página, `sum(byStage) === total` por
 * construção (o assert countersReconcile permanece verdadeiro).
 *
 * Ler só `stage` (uma coluna text indexada) é ordens de magnitude mais barato do
 * que materializar as ~15 colunas + resolver satélites para cada linha, e não
 * carrega documento/nome — nenhum PII trafega aqui.
 */
async function countByStage(
  f: NegotiationFilters,
  restrictIds: Set<string> | null,
  excludeIds: Set<string> | null,
): Promise<{ byStage: Record<string, number>; total: number }> {
  const supabase = createServiceClient()
  const byStage: Record<string, number> = {}
  let total = 0

  const idParts: (string[] | null)[] = restrictIds ? chunk(Array.from(restrictIds)) : [null]

  for (const part of idParts) {
    // conjunto vazio de ids restritos → zero linhas (não emite query "in ()").
    if (restrictIds && part && part.length === 0) continue
    let page = 0
    for (;;) {
      let q = (supabase as any).from("negotiation_state").select("stage, customer_id")
      q = applyStateFilters(q, f)
      if (part) q = q.in("customer_id", part)
      q = q.range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
      const { data, error } = await q
      if (error) throw new Error(`negotiation_state(count): ${error.message}`)
      const rows = (data ?? []) as Array<{ stage: string | null; customer_id: string }>
      for (const r of rows) {
        if (excludeIds && excludeIds.has(r.customer_id)) continue
        const stage = r.stage ?? "not_started"
        byStage[stage] = (byStage[stage] ?? 0) + 1
        total++
      }
      if (rows.length < PAGE_SIZE) break
      page++
    }
  }

  return { byStage, total }
}

// ------------------------------------------------------------------
// Consulta principal (paginação REAL server-side)
// ------------------------------------------------------------------

/**
 * Lista paginada de negociações. Passos:
 *  1. Resolve o conjunto de customerIds que casa os filtros SATÉLITE (só quando
 *     algum estiver ativo). Esse conjunto restringe TUDO abaixo.
 *  2. Contadores por estágio + total: agregação lendo só `stage` (mesmos filtros
 *     + mesma restrição) → fecham por construção.
 *  3. Página de dados: pede ao banco só a fatia `range(offset,+limit)` de
 *     negotiation_state (ordenada no BANCO por stage_rank/updated_at, usando os
 *     índices), e resolve satélites SÓ para as linhas da página.
 *
 * `collectAll` (usado por resolveFilteredCustomerIds) devolve todas as linhas do
 * universo filtrado — esse caminho PODE varrer (paginando negotiation_state), mas
 * ainda restrito ao conjunto satélite quando houver.
 */
export async function queryNegotiations(
  f: NegotiationFilters,
  opts: { collectAll?: boolean } = {},
): Promise<NegotiationListResult> {
  const collectAll = opts.collectAll ?? false
  const supabase = createServiceClient()

  // ---- fase 0: restrição por filtros satélite ----
  let restrictIds: Set<string> | null = null
  let excludeIds: Set<string> | null = null
  if (hasSatelliteFilter(f)) {
    const res = await resolveSatelliteCustomerIds(f)
    restrictIds = res.restrict
    excludeIds = res.exclude
  }

  // Restrição impossível (conjunto vazio) → resposta vazia coerente.
  if (restrictIds !== null && restrictIds.size === 0) {
    return { rows: [], total: 0, byStage: {}, page: f.page, pageSize: f.pageSize }
  }

  // ---- fase 1: contadores + total (agregação, sem materializar) ----
  const { byStage, total } = await countByStage(f, restrictIds, excludeIds)

  // ---- ordenação server-side ----
  const orderCol = f.sort === "stage" ? "stage_rank" : "updated_at"
  const ascending = f.dir === "asc"
  const select =
    "company_id, customer_id, stage, stage_rank, stage_at, channel, campaign_id, has_live_charge, provider_status_source, updated_at"

  // ---- fase 2: página de dados ----
  // Caminho COMUM (sem restrição de ids satélite): range direto no banco. Usa
  // idx_neg_state_company_rank (sort=stage) / _updated (sort=last_activity).
  let stateRows: any[] = []

  if (collectAll) {
    // varredura completa do universo filtrado (para resolveFilteredCustomerIds).
    stateRows = await scanState(supabase, f, restrictIds, excludeIds, select, orderCol, ascending)
  } else if (restrictIds === null && excludeIds === null) {
    // paginação REAL: só a fatia pedida sai do banco.
    let q = (supabase as any).from("negotiation_state").select(select)
    q = applyStateFilters(q, f)
    q = q.order(orderCol, { ascending }).order("updated_at", { ascending: false })
    const offset = f.page * f.pageSize
    q = q.range(offset, offset + f.pageSize - 1)
    const { data, error } = await q
    if (error) throw new Error(`negotiation_state(page): ${error.message}`)
    stateRows = data ?? []
  } else {
    // Restrição por ids satélite: o range precisa ser sobre o conjunto ordenado
    // já restrito. Como o `.in(customer_id)` pode exceder um chunk, varremos o
    // universo restrito ordenado e fatiamos a página em memória — mas isso NÃO
    // resolve satélites para tudo (só carrega o negotiation_state cru, leve), e a
    // fatia pesada (satélites da linha) fica limitada à página.
    const restricted = await scanState(
      supabase, f, restrictIds, excludeIds, select, orderCol, ascending,
    )
    const offset = f.page * f.pageSize
    stateRows = restricted.slice(offset, offset + f.pageSize)
  }

  // ---- satélites SÓ das linhas da página ----
  const companyIds = stateRows.map((r) => r.company_id)
  const customerIds = stateRows.map((r) => r.customer_id).filter(Boolean)
  const campaignIds = stateRows.map((r) => r.campaign_id).filter(Boolean)
  const sat = await loadPageSatellites(companyIds, customerIds, campaignIds)

  const rows = stateRows.map((r) => buildRow(r, sat))

  return { rows, total, byStage, page: f.page, pageSize: f.pageSize }
}

/**
 * Varredura completa (paginada) de negotiation_state sob os filtros de estado +
 * restrição/exclusão de ids satélite, ordenada no banco. Carrega só as colunas
 * de estado (sem satélite) — leve mesmo no universo inteiro. Usada pelo caminho
 * `collectAll` e pela paginação com restrição satélite.
 */
async function scanState(
  supabase: any,
  f: NegotiationFilters,
  restrictIds: Set<string> | null,
  excludeIds: Set<string> | null,
  select: string,
  orderCol: string,
  ascending: boolean,
): Promise<any[]> {
  const out: any[] = []
  const idParts: (string[] | null)[] = restrictIds ? chunk(Array.from(restrictIds)) : [null]

  for (const part of idParts) {
    if (restrictIds && part && part.length === 0) continue
    let page = 0
    for (;;) {
      let q = supabase.from("negotiation_state").select(select)
      q = applyStateFilters(q, f)
      if (part) q = q.in("customer_id", part)
      q = q.order(orderCol, { ascending }).order("updated_at", { ascending: false })
      q = q.range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
      const { data, error } = await q
      if (error) throw new Error(`negotiation_state(scan): ${error.message}`)
      const rows = (data ?? []) as any[]
      for (const r of rows) {
        if (excludeIds && excludeIds.has(r.customer_id)) continue
        out.push(r)
      }
      if (rows.length < PAGE_SIZE) break
      page++
    }
  }

  // Ordenação estável final quando a varredura foi feita por múltiplos chunks de
  // ids (cada chunk vem ordenado, mas a concatenação não está globalmente
  // ordenada). Reordena in-memory pelos mesmos critérios do banco.
  if (restrictIds && idParts.length > 1) {
    const dirMul = ascending ? 1 : -1
    out.sort((a, b) => {
      const av = a[orderCol] ?? ""
      const bv = b[orderCol] ?? ""
      if (av !== bv) return (av < bv ? -1 : 1) * dirMul
      // desempate estável por updated_at desc
      const au = a.updated_at ?? ""
      const bu = b.updated_at ?? ""
      return au < bu ? 1 : au > bu ? -1 : 0
    })
  }

  return out
}

/**
 * Resolve apenas os customerIds do total filtrado (para "selecionar todos os N").
 * Continua resolvendo o conjunto COMPLETO server-side: varre negotiation_state
 * (paginado) sob os mesmos filtros/restrição satélite. Não quebra a seleção em
 * lote — devolve todos os ids do universo filtrado, na ordem da lista.
 */
export async function resolveFilteredCustomerIds(f: NegotiationFilters): Promise<string[]> {
  const full = await queryNegotiations(f, { collectAll: true })
  return full.rows.map((r) => r.customerId)
}
