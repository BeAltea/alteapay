"use client"

// Gestão das negociações do chatbot — visão POR DEVEDOR (A1.2). Uma linha por
// (empresa, devedor); expandir mostra as sessões individuais. Filtros (período em
// America/Sao_Paulo), KPIs coerentes (A1.3) e transcript com contexto (A2.3).
// Documento/nome sempre mascarados; conteúdo redigido na origem. O n8n_execution_id
// só aparece para super_admin.

import { Fragment, useMemo, useState } from "react"
import { ChevronDown, ChevronRight, Eye, Loader2, MessageSquareText, User } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { stageLabel } from "@/components/super-admin/negotiations/stages"
import type { ChatKpis, DebtorRow } from "@/lib/negotiation/chat-debtors"

const SP_TZ = "America/Sao_Paulo"

const brl = (v: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v)

const OUTCOME_LABELS: Record<
  string,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  in_progress: { label: "Em andamento", variant: "secondary" },
  agreement_closed: { label: "Acordo fechado", variant: "default" },
  redirected_official: { label: "Redirecionado", variant: "outline" },
  handoff_human: { label: "Atendente", variant: "outline" },
  abandoned: { label: "Abandonada", variant: "destructive" },
  identity_failed: { label: "Identidade falhou", variant: "destructive" },
  expired: { label: "Expirada", variant: "destructive" },
}

function spDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: SP_TZ })
}

function spDateTime(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", { timeZone: SP_TZ })
}

/** Tempo relativo curto pt-BR ("há 3 min", "há 2 h", "há 4 d"). */
function relativeFromNow(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const min = Math.round(diffMs / 60000)
  if (min < 1) return "agora"
  if (min < 60) return `há ${min} min`
  const h = Math.round(min / 60)
  if (h < 24) return `há ${h} h`
  const d = Math.round(h / 24)
  return `há ${d} d`
}

type TimelineItem = {
  kind: "message" | "event"
  key: string
  at: string
  actor: string
  label: string
  text: string | null
  buttonId: number | null
  engine: string | null
  n8nExecutionId: string | null
}

type TranscriptResponse = {
  success: boolean
  scope: "customer" | "session"
  header: {
    customer_name_masked: string
    document_masked: string
    company_name: string
    channel: string
    engine: string | null
    started_at: string
    ended_at: string | null
    duration: string | null
    outcome: string
    session_id: string
    session_count: number
    campaign_id: string | null
  }
  empty_explanation: string | null
  timeline: TimelineItem[]
  agreement: {
    total_value: number | null
    discount_percentage: number | null
    installments: number | null
    status: string | null
    payment_status: string | null
    invoice_url: string | null
  } | null
  cases: Array<{ id: string; type: string; status: string; created_at: string }>
}

export function ChatSessionsContent({
  debtors,
  kpis,
  isSuperAdmin,
}: {
  debtors: DebtorRow[]
  kpis: ChatKpis
  isSuperAdmin: boolean
}) {
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [channel, setChannel] = useState("all")
  const [outcome, setOutcome] = useState("all")
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState<{ sessionId: string; label: string } | null>(null)
  const [data, setData] = useState<TranscriptResponse | null>(null)
  const [loading, setLoading] = useState(false)

  const filtered = useMemo(
    () =>
      debtors.filter((d) => {
        const day = spDate(d.last_activity_at)
        if (from && day < from) return false
        if (to && day > to) return false
        if (channel !== "all" && d.channel !== channel) return false
        if (outcome !== "all" && d.outcome !== outcome) return false
        return true
      }),
    [debtors, from, to, channel, outcome],
  )

  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  async function viewTranscript(sessionId: string, label: string, scopeCustomer: boolean) {
    setOpen({ sessionId, label })
    setLoading(true)
    setData(null)
    try {
      const resp = await fetch(
        `/api/negotiation/session/${sessionId}/transcript${scopeCustomer ? "?scope=customer" : ""}`,
      )
      const json = (await resp.json()) as TranscriptResponse
      setData(json.success ? json : null)
    } catch {
      setData(null)
    } finally {
      setLoading(false)
    }
  }

  const kpiCards: Array<{ label: string; value: string; hint?: string }> = [
    {
      label: "Devedores em negociação",
      value: String(kpis.debtors),
      hint: `${kpis.sessions} sessões`,
    },
    { label: "% de autenticação", value: `${kpis.authRatePct}%`, hint: `${kpis.authenticatedDebtors} devedores` },
    {
      label: `Conversas ativas (últimos ${kpis.activeWindowMin} min)`,
      value: String(kpis.activeConversations),
    },
    {
      label: "Acordos fechados",
      value: String(kpis.agreementsClosed),
      hint: brl(kpis.agreementsClosedAmount),
    },
    { label: "Redirects", value: String(kpis.redirects), hint: brl(kpis.redirectsAmount) },
    { label: "Reconhecimentos", value: `${kpis.ackYes} sim / ${kpis.ackNo} não` },
  ]

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
        {kpiCards.map((k) => (
          <Card key={k.label}>
            <CardContent className="pt-4">
              <p className="text-sm text-muted-foreground">{k.label}</p>
              <p className="text-2xl font-bold">{k.value}</p>
              {k.hint && <p className="text-xs text-muted-foreground">{k.hint}</p>}
            </CardContent>
          </Card>
        ))}
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
        <Select value={channel} onValueChange={setChannel}>
          <SelectTrigger className="w-36"><SelectValue placeholder="Canal" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos os canais</SelectItem>
            <SelectItem value="whatsapp">WhatsApp</SelectItem>
            <SelectItem value="web_campaign">Web (campanha)</SelectItem>
            <SelectItem value="web_generic">Web (genérico)</SelectItem>
            <SelectItem value="direct">Direto</SelectItem>
            <SelectItem value="mock">Mock</SelectItem>
          </SelectContent>
        </Select>
        <Select value={outcome} onValueChange={setOutcome}>
          <SelectTrigger className="w-44"><SelectValue placeholder="Resultado" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos os resultados</SelectItem>
            {Object.entries(OUTCOME_LABELS).map(([k, v]) => (
              <SelectItem key={k} value={k}>{v.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              {isSuperAdmin && <TableHead>Empresa</TableHead>}
              <TableHead>Devedor</TableHead>
              <TableHead>Sessões</TableHead>
              <TableHead>Início</TableHead>
              <TableHead>Última atividade</TableHead>
              <TableHead>Canal</TableHead>
              <TableHead>Engine</TableHead>
              <TableHead>Msgs</TableHead>
              <TableHead>Estágio</TableHead>
              <TableHead>Resultado</TableHead>
              <TableHead>Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={isSuperAdmin ? 12 : 11} className="text-center text-muted-foreground">
                  Nenhum devedor no período.
                </TableCell>
              </TableRow>
            )}
            {filtered.map((d) => {
              const o = OUTCOME_LABELS[d.outcome] ?? { label: d.outcome, variant: "secondary" as const }
              const isOpen = expanded.has(d.key)
              return (
                <Fragment key={d.key}>
                  <TableRow>
                    <TableCell>
                      {d.session_count > 1 && (
                        <button
                          type="button"
                          onClick={() => toggle(d.key)}
                          aria-label={isOpen ? "Recolher sessões" : "Expandir sessões"}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </button>
                      )}
                    </TableCell>
                    {isSuperAdmin && <TableCell>{d.company_name}</TableCell>}
                    <TableCell>
                      <div className="font-medium">{d.customer_name_masked}</div>
                      <div className="text-xs text-muted-foreground">{d.document_masked}</div>
                    </TableCell>
                    <TableCell>
                      {d.session_count > 1 ? (
                        <button
                          type="button"
                          onClick={() => toggle(d.key)}
                          className="underline decoration-dotted underline-offset-2"
                        >
                          {d.session_count}
                        </button>
                      ) : (
                        d.session_count
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm">{spDateTime(d.started_at)}</TableCell>
                    <TableCell className="whitespace-nowrap text-sm" title={spDateTime(d.last_activity_at)}>
                      {relativeFromNow(d.last_activity_at)}
                    </TableCell>
                    <TableCell className="capitalize">{d.channel}</TableCell>
                    <TableCell>{d.engine ?? "—"}</TableCell>
                    <TableCell>{d.message_count}</TableCell>
                    <TableCell>{stageLabel(d.stage)}</TableCell>
                    <TableCell><Badge variant={o.variant}>{o.label}</Badge></TableCell>
                    <TableCell>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            viewTranscript(
                              d.sessions[d.sessions.length - 1].id,
                              d.customer_name_masked,
                              true,
                            )
                          }
                        >
                          <MessageSquareText className="mr-1 h-3.5 w-3.5" /> Transcript
                        </Button>
                        {isSuperAdmin && d.customer_id && (
                          <Button size="sm" variant="ghost" asChild>
                            <a href={`/super-admin/negociacoes/${d.customer_id}`}>
                              <User className="mr-1 h-3.5 w-3.5" /> Ver devedor
                            </a>
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                  {isOpen &&
                    d.sessions.map((s) => {
                      const so = OUTCOME_LABELS[s.outcome] ?? {
                        label: s.outcome,
                        variant: "secondary" as const,
                      }
                      return (
                        <TableRow key={s.id} className="bg-muted/40">
                          <TableCell />
                          {isSuperAdmin && <TableCell />}
                          <TableCell colSpan={2} className="text-xs text-muted-foreground">
                            Sessão {s.id.slice(0, 8)}…
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-xs">{spDateTime(s.created_at)}</TableCell>
                          <TableCell className="whitespace-nowrap text-xs">
                            {s.last_activity_at ? relativeFromNow(s.last_activity_at) : "—"}
                          </TableCell>
                          <TableCell className="capitalize text-xs">{s.channel}</TableCell>
                          <TableCell className="text-xs">{s.engine ?? "—"}</TableCell>
                          <TableCell className="text-xs">{s.message_count}</TableCell>
                          <TableCell className="text-xs">
                            {s.identity_verified ? "Autenticada" : "—"}
                          </TableCell>
                          <TableCell><Badge variant={so.variant}>{so.label}</Badge></TableCell>
                          <TableCell>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => viewTranscript(s.id, `${d.customer_name_masked} · sessão`, false)}
                            >
                              <MessageSquareText className="mr-1 h-3.5 w-3.5" /> Transcript
                            </Button>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                </Fragment>
              )
            })}
          </TableBody>
        </Table>
      </div>

      <Dialog open={!!open} onOpenChange={(v) => !v && setOpen(null)}>
        <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Transcript — {open?.label}</DialogTitle>
          </DialogHeader>
          {loading ? (
            <div className="flex justify-center p-8"><Loader2 className="h-6 w-6 animate-spin" /></div>
          ) : !data ? (
            <p className="text-center text-sm text-muted-foreground">
              Não foi possível carregar o transcript.
            </p>
          ) : (
            <div className="space-y-4">
              {/* Cabeçalho de contexto */}
              <div className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-lg border p-3 text-sm md:grid-cols-3">
                <ContextField label="Devedor" value={data.header.customer_name_masked} />
                <ContextField label="Documento" value={data.header.document_masked} />
                <ContextField label="Empresa" value={data.header.company_name} />
                <ContextField label="Canal" value={data.header.channel} />
                <ContextField label="Engine" value={data.header.engine ?? "—"} />
                <ContextField label="Início" value={spDateTime(data.header.started_at)} />
                <ContextField label="Duração" value={data.header.duration ?? "—"} />
                <ContextField
                  label="Desfecho"
                  value={(OUTCOME_LABELS[data.header.outcome]?.label ?? data.header.outcome)}
                />
                <ContextField
                  label="Sessões"
                  value={String(data.header.session_count)}
                />
                {isSuperAdmin && (
                  <ContextField label="session_id" value={data.header.session_id} mono />
                )}
                {isSuperAdmin && data.header.campaign_id && (
                  <ContextField label="campaign_id" value={data.header.campaign_id} mono />
                )}
              </div>

              {/* Sessão sem mensagem: não abre vazia */}
              {data.empty_explanation && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                  {data.empty_explanation}
                </div>
              )}

              {/* Timeline cronológica (mensagens + eventos) */}
              {data.timeline.length > 0 && (
                <div className="space-y-2">
                  {data.timeline.map((item) =>
                    item.kind === "message" ? (
                      <div
                        key={item.key}
                        className={`rounded-lg p-3 text-sm ${
                          item.actor === "customer"
                            ? "ml-8 bg-primary/10"
                            : item.actor === "assistant"
                              ? "mr-8 bg-muted"
                              : "bg-amber-50 text-amber-900"
                        }`}
                      >
                        <div className="mb-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                          <span className="flex items-center gap-1">
                            {item.label}
                            {item.engine ? ` · ${item.engine}` : ""}
                            {isSuperAdmin && item.n8nExecutionId && (
                              <Badge variant="outline" className="font-mono text-[10px]">
                                n8n {item.n8nExecutionId.slice(0, 8)}
                              </Badge>
                            )}
                          </span>
                          <span>{spDateTime(item.at)}</span>
                        </div>
                        {item.text && <div className="whitespace-pre-wrap">{item.text}</div>}
                      </div>
                    ) : (
                      <div
                        key={item.key}
                        className="flex items-center justify-between gap-2 border-l-2 border-muted-foreground/30 pl-3 text-xs text-muted-foreground"
                      >
                        <span>
                          <Eye className="mr-1 inline h-3 w-3" />
                          {item.label} · {item.actor}
                        </span>
                        <span>{spDateTime(item.at)}</span>
                      </div>
                    ),
                  )}
                </div>
              )}

              {/* Rodapé: acordo + casos */}
              {data.agreement && (
                <div className="rounded-lg border p-3 text-sm">
                  <p className="mb-1 font-medium">Acordo</p>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-1 md:grid-cols-3">
                    <ContextField
                      label="Valor"
                      value={data.agreement.total_value != null ? brl(data.agreement.total_value) : "—"}
                    />
                    <ContextField
                      label="Desconto"
                      value={
                        data.agreement.discount_percentage != null
                          ? `${data.agreement.discount_percentage}%`
                          : "—"
                      }
                    />
                    <ContextField label="Parcelas" value={data.agreement.installments?.toString() ?? "—"} />
                    <ContextField label="Status" value={data.agreement.status ?? "—"} />
                    <ContextField label="Pagamento" value={data.agreement.payment_status ?? "—"} />
                    {data.agreement.invoice_url && (
                      <ContextField label="Link" value="ver cobrança" href={data.agreement.invoice_url} />
                    )}
                  </div>
                </div>
              )}
              {data.cases.length > 0 && (
                <div className="rounded-lg border p-3 text-sm">
                  <p className="mb-1 font-medium">Casos</p>
                  <ul className="space-y-1">
                    {data.cases.map((c) => (
                      <li key={c.id} className="flex justify-between text-xs">
                        <span>{c.type} · {c.status}</span>
                        <span className="text-muted-foreground">{spDateTime(c.created_at)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function ContextField({
  label,
  value,
  mono,
  href,
}: {
  label: string
  value: string
  mono?: boolean
  href?: string
}) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" className="text-primary underline">
          {value}
        </a>
      ) : (
        <p className={mono ? "font-mono text-xs" : ""}>{value}</p>
      )}
    </div>
  )
}
