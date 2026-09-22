"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useToast } from "@/hooks/use-toast"
import {
  ALLOWED_VARIABLES,
  VARIABLE_DESCRIPTIONS,
  type AllowedVariable,
} from "@/lib/email/templates/variables"
import {
  ArrowLeft,
  Loader2,
  Save,
  Eye,
  Monitor,
  Smartphone,
  Send,
  History,
  AlertTriangle,
  Variable,
} from "lucide-react"

interface Company {
  id: string
  name: string
}

interface VersionRow {
  id: string
  version: number
  subject: string
  createdAt: string
  createdBy: string | null
}

interface EditorState {
  name: string
  scope: "global" | "company"
  companyId: string | null
  purpose: "negotiation" | "communication"
  subject: string
  preheader: string
  html: string
  textFallback: string
  /** Libera dados do débito no corpo (valor/nome/documento mascarado/vencimento).
   * Só para e-mail de negociação; por padrão OFF (template continua neutro). */
  allowDebtFields: boolean
}

const EMPTY: EditorState = {
  name: "",
  scope: "global",
  companyId: null,
  purpose: "communication",
  subject: "",
  preheader: "",
  html: '<!DOCTYPE html>\n<html>\n<head><meta charset="utf-8"></head>\n<body>\n  <p>Olá, {{primeiro_nome}}!</p>\n</body>\n</html>',
  textFallback: "",
  allowDebtFields: false,
}

export function TemplateEditor({
  templateId,
  companies,
  onClose,
}: {
  templateId: string | null
  companies: Company[]
  onClose: () => void
}) {
  const { toast } = useToast()
  const [state, setState] = useState<EditorState>(EMPTY)
  const [loading, setLoading] = useState<boolean>(Boolean(templateId))
  const [saving, setSaving] = useState(false)
  const [previewHtml, setPreviewHtml] = useState<string>("")
  const [warnings, setWarnings] = useState<string[]>([])
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop")
  const [versions, setVersions] = useState<VersionRow[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [testEmail, setTestEmail] = useState("")
  const [sendingTest, setSendingTest] = useState(false)
  const htmlRef = useRef<HTMLTextAreaElement>(null)

  const set = <K extends keyof EditorState>(key: K, value: EditorState[K]) =>
    setState((s) => ({ ...s, [key]: value }))

  // Carrega template existente.
  useEffect(() => {
    if (!templateId) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/super-admin/email-templates/${templateId}`, { cache: "no-store" })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || "Falha ao carregar")
        if (cancelled) return
        const t = data.template
        const v = data.currentVersion
        setState({
          name: t.name,
          scope: t.companyId ? "company" : "global",
          companyId: t.companyId ?? null,
          purpose: t.purpose,
          subject: v?.subject ?? "",
          preheader: v?.preheader ?? "",
          html: v?.html ?? EMPTY.html,
          textFallback: v?.textFallback ?? "",
          allowDebtFields: Boolean(t.allowDebtFields),
        })
      } catch (e) {
        toast({ title: "Erro", description: e instanceof Error ? e.message : "Falha", variant: "destructive" })
        onClose()
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId])

  // Preview (debounce) — sempre via servidor: renderiza dados fictícios + sanitiza.
  const refreshPreview = useCallback(async () => {
    try {
      const res = await fetch("/api/super-admin/email-templates/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: state.subject,
          preheader: state.preheader,
          html: state.html,
          textFallback: state.textFallback,
          purpose: state.purpose,
        }),
      })
      const data = await res.json()
      if (res.ok) {
        setPreviewHtml(data.previewHtml || "")
        setWarnings(data.warnings || [])
      }
    } catch {
      // silencioso: o preview é auxiliar.
    }
  }, [state.subject, state.preheader, state.html, state.textFallback, state.purpose])

  useEffect(() => {
    if (loading) return
    const t = setTimeout(refreshPreview, 400)
    return () => clearTimeout(t)
  }, [refreshPreview, loading])

  const loadVersions = useCallback(async () => {
    if (!templateId) return
    try {
      const res = await fetch(`/api/super-admin/email-templates/${templateId}/versions`, { cache: "no-store" })
      const data = await res.json()
      if (res.ok) setVersions(data.versions || [])
    } catch {
      /* noop */
    }
  }, [templateId])

  const insertVariable = (name: AllowedVariable) => {
    const token = `{{${name}}}`
    const el = htmlRef.current
    if (!el) {
      set("html", state.html + token)
      return
    }
    const start = el.selectionStart ?? state.html.length
    const end = el.selectionEnd ?? state.html.length
    const next = state.html.slice(0, start) + token + state.html.slice(end)
    set("html", next)
    requestAnimationFrame(() => {
      el.focus()
      el.selectionStart = el.selectionEnd = start + token.length
    })
  }

  const buildBody = () => ({
    name: state.name,
    scope: state.scope,
    companyId: state.scope === "company" ? state.companyId : null,
    purpose: state.purpose,
    subject: state.subject,
    preheader: state.preheader,
    html: state.html,
    textFallback: state.textFallback,
    // Só faz sentido em templates de negociação; a rota (D1) ignora fora disso.
    allowDebtFields: state.purpose === "negotiation" ? state.allowDebtFields : false,
  })

  const save = async () => {
    setSaving(true)
    try {
      const url = templateId
        ? `/api/super-admin/email-templates/${templateId}`
        : `/api/super-admin/email-templates`
      const res = await fetch(url, {
        method: templateId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildBody()),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        const validationMsgs: string[] =
          data.validation?.errors?.map((e: { message: string }) => e.message) ?? []
        throw new Error(validationMsgs.join(" ") || data.error || "Falha ao salvar")
      }
      toast({ title: templateId ? "Nova versão salva" : "Template criado" })
      onClose()
    } catch (e) {
      toast({ title: "Não foi possível salvar", description: e instanceof Error ? e.message : "Falha", variant: "destructive" })
    } finally {
      setSaving(false)
    }
  }

  const restore = async (versionId: string) => {
    if (!templateId) return
    try {
      const res = await fetch(`/api/super-admin/email-templates/${templateId}/versions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ versionId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Falha ao restaurar")
      toast({ title: "Versão restaurada como nova versão" })
      onClose()
    } catch (e) {
      toast({ title: "Erro", description: e instanceof Error ? e.message : "Falha", variant: "destructive" })
    }
  }

  const sendTest = async () => {
    setSendingTest(true)
    try {
      const res = await fetch("/api/super-admin/email-templates/test-send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...buildBody(), testEmail }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        const msgs: string[] = data.validation?.errors?.map((e: { message: string }) => e.message) ?? []
        throw new Error(msgs.join(" ") || data.error || "Falha no teste")
      }
      toast({ title: "Teste validado", description: data.message || "SendGrid sandbox (nada entregue)." })
    } catch (e) {
      toast({ title: "Erro no teste", description: e instanceof Error ? e.message : "Falha", variant: "destructive" })
    } finally {
      setSendingTest(false)
    }
  }

  const highlightedHtml = useMemo(() => highlightHtmlSyntax(state.html), [state.html])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Carregando editor…
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Button variant="ghost" onClick={onClose}>
          <ArrowLeft className="mr-2 h-4 w-4" /> Voltar
        </Button>
        <div className="flex items-center gap-2">
          {templateId && (
            <Button
              variant="outline"
              onClick={() => {
                setShowHistory((v) => !v)
                if (!showHistory) loadVersions()
              }}
            >
              <History className="mr-2 h-4 w-4" /> Histórico
            </Button>
          )}
          <Button onClick={save} disabled={saving}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            {templateId ? "Salvar nova versão" : "Criar template"}
          </Button>
        </div>
      </div>

      {warnings.length > 0 && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            <p className="mb-1 font-medium">Corrija antes de salvar:</p>
            <ul className="list-inside list-disc text-sm">
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {showHistory && templateId && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Histórico de versões</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {versions.length === 0 ? (
              <p className="text-sm text-muted-foreground">Sem versões anteriores.</p>
            ) : (
              versions.map((v) => (
                <div key={v.id} className="flex items-center justify-between rounded border p-2 text-sm">
                  <div>
                    <Badge variant="outline">v{v.version}</Badge>{" "}
                    <span className="text-muted-foreground">
                      {new Date(v.createdAt).toLocaleString("pt-BR")}
                    </span>{" "}
                    — {v.subject}
                  </div>
                  <Button size="sm" variant="outline" onClick={() => restore(v.id)}>
                    Restaurar
                  </Button>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Coluna do editor */}
        <div className="space-y-4">
          <Card>
            <CardContent className="space-y-4 pt-6">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>Nome</Label>
                  <Input value={state.name} onChange={(e) => set("name", e.target.value)} placeholder="Ex.: Convite de negociação" />
                </div>
                <div className="space-y-1.5">
                  <Label>Propósito</Label>
                  <Select value={state.purpose} onValueChange={(v) => set("purpose", v as EditorState["purpose"])}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="communication">Comunicação</SelectItem>
                      <SelectItem value="negotiation">Negociação</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Escopo</Label>
                  <Select
                    value={state.scope}
                    onValueChange={(v) => {
                      const scope = v as EditorState["scope"]
                      set("scope", scope)
                      if (scope === "global") set("companyId", null)
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="global">Global (todos os cedentes)</SelectItem>
                      <SelectItem value="company">Cedente específico</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {state.scope === "company" && (
                  <div className="space-y-1.5">
                    <Label>Cedente</Label>
                    <Select value={state.companyId ?? ""} onValueChange={(v) => set("companyId", v)}>
                      <SelectTrigger>
                        <SelectValue placeholder="Selecione…" />
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
                )}
              </div>

              {state.purpose === "negotiation" && (
                <div className="rounded-md border border-amber-300/60 bg-amber-50 p-3 dark:border-amber-500/30 dark:bg-amber-950/20">
                  <div className="flex items-start gap-2">
                    <Checkbox
                      id="allow-debt-fields"
                      checked={state.allowDebtFields}
                      onCheckedChange={(v) => set("allowDebtFields", v === true)}
                      className="mt-0.5"
                    />
                    <div className="space-y-1">
                      <Label htmlFor="allow-debt-fields" className="cursor-pointer font-medium">
                        Permitir dados do débito (só e-mail de negociação)
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        Libera o uso de valor, nome do cliente, documento mascarado e vencimento no
                        corpo deste template. Use somente em cobrança nominal autorizada — os dados vão
                        para a caixa de entrada do destinatário.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              <div className="space-y-1.5">
                <Label>Assunto</Label>
                <Input value={state.subject} onChange={(e) => set("subject", e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Pré-header</Label>
                <Input
                  value={state.preheader}
                  onChange={(e) => set("preheader", e.target.value)}
                  placeholder="Texto de prévia (aparece na caixa de entrada)"
                />
              </div>
            </CardContent>
          </Card>

          {/* Painel de variáveis */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Variable className="h-4 w-4" /> Variáveis permitidas
              </CardTitle>
            </CardHeader>
            <CardContent>
              <TooltipProvider>
                <div className="flex flex-wrap gap-2">
                  {ALLOWED_VARIABLES.map((name) => (
                    <Tooltip key={name}>
                      <TooltipTrigger asChild>
                        <Button variant="outline" size="sm" onClick={() => insertVariable(name)}>
                          {`{{${name}}}`}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{VARIABLE_DESCRIPTIONS[name]}</TooltipContent>
                    </Tooltip>
                  ))}
                </div>
              </TooltipProvider>
              <p className="mt-2 text-xs text-muted-foreground">
                Dados do débito (valor, faturas, vencimento, CPF/CNPJ, contrato) são bloqueados.
                Templates de negociação exigem {"{{link_negociacao}}"} e {"{{link_descadastro}}"}.
              </p>
            </CardContent>
          </Card>

          {/* HTML com destaque de sintaxe (overlay) */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Corpo HTML</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="relative font-mono text-sm">
                <pre
                  aria-hidden
                  className="pointer-events-none absolute inset-0 m-0 overflow-auto whitespace-pre-wrap break-words rounded-md border border-transparent p-3"
                  dangerouslySetInnerHTML={{ __html: highlightedHtml }}
                />
                <Textarea
                  ref={htmlRef}
                  value={state.html}
                  onChange={(e) => set("html", e.target.value)}
                  spellCheck={false}
                  className="relative min-h-[280px] resize-y bg-transparent font-mono text-sm text-transparent caret-foreground selection:bg-blue-300/40"
                  style={{ WebkitTextFillColor: "transparent" }}
                />
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Editor de código (sem editor visual). O HTML é sanitizado por allowlist na gravação e no envio.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Texto alternativo (opcional)</CardTitle>
            </CardHeader>
            <CardContent>
              <Textarea
                value={state.textFallback}
                onChange={(e) => set("textFallback", e.target.value)}
                placeholder="Deixe vazio para gerar automaticamente a partir do HTML."
                className="min-h-[100px]"
              />
            </CardContent>
          </Card>

          {/* Enviar teste (SendGrid sandbox) */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Send className="h-4 w-4" /> Enviar teste
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap items-end gap-2">
              <div className="flex-1 space-y-1.5">
                <Label>E-mail de teste</Label>
                <Input
                  type="email"
                  value={testEmail}
                  onChange={(e) => setTestEmail(e.target.value)}
                  placeholder="voce@exemplo.com"
                />
              </div>
              <Button variant="outline" onClick={sendTest} disabled={sendingTest || !testEmail}>
                {sendingTest ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
                Enviar teste
              </Button>
              <p className="w-full text-xs text-muted-foreground">
                SendGrid em sandbox: o payload é validado, mas nenhum e-mail é entregue. Assunto prefixado com [TESTE].
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Coluna do preview */}
        <div className="space-y-4">
          <Card className="sticky top-4">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Eye className="h-4 w-4" /> Pré-visualização
              </CardTitle>
              <div className="flex items-center gap-1">
                <Button
                  variant={device === "desktop" ? "secondary" : "ghost"}
                  size="icon"
                  onClick={() => setDevice("desktop")}
                >
                  <Monitor className="h-4 w-4" />
                </Button>
                <Button
                  variant={device === "mobile" ? "secondary" : "ghost"}
                  size="icon"
                  onClick={() => setDevice("mobile")}
                >
                  <Smartphone className="h-4 w-4" />
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <p className="mb-2 truncate text-sm">
                <span className="text-muted-foreground">Assunto: </span>
                {state.subject || <span className="text-muted-foreground">(vazio)</span>}
              </p>
              <div className="flex justify-center rounded-md border bg-muted/30 p-3">
                <iframe
                  title="Pré-visualização do e-mail"
                  // sandbox SEM allow-scripts (§5.3): não executa JS nem navega o pai.
                  sandbox=""
                  srcDoc={previewHtml}
                  className="h-[520px] w-full rounded bg-white shadow-sm transition-all"
                  style={{ maxWidth: device === "mobile" ? 375 : "100%" }}
                />
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Dados fictícios. O HTML mostrado já está sanitizado.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

// Destaque de sintaxe leve (tags, atributos, variáveis {{...}}). Só visual —
// o valor real vem do textarea. Escapa antes de colorir para não injetar markup.
function highlightHtmlSyntax(src: string): string {
  const escaped = src.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  return escaped
    .replace(/(\{\{\s*[a-zA-Z0-9_]+\s*\}\})/g, '<span style="color:#0e7490;font-weight:600">$1</span>')
    .replace(/(&lt;\/?)([a-zA-Z0-9]+)/g, '$1<span style="color:#9333ea">$2</span>')
    .replace(/([a-zA-Z-]+)(=)(&quot;[^&]*&quot;|"[^"]*")/g, '<span style="color:#0369a1">$1</span>$2<span style="color:#15803d">$3</span>')
}
