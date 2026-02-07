"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
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
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Separator } from "@/components/ui/separator"
import {
  AlertCircle,
  Sparkles,
  Loader2,
  Eye,
  Building2,
  FileText,
  AlertTriangle,
  TrendingUp,
  Download,
  DollarSign,
  CreditCard,
  Shield,
  Check,
  CheckCircle2,
  Clock,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Square,
  CheckSquare,
} from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { runAssertivaManualAnalysis, getAllCompanies } from "@/app/actions/credit-actions"
import { getAllCustomers } from "@/app/actions/analyses-actions"

interface CreditAnalysis {
  id: string
  customer_id: string
  company_id: string
  cpf: string
  score: number | null
  source: string
  analysis_type: string
  status: string
  created_at: string
  customer_name?: string
  company_name?: string
  data?: any
  assertiva_data?: any // Added assertiva_data to the interface
}

type SortField = "name" | "score" | "status" | "date"
type SortDirection = "asc" | "desc"

export default function AnalysesPage() {
  const [analyses, setAnalyses] = useState<CreditAnalysis[]>([])
  const [companies, setCompanies] = useState<{ id: string; name: string }[]>([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState("")
  const [filterCompany, setFilterCompany] = useState<string>("all") // Renamed from filterCompany to filterCompany
  const [selectedCustomers, setSelectedCustomers] = useState<Set<string>>(new Set())
  const [showConfirmModal, setShowConfirmModal] = useState(false)
  const [isRunningAnalysis, setIsRunningAnalysis] = useState(false)
  const [selectedAnalysis, setSelectedAnalysis] = useState<CreditAnalysis | null>(null)
  const [showDetailsDrawer, setShowDetailsDrawer] = useState(false)
  const [sortField, setSortField] = useState<SortField>("date")
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc")
  const [filterStatus, setFilterStatus] = useState<string>("all") // "all", "pending", "completed"
  const [displayLimit, setDisplayLimit] = useState<number>(100) // Limite de exibição
  const { toast } = useToast()

  // Helper for currency formatting
  const newIntl = typeof window !== "undefined" ? window.Intl : null

  useEffect(() => {
    loadAnalyses()
    loadCompanies()
  }, [])

  const loadCompanies = async () => {
    try {
      const response = await getAllCompanies()
      if (response.success) {
        setCompanies(response.data)
      }
    } catch (error) {
      console.error("Error loading companies:", error)
    }
  }

  const loadAnalyses = async () => {
    try {
      setLoading(true)

      const response = await getAllCustomers()

      if (response.success) {
        const mappedData = response.data.map((customer: any) => {
          // Usar dados restritivos se existir, senão analysis_metadata (compatibilidade)
          const assertiva_data = customer.restrictive_analysis_logs || customer.analysis_metadata || null
          const analysisDate = customer.restrictive_analysis_date || customer.last_analysis_date

          let displayScore = customer.credit_score

          if (displayScore === 0) {
            displayScore = 5
          }

          // Verificar se tem análise RESTRITIVA
          const hasAnalysis = (customer.restrictive_analysis_logs || customer.analysis_metadata) && analysisDate
          const status = hasAnalysis ? "completed" : "pending"

          return {
            id: customer.id,
            customer_id: customer.id,
            company_id: customer.company_id,
            cpf: customer.document,
            score: displayScore,
            source: customer.source_table,
            analysis_type: hasAnalysis ? "detailed" : "pending",
            status,
            created_at: analysisDate || customer.created_at,
            customer_name: customer.name,
            company_name: customer.company_name,
            assertiva_data,
          }
        })

        setAnalyses(mappedData)
      } else {
        toast({
          title: "Erro ao carregar clientes",
          description: response.error,
          variant: "destructive",
        })
      }
    } catch (error: any) {
      toast({
        title: "Erro ao carregar clientes",
        description: error.message,
        variant: "destructive",
      })
    } finally {
      setLoading(false)
    }
  }

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc")
    } else {
      setSortField(field)
      setSortDirection("asc")
    }
  }

  const getSortIcon = (field: SortField) => {
    if (sortField !== field) return <ArrowUpDown className="h-4 w-4 ml-1" />
    return sortDirection === "asc" ? <ArrowUp className="h-4 w-4 ml-1" /> : <ArrowDown className="h-4 w-4 ml-1" />
  }

  const filteredAnalyses = analyses
    .filter((analysis) => {
      const matchesSearch =
        analysis.customer_name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        analysis.cpf?.toLowerCase().includes(searchTerm.toLowerCase())
      const matchesCompany = filterCompany === "all" || analysis.company_id === filterCompany
      const matchesStatus = filterStatus === "all" || analysis.status === filterStatus
      return matchesSearch && matchesCompany && matchesStatus
    })
    .sort((a, b) => {
      const direction = sortDirection === "asc" ? 1 : -1
      switch (sortField) {
        case "name":
          return direction * (a.customer_name || "").localeCompare(b.customer_name || "")
        case "score":
          return direction * ((a.score || 0) - (b.score || 0))
        case "status":
          return direction * (a.status || "").localeCompare(b.status || "")
        case "date":
          // Use created_at for sorting, which should be more reliable than last_analysis_date for order
          const dateA = new Date(a.created_at || "1970-01-01T00:00:00Z")
          const dateB = new Date(b.created_at || "1970-01-01T00:00:00Z")
          return direction * (dateA.getTime() - dateB.getTime())
        default:
          return 0
      }
    })
    .slice(0, displayLimit) // Limitar quantidade de exibição

  const totalFilteredCount = analyses.filter((analysis) => {
    const matchesSearch =
      analysis.customer_name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      analysis.cpf?.toLowerCase().includes(searchTerm.toLowerCase())
    const matchesCompany = filterCompany === "all" || analysis.company_id === filterCompany
    const matchesStatus = filterStatus === "all" || analysis.status === filterStatus
    return matchesSearch && matchesCompany && matchesStatus
  }).length

  const getSourceBadge = (source: string) => {
    return <Badge variant="default">Análise Restritiva</Badge>
  }

  const getScoreBadgeColor = (score: number | null) => {
    if (!score) return "bg-gray-500"
    // Adjusted score mapping for badges
    if (score >= 700) return "bg-green-500" // Good
    if (score >= 500) return "bg-blue-500" // Fair
    if (score >= 300) return "bg-yellow-500" // Caution
    if (score >= 100) return "bg-orange-500" // Risky
    return "bg-red-500" // Very Risky
  }

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "completed":
        return (
          <Badge className="bg-green-500">
            <CheckCircle2 className="h-3 w-3 mr-1" />
            Completo
          </Badge>
        )
      case "pending":
        return (
          <Badge variant="outline" className="border-yellow-500 text-yellow-600">
            <Clock className="h-3 w-3 mr-1" />
            Pendente
          </Badge>
        )
      case "failed":
        return (
          <Badge variant="destructive">
            <AlertTriangle className="h-3 w-3 mr-1" />
            Falhou
          </Badge>
        )
      default:
        return <Badge variant="secondary">{status}</Badge>
    }
  }

  const stats = {
    total: analyses.length,
    completed: analyses.filter((a) => a.status === "completed").length,
    pending: analyses.filter((a) => a.status === "pending").length,
  }

  // Renamed from toggleCustomerSelection to toggleSelection
  const toggleSelection = (customerId: string) => {
    const newSet = new Set(selectedCustomers)
    if (newSet.has(customerId)) {
      newSet.delete(customerId)
    } else {
      newSet.add(customerId)
    }
    setSelectedCustomers(newSet)
  }

  // Renamed from toggleSelectAll to toggleSelectAll
  const toggleSelectAll = () => {
    if (selectedCustomers.size === filteredAnalyses.length) {
      setSelectedCustomers(new Set())
    } else {
      setSelectedCustomers(new Set(filteredAnalyses.map((a) => a.id)))
    }
  }

  // Renamed from handleRunAssertivaAnalysis to handleRunAnalysis
  const handleRunAnalysis = async () => {
    if (selectedCustomers.size === 0) {
      toast({
        title: "Nenhum cliente selecionado",
        description: "Selecione pelo menos um cliente para análise",
        variant: "destructive",
      })
      return
    }

    setShowConfirmModal(false)
    setIsRunningAnalysis(true)

    try {
      const customerIds = Array.from(selectedCustomers)
      const result = await runAssertivaManualAnalysis(customerIds)

      if (result.success) {
        toast({
          title: "Análise Concluída",
          description: `${result.analyzed} cliente(s) analisado(s) com sucesso`,
        })
        await loadAnalyses()
        setSelectedCustomers(new Set())
      } else {
        throw new Error(result.error || "Erro desconhecido")
      }
    } catch (error: any) {
      toast({
        title: "Erro",
        description: error.message || "Falha ao executar análises",
        variant: "destructive",
      })
    } finally {
      setIsRunningAnalysis(false)
    }
  }

  // Renamed from handleRowClick to handleViewDetails
  const handleViewDetails = (analysis: CreditAnalysis) => {
    setSelectedAnalysis(analysis)
    setShowDetailsDrawer(true)
  }

  const exportToPDF = async (customer: any) => {
    if (!customer) return

    try {
      const response = await fetch("/api/export-customer-pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId: customer.id }),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || "Falha ao gerar PDF")
      }

      const { html } = await response.json()

      const printWindow = window.open("", "_blank")
      if (!printWindow) {
        throw new Error("Popup bloqueado. Permita popups para exportar PDF.")
      }

      printWindow.document.write(html)
      printWindow.document.close()

      printWindow.onload = () => {
        printWindow.print()
      }

      toast({
        title: "PDF gerado com sucesso!",
        description: `Relatório de ${customer.name} pronto para download`,
      })
    } catch (error: any) {
      console.error("[v0] exportToPDF - Error:", error.message)
      toast({
        title: "Erro ao gerar PDF",
        description: error.message,
        variant: "destructive",
      })
    }
  }

  const getScoreColor = (score: number | null) => {
    if (!score) return "text-gray-500"
    const adjustedScore = score === 0 ? 5 : score // Adjust score 0 to 5
    if (adjustedScore >= 700) return "text-green-600 dark:text-green-400"
    if (adjustedScore >= 500) return "text-yellow-600 dark:text-yellow-400"
    return "text-red-600 dark:text-red-400"
  }

  const formatDate = (dateString: string) => {
    // Ensure dateString is valid before creating a Date object
    if (!dateString) return "Data Inválida"
    try {
      const date = new Date(dateString)
      // Check if the date is valid
      if (isNaN(date.getTime())) {
        return "Data Inválida"
      }
      return date.toLocaleDateString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    } catch (error) {
      console.error("Error formatting date:", dateString, error)
      return "Erro ao formatar"
    }
  }

  // Helper to get the displayed score, converting 0 to 5
  const getDisplayedScore = (score: number | null | undefined): number | string => {
    if (score === null || score === undefined) return "N/A"
    return score === 0 ? 5 : score
  }

  // Placeholder for the missing viewAnalysis function
  const viewAnalysis = (analysisId: string) => {
    const analysis = analyses.find((a) => a.id === analysisId)
    if (analysis) {
      setSelectedAnalysis(analysis)
      setShowDetailsDrawer(true)
    } else {
      toast({
        title: "Erro ao visualizar análise",
        description: "Análise não encontrada.",
        variant: "destructive",
      })
    }
  }

  return (
    <div className="w-full space-y-6 overflow-x-hidden">
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Análise de Crédito</h1>
            <p className="text-muted-foreground mt-1">Visualize e gerencie todas as análises de crédito realizadas</p>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row gap-4 items-stretch sm:items-center">
          <div className="flex-1">
            <Input
              placeholder="Buscar por nome ou CPF..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="max-w-sm"
            />
          </div>

          <div className="flex gap-2 items-center">
            <Button
              variant="outline"
              size="default"
              onClick={toggleSelectAll}
              className="gap-2 border-2 hover:border-primary bg-transparent"
            >
              {selectedCustomers.size === filteredAnalyses.length && filteredAnalyses.length > 0 ? (
                <>
                  <CheckSquare className="h-4 w-4" />
                  Desmarcar Todos
                </>
              ) : (
                <>
                  <Square className="h-4 w-4" />
                  Selecionar Todos ({filteredAnalyses.length})
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
            Mostrando {filteredAnalyses.length} de {totalFilteredCount} clientes
          </span>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            variant={sortField === "name" ? "default" : "outline"}
            size="sm"
            onClick={() => handleSort("name")}
            className="text-xs"
          >
            Nome {getSortIcon("name")}
          </Button>
          <Button
            variant={sortField === "score" ? "default" : "outline"}
            size="sm"
            onClick={() => handleSort("score")}
            className="text-xs"
          >
            Score {getSortIcon("score")}
          </Button>
          <Button
            variant={sortField === "status" ? "default" : "outline"}
            size="sm"
            onClick={() => handleSort("status")}
            className="text-xs"
          >
            Status {getSortIcon("status")}
          </Button>
          <Button
            variant={sortField === "date" ? "default" : "outline"}
            size="sm"
            onClick={() => handleSort("date")}
            className="text-xs"
          >
            Data {getSortIcon("date")}
          </Button>
        </div>
      </div>

      {selectedCustomers.size > 0 && (
        <Card className="border-2 border-yellow-300 dark:border-yellow-700 bg-gradient-to-br from-yellow-50 to-white dark:from-yellow-950/20 dark:to-gray-900 shadow-xl">
          <CardContent className="pt-6">
            <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
              <div className="flex items-center gap-4">
                <div className="p-3 rounded-xl bg-gradient-to-br from-yellow-500 to-yellow-600 shadow-lg">
                  <Sparkles className="h-8 w-8 text-white" />
                </div>
                <div>
                  {/* Renomeando "Análise de Crédito" para "Análise Restritiva" */}
                  <h3 className="text-xl font-bold text-foreground">Análise Restritiva com Assertiva</h3>
                  <p className="text-sm text-muted-foreground">
                    {selectedCustomers.size} cliente{selectedCustomers.size > 1 ? "s" : ""} selecionado
                    {selectedCustomers.size > 1 ? "s" : ""}
                  </p>
                </div>
              </div>
              <Button
                size="lg"
                onClick={() => setShowConfirmModal(true)}
                disabled={isRunningAnalysis}
                className="gap-2 bg-gradient-to-r from-yellow-500 to-yellow-600 hover:from-yellow-600 hover:to-yellow-700 text-white shadow-lg hover:shadow-xl transition-all"
              >
                {isRunningAnalysis ? (
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
              <p className="text-muted-foreground">Carregando análises...</p>
            </CardContent>
          </Card>
        ) : filteredAnalyses.length === 0 ? (
          <Card>
            <CardContent className="p-12 text-center">
              <AlertCircle className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
              <p className="text-lg font-medium mb-2">Nenhuma análise encontrada</p>
              <p className="text-sm text-muted-foreground">Tente ajustar os filtros ou fazer uma nova busca</p>
            </CardContent>
          </Card>
        ) : (
          filteredAnalyses.map((analysis) => (
            <Card key={analysis.id} className="hover:shadow-md transition-shadow">
              <CardContent className="p-4">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start gap-3">
                      <Checkbox
                        checked={selectedCustomers.has(analysis.customer_id)}
                        onCheckedChange={(checked) => {
                          const newSet = new Set(selectedCustomers)
                          if (checked) {
                            newSet.add(analysis.customer_id)
                          } else {
                            newSet.delete(analysis.customer_id)
                          }
                          setSelectedCustomers(newSet)
                        }}
                        className="mt-1 border-2 border-gray-300"
                      />
                      <div className="flex-1 min-w-0">
                        <h3 className="font-semibold text-base truncate">{analysis.customer_name}</h3>
                        <p className="text-sm text-muted-foreground truncate">{analysis.cpf}</p>
                        {analysis.company_name && (
                          <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                            <Building2 className="h-3 w-3" />
                            {analysis.company_name}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 flex-wrap">
                    {analysis.score !== null && (
                      <Badge className={`${getScoreBadgeColor(analysis.score)} text-white font-bold`}>
                        Score: {analysis.score}
                      </Badge>
                    )}
                    {getStatusBadge(analysis.status)}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setSelectedAnalysis(analysis)
                        setShowDetailsDrawer(true)
                      }}
                    >
                      <Eye className="h-4 w-4 mr-1" />
                      Ver Detalhes
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>

      <Dialog open={showConfirmModal} onOpenChange={setShowConfirmModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-yellow-600" />
              {/* Renomeando "Análise de Crédito" para "Análise Restritiva" */}
              Confirmar Análise Restritiva
            </DialogTitle>
            <DialogDescription>
              {/* Renomeando "análise de crédito" para "análise restritiva" */}
              Você está prestes a executar a análise restritiva para {selectedCustomers.size} cliente
              {selectedCustomers.size > 1 ? "s" : ""}. Esta ação irá consumir créditos da API Assertiva.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowConfirmModal(false)}>
              Cancelar
            </Button>
            <Button onClick={handleRunAnalysis} className="bg-yellow-600 hover:bg-yellow-700">
              Confirmar Análise
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Sheet open={showDetailsDrawer} onOpenChange={setShowDetailsDrawer}>
        <SheetContent className="w-full sm:max-w-5xl overflow-y-auto bg-background px-6 sm:px-8">
          <SheetHeader className="pb-4 border-b">
            <SheetTitle className="text-2xl font-bold flex items-center gap-3">
              <div className="h-10 w-10 rounded-full bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center">
                <TrendingUp className="h-5 w-5 text-white" />
              </div>
              Analise Restritiva Completa
            </SheetTitle>
            <SheetDescription className="text-sm">
              Dados completos da analise restritiva do cliente
            </SheetDescription>
          </SheetHeader>

          {selectedAnalysis && (
            <div className="mt-6 space-y-6">
              {/* Botoes de acao */}
              <div className="flex flex-wrap gap-3">
                <Button
                  variant="outline"
                  className="gap-2"
                  onClick={() => exportToPDF(selectedAnalysis)}
                >
                  <Download className="h-4 w-4" />
                  Exportar PDF
                </Button>
              </div>

              {/* Cards de Score Principal - Layout em destaque */}
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
                    {(() => {
                      const creditoScore = selectedAnalysis.assertiva_data?.credito?.resposta?.score?.pontos
                      const displayScore = creditoScore === 0 ? 5 : creditoScore || selectedAnalysis.score || 0
                      const scoreClass = selectedAnalysis.assertiva_data?.credito?.resposta?.score?.classe || "N/A"
                      const scoreFaixa = selectedAnalysis.assertiva_data?.credito?.resposta?.score?.faixa?.titulo || ""
                      const scoreFaixaDescricao = selectedAnalysis.assertiva_data?.credito?.resposta?.score?.faixa?.descricao || ""

                      return (
                        <div className="space-y-4">
                          <div className="flex items-end gap-4">
                            <div className="text-6xl font-bold text-blue-600 dark:text-blue-400">
                              {displayScore}
                            </div>
                            <div className="pb-2">
                              <Badge className="bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">
                                Classe {scoreClass}
                              </Badge>
                            </div>
                          </div>
                          {scoreFaixa && (
                            <div className="p-4 bg-blue-50 dark:bg-blue-950/30 rounded-lg">
                              <p className="font-semibold text-blue-700 dark:text-blue-300 mb-1">{scoreFaixa}</p>
                              {scoreFaixaDescricao && (
                                <p className="text-sm text-muted-foreground">{scoreFaixaDescricao}</p>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })()}
                  </CardContent>
                </Card>

                {/* Score Recupere */}
                {selectedAnalysis.assertiva_data?.recupere?.resposta?.score && (
                  <Card className="border-2 border-orange-200 dark:border-orange-800 overflow-hidden">
                    <div className="bg-gradient-to-r from-orange-500 to-orange-600 p-4">
                      <h3 className="text-white font-semibold flex items-center gap-2">
                        <Sparkles className="h-5 w-5" />
                        Score de Recuperacao
                      </h3>
                    </div>
                    <CardContent className="p-6">
                      <div className="space-y-4">
                        <div className="flex items-end gap-4">
                          <div className="text-6xl font-bold text-orange-600 dark:text-orange-400">
                            {selectedAnalysis.assertiva_data.recupere.resposta.score.pontos}
                          </div>
                          <div className="pb-2">
                            <Badge className="bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200">
                              Classe {selectedAnalysis.assertiva_data.recupere.resposta.score.classe}
                            </Badge>
                          </div>
                        </div>
                        {selectedAnalysis.assertiva_data.recupere.resposta.score.faixa && (
                          <div className="p-4 bg-orange-50 dark:bg-orange-950/30 rounded-lg">
                            <p className="font-semibold text-orange-700 dark:text-orange-300 mb-1">
                              {selectedAnalysis.assertiva_data.recupere.resposta.score.faixa.titulo}
                            </p>
                            {selectedAnalysis.assertiva_data.recupere.resposta.score.faixa.descricao && (
                              <p className="text-sm text-muted-foreground">
                                {selectedAnalysis.assertiva_data.recupere.resposta.score.faixa.descricao}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                )}
              </div>

              {/* Alertas Rapidos */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <Card className="border-l-4 border-l-red-500">
                  <CardContent className="p-4">
                    <div className="flex items-center gap-3">
                      <AlertTriangle className="h-8 w-8 text-red-500" />
                      <div>
                        <p className="text-xs text-muted-foreground">Protestos</p>
                        <p className="text-2xl font-bold text-red-600">
                          {selectedAnalysis.assertiva_data?.credito?.resposta?.protestosPublicos?.qtdProtestos || 0}
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card className="border-l-4 border-l-yellow-500">
                  <CardContent className="p-4">
                    <div className="flex items-center gap-3">
                      <FileText className="h-8 w-8 text-yellow-500" />
                      <div>
                        <p className="text-xs text-muted-foreground">Ultimas Consultas</p>
                        <p className="text-2xl font-bold text-yellow-600">
                          {selectedAnalysis.assertiva_data?.credito?.resposta?.ultimasConsultas?.qtdUltConsultas || 0}
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card className="border-l-4 border-l-purple-500">
                  <CardContent className="p-4">
                    <div className="flex items-center gap-3">
                      <AlertCircle className="h-8 w-8 text-purple-500" />
                      <div>
                        <p className="text-xs text-muted-foreground">Sancoes CEIS</p>
                        <p className="text-2xl font-bold text-purple-600">
                          {selectedAnalysis.assertiva_data?.credito?.resposta?.ceis?.qtdOcorrencias || 0}
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card className="border-l-4 border-l-orange-500">
                  <CardContent className="p-4">
                    <div className="flex items-center gap-3">
                      <Shield className="h-8 w-8 text-orange-500" />
                      <div>
                        <p className="text-xs text-muted-foreground">Punicoes CNEP</p>
                        <p className="text-2xl font-bold text-orange-600">
                          {selectedAnalysis.assertiva_data?.credito?.resposta?.cnep?.qtdOcorrencias || 0}
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>

              {/* Informacoes do Cliente */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2">
                    <Building2 className="h-5 w-5" />
                    Informacoes do Cliente
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="p-4 bg-muted/50 rounded-lg">
                      <p className="text-xs text-muted-foreground mb-1">NOME COMPLETO</p>
                      <p className="font-semibold">{selectedAnalysis.customer_name}</p>
                    </div>
                    <div className="p-4 bg-muted/50 rounded-lg">
                      <p className="text-xs text-muted-foreground mb-1">CPF/CNPJ</p>
                      <p className="font-semibold font-mono">{selectedAnalysis.cpf}</p>
                    </div>
                    {selectedAnalysis.company_name && (
                      <div className="p-4 bg-muted/50 rounded-lg">
                        <p className="text-xs text-muted-foreground mb-1">EMPRESA</p>
                        <p className="font-semibold">{selectedAnalysis.company_name}</p>
                      </div>
                    )}
                    <div className="p-4 bg-muted/50 rounded-lg">
                      <p className="text-xs text-muted-foreground mb-1">DATA DA ANALISE</p>
                      <p className="font-semibold">{formatDate(selectedAnalysis.created_at)}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Renda/Faturamento */}
              {(selectedAnalysis.assertiva_data?.credito?.resposta?.faturamentoEstimado?.valor ||
                selectedAnalysis.assertiva_data?.credito?.resposta?.rendaPresumida?.valor) && (
                <Card className="border-2 border-green-200 dark:border-green-800">
                  <CardHeader className="pb-3">
                    <CardTitle className="flex items-center gap-2 text-green-600">
                      <DollarSign className="h-5 w-5" />
                      {selectedAnalysis.assertiva_data?.credito?.resposta?.faturamentoEstimado?.valor
                        ? "Faturamento Estimado"
                        : "Renda Presumida"}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-4xl font-bold text-green-600 dark:text-green-400">
                      {newIntl
                        ? new newIntl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(
                            selectedAnalysis.assertiva_data?.credito?.resposta?.faturamentoEstimado?.valor ||
                              selectedAnalysis.assertiva_data?.credito?.resposta?.rendaPresumida?.valor ||
                              0
                          )
                        : "N/A"}
                    </div>
                    {selectedAnalysis.assertiva_data?.credito?.resposta?.rendaPresumida?.faixa && (
                      <p className="text-sm text-muted-foreground mt-2">
                        Faixa: {selectedAnalysis.assertiva_data.credito.resposta.rendaPresumida.faixa}
                      </p>
                    )}
                  </CardContent>
                </Card>
              )}

              {/* Protestos Detalhados */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <AlertTriangle className="h-5 w-5 text-red-500" />
                    Protestos Publicos
                  </CardTitle>
                  <CardDescription>Protestos registrados em cartorio</CardDescription>
                </CardHeader>
                <CardContent>
                  {selectedAnalysis.assertiva_data?.credito?.resposta?.protestosPublicos?.qtdProtestos > 0 ? (
                    <div className="space-y-4">
                      <div className="grid grid-cols-2 gap-4">
                        <div className="p-4 bg-red-50 dark:bg-red-950/20 rounded-lg text-center">
                          <p className="text-xs text-muted-foreground mb-1">Quantidade</p>
                          <p className="text-3xl font-bold text-red-600">
                            {selectedAnalysis.assertiva_data.credito.resposta.protestosPublicos.qtdProtestos}
                          </p>
                        </div>
                        <div className="p-4 bg-red-50 dark:bg-red-950/20 rounded-lg text-center">
                          <p className="text-xs text-muted-foreground mb-1">Valor Total</p>
                          <p className="text-2xl font-bold text-red-600">
                            {newIntl
                              ? new newIntl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(
                                  selectedAnalysis.assertiva_data.credito.resposta.protestosPublicos.valorTotal || 0
                                )
                              : "N/A"}
                          </p>
                        </div>
                      </div>
                      {selectedAnalysis.assertiva_data.credito.resposta.protestosPublicos.list?.length > 0 && (
                        <div className="space-y-2 max-h-64 overflow-y-auto">
                          {selectedAnalysis.assertiva_data.credito.resposta.protestosPublicos.list.map((protesto: any, idx: number) => (
                            <div key={idx} className="p-3 border border-red-200 dark:border-red-800 rounded-lg bg-red-50/50 dark:bg-red-950/10">
                              <div className="flex justify-between items-start">
                                <div>
                                  <p className="font-medium text-sm">{protesto.cartorio || "Cartorio nao informado"}</p>
                                  <p className="text-xs text-muted-foreground">{protesto.cidade} - {protesto.uf}</p>
                                </div>
                                <Badge variant="destructive">
                                  {newIntl
                                    ? new newIntl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(protesto.valor || 0)
                                    : `R$ ${protesto.valor}`}
                                </Badge>
                              </div>
                              <p className="text-xs text-muted-foreground mt-1">Data: {protesto.data || "N/A"}</p>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="flex items-center gap-3 p-4 bg-green-50 dark:bg-green-950/20 rounded-lg">
                      <CheckCircle2 className="h-8 w-8 text-green-500" />
                      <div>
                        <p className="font-semibold text-green-700 dark:text-green-400">Nenhum protesto encontrado</p>
                        <p className="text-sm text-muted-foreground">Cliente sem registro de protestos</p>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Debitos */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <CreditCard className="h-5 w-5 text-orange-500" />
                    Registros de Debitos
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {selectedAnalysis.assertiva_data?.credito?.resposta?.registrosDebitos?.list?.length > 0 ? (
                    <div className="space-y-4">
                      <div className="grid grid-cols-2 gap-4">
                        <div className="p-4 bg-orange-50 dark:bg-orange-950/20 rounded-lg text-center">
                          <p className="text-xs text-muted-foreground mb-1">Quantidade</p>
                          <p className="text-3xl font-bold text-orange-600">
                            {selectedAnalysis.assertiva_data.credito.resposta.registrosDebitos.qtdDebitos || 0}
                          </p>
                        </div>
                        <div className="p-4 bg-orange-50 dark:bg-orange-950/20 rounded-lg text-center">
                          <p className="text-xs text-muted-foreground mb-1">Valor Total</p>
                          <p className="text-2xl font-bold text-orange-600">
                            {newIntl
                              ? new newIntl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(
                                  selectedAnalysis.assertiva_data.credito.resposta.registrosDebitos.valorTotal || 0
                                )
                              : "N/A"}
                          </p>
                        </div>
                      </div>
                      <div className="space-y-2 max-h-64 overflow-y-auto">
                        {selectedAnalysis.assertiva_data.credito.resposta.registrosDebitos.list.map((debito: any, idx: number) => (
                          <div key={idx} className="p-3 border border-orange-200 dark:border-orange-800 rounded-lg">
                            <div className="flex justify-between items-start">
                              <div>
                                <p className="font-medium text-sm">{debito.credor || "Credor nao informado"}</p>
                                <p className="text-xs text-muted-foreground">{debito.tipoDevedor?.titulo || ""}</p>
                              </div>
                              <Badge variant="outline" className="border-orange-500 text-orange-600">
                                {newIntl
                                  ? new newIntl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(debito.valor || 0)
                                  : `R$ ${debito.valor}`}
                              </Badge>
                            </div>
                            <div className="grid grid-cols-2 gap-2 mt-2 text-xs">
                              <div>
                                <span className="text-muted-foreground">Vencimento: </span>
                                <span>{debito.dataVencimento || "N/A"}</span>
                              </div>
                              <div>
                                <span className="text-muted-foreground">Local: </span>
                                <span>{debito.cidade || "N/A"}/{debito.uf || "N/A"}</span>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-3 p-4 bg-green-50 dark:bg-green-950/20 rounded-lg">
                      <CheckCircle2 className="h-8 w-8 text-green-500" />
                      <div>
                        <p className="font-semibold text-green-700 dark:text-green-400">Nenhum debito encontrado</p>
                        <p className="text-sm text-muted-foreground">Cliente sem registro de debitos</p>
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
                    Ultimas Consultas ({selectedAnalysis.assertiva_data?.credito?.resposta?.ultimasConsultas?.qtdUltConsultas || 0})
                  </CardTitle>
                  <CardDescription>Historico de consultas realizadas</CardDescription>
                </CardHeader>
                <CardContent>
                  {selectedAnalysis.assertiva_data?.credito?.resposta?.ultimasConsultas?.list?.length > 0 ? (
                    <div className="space-y-2 max-h-64 overflow-y-auto">
                      {selectedAnalysis.assertiva_data.credito.resposta.ultimasConsultas.list.slice(0, 10).map((consulta: any, idx: number) => (
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
                    <div className="flex items-center gap-3 p-4 bg-green-50 dark:bg-green-950/20 rounded-lg">
                      <CheckCircle2 className="h-8 w-8 text-green-500" />
                      <div>
                        <p className="font-semibold text-green-700 dark:text-green-400">Nenhuma consulta recente</p>
                        <p className="text-sm text-muted-foreground">Sem registro de consultas</p>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Cheques sem Fundo */}
              {selectedAnalysis.assertiva_data?.credito?.resposta?.chequesSemFundoCCF && (
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <CreditCard className="h-5 w-5 text-red-500" />
                      Cheques sem Fundo (CCF)
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {selectedAnalysis.assertiva_data.credito.resposta.chequesSemFundoCCF.qtdOcorrencias > 0 ? (
                      <div className="grid grid-cols-2 gap-4">
                        <div className="p-4 bg-red-50 dark:bg-red-950/20 rounded-lg text-center">
                          <p className="text-xs text-muted-foreground mb-1">Quantidade</p>
                          <p className="text-3xl font-bold text-red-600">
                            {selectedAnalysis.assertiva_data.credito.resposta.chequesSemFundoCCF.qtdOcorrencias}
                          </p>
                        </div>
                        <div className="p-4 bg-red-50 dark:bg-red-950/20 rounded-lg text-center">
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
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>

    </div>
  )
}
