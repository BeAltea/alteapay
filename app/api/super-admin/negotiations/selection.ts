// Resolução da SELEÇÃO das rotas de envio de negociação (send-preview / send).
//
// O diálogo (T5) transporta a seleção de DUAS formas mutuamente exclusivas:
//   - { customerIds: string[] }        — seleção manual / página.
//   - { allFiltered: { filters, expectedCount } } — "todos os N filtrados": o
//     servidor RESOLVE os ids a partir dos MESMOS filtros da lista (reuso de
//     resolveFilteredCustomerIds / ?mode=ids), nunca confiando numa contagem do
//     cliente. O companyId é SEMPRE forçado para o tenant resolvido no servidor
//     (o filtro do corpo nunca escapa o vínculo).
//
// Sem `customerIds` e sem `allFiltered` → erro 400 (fonte única do 400).

import "server-only"
import { parseFilters } from "@/components/super-admin/negotiations/filters"
import { resolveFilteredCustomerIds } from "@/components/super-admin/negotiations/query"

export interface AllFilteredSelection {
  filters: Record<string, unknown>
  expectedCount?: number
}

export interface SelectionBody {
  customerIds?: string[]
  allFiltered?: AllFilteredSelection
}

export interface ResolvedSelection {
  customerIds: string[]
  /** origem da seleção (telemetria/testes). */
  source: "ids" | "allFiltered"
}

export interface SelectionError {
  error: string
  status: number
}

/**
 * Converte os filtros "de conteúdo" transportados pelo diálogo em searchParams e
 * os parseia com o MESMO parser da lista. O companyId é forçado para o tenant do
 * servidor (não o do corpo) — isolamento cross-tenant preservado.
 */
function paramsFromFilters(raw: Record<string, unknown>, companyId: string): URLSearchParams {
  const p = new URLSearchParams()
  const setStr = (k: string, v: unknown) => {
    if (v == null || v === "") return
    p.set(k, String(v))
  }
  const setList = (k: string, v: unknown) => {
    if (Array.isArray(v) && v.length) p.set(k, v.map(String).join(","))
  }
  const setBool = (k: string, v: unknown) => {
    if (v === true || v === false) p.set(k, v ? "1" : "0")
  }

  // company SEMPRE do servidor (vínculo de tenant), ignorando o do corpo.
  p.set("companyId", companyId)
  setList("stage", (raw as any).stages)
  setList("contact_profile", (raw as any).contactProfiles)
  setStr("channel", (raw as any).channel)
  setStr("campaign", (raw as any).campaignId)
  setBool("live_charge", (raw as any).hasLiveCharge)
  setBool("suppressed", (raw as any).suppressed)
  setStr("aging_min", (raw as any).agingMin)
  setStr("aging_max", (raw as any).agingMax)
  setStr("value_min", (raw as any).valueMin)
  setStr("value_max", (raw as any).valueMax)
  setStr("activity_since", (raw as any).activitySince)
  setStr("activity_until", (raw as any).activityUntil)
  setStr("q", (raw as any).search)
  return p
}

/**
 * Resolve a seleção do corpo em uma lista concreta de customerIds já ligada ao
 * tenant. `allFiltered` resolve via a MESMA lógica de "?mode=ids" da lista.
 */
export async function resolveSelection(
  body: SelectionBody,
  companyId: string,
): Promise<ResolvedSelection | SelectionError> {
  const explicit = Array.isArray(body.customerIds) ? body.customerIds.filter(Boolean) : []
  if (explicit.length > 0) {
    return { customerIds: explicit, source: "ids" }
  }

  if (body.allFiltered && typeof body.allFiltered === "object") {
    const filters = parseFilters(paramsFromFilters(body.allFiltered.filters ?? {}, companyId))
    const ids = await resolveFilteredCustomerIds(filters)
    return { customerIds: ids, source: "allFiltered" }
  }

  return { error: "Informe customerIds ou allFiltered", status: 400 }
}
