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
// Sem N+1: usa os índices de negotiation_state
//   (idx_neg_state_company_stage / _rank / _updated) e resolve os satélites em
//   lote com `.in(...)`. Documento NUNCA sai em claro (maskDocument). Volume 3196.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { maskDocument } from "@/lib/journey/document"
import { maskName } from "@/lib/negotiation/pii"
import { stageRank } from "@/lib/journey/negotiation-state"
import type { ContactProfile } from "./stages"
import type { NegotiationFilters } from "./filters"

const PAGE_SIZE = 1000

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

/**
 * Carrega, em lote, os satélites por customer:
 *   - customers: nome, documento, contact_profile
 *   - debts: soma do valor em aberto (status != paid) + data de vencimento mais antiga
 *   - suppressions: existe supressão ativa?
 */
async function loadSatellites(
  companyIds: string[],
  customerIds: string[],
  campaignIds: string[],
) {
  const supabase = createServiceClient()

  const chunks = <T,>(arr: T[], size = 300): T[][] => {
    const out: T[][] = []
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
    return out
  }

  const customerById = new Map<
    string,
    { name: string | null; document: string | null; contact_profile: ContactProfile | null }
  >()
  for (const part of chunks(customerIds)) {
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
  for (const part of chunks(Array.from(new Set(companyIds)))) {
    const { data } = await (supabase as any).from("companies").select("id, name").in("id", part)
    for (const c of data ?? []) companyById.set(c.id, c.name)
  }

  // link único por cedente (tenant_chat_config). code só é exposto quando o link
  // está habilitado — senão o botão "Copiar link" fica desabilitado (sem link
  // quebrado). Isolado por company (uma linha de config por company).
  const publicLinkByCompany = new Map<string, string | null>()
  for (const part of chunks(Array.from(new Set(companyIds)))) {
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
    for (const part of chunks(Array.from(new Set(validCampaignIds)))) {
      const { data } = await (supabase as any)
        .from("whatsapp_campaigns")
        .select("id, name")
        .in("id", part)
      for (const c of data ?? []) campaignById.set(c.id, c.name)
    }
  }

  // debts: agrega valor em aberto + vencimento mais antigo por customer.
  const debtAgg = new Map<string, { open: number; oldestDue: string | null }>()
  for (const part of chunks(customerIds)) {
    let page = 0
    for (;;) {
      const { data } = await (supabase as any)
        .from("debts")
        .select("customer_id, amount, current_amount, due_date, status")
        .in("customer_id", part)
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
      const rows = (data ?? []) as Array<{
        customer_id: string
        amount: number | null
        current_amount: number | null
        due_date: string | null
        status: string | null
      }>
      for (const d of rows) {
        const status = (d.status ?? "").toLowerCase()
        if (status === "paid" || status === "written_off") continue
        const open = Number(d.current_amount ?? d.amount ?? 0)
        const prev = debtAgg.get(d.customer_id) ?? { open: 0, oldestDue: null }
        prev.open += Number.isFinite(open) ? open : 0
        if (d.due_date && (!prev.oldestDue || d.due_date < prev.oldestDue)) {
          prev.oldestDue = d.due_date
        }
        debtAgg.set(d.customer_id, prev)
      }
      if (rows.length < PAGE_SIZE) break
      page++
    }
  }

  // suppressions: customer com supressão ativa (scope customer). Isolado por company.
  const suppressed = new Set<string>()
  for (const part of chunks(customerIds)) {
    const { data } = await (supabase as any)
      .from("contact_suppressions")
      .select("customer_id, active")
      .in("customer_id", part)
      .eq("active", true)
    for (const s of data ?? []) if (s.customer_id) suppressed.add(s.customer_id)
  }

  return { customerById, companyById, campaignById, debtAgg, suppressed, publicLinkByCompany }
}

/**
 * Consulta principal. Duas fases:
 *  1. Carrega TODAS as linhas de negotiation_state que casam os filtros baratos
 *     (company, stage, channel, campaign, has_live_charge) usando os índices;
 *     resolve satélites em lote; aplica os filtros que dependem de satélites
 *     (contact_profile, aging, valor, supressão, busca por doc mascarado,
 *     período de última atividade) em memória.
 *  2. Calcula contadores por estágio sobre o TOTAL filtrado, ordena e pagina.
 *
 * Contadores fecham por construção: byStage é derivado da MESMA lista filtrada
 * que produz `total` (§5).
 */
export async function queryNegotiations(
  f: NegotiationFilters,
  opts: { collectAll?: boolean } = {},
): Promise<NegotiationListResult> {
  const collectAll = opts.collectAll ?? false
  const supabase = createServiceClient()

  // ---- fase 1: negotiation_state (índices de T1) ----
  let stateRows: any[] = []
  let page = 0
  for (;;) {
    let q = (supabase as any)
      .from("negotiation_state")
      .select(
        "company_id, customer_id, stage, stage_rank, stage_at, channel, campaign_id, has_live_charge, provider_status_source, updated_at",
      )
    if (f.companyId) q = q.eq("company_id", f.companyId)
    if (f.stages.length) q = q.in("stage", f.stages)
    if (f.channel) q = q.eq("channel", f.channel)
    if (f.campaignId) q = q.eq("campaign_id", f.campaignId)
    if (f.hasLiveCharge != null) q = q.eq("has_live_charge", f.hasLiveCharge)
    q = q.order("updated_at", { ascending: false }).range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)

    const { data, error } = await q
    if (error) throw new Error(`negotiation_state: ${error.message}`)
    const rows = data ?? []
    stateRows = stateRows.concat(rows)
    if (rows.length < PAGE_SIZE) break
    page++
  }

  const companyIds = stateRows.map((r) => r.company_id)
  const customerIds = stateRows.map((r) => r.customer_id).filter(Boolean)
  const campaignIds = stateRows.map((r) => r.campaign_id).filter(Boolean)
  const sat = await loadSatellites(companyIds, customerIds, campaignIds)

  // ---- monta linhas + aplica filtros dependentes de satélite ----
  const search = f.search?.trim() || null
  let all: NegotiationRow[] = stateRows.map((r) => {
    const cust = sat.customerById.get(r.customer_id)
    const agg = sat.debtAgg.get(r.customer_id) ?? { open: 0, oldestDue: null }
    const aging = agingFrom(agg.oldestDue)
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
    }
  })

  all = all.filter((row) => {
    if (f.contactProfiles.length && !f.contactProfiles.includes(row.contactProfile as ContactProfile))
      return false
    if (f.suppressed != null && row.suppressed !== f.suppressed) return false
    if (f.agingMin != null && (row.agingDays == null || row.agingDays < f.agingMin)) return false
    if (f.agingMax != null && (row.agingDays == null || row.agingDays > f.agingMax)) return false
    if (f.valueMin != null && row.openAmount < f.valueMin) return false
    if (f.valueMax != null && row.openAmount > f.valueMax) return false
    if (f.activitySince && (!row.lastActivityAt || row.lastActivityAt < f.activitySince)) return false
    if (f.activityUntil && (!row.lastActivityAt || row.lastActivityAt > `${f.activityUntil}T23:59:59.999Z`))
      return false
    if (search && !row.documentMasked.includes(search)) return false
    return true
  })

  // ---- contadores por estágio sobre o TOTAL filtrado (§5, fecham por construção) ----
  const byStage: Record<string, number> = {}
  for (const row of all) byStage[row.stage] = (byStage[row.stage] ?? 0) + 1
  const total = all.length

  // ---- ordenação server-side (estágio / última atividade) ----
  const dirMul = f.dir === "asc" ? 1 : -1
  all.sort((a, b) => {
    if (f.sort === "stage") {
      if (a.stageRank !== b.stageRank) return (a.stageRank - b.stageRank) * dirMul
      // desempate estável por última atividade desc
      return (a.lastActivityAt ?? "") < (b.lastActivityAt ?? "") ? 1 : -1
    }
    const av = a.lastActivityAt ?? ""
    const bv = b.lastActivityAt ?? ""
    if (av === bv) return 0
    return (av < bv ? -1 : 1) * dirMul
  })

  // ---- paginação (opcional: collectAll devolve a lista inteira ordenada) ----
  const rows = collectAll ? all : all.slice(f.page * f.pageSize, f.page * f.pageSize + f.pageSize)

  return { rows, total, byStage, page: f.page, pageSize: f.pageSize }
}

/**
 * Resolve apenas os customerIds do total filtrado (para "selecionar todos os N").
 * Uma única passada (collectAll) — a mesma lógica/filtros da lista, sem re-query.
 */
export async function resolveFilteredCustomerIds(f: NegotiationFilters): Promise<string[]> {
  const full = await queryNegotiations(f, { collectAll: true })
  return full.rows.map((r) => r.customerId)
}
