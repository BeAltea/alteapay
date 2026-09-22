"use client"

import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useToast } from "@/hooks/use-toast"
import { Plus, MoreVertical, Loader2, Star, Archive, Copy, Pencil, RefreshCw } from "lucide-react"
import { TemplateEditor } from "@/components/super-admin/emails/template-editor"

interface Company {
  id: string
  name: string
}

interface TemplateRow {
  template: {
    id: string
    companyId: string | null
    name: string
    purpose: "negotiation" | "communication"
    status: "draft" | "active" | "archived"
    currentVersionId: string | null
    updatedAt: string
  }
  currentVersion: { version: number; subject: string } | null
  isDefault?: boolean
}

const PURPOSE_LABEL: Record<string, string> = { negotiation: "Negociação", communication: "Comunicação" }
const STATUS_LABEL: Record<string, string> = { draft: "Rascunho", active: "Ativo", archived: "Arquivado" }

export function TemplatesManager({ companies }: { companies: Company[] }) {
  const { toast } = useToast()
  const [rows, setRows] = useState<TemplateRow[]>([])
  const [loading, setLoading] = useState(true)
  const [scopeFilter, setScopeFilter] = useState<string>("all")
  const [includeArchived, setIncludeArchived] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const companyName = useCallback(
    (id: string | null) => (id ? companies.find((c) => c.id === id)?.name ?? "Cedente" : "Global"),
    [companies],
  )

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (scopeFilter === "global") params.set("companyId", "global")
      else if (scopeFilter !== "all") params.set("companyId", scopeFilter)
      if (includeArchived) params.set("includeArchived", "true")
      const res = await fetch(`/api/super-admin/email-templates?${params.toString()}`, { cache: "no-store" })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Falha ao carregar templates")
      setRows(data.templates || [])
    } catch (e) {
      toast({ title: "Erro", description: e instanceof Error ? e.message : "Falha ao carregar", variant: "destructive" })
    } finally {
      setLoading(false)
    }
  }, [scopeFilter, includeArchived, toast])

  useEffect(() => {
    load()
  }, [load])

  const openCreate = () => {
    setEditingId(null)
    setEditorOpen(true)
  }
  const openEdit = (id: string) => {
    setEditingId(id)
    setEditorOpen(true)
  }

  const action = async (id: string, fn: () => Promise<Response>, okMsg: string) => {
    setBusyId(id)
    try {
      const res = await fn()
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Falha na operação")
      toast({ title: okMsg })
      await load()
    } catch (e) {
      toast({ title: "Erro", description: e instanceof Error ? e.message : "Falha", variant: "destructive" })
    } finally {
      setBusyId(null)
    }
  }

  const duplicate = (id: string) =>
    action(id, () => fetch(`/api/super-admin/email-templates/${id}/duplicate`, { method: "POST" }), "Template duplicado")

  const setStatus = (id: string, status: string) =>
    action(
      id,
      () =>
        fetch(`/api/super-admin/email-templates/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        }),
      status === "archived" ? "Template arquivado" : status === "active" ? "Template ativado" : "Status alterado",
    )

  const setDefaultFor = (id: string, companyId: string) =>
    action(
      id,
      () =>
        fetch(`/api/super-admin/email-templates/${id}/default`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ companyId }),
        }),
      "Padrão definido",
    )

  if (editorOpen) {
    return (
      <TemplateEditor
        templateId={editingId}
        companies={companies}
        onClose={() => {
          setEditorOpen(false)
          load()
        }}
      />
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Select value={scopeFilter} onValueChange={setScopeFilter}>
          <SelectTrigger className="w-56">
            <SelectValue placeholder="Escopo" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos os escopos</SelectItem>
            <SelectItem value="global">Somente globais</SelectItem>
            {companies.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" onClick={() => setIncludeArchived((v) => !v)}>
          {includeArchived ? "Ocultar arquivados" : "Mostrar arquivados"}
        </Button>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
        <div className="ml-auto">
          <Button onClick={openCreate}>
            <Plus className="mr-2 h-4 w-4" /> Novo template
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Carregando templates…
        </div>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center text-muted-foreground">
            Nenhum template encontrado. Clique em “Novo template” para começar.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {rows.map(({ template, currentVersion, isDefault }) => (
            <Card key={template.id}>
              <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0 pb-2">
                <div className="min-w-0">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <span className="truncate">{template.name}</span>
                    {isDefault && (
                      <Star className="h-4 w-4 fill-yellow-400 text-yellow-500" aria-label="Padrão" />
                    )}
                  </CardTitle>
                  <p className="mt-1 truncate text-sm text-muted-foreground">
                    {currentVersion?.subject ?? "— sem versão —"}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge variant="outline">{companyName(template.companyId)}</Badge>
                  <Badge variant={template.purpose === "negotiation" ? "default" : "secondary"}>
                    {PURPOSE_LABEL[template.purpose]}
                  </Badge>
                  <Badge
                    variant={
                      template.status === "active"
                        ? "default"
                        : template.status === "archived"
                          ? "outline"
                          : "secondary"
                    }
                  >
                    {STATUS_LABEL[template.status]}
                  </Badge>
                  {currentVersion && <Badge variant="outline">v{currentVersion.version}</Badge>}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" disabled={busyId === template.id}>
                        {busyId === template.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <MoreVertical className="h-4 w-4" />
                        )}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => openEdit(template.id)}>
                        <Pencil className="mr-2 h-4 w-4" /> Editar
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => duplicate(template.id)}>
                        <Copy className="mr-2 h-4 w-4" /> Duplicar
                      </DropdownMenuItem>
                      {template.status !== "active" && (
                        <DropdownMenuItem onClick={() => setStatus(template.id, "active")}>
                          Ativar
                        </DropdownMenuItem>
                      )}
                      {template.status === "active" && (
                        <DropdownMenuItem onClick={() => setStatus(template.id, "draft")}>
                          Voltar a rascunho
                        </DropdownMenuItem>
                      )}
                      {template.status !== "archived" && (
                        <DropdownMenuItem onClick={() => setStatus(template.id, "archived")}>
                          <Archive className="mr-2 h-4 w-4" /> Arquivar
                        </DropdownMenuItem>
                      )}
                      {template.status === "active" && companies.length > 0 && (
                        <>
                          {companies.map((c) => (
                            <DropdownMenuItem
                              key={c.id}
                              onClick={() => setDefaultFor(template.id, c.id)}
                              disabled={template.companyId != null && template.companyId !== c.id}
                            >
                              <Star className="mr-2 h-4 w-4" /> Padrão para {c.name}
                            </DropdownMenuItem>
                          ))}
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </CardHeader>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
