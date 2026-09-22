// Parsing/serialização dos filtros da página de negociações (T5).
//
// PURO: a mesma função lê tanto os searchParams do server component quanto o
// querystring da list API. Os filtros vivem na URL (combináveis) e a seleção
// "todos os N filtrados" reusa EXATAMENTE este objeto para nunca incluir
// silenciosamente quem está fora do filtro (§4.1).

import type { ContactProfile } from "./stages"

export type SortField = "stage" | "last_activity"
export type SortDir = "asc" | "desc"

export interface NegotiationFilters {
  companyId: string | null
  /** cedente = company (super-admin cross-tenant). Alias de companyId no filtro. */
  stages: string[]
  contactProfiles: ContactProfile[]
  channel: string | null
  campaignId: string | null
  hasLiveCharge: boolean | null
  suppressed: boolean | null
  agingMin: number | null
  agingMax: number | null
  valueMin: number | null
  valueMax: number | null
  activitySince: string | null // ISO date (yyyy-mm-dd) — última atividade >= X
  activityUntil: string | null
  search: string | null // busca por documento MASCARADO
  sort: SortField
  dir: SortDir
  page: number
  pageSize: number
}

const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200

function toInt(v: string | null | undefined): number | null {
  if (v == null || v === "") return null
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) ? n : null
}

function toFloat(v: string | null | undefined): number | null {
  if (v == null || v === "") return null
  const n = Number.parseFloat(v)
  return Number.isFinite(n) ? n : null
}

function toBool(v: string | null | undefined): boolean | null {
  if (v === "1" || v === "true" || v === "sim") return true
  if (v === "0" || v === "false" || v === "nao") return false
  return null
}

function toList(v: string | null | undefined): string[] {
  if (!v) return []
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Aceita um objeto simples de string→string|string[] (searchParams do Next). */
export type RawParams = Record<string, string | string[] | undefined>

function first(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v[0] ?? null
  return v ?? null
}

export function parseFilters(raw: RawParams | URLSearchParams): NegotiationFilters {
  const get = (k: string): string | null =>
    raw instanceof URLSearchParams ? raw.get(k) : first(raw[k])

  const rawPageSize = toInt(get("pageSize")) ?? DEFAULT_PAGE_SIZE
  const pageSize = Math.min(Math.max(1, rawPageSize), MAX_PAGE_SIZE)
  const sortRaw = get("sort")
  const dirRaw = get("dir")

  return {
    companyId: get("companyId") || get("cedente") || null,
    stages: toList(get("stage")),
    // Perfil de contato: aceita o alias curto `contato` (forma compartilhável
    // documentada, ?contato=mobile,both) OU o nome canônico `contact_profile`
    // (compat com selection.ts / round-trip de serializeFilters). `contato` tem
    // precedência quando ambos vêm na URL. Valores fora do enum são descartados.
    contactProfiles: toList(get("contato") || get("contact_profile")).filter(
      (p): p is ContactProfile => ["mobile", "email_only", "both", "none"].includes(p),
    ),
    channel: get("channel") || null,
    campaignId: get("campaign") || get("campaignId") || null,
    hasLiveCharge: toBool(get("live_charge")),
    suppressed: toBool(get("suppressed")),
    agingMin: toInt(get("aging_min")),
    agingMax: toInt(get("aging_max")),
    valueMin: toFloat(get("value_min")),
    valueMax: toFloat(get("value_max")),
    activitySince: get("activity_since") || null,
    activityUntil: get("activity_until") || null,
    search: get("q") || null,
    sort: sortRaw === "stage" ? "stage" : "last_activity",
    dir: dirRaw === "asc" ? "asc" : "desc",
    page: Math.max(0, toInt(get("page")) ?? 0),
    pageSize,
  }
}

/** Serializa de volta para querystring (para links de ordenação/paginação/URL). */
export function serializeFilters(f: Partial<NegotiationFilters>): string {
  const p = new URLSearchParams()
  if (f.companyId) p.set("companyId", f.companyId)
  if (f.stages?.length) p.set("stage", f.stages.join(","))
  // Emite o alias curto documentado (?contato=mobile,both) para a URL
  // compartilhável/recarregável. parseFilters aceita `contato` e `contact_profile`.
  if (f.contactProfiles?.length) p.set("contato", f.contactProfiles.join(","))
  if (f.channel) p.set("channel", f.channel)
  if (f.campaignId) p.set("campaign", f.campaignId)
  if (f.hasLiveCharge != null) p.set("live_charge", f.hasLiveCharge ? "1" : "0")
  if (f.suppressed != null) p.set("suppressed", f.suppressed ? "1" : "0")
  if (f.agingMin != null) p.set("aging_min", String(f.agingMin))
  if (f.agingMax != null) p.set("aging_max", String(f.agingMax))
  if (f.valueMin != null) p.set("value_min", String(f.valueMin))
  if (f.valueMax != null) p.set("value_max", String(f.valueMax))
  if (f.activitySince) p.set("activity_since", f.activitySince)
  if (f.activityUntil) p.set("activity_until", f.activityUntil)
  if (f.search) p.set("q", f.search)
  if (f.sort) p.set("sort", f.sort)
  if (f.dir) p.set("dir", f.dir)
  if (f.page) p.set("page", String(f.page))
  if (f.pageSize && f.pageSize !== DEFAULT_PAGE_SIZE) p.set("pageSize", String(f.pageSize))
  return p.toString()
}

/** Filtros "de conteúdo" (sem paginação/ordenação) — usados para a seleção de
 * "todos os N filtrados": a seleção transporta ISTO, não a página atual. */
export function contentFilters(f: NegotiationFilters): Omit<NegotiationFilters, "page" | "pageSize" | "sort" | "dir"> {
  const { page: _p, pageSize: _ps, sort: _s, dir: _d, ...rest } = f
  return rest
}
