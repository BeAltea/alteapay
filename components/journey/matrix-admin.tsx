"use client"

// CRUD da matriz de condições (super-admin). Edição via Dialog; grava por
// server action (validação servidor-autoritativa). Sem service role no client.
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
import {
  setMatrixActive,
  upsertMatrixRow,
  type MatrixInput,
} from "@/app/actions/journey-matrix"

export interface MatrixRowView extends MatrixInput {
  id: string
}
export interface CompanyOption {
  id: string
  name: string
}

const BILLING = ["PIX", "BOLETO", "CREDIT_CARD"]

function emptyRow(companyId: string): MatrixInput {
  return {
    company_id: companyId,
    name: "",
    priority: 0,
    active: true,
    aging_min_days: 0,
    aging_max_days: null,
    max_discount_pct: 0,
    installment_discount_pct: 0,
    min_entry_pct: 0,
    max_installments: 1,
    min_installment_value: 0,
    allowed_billing_types: ["PIX", "BOLETO"],
    proposal_validity_days: 7,
    retry_after_days: null,
    max_retries: null,
    min_debt_value: 0,
  }
}

export function MatrixAdmin({
  companies,
  rows,
  selectedCompanyId,
}: {
  companies: CompanyOption[]
  rows: MatrixRowView[]
  selectedCompanyId: string | null
}) {
  const router = useRouter()
  const [companyId, setCompanyId] = useState<string>(selectedCompanyId ?? companies[0]?.id ?? "")
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<MatrixInput>(emptyRow(companyId))
  const [editingId, setEditingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  function onCompanyChange(id: string) {
    setCompanyId(id)
    router.push(`/super-admin/negociacao-ia/matriz?company=${id}`)
  }

  function openNew() {
    setDraft(emptyRow(companyId))
    setEditingId(null)
    setError(null)
    setOpen(true)
  }
  function openEdit(r: MatrixRowView) {
    const { id, ...rest } = r
    setDraft({ ...rest })
    setEditingId(id)
    setError(null)
    setOpen(true)
  }

  function num(v: string): number {
    const n = Number(v.replace(",", "."))
    return Number.isNaN(n) ? 0 : n
  }

  async function save() {
    setSaving(true)
    setError(null)
    const res = await upsertMatrixRow(editingId ? { ...draft, id: editingId } : draft)
    setSaving(false)
    if (!res.ok) {
      setError(res.error ?? "Falha ao salvar.")
      return
    }
    setOpen(false)
    router.refresh()
  }

  async function toggleActive(r: MatrixRowView) {
    const res = await setMatrixActive(r.id, !r.active)
    if (res.ok) router.refresh()
    else setError(res.error ?? "Falha ao atualizar.")
  }

  function toggleBilling(b: string) {
    setDraft((d) => ({
      ...d,
      allowed_billing_types: d.allowed_billing_types.includes(b)
        ? d.allowed_billing_types.filter((x) => x !== b)
        : [...d.allowed_billing_types, b],
    }))
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-4">
        <CardTitle>Matriz de condições</CardTitle>
        <div className="flex items-center gap-2">
          <Select value={companyId} onValueChange={onCompanyChange}>
            <SelectTrigger className="w-56">
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
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button onClick={openNew} disabled={!companyId}>
                Nova faixa
              </Button>
            </DialogTrigger>
            <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
              <DialogHeader>
                <DialogTitle>{editingId ? "Editar faixa" : "Nova faixa"}</DialogTitle>
              </DialogHeader>
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <Label>Nome</Label>
                  <Input
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  />
                </div>
                <div>
                  <Label>Prioridade</Label>
                  <Input
                    type="number"
                    value={draft.priority}
                    onChange={(e) => setDraft({ ...draft, priority: num(e.target.value) })}
                  />
                </div>
                <div>
                  <Label>Aging mín. (dias)</Label>
                  <Input
                    type="number"
                    value={draft.aging_min_days}
                    onChange={(e) => setDraft({ ...draft, aging_min_days: num(e.target.value) })}
                  />
                </div>
                <div>
                  <Label>Aging máx. (dias, vazio = ∞)</Label>
                  <Input
                    type="number"
                    value={draft.aging_max_days ?? ""}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        aging_max_days: e.target.value === "" ? null : num(e.target.value),
                      })
                    }
                  />
                </div>
                <div>
                  <Label>Desconto máx. (%)</Label>
                  <Input
                    type="number"
                    value={draft.max_discount_pct}
                    onChange={(e) => setDraft({ ...draft, max_discount_pct: num(e.target.value) })}
                  />
                </div>
                <div>
                  <Label>Desconto parcelado (%)</Label>
                  <Input
                    type="number"
                    value={draft.installment_discount_pct}
                    onChange={(e) =>
                      setDraft({ ...draft, installment_discount_pct: num(e.target.value) })
                    }
                  />
                </div>
                <div>
                  <Label>Entrada mín. (%)</Label>
                  <Input
                    type="number"
                    value={draft.min_entry_pct}
                    onChange={(e) => setDraft({ ...draft, min_entry_pct: num(e.target.value) })}
                  />
                </div>
                <div>
                  <Label>Máx. parcelas</Label>
                  <Input
                    type="number"
                    value={draft.max_installments}
                    onChange={(e) => setDraft({ ...draft, max_installments: num(e.target.value) })}
                  />
                </div>
                <div>
                  <Label>Valor mín. parcela</Label>
                  <Input
                    type="number"
                    value={draft.min_installment_value}
                    onChange={(e) =>
                      setDraft({ ...draft, min_installment_value: num(e.target.value) })
                    }
                  />
                </div>
                <div>
                  <Label>Valor mín. dívida</Label>
                  <Input
                    type="number"
                    value={draft.min_debt_value}
                    onChange={(e) => setDraft({ ...draft, min_debt_value: num(e.target.value) })}
                  />
                </div>
                <div>
                  <Label>Validade proposta (dias)</Label>
                  <Input
                    type="number"
                    value={draft.proposal_validity_days}
                    onChange={(e) =>
                      setDraft({ ...draft, proposal_validity_days: num(e.target.value) })
                    }
                  />
                </div>
                <div>
                  <Label>Nova tentativa após (dias)</Label>
                  <Input
                    type="number"
                    value={draft.retry_after_days ?? ""}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        retry_after_days: e.target.value === "" ? null : num(e.target.value),
                      })
                    }
                  />
                </div>
                <div className="col-span-2">
                  <Label>Formas de pagamento</Label>
                  <div className="mt-1 flex gap-2">
                    {BILLING.map((b) => (
                      <button
                        key={b}
                        type="button"
                        onClick={() => toggleBilling(b)}
                        className={
                          "rounded-md border px-3 py-1.5 text-sm " +
                          (draft.allowed_billing_types.includes(b)
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-input text-muted-foreground")
                        }
                      >
                        {b}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              {error ? <p className="text-sm text-red-600">{error}</p> : null}
              <DialogFooter>
                <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
                  Cancelar
                </Button>
                <Button onClick={save} disabled={saving}>
                  {saving ? "Salvando..." : "Salvar"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </CardHeader>
      <CardContent>
        {error && !open ? <p className="mb-3 text-sm text-red-600">{error}</p> : null}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nome</TableHead>
              <TableHead>Prior.</TableHead>
              <TableHead>Aging</TableHead>
              <TableHead>Desc. máx.</TableHead>
              <TableHead>Parcelas</TableHead>
              <TableHead>Pagamento</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-muted-foreground">
                  Nenhuma faixa cadastrada para esta empresa.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <TableCell>{r.priority}</TableCell>
                  <TableCell>
                    {r.aging_min_days}–{r.aging_max_days ?? "∞"}
                  </TableCell>
                  <TableCell>{r.max_discount_pct}%</TableCell>
                  <TableCell>{r.max_installments}x</TableCell>
                  <TableCell className="text-xs">{r.allowed_billing_types.join(", ")}</TableCell>
                  <TableCell>
                    <Badge variant={r.active ? "default" : "secondary"}>
                      {r.active ? "Ativa" : "Inativa"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button variant="outline" size="sm" onClick={() => openEdit(r)}>
                        Editar
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => toggleActive(r)}>
                        {r.active ? "Desativar" : "Ativar"}
                      </Button>
                    </div>
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
