"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  AlertCircle,
  Loader2,
  Sparkles,
  Building2,
  CheckCircle2,
  Eye,
  TrendingUp,
  FileText,
  DollarSign,
  AlertTriangle,
  Square,
  CheckSquare,
  CreditCard,
  Users,
  MapPin,
  Phone,
  Mail,
  Calendar,
  Shield,
  Download,
  Briefcase,
  Clock,
  Gavel,
} from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { getAllCustomers, getAllCompanies } from "@/app/actions/analyses-actions"
import { runAsyncAssertivaAnalysis } from "@/app/actions/run-async-assertiva-analysis"
import { getPendingAnalyses } from "@/app/actions/get-pending-analyses"

export default function ComportamentalPage() {
  const [customers, setCustomers] = useState<any[]>([])
  const [companies, setCompanies] = useState<{ id: string; name: string }[]>([])
  const [pendingAnalyses, setPendingAnalyses] = useState<any[]>([])
  const [selectedAnalysis, setSelectedAnalysis] = useState<any | null>(null)
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState("")
  const [filterCompany, setFilterCompany] = useState<string>("all")
  const [selectedCustomers, setSelectedCustomers] = useState<Set<string>>(new Set())
  const [isRunning, setIsRunning] = useState(false)
  const [showDetailsModal, setShowDetailsModal] = useState(false)
  const [sortBy, setSortBy] = useState<"name" | "score" | "status" | "date">("name")
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("asc")
  const [filterStatus, setFilterStatus] = useState<string>("all") // "all", "pending", "completed"
  const [displayLimit, setDisplayLimit] = useState<number>(100) // Limite de exibição
  const { toast } = useToast()

  useEffect(() => {
    loadData()
    const interval = setInterval(loadPendingAnalyses, 30000)
    return () => clearInterval(interval)
  }, [])

  const loadData = async () => {
    try {
      setLoading(true)
      const [customersRes, companiesRes] = await Promise.all([getAllCustomers(), getAllCompanies()])

      if (customersRes.success) setCustomers(customersRes.data)
      if (companiesRes.success) setCompanies(companiesRes.data)

      await loadPendingAnalyses()
    } catch (error: any) {
      toast({
        title: "Erro ao carregar dados",
        description: error.message,
        variant: "destructive",
      })
    } finally {
      setLoading(false)
    }
  }

  const loadPendingAnalyses = async () => {
    try {
      const result = await getPendingAnalyses()
      if (result.success && result.data) {
        setPendingAnalyses(result.data)
      }
    } catch (error) {
      console.error("Error loading pending analyses:", error)
    }
  }

  const filteredCustomers = customers
    .filter((customer) => {
      const matchesSearch =
        customer.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        customer.document?.toLowerCase().includes(searchTerm.toLowerCase())
      const matchesCompany = filterCompany === "all" || customer.company_id === filterCompany
      // Filtro por status de análise
      const hasAnalysis = customer.recovery_score !== null || customer.analysis_metadata !== null
      const matchesStatus = filterStatus === "all" || 
        (filterStatus === "pending" && !hasAnalysis) || 
        (filterStatus === "completed" && hasAnalysis)
      return matchesSearch && matchesCompany && matchesStatus
    })
    .map((customer) => {
      const analysis = pendingAnalyses.find((a) => a.cpf?.replace(/\D/g, "") === customer.document?.replace(/\D/g, ""))
      return {
        ...customer,
        hasAnalysis: !!analysis,
        analysisData: analysis,
      }
    })
    .sort((a, b) => {
      let compareValue = 0

      switch (sortBy) {
        case "name":
          compareValue = (a.name || "").localeCompare(b.name || "")
          break
        case "score":
          const scoreA = a.analysisData?.data?.credito?.resposta?.score?.pontos || 0
          const scoreB = b.analysisData?.data?.credito?.resposta?.score?.pontos || 0
          compareValue = scoreA - scoreB
          break
        case "status":
          compareValue = (a.hasAnalysis ? 1 : 0) - (b.hasAnalysis ? 1 : 0)
          break
        case "date":
          const dateA = a.analysisData?.created_at ? new Date(a.analysisData.created_at).getTime() : 0
          const dateB = b.analysisData?.created_at ? new Date(b.analysisData.created_at).getTime() : 0
          compareValue = dateA - dateB
          break
      }

      return sortOrder === "asc" ? compareValue : -compareValue
    })
    .slice(0, displayLimit) // Limitar quantidade de exibição

  // Total de clientes filtrados (antes do limite)
  const totalFilteredCount = customers.filter((customer) => {
    const matchesSearch =
      customer.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      customer.document?.toLowerCase().includes(searchTerm.toLowerCase())
    const matchesCompany = filterCompany === "all" || customer.company_id === filterCompany
    const hasAnalysis = customer.recovery_score !== null || customer.analysis_metadata !== null
    const matchesStatus = filterStatus === "all" || 
      (filterStatus === "pending" && !hasAnalysis) || 
      (filterStatus === "completed" && hasAnalysis)
    return matchesSearch && matchesCompany && matchesStatus
  }).length

  const toggleSelectAll = () => {
    if (selectedCustomers.size === filteredCustomers.length) {
      setSelectedCustomers(new Set())
    } else {
      setSelectedCustomers(new Set(filteredCustomers.map((c) => c.id)))
    }
  }

  const handleRunAnalysis = async () => {
    if (selectedCustomers.size === 0) {
      toast({
        title: "Nenhum cliente selecionado",
        description: "Selecione pelo menos um cliente",
        variant: "destructive",
      })
      return
    }

    setIsRunning(true)
    let successCount = 0

    try {
      for (const customerId of selectedCustomers) {
        const customer = customers.find((c) => c.id === customerId)
        if (!customer) continue

        const tipo = customer.document.replace(/\D/g, "").length === 11 ? "pf" : "pj"
        const result = await runAsyncAssertivaAnalysis({
          documento: customer.document,
          tipo,
          customerId: customer.id,
          analysisType: "behavioral", // Análise COMPORTAMENTAL
        })

        if (result.success) {
          successCount++
        } else {
          toast({
            title: `Erro: ${customer.name}`,
            description: result.error,
            variant: "destructive",
          })
        }
      }

      toast({
        title: "Análises comportamentais enviadas",
        description: `${successCount} análise(s) em processamento. Aguarde 2-5 minutos.`,
      })

      setSelectedCustomers(new Set())
      await loadPendingAnalyses()
    } catch (error: any) {
      toast({
        title: "Erro",
        description: error.message,
        variant: "destructive",
      })
    } finally {
      setIsRunning(false)
    }
  }

  const handleViewDetails = (analysis: any) => {
    setSelectedAnalysis(analysis)
    setShowDetailsModal(true)
  }

  const renderDetailsModal = () => {
    if (!selectedAnalysis || !selectedAnalysis.data) return null

    const data = selectedAnalysis.data
    const creditoData = data.credito?.resposta || {}
    const recupereData = data.recupere?.resposta || {}
    const acoesData = data.acoes?.resposta || {}
    const localizaData = data.localiza?.resposta || data.localizaPF?.resposta || {}
    const pessoaData = localizaData.pessoa || creditoData.pessoa || {}

    return (
      <Sheet open={showDetailsModal} onOpenChange={setShowDetailsModal}>
        <SheetContent className="w-full sm:max-w-5xl overflow-y-auto bg-background px-6 sm:px-8">
          <SheetHeader className="pb-4 border-b">
            <SheetTitle className="text-2xl font-bold flex items-center gap-3">
              <div className="h-10 w-10 rounded-full bg-gradient-to-br from-yellow-500 to-orange-600 flex items-center justify-center">
                <Sparkles className="h-5 w-5 text-white" />
              </div>
              Análise 360 Completa
            </SheetTitle>
            <SheetDescription>
              {selectedAnalysis.cpf} - {new Date(selectedAnalysis.created_at).toLocaleString("pt-BR")}
            </SheetDescription>
          </SheetHeader>

          <div className="mt-6 space-y-6">
            <Tabs defaultValue="overview" className="w-full">
              <TabsList className="grid grid-cols-5 w-full">
                <TabsTrigger value="overview">Visao Geral</TabsTrigger>
                <TabsTrigger value="restricoes">Restricoes</TabsTrigger>
                <TabsTrigger value="perfil">Perfil & Contato</TabsTrigger>
                <TabsTrigger value="renda">Capacidade</TabsTrigger>
                <TabsTrigger value="json">JSON</TabsTrigger>
              </TabsList>

              {/* ABA VISAO GERAL */}
              <TabsContent value="overview" className="mt-6 space-y-6">
                {/* Scores em Destaque */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* Score de Credito */}
                  <Card className="border-2 border-blue-200 dark:border-blue-800 overflow-hidden">
                    <div className="bg-gradient-to-r from-blue-500 to-blue-600 p-4">
                      <h3 className="text-white font-semibold flex items-center gap-2">
                        <TrendingUp className="h-5 w-5" />
                        Score de Credito
                      </h3>
                    </div>
                    <CardContent className="p-6">
                      {creditoData.score ? (
                        <div className="space-y-4">
                          <div className="flex items-end gap-4">
                            <div className="text-6xl font-bold text-blue-600 dark:text-blue-400">
                              {creditoData.score.pontos}
                            </div>
                            <div className="pb-2">
                              <Badge className="bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">
                                Classe {creditoData.score.classe}
                              </Badge>
                            </div>
                          </div>
                          {creditoData.score.faixa && (
                            <div className="p-4 bg-blue-50 dark:bg-blue-950/30 rounded-lg">
                              <p className="font-semibold text-blue-700 dark:text-blue-300 mb-1">
                                {creditoData.score.faixa.titulo}
                              </p>
                              <p className="text-sm text-muted-foreground">{creditoData.score.faixa.descricao}</p>
                              {creditoData.score.faixa.probabilidade && (
                                <p className="text-xs text-blue-600 mt-2">
                                  Probabilidade: {creditoData.score.faixa.probabilidade}
                                </p>
                              )}
                            </div>
                          )}
                        </div>
                      ) : (
                        <p className="text-muted-foreground">Nao disponivel</p>
                      )}
                    </CardContent>
                  </Card>

                  {/* Score de Recuperacao */}
                  <Card className="border-2 border-orange-200 dark:border-orange-800 overflow-hidden">
                    <div className="bg-gradient-to-r from-orange-500 to-orange-600 p-4">
                      <h3 className="text-white font-semibold flex items-center gap-2">
                        <Sparkles className="h-5 w-5" />
                        Score de Recuperacao
                      </h3>
                    </div>
                    <CardContent className="p-6">
                      {recupereData.score ? (
                        <div className="space-y-4">
                          <div className="flex items-end gap-4">
                            <div className="text-6xl font-bold text-orange-600 dark:text-orange-400">
                              {recupereData.score.pontos}
                            </div>
                            <div className="pb-2">
                              <Badge className="bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200">
                                Classe {recupereData.score.classe}
                              </Badge>
                            </div>
                          </div>
                          {recupereData.score.faixa && (
                            <div className="p-4 bg-orange-50 dark:bg-orange-950/30 rounded-lg">
                              <p className="font-semibold text-orange-700 dark:text-orange-300 mb-1">
                                {recupereData.score.faixa.titulo}
                              </p>
                              <p className="text-sm text-muted-foreground">{recupereData.score.faixa.descricao}</p>
                              {recupereData.score.faixa.probabilidade && (
                                <p className="text-xs text-orange-600 mt-2">
                                  Probabilidade: {recupereData.score.faixa.probabilidade}
                                </p>
                              )}
                            </div>
                          )}
                        </div>
                      ) : (
                        <p className="text-muted-foreground">Nao disponivel</p>
                      )}
                    </CardContent>
                  </Card>
                </div>

                {/* Projecao de Recuperacao */}
                {recupereData.projecao && (
                  <Card className="border-2 border-purple-200 dark:border-purple-800">
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2 text-purple-600">
                        <Clock className="h-5 w-5" />
                        Projecao de Recuperacao
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="grid grid-cols-3 gap-4">
                        <div className="p-4 bg-purple-50 dark:bg-purple-950/30 rounded-lg text-center">
                          <p className="text-xs text-muted-foreground mb-1">30 Dias</p>
                          <p className="text-2xl font-bold text-purple-600">
                            {recupereData.projecao.dias30 || "N/A"}%
                          </p>
                        </div>
                        <div className="p-4 bg-purple-50 dark:bg-purple-950/30 rounded-lg text-center">
                          <p className="text-xs text-muted-foreground mb-1">60 Dias</p>
                          <p className="text-2xl font-bold text-purple-600">
                            {recupereData.projecao.dias60 || "N/A"}%
                          </p>
                        </div>
                        <div className="p-4 bg-purple-50 dark:bg-purple-950/30 rounded-lg text-center">
                          <p className="text-xs text-muted-foreground mb-1">90 Dias</p>
                          <p className="text-2xl font-bold text-purple-600">
                            {recupereData.projecao.dias90 || "N/A"}%
                          </p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                )}

                {/* Alertas Rapidos */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <Card className="border-l-4 border-l-red-500">
                    <CardContent className="p-4">
                      <div className="flex items-center gap-3">
                        <AlertTriangle className="h-8 w-8 text-red-500" />
                        <div>
                          <p className="text-xs text-muted-foreground">Pendencias Financ.</p>
                          <p className="text-2xl font-bold text-red-600">
                            {creditoData.registrosDebitos?.qtdDebitos || 0}
                          </p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>

                  <Card className="border-l-4 border-l-orange-500">
                    <CardContent className="p-4">
                      <div className="flex items-center gap-3">
                        <FileText className="h-8 w-8 text-orange-500" />
                        <div>
                          <p className="text-xs text-muted-foreground">Protestos</p>
                          <p className="text-2xl font-bold text-orange-600">
                            {creditoData.protestosPublicos?.qtdProtestos || 0}
                          </p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>

                  <Card className="border-l-4 border-l-yellow-500">
                    <CardContent className="p-4">
                      <div className="flex items-center gap-3">
                        <CreditCard className="h-8 w-8 text-yellow-500" />
                        <div>
                          <p className="text-xs text-muted-foreground">Cheques s/ Fundo</p>
                          <p className="text-2xl font-bold text-yellow-600">
                            {creditoData.chequesSemFundoCCF?.qtdOcorrencias || 0}
                          </p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>

                  <Card className="border-l-4 border-l-purple-500">
                    <CardContent className="p-4">
                      <div className="flex items-center gap-3">
                        <Gavel className="h-8 w-8 text-purple-500" />
                        <div>
                          <p className="text-xs text-muted-foreground">Acoes Judiciais</p>
                          <p className="text-2xl font-bold text-purple-600">
                            {acoesData.acoes?.length || acoesData.qtdAcoes || 0}
                          </p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </div>
              </TabsContent>

              {/* ABA RESTRICOES */}
              <TabsContent value="restricoes" className="mt-6 space-y-6">
                {/* Pendencias Financeiras */}
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <DollarSign className="h-5 w-5 text-red-500" />
                      Pendencias Financeiras
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {creditoData.registrosDebitos?.list?.length > 0 ? (
                      <div className="space-y-4">
                        <div className="grid grid-cols-2 gap-4">
                          <div className="p-4 bg-red-50 dark:bg-red-950/20 rounded-lg text-center">
                            <p className="text-xs text-muted-foreground mb-1">Quantidade</p>
                            <p className="text-3xl font-bold text-red-600">
                              {creditoData.registrosDebitos.qtdDebitos || 0}
                            </p>
                          </div>
                          <div className="p-4 bg-red-50 dark:bg-red-950/20 rounded-lg text-center">
                            <p className="text-xs text-muted-foreground mb-1">Valor Total</p>
                            <p className="text-2xl font-bold text-red-600">
                              {new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(
                                creditoData.registrosDebitos.valorTotal || 0
                              )}
                            </p>
                          </div>
                        </div>
                        <div className="space-y-2 max-h-64 overflow-y-auto">
                          {creditoData.registrosDebitos.list.map((debito: any, idx: number) => (
                            <div key={idx} className="p-3 border border-red-200 dark:border-red-800 rounded-lg">
                              <div className="flex justify-between items-start">
                                <div>
                                  <p className="font-medium text-sm">{debito.credor || "Credor nao informado"}</p>
                                  <p className="text-xs text-muted-foreground">{debito.tipoDevedor?.titulo || ""}</p>
                                </div>
                                <Badge variant="destructive">
                                  {new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(
                                    debito.valor || 0
                                  )}
                                </Badge>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-3 p-4 bg-green-50 dark:bg-green-950/20 rounded-lg">
                        <CheckCircle2 className="h-8 w-8 text-green-500" />
                        <div>
                          <p className="font-semibold text-green-700 dark:text-green-400">Nenhuma pendencia</p>
                          <p className="text-sm text-muted-foreground">Cliente sem registro de debitos</p>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* Protestos */}
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <AlertTriangle className="h-5 w-5 text-orange-500" />
                      Protestos
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {creditoData.protestosPublicos?.qtdProtestos > 0 ? (
                      <div className="space-y-4">
                        <div className="grid grid-cols-2 gap-4">
                          <div className="p-4 bg-orange-50 dark:bg-orange-950/20 rounded-lg text-center">
                            <p className="text-xs text-muted-foreground mb-1">Quantidade</p>
                            <p className="text-3xl font-bold text-orange-600">
                              {creditoData.protestosPublicos.qtdProtestos}
                            </p>
                          </div>
                          <div className="p-4 bg-orange-50 dark:bg-orange-950/20 rounded-lg text-center">
                            <p className="text-xs text-muted-foreground mb-1">Valor Total</p>
                            <p className="text-2xl font-bold text-orange-600">
                              {new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(
                                Number.parseFloat(creditoData.protestosPublicos.valorTotal) || 0
                              )}
                            </p>
                          </div>
                        </div>
                        {creditoData.protestosPublicos.list?.length > 0 && (
                          <div className="space-y-2 max-h-64 overflow-y-auto">
                            {creditoData.protestosPublicos.list.map((protesto: any, idx: number) => (
                              <div key={idx} className="p-3 border border-orange-200 dark:border-orange-800 rounded-lg">
                                <div className="flex justify-between items-start">
                                  <div>
                                    <p className="font-medium text-sm">{protesto.cartorio}</p>
                                    <p className="text-xs text-muted-foreground">
                                      {protesto.cidade} - {protesto.uf}
                                    </p>
                                  </div>
                                  <Badge variant="outline" className="border-orange-500 text-orange-600">
                                    {new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(
                                      protesto.valor
                                    )}
                                  </Badge>
                                </div>
                                <p className="text-xs text-muted-foreground mt-1">Data: {protesto.data}</p>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="flex items-center gap-3 p-4 bg-green-50 dark:bg-green-950/20 rounded-lg">
                        <CheckCircle2 className="h-8 w-8 text-green-500" />
                        <div>
                          <p className="font-semibold text-green-700 dark:text-green-400">Nenhum protesto</p>
                          <p className="text-sm text-muted-foreground">Cliente sem registro de protestos</p>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* Cheques sem Fundo */}
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <CreditCard className="h-5 w-5 text-yellow-500" />
                      Cheques sem Fundo (CCF)
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {creditoData.chequesSemFundoCCF?.qtdOcorrencias > 0 ? (
                      <div className="grid grid-cols-2 gap-4">
                        <div className="p-4 bg-yellow-50 dark:bg-yellow-950/20 rounded-lg text-center">
                          <p className="text-xs text-muted-foreground mb-1">Quantidade</p>
                          <p className="text-3xl font-bold text-yellow-600">
                            {creditoData.chequesSemFundoCCF.qtdOcorrencias}
                          </p>
                        </div>
                        <div className="p-4 bg-yellow-50 dark:bg-yellow-950/20 rounded-lg text-center">
                          <p className="text-xs text-muted-foreground mb-1">Status</p>
                          <Badge variant="destructive">Com Ocorrencias</Badge>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-3 p-4 bg-green-50 dark:bg-green-950/20 rounded-lg">
                        <CheckCircle2 className="h-8 w-8 text-green-500" />
                        <div>
                          <p className="font-semibold text-green-700 dark:text-green-400">Nenhum cheque sem fundo</p>
                          <p className="text-sm text-muted-foreground">Cliente sem registro de cheques devolvidos</p>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* Acoes Judiciais */}
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Gavel className="h-5 w-5 text-purple-500" />
                      Acoes Judiciais
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {(acoesData.acoes?.length > 0 || acoesData.qtdAcoes > 0) ? (
                      <div className="space-y-4">
                        <div className="p-4 bg-purple-50 dark:bg-purple-950/20 rounded-lg text-center">
                          <p className="text-xs text-muted-foreground mb-1">Quantidade</p>
                          <p className="text-3xl font-bold text-purple-600">
                            {acoesData.acoes?.length || acoesData.qtdAcoes || 0}
                          </p>
                        </div>
                        {acoesData.acoes?.length > 0 && (
                          <div className="space-y-2 max-h-64 overflow-y-auto">
                            {acoesData.acoes.map((acao: any, idx: number) => (
                              <div key={idx} className="p-3 border border-purple-200 dark:border-purple-800 rounded-lg">
                                <div className="flex justify-between items-start">
                                  <div>
                                    <p className="font-medium text-sm">{acao.tipoAcao || acao.tipo || "Acao judicial"}</p>
                                    <p className="text-xs text-muted-foreground">{acao.vara || acao.tribunal || ""}</p>
                                  </div>
                                  <Badge variant="outline" className="border-purple-500 text-purple-600">
                                    {acao.status || "Em andamento"}
                                  </Badge>
                                </div>
                                {acao.valor && (
                                  <p className="text-sm font-semibold text-purple-600 mt-2">
                                    {new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(
                                      acao.valor
                                    )}
                                  </p>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="flex items-center gap-3 p-4 bg-green-50 dark:bg-green-950/20 rounded-lg">
                        <CheckCircle2 className="h-8 w-8 text-green-500" />
                        <div>
                          <p className="font-semibold text-green-700 dark:text-green-400">Nenhuma acao judicial</p>
                          <p className="text-sm text-muted-foreground">Cliente sem registro de acoes</p>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              {/* ABA PERFIL & CONTATO */}
              <TabsContent value="perfil" className="mt-6 space-y-6">
                {/* Dados Pessoais */}
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Users className="h-5 w-5" />
                      Dados Pessoais
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="p-4 bg-muted/50 rounded-lg">
                        <p className="text-xs text-muted-foreground mb-1">NOME COMPLETO</p>
                        <p className="font-semibold">{pessoaData.nome || localizaData.nome || selectedAnalysis.cpf}</p>
                      </div>
                      <div className="p-4 bg-muted/50 rounded-lg">
                        <p className="text-xs text-muted-foreground mb-1">CPF</p>
                        <p className="font-semibold font-mono">{selectedAnalysis.cpf}</p>
                      </div>
                      {pessoaData.dataNascimento && (
                        <div className="p-4 bg-muted/50 rounded-lg">
                          <p className="text-xs text-muted-foreground mb-1">DATA DE NASCIMENTO</p>
                          <p className="font-semibold flex items-center gap-2">
                            <Calendar className="h-4 w-4" />
                            {pessoaData.dataNascimento}
                          </p>
                        </div>
                      )}
                      {pessoaData.sexo && (
                        <div className="p-4 bg-muted/50 rounded-lg">
                          <p className="text-xs text-muted-foreground mb-1">SEXO</p>
                          <p className="font-semibold">{pessoaData.sexo === "M" ? "Masculino" : "Feminino"}</p>
                        </div>
                      )}
                      <div className="p-4 bg-muted/50 rounded-lg">
                        <p className="text-xs text-muted-foreground mb-1">SITUACAO CPF</p>
                        <Badge variant={pessoaData.situacaoCpf === "REGULAR" ? "default" : "destructive"}>
                          {pessoaData.situacaoCpf || "Nao informado"}
                        </Badge>
                      </div>
                      <div className="p-4 bg-muted/50 rounded-lg">
                        <p className="text-xs text-muted-foreground mb-1">OBITO</p>
                        <Badge variant={pessoaData.obito ? "destructive" : "default"}>
                          {pessoaData.obito ? "Sim" : "Nao"}
                        </Badge>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                {/* Endereco */}
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <MapPin className="h-5 w-5 text-blue-500" />
                      Endereco
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {(creditoData.endereco || localizaData.endereco) ? (
                      <div className="space-y-3">
                        {(Array.isArray(creditoData.endereco) ? creditoData.endereco : [creditoData.endereco || localizaData.endereco]).filter(Boolean).map((end: any, idx: number) => (
                          <div key={idx} className="p-4 bg-blue-50 dark:bg-blue-950/20 rounded-lg">
                            <p className="font-medium">
                              {end.logradouro || end.endereco}, {end.numero} {end.complemento && `- ${end.complemento}`}
                            </p>
                            <p className="text-sm text-muted-foreground">
                              {end.bairro} - {end.cidade || end.municipio}/{end.uf} - CEP: {end.cep}
                            </p>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-muted-foreground">Endereco nao disponivel</p>
                    )}
                  </CardContent>
                </Card>

                {/* Telefones */}
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Phone className="h-5 w-5 text-green-500" />
                      Telefones
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {(creditoData.telefones || localizaData.telefones) ? (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        {(Array.isArray(creditoData.telefones) ? creditoData.telefones : Array.isArray(localizaData.telefones) ? localizaData.telefones : []).map((tel: any, idx: number) => (
                          <div key={idx} className="p-3 bg-green-50 dark:bg-green-950/20 rounded-lg flex items-center gap-3">
                            <Phone className="h-4 w-4 text-green-600" />
                            <span className="font-medium">({tel.ddd}) {tel.numero || tel.telefone}</span>
                            {tel.ranking && <Badge variant="secondary">#{tel.ranking}</Badge>}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-muted-foreground">Nenhum telefone disponivel</p>
                    )}
                  </CardContent>
                </Card>

                {/* E-mails */}
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Mail className="h-5 w-5 text-purple-500" />
                      E-mails
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {(creditoData.emails || localizaData.emails) ? (
                      <div className="space-y-2">
                        {(Array.isArray(creditoData.emails) ? creditoData.emails : Array.isArray(localizaData.emails) ? localizaData.emails : []).map((email: any, idx: number) => (
                          <div key={idx} className="p-3 bg-purple-50 dark:bg-purple-950/20 rounded-lg flex items-center justify-between">
                            <span className="font-medium">{email.email || email}</span>
                            {email.ranking && <Badge variant="secondary">#{email.ranking}</Badge>}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-muted-foreground">Nenhum e-mail disponivel</p>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              {/* ABA CAPACIDADE DE PAGAMENTO */}
              <TabsContent value="renda" className="mt-6 space-y-6">
                {/* Renda Presumida */}
                <Card className="border-2 border-green-200 dark:border-green-800">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-green-600">
                      <DollarSign className="h-5 w-5" />
                      {creditoData.faturamentoEstimado ? "Faturamento Estimado" : "Renda Presumida"}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {(creditoData.faturamentoEstimado || creditoData.rendaPresumida) ? (
                      <div className="space-y-4">
                        <div className="text-5xl font-bold text-green-600 dark:text-green-400">
                          {new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(
                            creditoData.faturamentoEstimado?.valor || creditoData.rendaPresumida?.valor || 0
                          )}
                        </div>
                        {creditoData.rendaPresumida && (
                          <div className="grid grid-cols-3 gap-4 mt-4">
                            <div className="p-4 bg-green-50 dark:bg-green-950/20 rounded-lg text-center">
                              <p className="text-xs text-muted-foreground mb-1">Faixa</p>
                              <p className="font-semibold">{creditoData.rendaPresumida.faixa || "N/A"}</p>
                            </div>
                            <div className="p-4 bg-green-50 dark:bg-green-950/20 rounded-lg text-center">
                              <p className="text-xs text-muted-foreground mb-1">Minimo</p>
                              <p className="font-semibold">
                                {creditoData.rendaPresumida.valorMinimo
                                  ? new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(
                                      creditoData.rendaPresumida.valorMinimo
                                    )
                                  : "N/A"}
                              </p>
                            </div>
                            <div className="p-4 bg-green-50 dark:bg-green-950/20 rounded-lg text-center">
                              <p className="text-xs text-muted-foreground mb-1">Maximo</p>
                              <p className="font-semibold">
                                {creditoData.rendaPresumida.valorMaximo
                                  ? new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(
                                      creditoData.rendaPresumida.valorMaximo
                                    )
                                  : "N/A"}
                              </p>
                            </div>
                          </div>
                        )}
                      </div>
                    ) : (
                      <p className="text-muted-foreground">Informacao nao disponivel</p>
                    )}
                  </CardContent>
                </Card>

                {/* Participacao em Empresas */}
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Briefcase className="h-5 w-5 text-yellow-500" />
                      Participacao em Empresas
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {creditoData.participacaoSocietaria?.length > 0 ? (
                      <div className="space-y-4">
                        <div className="p-4 bg-yellow-50 dark:bg-yellow-950/20 rounded-lg text-center">
                          <p className="text-xs text-muted-foreground mb-1">Quantidade</p>
                          <p className="text-3xl font-bold text-yellow-600">
                            {creditoData.participacaoSocietaria.length}
                          </p>
                        </div>
                        <div className="space-y-2 max-h-64 overflow-y-auto">
                          {creditoData.participacaoSocietaria.map((empresa: any, idx: number) => (
                            <div key={idx} className="p-4 bg-yellow-50 dark:bg-yellow-950/20 rounded-lg">
                              <p className="font-bold">{empresa.nomeEmpresarial || empresa.razaoSocial}</p>
                              <p className="text-sm text-muted-foreground">CNPJ: {empresa.cnpj}</p>
                              <p className="text-sm text-muted-foreground">
                                Participacao: {empresa.participacao || empresa.percentualParticipacao}%
                              </p>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-3 p-4 bg-muted/50 rounded-lg">
                        <Building2 className="h-8 w-8 text-muted-foreground" />
                        <div>
                          <p className="font-semibold">Nenhuma participacao</p>
                          <p className="text-sm text-muted-foreground">Cliente sem participacao societaria</p>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* Ultimas Consultas */}
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <FileText className="h-5 w-5" />
                      Ultimas Consultas ({creditoData.ultimasConsultas?.qtdUltConsultas || 0})
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {creditoData.ultimasConsultas?.list?.length > 0 ? (
                      <div className="space-y-2 max-h-64 overflow-y-auto">
                        {creditoData.ultimasConsultas.list.slice(0, 10).map((consulta: any, idx: number) => (
                          <div key={idx} className="flex justify-between items-center p-3 bg-muted/50 rounded-lg">
                            <div>
                              <p className="font-medium text-sm">{consulta.dataOcorrencia}</p>
                              <p className="text-xs text-muted-foreground">Consulta realizada</p>
                            </div>
                            <Badge variant="secondary">#{idx + 1}</Badge>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="flex items-center gap-3 p-4 bg-muted/50 rounded-lg">
                        <FileText className="h-8 w-8 text-muted-foreground" />
                        <div>
                          <p className="font-semibold">Nenhuma consulta</p>
                          <p className="text-sm text-muted-foreground">Sem registro de consultas</p>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              {/* ABA JSON */}
              <TabsContent value="json" className="mt-6">
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <FileText className="h-5 w-5" />
                      Dados Completos (JSON)
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <pre className="bg-muted p-4 rounded-lg text-xs overflow-x-auto max-h-[500px] overflow-y-auto">
                      {JSON.stringify(data, null, 2)}
                    </pre>
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          </div>
        </SheetContent>
      </Sheet>
    )
  }

  const handleSort = (field: "name" | "score" | "status" | "date") => {
    if (sortBy === field) {
      setSortOrder(sortOrder === "asc" ? "desc" : "asc")
    } else {
      setSortBy(field)
      setSortOrder("asc")
    }
  }

  return (
    <div className="container mx-auto py-8 space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Análise 360</h1>
        <p className="text-muted-foreground mt-1">Visão completa: crédito + comportamental + propensão de pagamento com IA preditiva</p>
      </div>

      <div className="flex flex-col sm:flex-row gap-4">
        <Input
          placeholder="Buscar por nome ou CPF..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="max-w-sm"
        />
        <div className="flex gap-2">
          <Button variant="outline" size="default" onClick={toggleSelectAll} className="gap-2 border-2 bg-transparent">
            {selectedCustomers.size === filteredCustomers.length && filteredCustomers.length > 0 ? (
              <>
                <CheckSquare className="h-4 w-4" />
                Desmarcar Todos
              </>
            ) : (
              <>
                <Square className="h-4 w-4" />
                Selecionar Todos ({filteredCustomers.length})
              </>
            )}
          </Button>
          <Select value={filterCompany} onValueChange={setFilterCompany}>
            <SelectTrigger className="w-[200px]">
              <SelectValue placeholder="Todas as empresas" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas as empresas</SelectItem>
              {companies.map((company) => (
                <SelectItem key={company.id} value={company.id}>
                  {company.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Filtros adicionais para facilitar processamento em lotes */}
      <div className="flex flex-wrap gap-2 items-center">
        <span className="text-sm text-muted-foreground">Filtros:</span>
        
        <Select value={filterStatus} onValueChange={setFilterStatus}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Status da análise" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos os status</SelectItem>
            <SelectItem value="pending">Sem Análise</SelectItem>
            <SelectItem value="completed">Com Análise</SelectItem>
          </SelectContent>
        </Select>

        <Select value={String(displayLimit)} onValueChange={(v) => setDisplayLimit(Number(v))}>
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder="Exibir..." />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="50">Exibir 50</SelectItem>
            <SelectItem value="100">Exibir 100</SelectItem>
            <SelectItem value="200">Exibir 200</SelectItem>
            <SelectItem value="500">Exibir 500</SelectItem>
            <SelectItem value="99999">Exibir Todos</SelectItem>
          </SelectContent>
        </Select>

        <span className="text-sm text-muted-foreground ml-2">
          Mostrando {filteredCustomers.length} de {totalFilteredCount} clientes
        </span>
      </div>

      <div className="flex gap-2">
        <Button
          variant={sortBy === "name" ? "default" : "outline"}
          onClick={() => handleSort("name")}
          className="gap-2"
        >
          Nome
          {sortBy === "name" && (sortOrder === "asc" ? " ↑" : " ↓")}
        </Button>
        <Button
          variant={sortBy === "score" ? "default" : "outline"}
          onClick={() => handleSort("score")}
          className="gap-2"
        >
          Score
          {sortBy === "score" && (sortOrder === "asc" ? " ↑" : " ↓")}
        </Button>
        <Button
          variant={sortBy === "status" ? "default" : "outline"}
          onClick={() => handleSort("status")}
          className="gap-2"
        >
          Status
          {sortBy === "status" && (sortOrder === "asc" ? " ↑" : " ↓")}
        </Button>
        <Button
          variant={sortBy === "date" ? "default" : "outline"}
          onClick={() => handleSort("date")}
          className="gap-2"
        >
          Data
          {sortBy === "date" && (sortOrder === "asc" ? " ↑" : " ↓")}
        </Button>
      </div>

      {selectedCustomers.size > 0 && (
        <Card className="border-2 border-yellow-300 bg-gradient-to-br from-yellow-50 to-white shadow-xl">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4 flex-1">
                <div className="p-3 rounded-xl bg-gradient-to-br from-yellow-500 to-yellow-600">
                  <Sparkles className="h-8 w-8 text-white" />
                </div>
                <div>
                  <h3 className="text-xl font-bold">Análise Comportamental Assertiva</h3>
                  <p className="text-sm text-muted-foreground">
                    {selectedCustomers.size} cliente{selectedCustomers.size > 1 ? "s" : ""} selecionado
                    {selectedCustomers.size > 1 ? "s" : ""}
                  </p>
                </div>
              </div>
              <Button
                size="lg"
                onClick={handleRunAnalysis}
                disabled={isRunning}
                className="gap-2 bg-gradient-to-r from-yellow-500 to-yellow-600 hover:from-yellow-600 hover:to-yellow-700"
              >
                {isRunning ? (
                  <>
                    <Loader2 className="h-5 w-5 animate-spin" />
                    Processando...
                  </>
                ) : (
                  <>
                    <Sparkles className="h-5 w-5" />
                    Executar Análise ({selectedCustomers.size})
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="space-y-3">
        {loading ? (
          <Card>
            <CardContent className="p-12 text-center">
              <Loader2 className="h-8 w-8 animate-spin mx-auto mb-4 text-primary" />
              <p className="text-muted-foreground">Carregando clientes...</p>
            </CardContent>
          </Card>
        ) : filteredCustomers.length === 0 ? (
          <Card>
            <CardContent className="p-12 text-center">
              <AlertCircle className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
              <p className="text-lg font-medium mb-2">Nenhum cliente encontrado</p>
              <p className="text-sm text-muted-foreground">Tente ajustar os filtros ou fazer uma nova busca</p>
            </CardContent>
          </Card>
        ) : (
          filteredCustomers.map((customer) => (
            <Card key={customer.id} className="hover:shadow-md transition-shadow">
              <CardContent className="p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-start gap-3 flex-1">
                    <Checkbox
                      checked={selectedCustomers.has(customer.id)}
                      onCheckedChange={(checked) => {
                        const newSet = new Set(selectedCustomers)
                        if (checked) {
                          newSet.add(customer.id)
                        } else {
                          newSet.delete(customer.id)
                        }
                        setSelectedCustomers(newSet)
                      }}
                      className="mt-1 h-6 w-6 border-2 border-gray-400"
                    />
                    <div className="flex-1">
                      <h3 className="font-semibold text-base">{customer.name}</h3>
                      <p className="text-sm text-muted-foreground">{customer.document}</p>
                      {customer.company_name && (
                        <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                          <Building2 className="h-3 w-3" />
                          {customer.company_name}
                        </p>
                      )}
                    </div>
                  </div>

                  {customer.hasAnalysis && customer.analysisData?.data && (
                    <div className="flex items-center gap-3">
                      <div className="flex gap-3 text-right">
                        {(customer.analysisData.data.recupere?.resposta?.score ||
                          customer.analysisData.score_assertiva ||
                          customer.analysisData.score) && (
                          <div>
                            <p className="text-xs text-muted-foreground">Recuperação</p>
                            <div className="flex items-center gap-1">
                              <span className="text-xl font-bold text-yellow-600">
                                {customer.analysisData.data.recupere?.resposta?.score?.pontos ||
                                  customer.analysisData.score_assertiva ||
                                  customer.analysisData.score ||
                                  0}
                              </span>
                              <Badge variant="outline" className="text-xs">
                                {customer.analysisData.data.recupere?.resposta?.score?.classe || "N/A"}
                              </Badge>
                            </div>
                          </div>
                        )}
                        {(customer.analysisData.data.credito?.resposta?.score ||
                          customer.analysisData.score_assertiva ||
                          customer.analysisData.score) && (
                          <div>
                            <p className="text-xs text-muted-foreground">Crédito</p>
                            <div className="flex items-center gap-1">
                              <span className="text-xl font-bold text-blue-600">
                                {customer.analysisData.data.credito?.resposta?.score?.pontos ||
                                  customer.analysisData.score_assertiva ||
                                  customer.analysisData.score ||
                                  0}
                              </span>
                              <Badge variant="outline" className="text-xs">
                                {customer.analysisData.data.credito?.resposta?.score?.classe || "N/A"}
                              </Badge>
                            </div>
                          </div>
                        )}
                      </div>
                      <Badge className="bg-green-500">
                        <CheckCircle2 className="h-3 w-3 mr-1" />
                        Completo
                      </Badge>
                      <Button size="sm" onClick={() => handleViewDetails(customer.analysisData)} className="gap-2">
                        <Eye className="h-4 w-4" />
                        Ver Detalhes
                      </Button>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>

      {renderDetailsModal()}
    </div>
  )
}
