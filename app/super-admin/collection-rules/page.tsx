"use client"

import { useState, useEffect } from "react"
import { createClient } from "@/lib/supabase/client"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { Plus, Edit, Trash2, Building2, Check, X, Users, AlertCircle, Timer, Clock, Info } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { fetchAllCustomers } from "@/app/actions/fetch-customers-action"
import { getAutomaticCollectionStats } from "@/app/actions/analyses-actions"
import { getCollectionRulerStats } from "@/app/actions/ruler-actions" // Import getCollectionRulerStats

interface CollectionRule {
  id: string
  name: string
  description: string | null
  is_active: boolean
  created_at: string
  steps: CollectionRuleStep[]
  active_for_companies: string[] | null
  active_for_customers: string[] | null
  min_score: number
  max_score: number
  process_type: string
  priority: string
  rule_type: string
}

interface CollectionRuleStep {
  id: string
  rule_id: string
  step_order: number
  days_after_due: number
  channel: string
  template: string
  created_at: string
}

interface Company {
  id: string
  name: string
  cnpj: string
}

interface Customer {
  id: string
  name: string
  document: string
  company_id: string
}

export default function SuperAdminCollectionRulesPage() {
  const [automaticStats, setAutomaticStats] = useState<any>(null)
  const [rulerStats, setRulerStats] = useState<any>(null)
  const [rules, setRules] = useState<CollectionRule[]>([])
  const [companies, setCompanies] = useState<Company[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [filteredCustomers, setFilteredCustomers] = useState<Customer[]>([])
  const [loading, setLoading] = useState(true)
  const [showDialog, setShowDialog] = useState(false)
  const [editingRule, setEditingRule] = useState<CollectionRule | null>(null)
  const { toast } = useToast()
  const supabase = createClient()

  // Form state
  const [formData, setFormData] = useState<any>({
    name: "",
    description: "",
    is_active: true,
    steps: [],
    assignment_mode: "companies",
    assigned_companies: [],
    assigned_customers: [],
    min_score: 0,
    max_score: 1000,
    process_type: "automatic",
    priority: "medium",
    rule_type: "custom",
  })

  useEffect(() => {
    fetchRules()
    fetchCompanies()
    fetchCustomers()
    fetchAutomaticStats()
    fetchRulerStats()
  }, [])

  const fetchAutomaticStats = async () => {
    try {
      const stats = await getAutomaticCollectionStats()
      setAutomaticStats(stats)
    } catch (error) {
      console.error("[v0] Error fetching automatic stats:", error)
    }
  }

  const fetchRulerStats = async () => {
    try {
      const stats = await getCollectionRulerStats()
      setRulerStats(stats)
    } catch (error) {}
  }

  async function fetchRules() {
    try {
      const { data: rulesData, error: rulesError } = await supabase
        .from("collection_rules")
        .select("*")
        .order("created_at", { ascending: false })

      if (rulesError) throw rulesError

      // Fetch steps for each rule
      const rulesWithSteps = await Promise.all(
        (rulesData || []).map(async (rule) => {
          const { data: stepsData } = await supabase
            .from("collection_rule_steps")
            .select("*")
            .eq("rule_id", rule.id)
            .order("step_order")

          return { ...rule, steps: stepsData || [] }
        }),
      )

      setRules(rulesWithSteps)
    } catch (error: any) {
      toast({
        title: "Erro ao carregar réguas",
        description: error.message,
        variant: "destructive",
      })
    } finally {
      setLoading(false)
    }
  }

  async function fetchCompanies() {
    try {
      const { data, error } = await supabase.from("companies").select("id, name, cnpj").order("name")

      if (error) throw error
      setCompanies(data || [])
    } catch (error: any) {
      console.error("Error fetching companies:", error)
    }
  }

  async function fetchCustomers() {
    try {
      const result = await fetchAllCustomers()

      if (!result.success) {
        throw new Error(result.error)
      }

      console.log("[v0] Customers fetched via server action:", result.customers.length)
      setCustomers(result.customers)
    } catch (error: any) {
      console.error("Error fetching customers:", error.message || error)
      toast({
        title: "Erro ao carregar clientes",
        description: error.message,
        variant: "destructive",
      })
    }
  }

  async function handleSaveRule() {
    try {
      if (editingRule) {
        // Update existing rule
        const { error: ruleError } = await supabase
          .from("collection_rules")
          .update({
            name: formData.name,
            description: formData.description,
            is_active: formData.is_active,
            active_for_companies:
              formData.assignment_mode === "companies" && formData.assigned_companies.length > 0
                ? formData.assigned_companies
                : formData.assignment_mode === "customers"
                  ? formData.assigned_companies
                  : null,
            active_for_customers:
              formData.assignment_mode === "customers" && formData.assigned_customers.length > 0
                ? formData.assigned_customers
                : null,
            min_score: formData.min_score,
            max_score: formData.max_score,
            process_type: formData.process_type,
            priority: formData.priority,
            rule_type: formData.rule_type,
          })
          .eq("id", editingRule.id)

        if (ruleError) throw ruleError

        // Delete old steps
        await supabase.from("collection_rule_steps").delete().eq("rule_id", editingRule.id)

        // Insert new steps
        const stepsToInsert = formData.steps.map((step) => ({
          rule_id: editingRule.id,
          ...step,
        }))

        const { error: stepsError } = await supabase.from("collection_rule_steps").insert(stepsToInsert)

        if (stepsError) throw stepsError

        toast({
          title: "Régua atualizada",
          description: "A régua de cobrança foi atualizada com sucesso.",
        })
      } else {
        // Create new rule
        const { data: newRule, error: ruleError } = await supabase
          .from("collection_rules")
          .insert({
            name: formData.name,
            description: formData.description,
            is_active: formData.is_active,
            active_for_companies:
              formData.assignment_mode === "companies" && formData.assigned_companies.length > 0
                ? formData.assigned_companies
                : formData.assignment_mode === "customers"
                  ? formData.assigned_companies
                  : null,
            active_for_customers:
              formData.assignment_mode === "customers" && formData.assigned_customers.length > 0
                ? formData.assigned_customers
                : null,
            min_score: formData.min_score,
            max_score: formData.max_score,
            process_type: formData.process_type,
            priority: formData.priority,
            rule_type: formData.rule_type,
          })
          .select()
          .single()

        if (ruleError) throw ruleError

        // Insert steps
        const stepsToInsert = formData.steps.map((step) => ({
          rule_id: newRule.id,
          ...step,
        }))

        const { error: stepsError } = await supabase.from("collection_rule_steps").insert(stepsToInsert)

        if (stepsError) throw stepsError

        toast({
          title: "Régua criada",
          description: "A régua de cobrança foi criada com sucesso.",
        })
      }

      setShowDialog(false)
      setEditingRule(null)
      resetForm()
      fetchRules()
      fetchRulerStats() // Refresh ruler stats after saving
    } catch (error: any) {
      toast({
        title: "Erro ao salvar régua",
        description: error.message,
        variant: "destructive",
      })
    }
  }

  async function handleDeleteRule(ruleId: string) {
    if (!confirm("Tem certeza que deseja excluir esta régua?")) return

    try {
      const { error } = await supabase.from("collection_rules").delete().eq("id", ruleId)

      if (error) throw error

      toast({
        title: "Régua excluída",
        description: "A régua de cobrança foi excluída com sucesso.",
      })

      fetchRules()
      fetchRulerStats() // Refresh ruler stats after deleting
    } catch (error: any) {
      toast({
        title: "Erro ao excluir régua",
        description: error.message,
        variant: "destructive",
      })
    }
  }

  async function handleToggleActive(rule: CollectionRule) {
    try {
      const { error } = await supabase.from("collection_rules").update({ is_active: !rule.is_active }).eq("id", rule.id)

      if (error) throw error

      toast({
        title: rule.is_active ? "Régua desativada" : "Régua ativada",
        description: `A régua foi ${rule.is_active ? "desativada" : "ativada"} com sucesso.`,
      })

      fetchRules()
      fetchRulerStats() // Refresh ruler stats after toggling active
    } catch (error: any) {
      toast({
        title: "Erro ao alterar status",
        description: error.message,
        variant: "destructive",
      })
    }
  }

  function openCreateDialog() {
    resetForm()
    setEditingRule(null)
    setShowDialog(true)
  }

  function openEditDialog(rule: CollectionRule) {
    setFormData({
      name: rule.name,
      description: rule.description || "",
      is_active: rule.is_active,
      steps: rule.steps.map((step) => ({
        step_order: step.step_order,
        days_after_due: step.days_after_due,
        channel: step.channel,
        template: step.template,
      })),
      assignment_mode: rule.active_for_customers && rule.active_for_customers.length > 0 ? "customers" : "companies",
      assigned_companies: rule.active_for_companies || [],
      assigned_customers: rule.active_for_customers || [],
      min_score: rule.min_score || 0,
      max_score: rule.max_score || 1000,
      process_type: rule.process_type || "automatic",
      priority: rule.priority || "medium",
      rule_type: rule.rule_type || "custom",
    })
    setEditingRule(rule)
    setShowDialog(true)
  }

  function resetForm() {
    setFormData({
      name: "",
      description: "",
      is_active: true,
      steps: [],
      assignment_mode: "companies",
      assigned_companies: [],
      assigned_customers: [],
      min_score: 0,
      max_score: 1000,
      process_type: "automatic",
      priority: "medium",
      rule_type: "custom",
    })
  }

  function addStep() {
    setFormData({
      ...formData,
      steps: [
        ...formData.steps,
        {
          step_order: formData.steps.length + 1,
          days_after_due: 0,
          channel: "email",
          template: "",
        },
      ],
    })
  }

  function removeStep(index: number) {
    const newSteps = formData.steps.filter((_, i) => i !== index)
    setFormData({
      ...formData,
      steps: newSteps.map((step, i) => ({ ...step, step_order: i + 1 })),
    })
  }

  function updateStep(index: number, field: string, value: any) {
    const newSteps = [...formData.steps]
    newSteps[index] = { ...newSteps[index], [field]: value }
    setFormData({ ...formData, steps: newSteps })
  }

  function toggleCompanySelection(companyId: string) {
    setFormData((prev) => ({
      ...prev,
      assigned_companies: prev.assigned_companies.includes(companyId)
        ? prev.assigned_companies.filter((id) => id !== companyId)
        : [...prev.assigned_companies, companyId],
    }))
  }

  function toggleCustomerSelection(customerId: string) {
    setFormData((prev) => ({
      ...prev,
      assigned_customers: prev.assigned_customers.includes(customerId)
        ? prev.assigned_customers.filter((id) => id !== customerId)
        : [...prev.assigned_customers, customerId],
    }))
  }

  // Filter customers based on selected companies
  useEffect(() => {
    if (formData.assigned_companies.length > 0) {
      setFilteredCustomers(customers.filter((customer) => formData.assigned_companies.includes(customer.company_id)))
    } else {
      setFilteredCustomers(customers)
    }
  }, [formData.assigned_companies, customers])

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-muted-foreground">Carregando réguas...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="w-full space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Réguas de Cobrança</h1>
          <p className="text-muted-foreground">Gerencie réguas de cobrança e atribua a empresas</p>
        </div>
        <Button onClick={openCreateDialog}>
          <Plus className="mr-2 h-4 w-4" />
          Nova Régua Customizada
        </Button>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Timer className="h-5 w-5 text-blue-600" />
              <CardTitle>Régua 1 - Análise de Score (Assertiva)</CardTitle>
            </div>
            <Badge variant={automaticStats?.eligible > 0 ? "default" : "secondary"}>
              {automaticStats?.eligible > 0 ? "Funcionando" : "Sem clientes"}
            </Badge>
          </div>
          <CardDescription>Régua automática baseada no Score de Recuperação da Assertiva (Classes A-F)</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Status Cards */}
          <div className="grid gap-4 md:grid-cols-3">
            <Card>
              <CardHeader className="pb-3">
                <CardDescription>Clientes Elegíveis</CardDescription>
                <CardTitle className="text-2xl text-blue-600">{automaticStats?.eligible || 0}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground">
                  Total de clientes com status ACEITA e Recovery Score ≥ 294 (Classe C ou superior)
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardDescription>Aguardando Processamento</CardDescription>
                <CardTitle className="text-2xl text-orange-600">{automaticStats?.notProcessed || 0}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground">Serão processados na próxima execução automática</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardDescription>Já Processados</CardDescription>
                <CardTitle className="text-2xl text-green-600">{automaticStats?.alreadyProcessed || 0}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground">Cobranças já enviadas automaticamente</p>
              </CardContent>
            </Card>
          </div>

          {/* Info */}
          <div className="rounded-lg bg-blue-50 dark:bg-blue-950 p-4 space-y-2">
            <div className="flex items-start gap-2">
              <Info className="h-4 w-4 text-blue-600 mt-0.5" />
              <div className="space-y-1 text-sm text-blue-900 dark:text-blue-100">
                <p>
                  <strong>Como funciona:</strong> Quando você importa ou analisa um cliente, o sistema busca dados da
                  Assertiva e verifica o Score de Recuperação automaticamente.
                </p>
                <p>
                  <strong>Critérios de Cobrança Automática:</strong> Recovery Score ≥ 294 (Classes C, B, A) → Cobrança
                  automática permitida | Recovery Score &lt; 294 (Classes D, E, F) → Cobrança manual obrigatória
                </p>
                <p>
                  <strong>Status:</strong> 100% Funcional baseado no Score de Recuperação da Assertiva
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Clock className="h-5 w-5 text-purple-600" />
              <CardTitle>Régua 2 - Cobrança Customizável</CardTitle>
            </div>
            <Badge variant={rulerStats?.activeRulers > 0 ? "default" : "secondary"}>
              {rulerStats?.activeRulers > 0 ? "Funcionando" : "Aguardando configuração"}
            </Badge>
          </div>
          <CardDescription>
            Régua customizável baseada no Score de Recuperação. Permite configurar dias e canais personalizados de
            cobrança
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Status Cards */}
          <div className="grid gap-4 md:grid-cols-4">
            <Card>
              <CardHeader className="pb-3">
                <CardDescription>Réguas Ativas</CardDescription>
                <CardTitle className="text-2xl text-purple-600">{rulerStats?.activeRulers || 0}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground">Réguas customizadas criadas e ativas no sistema</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardDescription>Clientes Elegíveis</CardDescription>
                <CardTitle className="text-2xl text-blue-600">{rulerStats?.eligibleClients || 0}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground">Clientes que podem receber cobrança customizada</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardDescription>Execuções Hoje</CardDescription>
                <CardTitle className="text-2xl text-green-600">{rulerStats?.successfulToday || 0}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground">Cobranças enviadas com sucesso hoje</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardDescription>Última Execução</CardDescription>
                <CardTitle className="text-sm">
                  {rulerStats?.lastExecution ? new Date(rulerStats.lastExecution).toLocaleTimeString("pt-BR") : "Nunca"}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground">Horário da última execução automática</p>
              </CardContent>
            </Card>
          </div>

          {/* Recent Executions */}
          {rulerStats?.recentExecutions?.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-sm font-medium">Últimas Execuções Automáticas</h4>
              <div className="space-y-2">
                {rulerStats.recentExecutions.slice(0, 5).map((execution: any) => (
                  <div key={execution.id} className="flex items-center justify-between rounded-lg border p-3">
                    <div className="space-y-1">
                      <p className="text-sm font-medium">
                        Régua: {execution.ruler_name} - {execution.actions_taken} ações enviadas
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(execution.executed_at).toLocaleString("pt-BR")}
                      </p>
                    </div>
                    <Badge variant={execution.status === "success" ? "default" : "destructive"}>
                      {execution.status === "success" ? "Sucesso" : "Erro"}
                    </Badge>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Info */}
          <div className="rounded-lg bg-purple-50 dark:bg-purple-950 p-4 space-y-2">
            <div className="flex items-start gap-2">
              <Info className="h-4 w-4 text-purple-600 mt-0.5" />
              <div className="space-y-1 text-sm text-purple-900 dark:text-purple-100">
                <p>
                  <strong>Como funciona:</strong> A régua customizável executa automaticamente a cada hora via Vercel
                  Cron Job processando clientes baseado em days_after_due.
                </p>
                <p>
                  <strong>Configuração:</strong> Cada empresa pode criar réguas com dias específicos (D0, D2, D5, D7) e
                  múltiplos canais (Email, SMS, WhatsApp, Ligação).
                </p>
                <p>
                  <strong>Próxima execução:</strong> No início da próxima hora (às XX:00)
                </p>
                <p>
                  <strong>Status:</strong> 100% Funcional - Sistema pronto para uso. Clique em "Nova Régua Customizada"
                  acima para criar.
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4">
        {rules.map((rule) => (
          <Card key={rule.id} className="p-6">
            <div className="flex items-start justify-between mb-4">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-2">
                  <h3 className="text-xl font-semibold">{rule.name}</h3>
                  <Badge variant={rule.is_active ? "default" : "secondary"}>
                    {rule.is_active ? "Ativa" : "Inativa"}
                  </Badge>
                </div>
                {rule.description && <p className="text-sm text-muted-foreground mb-3">{rule.description}</p>}
                <div className="flex items-center gap-4 text-sm text-muted-foreground">
                  <div className="flex items-center gap-2">
                    <Building2 className="h-4 w-4" />
                    <span>{rule.active_for_companies?.length || 0} empresa(s)</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Users className="h-4 w-4" />
                    <span>{rule.active_for_customers?.length || 0} cliente(s)</span>
                  </div>
                </div>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => handleToggleActive(rule)}>
                  {rule.is_active ? <X className="h-4 w-4" /> : <Check className="h-4 w-4" />}
                </Button>
                <Button variant="outline" size="sm" onClick={() => openEditDialog(rule)}>
                  <Edit className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="sm" onClick={() => handleDeleteRule(rule.id)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <h4 className="font-medium text-sm">Etapas:</h4>
              {rule.steps.map((step) => (
                <div key={step.id} className="flex items-center gap-4 text-sm p-3 bg-muted rounded-lg">
                  <Badge variant="outline">Etapa {step.step_order}</Badge>
                  <span>{step.days_after_due} dias após vencimento</span>
                  <Badge>{step.channel}</Badge>
                  <span className="text-muted-foreground truncate flex-1">{step.template.substring(0, 50)}...</span>
                </div>
              ))}
            </div>
          </Card>
        ))}

        {rules.length === 0 && (
          <Card className="p-12 text-center">
            <p className="text-muted-foreground mb-4">Nenhuma régua de cobrança cadastrada</p>
            <Button onClick={openCreateDialog}>
              <Plus className="mr-2 h-4 w-4" />
              Criar Primeira Régua Customizada
            </Button>
          </Card>
        )}
      </div>

      {/* Create/Edit Dialog */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingRule ? "Editar Régua" : "Nova Régua Customizada"}</DialogTitle>
            <DialogDescription>
              Configure uma régua de cobrança personalizada com score e critérios específicos
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-6">
            {/* Informações Básicas */}
            <div className="space-y-4">
              <h4 className="font-semibold text-sm">Informações Básicas</h4>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="name">Nome da Régua *</Label>
                  <Input
                    id="name"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    placeholder="Ex: Régua Premium Score 600+"
                  />
                </div>

                <div>
                  <Label htmlFor="priority">Prioridade *</Label>
                  <Select
                    value={formData.priority}
                    onValueChange={(value) => setFormData({ ...formData, priority: value })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Selecione a prioridade" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="low">Baixa</SelectItem>
                      <SelectItem value="medium">Média</SelectItem>
                      <SelectItem value="high">Alta</SelectItem>
                      <SelectItem value="urgent">Urgente</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div>
                <Label htmlFor="description">Descrição</Label>
                <Textarea
                  id="description"
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  placeholder="Descreva o objetivo desta régua customizada"
                  rows={2}
                />
              </div>
            </div>

            <div className="space-y-4 p-4 border rounded-lg bg-muted/50">
              <h4 className="font-semibold text-sm">Critérios de Score</h4>
              <p className="text-xs text-muted-foreground">
                Defina a faixa de score para aplicar esta régua (diferente da régua padrão 350/490)
              </p>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="min_score">Score Mínimo</Label>
                  <Input
                    id="min_score"
                    type="number"
                    min="0"
                    max="1000"
                    value={formData.min_score}
                    onChange={(e) => setFormData({ ...formData, min_score: Number.parseInt(e.target.value) || 0 })}
                    placeholder="Ex: 600"
                  />
                  <p className="text-xs text-muted-foreground mt-1">Padrão sistema: 350 (médio), 490 (alto)</p>
                </div>

                <div>
                  <Label htmlFor="max_score">Score Máximo</Label>
                  <Input
                    id="max_score"
                    type="number"
                    min="0"
                    max="1000"
                    value={formData.max_score}
                    onChange={(e) => setFormData({ ...formData, max_score: Number.parseInt(e.target.value) || 1000 })}
                    placeholder="Ex: 1000"
                  />
                  <p className="text-xs text-muted-foreground mt-1">Máximo: 1000</p>
                </div>
              </div>

              <div>
                <Label htmlFor="process_type">Tipo de Processo *</Label>
                <Select
                  value={formData.process_type}
                  onValueChange={(value) => setFormData({ ...formData, process_type: value })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Selecione o tipo de processo" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="automatic">
                      <div className="space-y-1">
                        <div className="font-medium">Automático</div>
                        <div className="text-xs text-muted-foreground">
                          Dispara mensagens automaticamente (Email + SMS)
                        </div>
                      </div>
                    </SelectItem>
                    <SelectItem value="semi_automatic">
                      <div className="space-y-1">
                        <div className="font-medium">Semi-Automático</div>
                        <div className="text-xs text-muted-foreground">
                          Cria tarefa para operador (WhatsApp assistido)
                        </div>
                      </div>
                    </SelectItem>
                    <SelectItem value="manual">
                      <div className="space-y-1">
                        <div className="font-medium">Manual</div>
                        <div className="text-xs text-muted-foreground">Cobrança 100% manual, bloqueia automação</div>
                      </div>
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center gap-2 p-3 bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 rounded-lg">
                <AlertCircle className="h-4 w-4 text-blue-600 dark:text-blue-400 flex-shrink-0" />
                <p className="text-xs text-blue-700 dark:text-blue-300">
                  Esta régua customizada será aplicada apenas aos clientes selecionados. Os demais clientes continuarão
                  usando a régua padrão do sistema.
                </p>
              </div>
            </div>

            <div className="space-y-4 p-4 border rounded-lg bg-muted/50">
              <h4 className="font-semibold text-sm">Critérios de Score de Recuperação</h4>
              <p className="text-xs text-muted-foreground">
                Defina a faixa de Recovery Score para aplicar esta régua (sistema usa ≥ 294 como padrão para cobrança
                automática)
              </p>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="min_score">Recovery Score Mínimo</Label>
                  <Input
                    id="min_score"
                    type="number"
                    min="0"
                    max="1000"
                    value={formData.min_score}
                    onChange={(e) => setFormData({ ...formData, min_score: Number.parseInt(e.target.value) || 0 })}
                    placeholder="Ex: 294"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Padrão sistema: 294 (Classe C), 491 (Classe B), 800+ (Classe A)
                  </p>
                </div>

                <div>
                  <Label htmlFor="max_score">Recovery Score Máximo</Label>
                  <Input
                    id="max_score"
                    type="number"
                    min="0"
                    max="1000"
                    value={formData.max_score}
                    onChange={(e) => setFormData({ ...formData, max_score: Number.parseInt(e.target.value) || 1000 })}
                    placeholder="Ex: 1000"
                  />
                  <p className="text-xs text-muted-foreground mt-1">Máximo: 1000 (Classe A)</p>
                </div>
              </div>
            </div>

            {/* Etapas de Cobrança */}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="font-semibold text-sm">Etapas de Cobrança</h4>
                  <p className="text-xs text-muted-foreground">Configure as mensagens e canais para cada etapa</p>
                </div>
                <Button type="button" size="sm" onClick={addStep}>
                  <Plus className="h-4 w-4 mr-2" />
                  Adicionar Etapa
                </Button>
              </div>

              {formData.steps.map((step, index) => (
                <Card key={index} className="p-4">
                  <div className="flex items-start gap-4">
                    <div className="flex-1 space-y-3">
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <Label>Dias após vencimento</Label>
                          <Input
                            type="number"
                            value={step.days_after_due}
                            onChange={(e) => updateStep(index, "days_after_due", Number.parseInt(e.target.value) || 0)}
                          />
                        </div>
                        <div>
                          <Label>Canal</Label>
                          <Select value={step.channel} onValueChange={(value) => updateStep(index, "channel", value)}>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="email">Email</SelectItem>
                              <SelectItem value="sms">SMS</SelectItem>
                              <SelectItem value="whatsapp">WhatsApp</SelectItem>
                              <SelectItem value="phone">Ligação</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                      <div>
                        <Label>Template da Mensagem</Label>
                        <Textarea
                          value={step.template}
                          onChange={(e) => updateStep(index, "template", e.target.value)}
                          placeholder="Digite o template da mensagem..."
                          rows={3}
                        />
                      </div>
                    </div>
                    {formData.steps.length > 1 && (
                      <Button type="button" variant="ghost" size="sm" onClick={() => removeStep(index)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </Card>
              ))}
            </div>

            {/* Atribuição de Clientes */}
            <div className="space-y-4 p-4 border rounded-lg bg-muted/50">
              <h4 className="font-semibold text-sm">Atribuir Régua a Clientes Específicos</h4>
              <p className="text-xs text-muted-foreground">Selecione os clientes que usarão esta régua customizada</p>

              <div className="flex gap-2 p-1 bg-muted/50 rounded-lg border">
                <Button
                  type="button"
                  variant={formData.assignment_mode === "companies" ? "default" : "ghost"}
                  size="sm"
                  onClick={() => setFormData({ ...formData, assignment_mode: "companies", assigned_customers: [] })}
                  className="flex-1"
                >
                  <Building2 className="h-4 w-4 mr-2" />
                  Empresas
                </Button>
                <Button
                  type="button"
                  variant={formData.assignment_mode === "customers" ? "default" : "ghost"}
                  size="sm"
                  onClick={() => setFormData({ ...formData, assignment_mode: "customers" })}
                  className="flex-1"
                >
                  <Users className="h-4 w-4 mr-2" />
                  Clientes Específicos
                </Button>
              </div>

              {formData.assignment_mode === "companies" ? (
                <div className="space-y-3">
                  <div>
                    <Label className="text-sm font-medium mb-2 block">Selecione as empresas</Label>
                    <p className="text-xs text-muted-foreground mb-3">
                      A régua será aplicada a todos os clientes dessas empresas
                    </p>
                    <div className="max-h-60 overflow-y-auto space-y-2 p-3 border rounded-lg bg-background">
                      {companies.length === 0 ? (
                        <p className="text-sm text-muted-foreground text-center py-4">Nenhuma empresa encontrada</p>
                      ) : (
                        companies.map((company) => (
                          <div
                            key={company.id}
                            className="flex items-center gap-3 p-3 hover:bg-muted rounded-lg cursor-pointer transition-colors border border-transparent hover:border-border"
                            onClick={() => toggleCompanySelection(company.id)}
                          >
                            <div
                              className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-all ${
                                formData.assigned_companies.includes(company.id)
                                  ? "bg-primary border-primary"
                                  : "border-muted-foreground"
                              }`}
                            >
                              {formData.assigned_companies.includes(company.id) && (
                                <Check className="h-3 w-3 text-primary-foreground" />
                              )}
                            </div>
                            <div className="flex-1">
                              <p className="font-medium text-sm">{company.name}</p>
                              <p className="text-xs text-muted-foreground">{company.cnpj}</p>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-2">
                      {formData.assigned_companies.length} empresa(s) selecionada(s)
                    </p>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <div>
                    <Label className="text-sm font-medium mb-2 block">1. Selecione as empresas</Label>
                    <p className="text-xs text-muted-foreground mb-3">
                      Primeiro escolha as empresas para filtrar os clientes
                    </p>
                    <div className="max-h-40 overflow-y-auto space-y-2 p-3 border rounded-lg bg-background">
                      {companies.length === 0 ? (
                        <p className="text-sm text-muted-foreground text-center py-4">Nenhuma empresa encontrada</p>
                      ) : (
                        companies.map((company) => (
                          <div
                            key={company.id}
                            className="flex items-center gap-3 p-2 hover:bg-muted rounded-lg cursor-pointer transition-colors"
                            onClick={() => toggleCompanySelection(company.id)}
                          >
                            <div
                              className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-all ${
                                formData.assigned_companies.includes(company.id)
                                  ? "bg-primary border-primary"
                                  : "border-muted-foreground"
                              }`}
                            >
                              {formData.assigned_companies.includes(company.id) && (
                                <Check className="h-3 w-3 text-primary-foreground" />
                              )}
                            </div>
                            <span className="text-sm font-medium">{company.name}</span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  {formData.assigned_companies.length > 0 ? (
                    <div>
                      <label className="text-sm font-medium">2. Selecione os clientes</label>
                      <p className="text-xs text-muted-foreground">
                        Escolha clientes específicos das empresas selecionadas
                      </p>
                      <div className="max-h-[300px] overflow-y-auto rounded-md border p-4">
                        {filteredCustomers.length === 0 ? (
                          <div className="flex flex-col items-center justify-center py-8 text-center">
                            <Users className="mb-2 h-8 w-8 text-muted-foreground/50" />
                            <p className="text-sm text-muted-foreground">
                              {formData.assigned_companies.length === 0
                                ? "Selecione empresas primeiro"
                                : "Nenhum cliente encontrado para as empresas selecionadas"}
                            </p>
                          </div>
                        ) : (
                          <div className="space-y-2">
                            {filteredCustomers.map((customer) => (
                              <div key={customer.id} className="flex items-start space-x-2">
                                <Checkbox
                                  id={`customer-${customer.id}`}
                                  checked={formData.assigned_customers.includes(customer.id)}
                                  onCheckedChange={() => toggleCustomerSelection(customer.id)}
                                />
                                <label
                                  htmlFor={`customer-${customer.id}`}
                                  className="flex-1 cursor-pointer text-sm leading-tight"
                                >
                                  <div className="font-medium">{customer.name}</div>
                                  <div className="text-xs text-muted-foreground">{customer.document}</div>
                                </label>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {formData.assigned_customers.length} cliente(s) selecionado(s)
                      </p>
                    </div>
                  ) : (
                    <div className="p-6 border border-dashed rounded-lg bg-muted/30 text-center">
                      <Users className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
                      <p className="text-sm text-muted-foreground">
                        Selecione pelo menos uma empresa para ver os clientes
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="flex items-center gap-2 pt-2">
              <input
                type="checkbox"
                id="is_active"
                checked={formData.is_active}
                onChange={(e) => setFormData({ ...formData, is_active: e.target.checked })}
                className="rounded"
              />
              <Label htmlFor="is_active">Régua ativa</Label>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setShowDialog(false)}>
              Cancelar
            </Button>
            <Button type="button" onClick={handleSaveRule}>
              {editingRule ? "Salvar Alterações" : "Criar Régua"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
