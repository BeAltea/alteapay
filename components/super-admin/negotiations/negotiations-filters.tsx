// Filtros da página de negociações (T5 §4). Combináveis, refletidos na URL.
// Aplica via onApply → o pai navega por querystring (server-side re-query).
"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { CONTACT_PROFILES, CONTACT_PROFILE_META, STAGE_META, type ContactProfile } from "./stages"
import type { NegotiationFilters } from "./filters"

interface Props {
  filters: NegotiationFilters
  companyOptions: Array<{ id: string; name: string }>
  campaignOptions: Array<{ id: string; name: string }>
  channelOptions: string[]
  onApply: (patch: Partial<NegotiationFilters>) => void
}

export function NegotiationsFilters({
  filters,
  companyOptions,
  campaignOptions,
  channelOptions,
  onApply,
}: Props) {
  const [draft, setDraft] = useState<NegotiationFilters>(filters)

  function set<K extends keyof NegotiationFilters>(key: K, value: NegotiationFilters[K]) {
    setDraft((d) => ({ ...d, [key]: value }))
  }

  function toggleStage(stage: string) {
    setDraft((d) => ({
      ...d,
      stages: d.stages.includes(stage)
        ? d.stages.filter((s) => s !== stage)
        : [...d.stages, stage],
    }))
  }

  function toggleProfile(p: ContactProfile) {
    setDraft((d) => ({
      ...d,
      contactProfiles: d.contactProfiles.includes(p)
        ? d.contactProfiles.filter((x) => x !== p)
        : [...d.contactProfiles, p],
    }))
  }

  function apply() {
    onApply(draft)
  }

  function reset() {
    const cleared: NegotiationFilters = {
      ...draft,
      stages: [],
      contactProfiles: [],
      channel: null,
      campaignId: null,
      hasLiveCharge: null,
      suppressed: null,
      agingMin: null,
      agingMax: null,
      valueMin: null,
      valueMax: null,
      activitySince: null,
      activityUntil: null,
      search: null,
    }
    setDraft(cleared)
    onApply(cleared)
  }

  const triState = (v: boolean | null) => (v === true ? "sim" : v === false ? "nao" : "")
  const parseTri = (s: string): boolean | null => (s === "sim" ? true : s === "nao" ? false : null)

  return (
    <details className="rounded-md border p-3" open>
      <summary className="cursor-pointer text-sm font-medium">Filtros</summary>
      <div className="mt-3 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {/* Cedente */}
        <label className="text-xs">
          Cedente
          <select
            className="mt-1 w-full rounded-md border px-2 py-1.5 text-sm"
            value={draft.companyId ?? ""}
            onChange={(e) => set("companyId", e.target.value || null)}
          >
            <option value="">Todos</option>
            {companyOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>

        {/* Canal */}
        <label className="text-xs">
          Canal
          <select
            className="mt-1 w-full rounded-md border px-2 py-1.5 text-sm"
            value={draft.channel ?? ""}
            onChange={(e) => set("channel", e.target.value || null)}
          >
            <option value="">Todos</option>
            {channelOptions.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>

        {/* Campanha */}
        <label className="text-xs">
          Campanha
          <select
            className="mt-1 w-full rounded-md border px-2 py-1.5 text-sm"
            value={draft.campaignId ?? ""}
            onChange={(e) => set("campaignId", e.target.value || null)}
          >
            <option value="">Todas</option>
            {campaignOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>

        {/* Perfil de contato (multi) */}
        <div className="text-xs">
          Perfil de contato
          <div className="mt-1 flex flex-wrap gap-1">
            {CONTACT_PROFILES.map((p) => (
              <button
                type="button"
                key={p}
                onClick={() => toggleProfile(p)}
                className={`rounded-full border px-2 py-0.5 ${
                  draft.contactProfiles.includes(p)
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground"
                }`}
              >
                {CONTACT_PROFILE_META[p].label}
              </button>
            ))}
          </div>
        </div>

        {/* Cobrança viva / supressão */}
        <label className="text-xs">
          Cobrança viva
          <select
            className="mt-1 w-full rounded-md border px-2 py-1.5 text-sm"
            value={triState(draft.hasLiveCharge)}
            onChange={(e) => set("hasLiveCharge", parseTri(e.target.value))}
          >
            <option value="">Indiferente</option>
            <option value="sim">Sim</option>
            <option value="nao">Não</option>
          </select>
        </label>
        <label className="text-xs">
          Supressão
          <select
            className="mt-1 w-full rounded-md border px-2 py-1.5 text-sm"
            value={triState(draft.suppressed)}
            onChange={(e) => set("suppressed", parseTri(e.target.value))}
          >
            <option value="">Indiferente</option>
            <option value="sim">Suprimido</option>
            <option value="nao">Não suprimido</option>
          </select>
        </label>

        {/* Aging */}
        <div className="text-xs">
          Aging (dias)
          <div className="mt-1 flex gap-1">
            <Input
              type="number"
              placeholder="min"
              value={draft.agingMin ?? ""}
              onChange={(e) => set("agingMin", e.target.value ? Number(e.target.value) : null)}
            />
            <Input
              type="number"
              placeholder="max"
              value={draft.agingMax ?? ""}
              onChange={(e) => set("agingMax", e.target.value ? Number(e.target.value) : null)}
            />
          </div>
        </div>

        {/* Valor */}
        <div className="text-xs">
          Valor em aberto (R$)
          <div className="mt-1 flex gap-1">
            <Input
              type="number"
              placeholder="min"
              value={draft.valueMin ?? ""}
              onChange={(e) => set("valueMin", e.target.value ? Number(e.target.value) : null)}
            />
            <Input
              type="number"
              placeholder="max"
              value={draft.valueMax ?? ""}
              onChange={(e) => set("valueMax", e.target.value ? Number(e.target.value) : null)}
            />
          </div>
        </div>

        {/* Período última atividade */}
        <div className="text-xs">
          Última atividade
          <div className="mt-1 flex gap-1">
            <Input
              type="date"
              value={draft.activitySince ?? ""}
              onChange={(e) => set("activitySince", e.target.value || null)}
            />
            <Input
              type="date"
              value={draft.activityUntil ?? ""}
              onChange={(e) => set("activityUntil", e.target.value || null)}
            />
          </div>
        </div>

        {/* Busca por documento mascarado */}
        <label className="text-xs">
          Busca (documento mascarado)
          <Input
            className="mt-1"
            placeholder="ex.: ***.456.789-**"
            value={draft.search ?? ""}
            onChange={(e) => set("search", e.target.value || null)}
          />
        </label>
      </div>

      {/* Estágios (multi) */}
      <div className="mt-3 text-xs">
        Estágio (múltiplo)
        <div className="mt-1 flex flex-wrap gap-1">
          {STAGE_META.map((m) => (
            <button
              type="button"
              key={m.stage}
              onClick={() => toggleStage(m.stage)}
              className={`rounded-full border px-2 py-0.5 ${
                draft.stages.includes(m.stage)
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3 flex gap-2">
        <Button size="sm" onClick={apply}>
          Aplicar filtros
        </Button>
        <Button size="sm" variant="outline" onClick={reset}>
          Limpar
        </Button>
      </div>
    </details>
  )
}
