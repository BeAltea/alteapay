"use client"

// Tela do cenário 2: redirect_events como evidência de disposição a pagar
// gerada pela cobrança AlteaPay — insumo de faturamento junto ao cliente.
// Totalizadores por período (America/Sao_Paulo) + exportação CSV.

import { useMemo, useState } from "react"
import { Download, ExternalLink } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

export interface RedirectEventRow {
  id: string
  company_name: string
  customer_name_masked: string
  document_masked: string
  debt_amount_at_redirect: number
  offer_presented: { label?: string; total?: string | number; installments?: number } | null
  official_channel_url: string
  confirmed_intent: boolean
  clicked_at: string
}

const SP_TZ = "America/Sao_Paulo"
const brl = (v: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v)

function spDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: SP_TZ })
}

function spDateTime(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", { timeZone: SP_TZ })
}

function offerLabel(offer: RedirectEventRow["offer_presented"]): string {
  if (!offer) return "—"
  if (offer.label) return offer.label
  const parts: string[] = []
  if (offer.installments && offer.installments > 1) parts.push(`${offer.installments}x`)
  if (offer.total != null) parts.push(brl(Number(offer.total)))
  return parts.join(" de ") || "—"
}

export function RedirectsContent({
  events,
  isSuperAdmin,
}: {
  events: RedirectEventRow[]
  isSuperAdmin: boolean
}) {
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")

  const filtered = useMemo(
    () =>
      events.filter((e) => {
        const d = spDate(e.clicked_at)
        if (from && d < from) return false
        if (to && d > to) return false
        return true
      }),
    [events, from, to],
  )

  const totals = useMemo(
    () => ({
      count: filtered.length,
      amount: filtered.reduce((acc, e) => acc + Number(e.debt_amount_at_redirect), 0),
    }),
    [filtered],
  )

  function exportCsv() {
    const header = [
      "data_clique_sp",
      "empresa",
      "devedor",
      "documento",
      "valor_divida",
      "oferta_apresentada",
      "intencao_confirmada",
      "url_canal_oficial",
    ]
    const rows = filtered.map((e) => [
      spDateTime(e.clicked_at),
      e.company_name,
      e.customer_name_masked,
      e.document_masked,
      String(Number(e.debt_amount_at_redirect).toFixed(2)).replace(".", ","),
      offerLabel(e.offer_presented),
      e.confirmed_intent ? "sim" : "não",
      e.official_channel_url,
    ])
    const csv = [header, ...rows]
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(";"))
      .join("\n")
    const blob = new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" })
    const a = document.createElement("a")
    a.href = URL.createObjectURL(blob)
    a.download = `redirecionamentos_${from || "inicio"}_${to || "hoje"}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4">
        <Card>
          <CardContent className="pt-4">
            <p className="text-sm text-muted-foreground">Redirecionamentos no período</p>
            <p className="text-2xl font-bold">{totals.count}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <p className="text-sm text-muted-foreground">Valor total das dívidas no clique</p>
            <p className="text-2xl font-bold">{brl(totals.amount)}</p>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="text-xs text-muted-foreground">De</label>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground">Até</label>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" />
        </div>
        <Button onClick={exportCsv} disabled={filtered.length === 0}>
          <Download className="mr-2 h-4 w-4" /> Exportar CSV
        </Button>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Clique (SP)</TableHead>
              {isSuperAdmin && <TableHead>Empresa</TableHead>}
              <TableHead>Devedor</TableHead>
              <TableHead>Documento</TableHead>
              <TableHead className="text-right">Valor no momento</TableHead>
              <TableHead>Oferta aceita/vista</TableHead>
              <TableHead>Destino</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={isSuperAdmin ? 7 : 6} className="text-center text-muted-foreground">
                  Nenhum redirecionamento no período.
                </TableCell>
              </TableRow>
            )}
            {filtered.map((e) => (
              <TableRow key={e.id}>
                <TableCell className="whitespace-nowrap">{spDateTime(e.clicked_at)}</TableCell>
                {isSuperAdmin && <TableCell>{e.company_name}</TableCell>}
                <TableCell>{e.customer_name_masked}</TableCell>
                <TableCell>{e.document_masked}</TableCell>
                <TableCell className="text-right font-medium">
                  {brl(Number(e.debt_amount_at_redirect))}
                </TableCell>
                <TableCell>{offerLabel(e.offer_presented)}</TableCell>
                <TableCell>
                  <a
                    href={e.official_channel_url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1 text-xs text-muted-foreground underline"
                  >
                    canal oficial <ExternalLink className="h-3 w-3" />
                  </a>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
