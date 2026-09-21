// Tabela de negociações por devedor (T5). Client component: paginação/ordenação
// server-side (via /api/super-admin/negociacoes), seleção múltipla (página +
// "todos os N filtrados"), contadores por estágio no topo e o diálogo de envio.
//
// Filtros vivem na URL (o server component passa o estado inicial; alterações de
// filtro/ordenação/página navegam por querystring). Documento SEMPRE mascarado
// (a API nunca devolve documento em claro).
"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useToast } from "@/hooks/use-toast"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { StageBadge, ContactProfileIcon, LiveChargeCell, ProviderHonesty } from "./badges"
import { SendNegotiationDialog } from "./send-dialog"
import { NegotiationsFilters } from "./negotiations-filters"
import { parseFilters, serializeFilters, type NegotiationFilters } from "./filters"
import type { NegotiationRow } from "./query"
import type { StageCount } from "./stages"

interface ApiResponse {
  rows: NegotiationRow[]
  total: number
  page: number
  pageSize: number
  pageCount: number
  stageCounts: StageCount[]
  countersReconcile: boolean
}

const BRL = (v: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v)

interface Props {
  companyOptions: Array<{ id: string; name: string }>
  campaignOptions: Array<{ id: string; name: string }>
  channelOptions: string[]
}

export function NegotiationsTable({ companyOptions, campaignOptions, channelOptions }: Props) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { toast } = useToast()

  const filters: NegotiationFilters = useMemo(
    () => parseFilters(searchParams),
    [searchParams],
  )

  const [data, setData] = useState<ApiResponse | null>(null)
  const [loading, setLoading] = useState(true)

  // seleção: ids da página + flag "todos os N filtrados"
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [selectAllFiltered, setSelectAllFiltered] = useState(false)
  const [allFilteredCount, setAllFilteredCount] = useState(0)
  const [dialogOpen, setDialogOpen] = useState(false)

  const fetchList = useCallback(async () => {
    setLoading(true)
    try {
      const qs = serializeFilters(filters)
      const res = await fetch(`/api/super-admin/negociacoes?${qs}`, { cache: "no-store" })
      if (!res.ok) {
        toast({ title: "Erro ao carregar", description: `HTTP ${res.status}`, variant: "destructive" })
        setData(null)
        return
      }
      setData((await res.json()) as ApiResponse)
    } finally {
      setLoading(false)
    }
  }, [filters, toast])

  useEffect(() => {
    void fetchList()
    // trocar de filtro/página limpa a seleção (nunca carregar seleção entre filtros diferentes)
    setSelectedIds(new Set())
    setSelectAllFiltered(false)
    setAllFilteredCount(0)
  }, [fetchList])

  const rows = data?.rows ?? []
  const pageIds = rows.map((r) => r.customerId)
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id))

  function toggleRow(id: string) {
    setSelectAllFiltered(false)
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function togglePage() {
    setSelectAllFiltered(false)
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (allPageSelected) pageIds.forEach((id) => next.delete(id))
      else pageIds.forEach((id) => next.add(id))
      return next
    })
  }

  async function selectAllN() {
    // resolve os ids do TOTAL filtrado no servidor (respeita EXATAMENTE os filtros).
    const qs = serializeFilters({ ...filters, page: 0, pageSize: filters.pageSize }) + "&mode=ids"
    const res = await fetch(`/api/super-admin/negociacoes?${qs}`, { cache: "no-store" })
    if (!res.ok) {
      toast({ title: "Falha ao selecionar todos", variant: "destructive" })
      return
    }
    const { customerIds, total } = (await res.json()) as { customerIds: string[]; total: number }
    setSelectedIds(new Set(customerIds))
    setSelectAllFiltered(true)
    setAllFilteredCount(total)
  }

  function clearSelection() {
    setSelectedIds(new Set())
    setSelectAllFiltered(false)
    setAllFilteredCount(0)
  }

  const selectedCount = selectAllFiltered ? allFilteredCount : selectedIds.size

  function updateUrl(patch: Partial<NegotiationFilters>) {
    const qs = serializeFilters({ ...filters, ...patch })
    router.push(`/super-admin/negociacoes?${qs}`)
  }

  function toggleSort(field: "stage" | "last_activity") {
    if (filters.sort === field) {
      updateUrl({ sort: field, dir: filters.dir === "asc" ? "desc" : "asc", page: 0 })
    } else {
      updateUrl({ sort: field, dir: "desc", page: 0 })
    }
  }

  const sortArrow = (field: "stage" | "last_activity") =>
    filters.sort === field ? (filters.dir === "asc" ? " ↑" : " ↓") : ""

  const publicLinkFor = (companyId: string) => `/n/${companyId.slice(0, 8)}` // placeholder p/ copiar; link real vem do preview

  return (
    <TooltipProvider>
      <div className="space-y-4">
        <NegotiationsFilters
          filters={filters}
          companyOptions={companyOptions}
          campaignOptions={campaignOptions}
          channelOptions={channelOptions}
          onApply={(patch) => updateUrl({ ...patch, page: 0 })}
        />

        {/* Contadores por estágio (topo). Total = soma (assert visível). */}
        {data ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md border p-3">
            <span className="text-sm font-medium">Total filtrado: {data.total}</span>
            <span className="text-muted-foreground">·</span>
            {data.stageCounts.map((c) => (
              <span
                key={c.stage}
                className="inline-flex items-center gap-1 rounded-full border bg-neutral-50 px-2 py-0.5 text-xs"
              >
                {c.label}: <strong>{c.count}</strong>
              </span>
            ))}
            <span
              className={`ml-auto text-xs ${
                data.countersReconcile ? "text-green-600" : "text-red-600"
              }`}
              title="A soma dos contadores por estágio deve fechar com o total filtrado."
            >
              {data.countersReconcile ? "✓ soma = total" : "✗ soma ≠ total"}
            </span>
          </div>
        ) : null}

        {/* Barra de seleção / ação primária */}
        <div className="flex flex-wrap items-center gap-3 rounded-md border p-3">
          <Button
            onClick={() => setDialogOpen(true)}
            disabled={selectedCount < 1}
          >
            Enviar negociação{selectedCount > 0 ? ` (${selectedCount})` : ""}
          </Button>
          {selectedCount > 0 ? (
            <>
              <span className="text-sm text-muted-foreground">
                {selectedCount} selecionado(s)
              </span>
              <button
                type="button"
                onClick={clearSelection}
                className="text-xs text-primary underline underline-offset-2"
              >
                limpar seleção
              </button>
            </>
          ) : null}
          {/* ação explícita "selecionar todos os N filtrados" com a contagem */}
          {allPageSelected && !selectAllFiltered && data && data.total > rows.length ? (
            <button
              type="button"
              onClick={selectAllN}
              className="text-xs text-primary underline underline-offset-2"
            >
              selecionar todos os {data.total} filtrados
            </button>
          ) : null}
          {selectAllFiltered ? (
            <span className="text-xs text-muted-foreground">
              (todos os {allFilteredCount} que casam os filtros)
            </span>
          ) : null}
        </div>

        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    checked={allPageSelected}
                    onCheckedChange={togglePage}
                    aria-label="Selecionar página"
                  />
                </TableHead>
                <TableHead>Devedor</TableHead>
                <TableHead>Cedente</TableHead>
                <TableHead>Contato</TableHead>
                <TableHead>Canal</TableHead>
                <TableHead>
                  <button type="button" onClick={() => toggleSort("stage")}>
                    Estágio{sortArrow("stage")}
                  </button>
                </TableHead>
                <TableHead>
                  <button type="button" onClick={() => toggleSort("last_activity")}>
                    Última atividade{sortArrow("last_activity")}
                  </button>
                </TableHead>
                <TableHead className="text-right">Valor aberto</TableHead>
                <TableHead>Cobrança viva</TableHead>
                <TableHead>Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={10} className="text-center text-muted-foreground">
                    Carregando…
                  </TableCell>
                </TableRow>
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={10} className="text-center text-muted-foreground">
                    Nenhum devedor para os filtros atuais.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((r) => (
                  <TableRow key={r.customerId} data-selected={selectedIds.has(r.customerId)}>
                    <TableCell>
                      <Checkbox
                        checked={selectedIds.has(r.customerId)}
                        onCheckedChange={() => toggleRow(r.customerId)}
                        aria-label={`Selecionar ${r.documentMasked}`}
                      />
                    </TableCell>
                    <TableCell>
                      <div className="text-sm font-medium">{r.nameMasked}</div>
                      <div className="font-mono text-xs text-muted-foreground">{r.documentMasked}</div>
                    </TableCell>
                    <TableCell className="text-sm">{r.cedente ?? "—"}</TableCell>
                    <TableCell>
                      <ContactProfileIcon profile={r.contactProfile} />
                    </TableCell>
                    <TableCell className="text-xs">{r.channel ?? "—"}</TableCell>
                    <TableCell>
                      <StageBadge stage={r.stage} at={r.stageAt} />
                      <div className="mt-0.5">
                        <ProviderHonesty
                          stage={r.stage}
                          providerStatusSource={r.providerStatusSource}
                        />
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {r.lastActivityAt
                        ? new Date(r.lastActivityAt).toLocaleString("pt-BR")
                        : "—"}
                    </TableCell>
                    <TableCell className="text-right text-sm">{BRL(r.openAmount)}</TableCell>
                    <TableCell>
                      <LiveChargeCell live={r.hasLiveCharge} />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2 text-xs">
                        <Link
                          href={`/super-admin/negociacoes/${r.customerId}?companyId=${r.companyId}`}
                          className="text-primary underline underline-offset-2"
                        >
                          Detalhe
                        </Link>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectAllFiltered(false)
                            setSelectedIds(new Set([r.customerId]))
                            setDialogOpen(true)
                          }}
                          className="text-primary underline underline-offset-2"
                        >
                          Reenviar
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            void navigator.clipboard?.writeText(
                              `${window.location.origin}${publicLinkFor(r.companyId)}`,
                            )
                            toast({ title: "Link copiado" })
                          }}
                          className="text-primary underline underline-offset-2"
                        >
                          Copiar link
                        </button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        {/* Paginação */}
        {data ? (
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              Página {data.page + 1} de {data.pageCount} · {data.total} devedores
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={data.page <= 0}
                onClick={() => updateUrl({ page: data.page - 1 })}
              >
                Anterior
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={data.page + 1 >= data.pageCount}
                onClick={() => updateUrl({ page: data.page + 1 })}
              >
                Próxima
              </Button>
            </div>
          </div>
        ) : null}

        {dialogOpen && filters.companyId ? (
          <SendNegotiationDialog
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            companyId={filters.companyId}
            selectedCount={selectedCount}
            selection={
              selectAllFiltered
                ? {
                    kind: "allFiltered",
                    filters: serializeSelectionFilters(filters),
                    expectedCount: allFilteredCount,
                  }
                : { kind: "ids", customerIds: Array.from(selectedIds) }
            }
            onDone={() => {
              void fetchList()
            }}
          />
        ) : null}

        {dialogOpen && !filters.companyId ? (
          <SendDialogGuard onClose={() => setDialogOpen(false)} toast={toast} />
        ) : null}
      </div>
    </TooltipProvider>
  )
}

/** Filtros de conteúdo (sem paginação) transportados na seleção "todos os N". */
function serializeSelectionFilters(f: NegotiationFilters): Record<string, unknown> {
  return {
    companyId: f.companyId,
    stages: f.stages,
    contactProfiles: f.contactProfiles,
    channel: f.channel,
    campaignId: f.campaignId,
    hasLiveCharge: f.hasLiveCharge,
    suppressed: f.suppressed,
    agingMin: f.agingMin,
    agingMax: f.agingMax,
    valueMin: f.valueMin,
    valueMax: f.valueMax,
    activitySince: f.activitySince,
    activityUntil: f.activityUntil,
    search: f.search,
  }
}

/** Guarda: enviar exige um cedente (companyId) selecionado no filtro. */
function SendDialogGuard({
  onClose,
  toast,
}: {
  onClose: () => void
  toast: ReturnType<typeof useToast>["toast"]
}) {
  useEffect(() => {
    toast({
      title: "Selecione um cedente",
      description: "O envio de negociação exige filtrar por um cedente.",
      variant: "destructive",
    })
    onClose()
  }, [onClose, toast])
  return null
}
