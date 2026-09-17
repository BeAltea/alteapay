"use client"

// Campanhas da jornada (super-admin): criação por LISTA EXPLÍCITA de clientes
// (regra D8) e contadores de elegibilidade. Iniciar enfileira o disparo.
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
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
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
import { createJourneyCampaign, startJourneyCampaign } from "@/app/actions/journey-cases"

export interface CampaignView {
  id: string
  company_name: string
  name: string
  status: string
  template_key: string
  eligible: number | null
  queued: number | null
  created_at: string
}
export interface CompanyOption {
  id: string
  name: string
}

export function CampaignsAdmin({
  companies,
  campaigns,
}: {
  companies: CompanyOption[]
  campaigns: CampaignView[]
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [companyId, setCompanyId] = useState(companies[0]?.id ?? "")
  const [name, setName] = useState("")
  const [templateKey, setTemplateKey] = useState("default")
  const [idsText, setIdsText] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function create() {
    setBusy(true)
    setError(null)
    setInfo(null)
    const ids = idsText
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    const res = await createJourneyCampaign({
      companyId,
      name,
      templateKey,
      customerIds: ids,
    })
    setBusy(false)
    if (!res.ok) {
      setError(res.error ?? "Falha ao criar.")
      return
    }
    setInfo(`Campanha criada. Elegíveis: ${res.eligible ?? 0}.`)
    setOpen(false)
    setName("")
    setIdsText("")
    router.refresh()
  }

  async function start(id: string) {
    setBusy(true)
    setError(null)
    const res = await startJourneyCampaign(id)
    setBusy(false)
    if (!res.ok) {
      setError(res.error ?? "Falha ao iniciar.")
      return
    }
    setInfo(`Disparo enfileirado: ${res.queued ?? 0} mensagens.`)
    router.refresh()
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Campanhas</CardTitle>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button disabled={companies.length === 0}>Nova campanha</Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Nova campanha (lista explícita)</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <Label>Empresa</Label>
                <Select value={companyId} onValueChange={setCompanyId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Empresa" />
                  </SelectTrigger>
                  <SelectContent>
                    {companies.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Nome</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div>
                <Label>Template</Label>
                <Input value={templateKey} onChange={(e) => setTemplateKey(e.target.value)} />
              </div>
              <div>
                <Label>IDs de clientes (um por linha ou separados por vírgula)</Label>
                <Textarea
                  rows={5}
                  value={idsText}
                  onChange={(e) => setIdsText(e.target.value)}
                  placeholder="uuid-1&#10;uuid-2"
                />
              </div>
              {error ? <p className="text-sm text-red-600">{error}</p> : null}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
                Cancelar
              </Button>
              <Button onClick={create} disabled={busy}>
                {busy ? "Criando..." : "Criar"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent>
        {info ? <p className="mb-3 text-sm text-green-700">{info}</p> : null}
        {error && !open ? <p className="mb-3 text-sm text-red-600">{error}</p> : null}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Empresa</TableHead>
              <TableHead>Nome</TableHead>
              <TableHead>Template</TableHead>
              <TableHead>Elegíveis</TableHead>
              <TableHead>Enfileirados</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {campaigns.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground">
                  Nenhuma campanha.
                </TableCell>
              </TableRow>
            ) : (
              campaigns.map((c) => (
                <TableRow key={c.id}>
                  <TableCell>{c.company_name}</TableCell>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell className="text-xs">{c.template_key}</TableCell>
                  <TableCell>{c.eligible ?? "—"}</TableCell>
                  <TableCell>{c.queued ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{c.status}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy || !["draft", "scheduled", "paused"].includes(c.status)}
                      onClick={() => start(c.id)}
                    >
                      Iniciar
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
