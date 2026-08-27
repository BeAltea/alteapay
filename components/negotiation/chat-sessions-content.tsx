"use client"

// Gestão das sessões do chatbot de negociação: filtros (período em
// America/Sao_Paulo), funil, e transcript (redigido por padrão; integral
// apenas super_admin, com trilha de acesso no backend).

import { useMemo, useState } from "react"
import { Eye, Loader2, MessageSquareText } from "lucide-react"

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

export interface ChatSessionRow {
  id: string
  company_name: string
  customer_name_masked: string
  channel_origin: string
  frontend_mode: string
  fulfillment_mode: string | null
  outcome: string
  identity_verified: boolean
  consent_given: boolean
  debt_acknowledged: boolean
  agreement_id: string | null
  message_count: number
  created_at: string
}

const SP_TZ = "America/Sao_Paulo"

const OUTCOME_LABELS: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
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

type TranscriptMessage = {
  id: string
  channel: string
  direction: string
  sender: string
  content: string
  prompt_version: string | null
  created_at: string
}

export function ChatSessionsContent({
  sessions,
  isSuperAdmin,
}: {
  sessions: ChatSessionRow[]
  isSuperAdmin: boolean
}) {
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [channel, setChannel] = useState("all")
  const [outcome, setOutcome] = useState("all")
  const [mode, setMode] = useState("all")
  const [open, setOpen] = useState<ChatSessionRow | null>(null)
  const [transcript, setTranscript] = useState<TranscriptMessage[] | null>(null)
  const [loadingTranscript, setLoadingTranscript] = useState(false)
  const [fullContent, setFullContent] = useState(false)

  const filtered = useMemo(
    () =>
      sessions.filter((s) => {
        const d = spDate(s.created_at)
        if (from && d < from) return false
        if (to && d > to) return false
        if (channel !== "all" && s.channel_origin !== channel) return false
        if (outcome !== "all" && s.outcome !== outcome) return false
        if (mode !== "all" && s.fulfillment_mode !== mode) return false
        return true
      }),
    [sessions, from, to, channel, outcome, mode],
  )

  const funnel = useMemo(() => {
    const total = filtered.length
    const verified = filtered.filter((s) => s.identity_verified).length
    const engaged = filtered.filter((s) => s.consent_given && s.message_count > 0).length
    const closed = filtered.filter(
      (s) => s.outcome === "agreement_closed" || s.outcome === "redirected_official",
    ).length
    return { total, verified, engaged, closed }
  }, [filtered])

  async function viewTranscript(session: ChatSessionRow, full: boolean) {
    setOpen(session)
    setLoadingTranscript(true)
    setFullContent(full)
    try {
      const resp = await fetch(
        `/api/negotiation/session/${session.id}/transcript${full ? "?full=1" : ""}`,
      )
      const data = await resp.json()
      setTranscript(data.success ? data.messages : [])
    } catch {
      setTranscript([])
    } finally {
      setLoadingTranscript(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {[
          ["Sessões", funnel.total],
          ["Identidade verificada", funnel.verified],
          ["Conversas ativas", funnel.engaged],
          ["Fechamento/Redirect", funnel.closed],
        ].map(([label, value]) => (
          <Card key={label as string}>
            <CardContent className="pt-4">
              <p className="text-sm text-muted-foreground">{label}</p>
              <p className="text-2xl font-bold">{value}</p>
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
        <Select value={mode} onValueChange={setMode}>
          <SelectTrigger className="w-32"><SelectValue placeholder="Modo" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos os modos</SelectItem>
            <SelectItem value="A">A (AlteaPay)</SelectItem>
            <SelectItem value="B">B (Canal oficial)</SelectItem>
            <SelectItem value="C">C (Atendimento)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Data (SP)</TableHead>
              {isSuperAdmin && <TableHead>Empresa</TableHead>}
              <TableHead>Devedor</TableHead>
              <TableHead>Canal</TableHead>
              <TableHead>Modo</TableHead>
              <TableHead>Msgs</TableHead>
              <TableHead>Resultado</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={isSuperAdmin ? 8 : 7} className="text-center text-muted-foreground">
                  Nenhuma sessão no período.
                </TableCell>
              </TableRow>
            )}
            {filtered.map((s) => {
              const o = OUTCOME_LABELS[s.outcome] ?? { label: s.outcome, variant: "secondary" as const }
              return (
                <TableRow key={s.id}>
                  <TableCell className="whitespace-nowrap">{spDateTime(s.created_at)}</TableCell>
                  {isSuperAdmin && <TableCell>{s.company_name}</TableCell>}
                  <TableCell>{s.customer_name_masked}</TableCell>
                  <TableCell className="capitalize">{s.channel_origin}</TableCell>
                  <TableCell>{s.fulfillment_mode ?? "—"}</TableCell>
                  <TableCell>{s.message_count}</TableCell>
                  <TableCell><Badge variant={o.variant}>{o.label}</Badge></TableCell>
                  <TableCell>
                    <Button size="sm" variant="outline" onClick={() => viewTranscript(s, false)}>
                      <MessageSquareText className="mr-1 h-3.5 w-3.5" /> Transcript
                    </Button>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>

      <Dialog open={!!open} onOpenChange={(v) => !v && setOpen(null)}>
        <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center justify-between pr-6">
              <span>Transcript — {open?.customer_name_masked}</span>
              {isSuperAdmin && open && (
                <Button
                  size="sm"
                  variant={fullContent ? "default" : "outline"}
                  onClick={() => viewTranscript(open, !fullContent)}
                >
                  <Eye className="mr-1 h-3.5 w-3.5" />
                  {fullContent ? "Conteúdo integral (auditado)" : "Ver integral"}
                </Button>
              )}
            </DialogTitle>
          </DialogHeader>
          {loadingTranscript ? (
            <div className="flex justify-center p-8"><Loader2 className="h-6 w-6 animate-spin" /></div>
          ) : (
            <div className="space-y-2">
              {(transcript ?? []).map((m) => (
                <div
                  key={m.id}
                  className={`rounded-lg p-3 text-sm ${
                    m.sender === "debtor"
                      ? "ml-8 bg-primary/10"
                      : m.sender === "agent"
                        ? "mr-8 bg-muted"
                        : "bg-amber-50 text-amber-900"
                  }`}
                >
                  <div className="mb-1 flex justify-between text-xs text-muted-foreground">
                    <span>
                      {m.sender} · {m.channel}
                      {m.prompt_version ? ` · prompt v${m.prompt_version}` : ""}
                    </span>
                    <span>{spDateTime(m.created_at)}</span>
                  </div>
                  <div className="whitespace-pre-wrap">{m.content}</div>
                </div>
              ))}
              {transcript?.length === 0 && (
                <p className="text-center text-sm text-muted-foreground">Sem mensagens.</p>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
