"use client"

// Casos da jornada (super-admin): contestações, "já paguei" e handoffs.
// Resolver via server action; nunca expõe service role ao client.
import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
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
import { Badge } from "@/components/ui/badge"
import { resolveCase } from "@/app/actions/journey-cases"

export interface CaseView {
  id: string
  company_name: string
  customer_name_masked: string
  document_masked: string
  type: string
  status: string
  detail_note: string
  created_at: string
}

const TYPE_LABEL: Record<string, string> = {
  dispute: "Contestação",
  payment_claim: "Já paguei",
  human_handoff: "Atendimento humano",
}
const STATUS_LABEL: Record<string, string> = {
  open: "Aberto",
  in_review: "Em análise",
  resolved: "Resolvido",
  rejected: "Recusado",
}

export function CasesAdmin({ cases }: { cases: CaseView[] }) {
  const router = useRouter()
  const [active, setActive] = useState<CaseView | null>(null)
  const [status, setStatus] = useState<string>("resolved")
  const [resolution, setResolution] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  function openResolve(c: CaseView) {
    setActive(c)
    setStatus(c.status === "open" ? "in_review" : "resolved")
    setResolution("")
    setError(null)
  }

  async function submit() {
    if (!active) return
    setBusy(true)
    setError(null)
    const res = await resolveCase({
      caseId: active.id,
      status: status as "open" | "in_review" | "resolved" | "rejected",
      resolution: resolution || undefined,
    })
    setBusy(false)
    if (!res.ok) {
      setError(res.error ?? "Falha ao atualizar.")
      return
    }
    setActive(null)
    router.refresh()
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Casos</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Data</TableHead>
              <TableHead>Empresa</TableHead>
              <TableHead>Cliente</TableHead>
              <TableHead>Documento</TableHead>
              <TableHead>Tipo</TableHead>
              <TableHead>Detalhe</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {cases.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-muted-foreground">
                  Nenhum caso aberto.
                </TableCell>
              </TableRow>
            ) : (
              cases.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="whitespace-nowrap text-sm">
                    {new Date(c.created_at).toLocaleString("pt-BR")}
                  </TableCell>
                  <TableCell>{c.company_name}</TableCell>
                  <TableCell>{c.customer_name_masked}</TableCell>
                  <TableCell className="font-mono text-xs">{c.document_masked}</TableCell>
                  <TableCell>{TYPE_LABEL[c.type] ?? c.type}</TableCell>
                  <TableCell className="max-w-[220px] truncate text-sm text-muted-foreground">
                    {c.detail_note || "—"}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        c.status === "resolved"
                          ? "default"
                          : c.status === "rejected"
                            ? "destructive"
                            : "secondary"
                      }
                    >
                      {STATUS_LABEL[c.status] ?? c.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => openResolve(c)}
                      disabled={c.status === "resolved" || c.status === "rejected"}
                    >
                      Tratar
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>

      <Dialog open={active !== null} onOpenChange={(o) => !o && setActive(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Tratar caso</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Status</Label>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="in_review">Em análise</SelectItem>
                  <SelectItem value="resolved">Resolvido</SelectItem>
                  <SelectItem value="rejected">Recusado</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Resolução / observação</Label>
              <Textarea
                rows={4}
                value={resolution}
                onChange={(e) => setResolution(e.target.value)}
              />
            </div>
            {error ? <p className="text-sm text-red-600">{error}</p> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setActive(null)} disabled={busy}>
              Cancelar
            </Button>
            <Button onClick={submit} disabled={busy}>
              {busy ? "Salvando..." : "Salvar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
