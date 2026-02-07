"use client"

import { useState, useEffect } from "react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Search,
  Eye,
  TrendingUp,
  AlertTriangle,
  Building2,
  RefreshCw,
  Loader2,
  AlertCircle,
  DollarSign,
} from "lucide-react"
import { getAllCustomers } from "@/app/actions/analyses-actions"
import { getAllBehavioralAnalyses } from "@/app/actions/get-all-behavioral-analyses"
import { useToast } from "@/hooks/use-toast"

export default function ConsolidatedAnalysisPage() {
  const [customers, setCustomers] = useState<any[]>([])
  const [behavioralAnalyses, setBehavioralAnalyses] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState("")
  const [filterSource, setFilterSource] = useState<string>("all")
  const [filterStatus, setFilterStatus] = useState<string>("all")
  const [selectedCustomer, setSelectedCustomer] = useState<any | null>(null)
  const [sortBy, setSortBy] = useState<string>("name")
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc")
  const { toast } = useToast()

  useEffect(() => {
    loadData()
  }, [])

  const loadData = async () => {
    try {
      setLoading(true)
      const [customersRes, behavioralRes] = await Promise.all([getAllCustomers(), getAllBehavioralAnalyses()])

      if (customersRes.success) setCustomers(customersRes.data)
      if (behavioralRes.success) setBehavioralAnalyses(behavioralRes.data)

      console.log("[v0] Customers loaded:", customersRes.data?.length)
      console.log("[v0] Behavioral analyses loaded:", behavioralRes.data?.length)
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

  const consolidatedCustomers = customers.map((customer) => {
    const cleanDoc = customer.document?.replace(/\D/g, "")

    const hasRestrictive = !!(customer.analysis_metadata && customer.last_analysis_date)
    const restrictiveData = customer.analysis_metadata
    const restrictiveCreditScore = customer.credit_score || null
    const restrictiveRecoveryScore =
      restrictiveData?.recupere?.resposta?.score?.pontos || customer.recovery_score || null
    const restrictiveRecoveryClass = restrictiveData?.recupere?.resposta?.score?.classe || null

    // Análise Comportamental (de credit_profiles)
    const behavioralAnalysis = behavioralAnalyses.find((a) => a.cpf?.replace(/\D/g, "") === cleanDoc)
    const hasBehavioral = !!behavioralAnalysis

    if (hasBehavioral && behavioralAnalysis) {
      console.log(
        "[v0] Customer:",
        customer.name,
        "Behavioral data keys:",
        Object.keys(behavioralAnalysis),
        "data_assertiva exists:",
        !!behavioralAnalysis.data_assertiva,
        "data exists:",
        !!behavioralAnalysis.data,
      )
    }

    return {
      ...customer,
      hasRestrictive,
      hasBehavioral,
      restrictiveData,
      restrictiveCreditScore,
      restrictiveRecoveryScore,
      restrictiveRecoveryClass,
      behavioralData: behavioralAnalysis,
      consolidatedStatus:
        hasRestrictive && hasBehavioral ? "complete" : hasRestrictive || hasBehavioral ? "partial" : "none",
    }
  })

  const filteredCustomers = consolidatedCustomers
    .filter((customer) => {
      const matchesSearch =
        customer.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        customer.document?.toLowerCase().includes(searchTerm.toLowerCase())

      const matchesSource = filterSource === "all" || customer.source_table === filterSource

      const matchesStatus = filterStatus === "all" || customer.consolidatedStatus === filterStatus

      return matchesSearch && matchesSource && matchesStatus
    })
    .sort((a, b) => {
      let comparison = 0

      switch (sortBy) {
        case "name":
          comparison = (a.name || "").localeCompare(b.name || "")
          break
        case "score":
          const scoreA = a.credit_score || 0
          const scoreB = b.credit_score || 0
          comparison = scoreA - scoreB
          break
        case "status":
          const statusOrder = { complete: 0, partial: 1, none: 2 }
          comparison = statusOrder[a.consolidatedStatus] - statusOrder[b.consolidatedStatus]
          break
        case "date":
          const dateA = new Date(a.last_analysis_date || a.created_at || 0).getTime()
          const dateB = new Date(b.last_analysis_date || b.created_at || 0).getTime()
          comparison = dateA - dateB
          break
      }

      return sortDirection === "asc" ? comparison : -comparison
    })

  const stats = {
    total: consolidatedCustomers.length,
    complete: consolidatedCustomers.filter((c) => c.consolidatedStatus === "complete").length,
    partial: consolidatedCustomers.filter((c) => c.consolidatedStatus === "partial").length,
    none: consolidatedCustomers.filter((c) => c.consolidatedStatus === "none").length,
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-yellow-600" />
      </div>
    )
  }

  return (
    <div className="w-full space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Análise Consolidada</h1>
          <p className="text-muted-foreground mt-1">
            Visualize dados de Análise Restritiva e Comportamental consolidados
          </p>
        </div>
        <Button onClick={loadData} variant="outline">
          <RefreshCw className="h-4 w-4 mr-2" />
          Atualizar
        </Button>
      </div>

      {/* Filtros */}
      <Card className="p-4">
        <div className="flex flex-wrap gap-4">
          <div className="flex-1 min-w-[250px]">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Buscar por nome ou CPF/CNPJ..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10"
              />
            </div>
          </div>

          <Select value={filterSource} onValueChange={setFilterSource}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Todas as origens" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas as origens</SelectItem>
              <SelectItem value="customers">Customers</SelectItem>
              <SelectItem value="VMAX">VMAX</SelectItem>
            </SelectContent>
          </Select>

          <Select value={filterStatus} onValueChange={setFilterStatus}>
            <SelectTrigger className="w-[200px]">
              <SelectValue placeholder="Todos os status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos os status</SelectItem>
              <SelectItem value="complete">Análises Completas</SelectItem>
              <SelectItem value="partial">Parcial</SelectItem>
              <SelectItem value="none">Sem Análises</SelectItem>
            </SelectContent>
          </Select>

          <div className="flex items-center gap-2">
            <Button
              variant={sortBy === "name" ? "default" : "outline"}
              size="sm"
              onClick={() => {
                if (sortBy === "name") {
                  setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"))
                } else {
                  setSortBy("name")
                  setSortDirection("asc")
                }
              }}
            >
              Nome {sortBy === "name" && (sortDirection === "asc" ? "↑" : "↓")}
            </Button>
            <Button
              variant={sortBy === "score" ? "default" : "outline"}
              size="sm"
              onClick={() => {
                if (sortBy === "score") {
                  setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"))
                } else {
                  setSortBy("score")
                  setSortDirection("desc")
                }
              }}
            >
              Score {sortBy === "score" && (sortDirection === "asc" ? "↑" : "↓")}
            </Button>
            <Button
              variant={sortBy === "status" ? "default" : "outline"}
              size="sm"
              onClick={() => {
                if (sortBy === "status") {
                  setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"))
                } else {
                  setSortBy("status")
                  setSortDirection("asc")
                }
              }}
            >
              Status {sortBy === "status" && (sortDirection === "asc" ? "↑" : "↓")}
            </Button>
            <Button
              variant={sortBy === "date" ? "default" : "outline"}
              size="sm"
              onClick={() => {
                if (sortBy === "date") {
                  setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"))
                } else {
                  setSortBy("date")
                  setSortDirection("desc")
                }
              }}
            >
              Data {sortBy === "date" && (sortDirection === "asc" ? "↑" : "↓")}
            </Button>
          </div>
        </div>
      </Card>

      {/* Estatísticas */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className="p-4">
          <div className="flex items-center gap-3">
            <div className="h-12 w-12 rounded-full bg-blue-100 flex items-center justify-center">
              <Building2 className="h-6 w-6 text-blue-600" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Total de Clientes</p>
              <p className="text-2xl font-bold">{stats.total}</p>
            </div>
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center gap-3">
            <div className="h-12 w-12 rounded-full bg-green-100 flex items-center justify-center">
              <TrendingUp className="h-6 w-6 text-green-600" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Análises Completas</p>
              <p className="text-2xl font-bold">{stats.complete}</p>
            </div>
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center gap-3">
            <div className="h-12 w-12 rounded-full bg-yellow-100 flex items-center justify-center">
              <AlertTriangle className="h-6 w-6 text-yellow-600" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Análises Parciais</p>
              <p className="text-2xl font-bold">{stats.partial}</p>
            </div>
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center gap-3">
            <div className="h-12 w-12 rounded-full bg-gray-100 flex items-center justify-center">
              <AlertTriangle className="h-6 w-6 text-gray-600" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Sem Análises</p>
              <p className="text-2xl font-bold">{stats.none}</p>
            </div>
          </div>
        </Card>
      </div>

      {/* Lista de Clientes */}
      <div className="space-y-4">
        {filteredCustomers.length === 0 ? (
          <Card className="p-8 text-center">
            <p className="text-muted-foreground">Nenhum cliente encontrado com os filtros aplicados.</p>
          </Card>
        ) : (
          filteredCustomers.map((customer) => {
            return (
              <Card key={customer.id} className="p-6 hover:shadow-lg transition-shadow">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-3">
                      <h3 className="text-lg font-semibold">{customer.name}</h3>
                      {customer.source_table === "VMAX" && (
                        <Badge variant="outline" className="text-xs">
                          VMAX
                        </Badge>
                      )}
                      {customer.consolidatedStatus === "complete" && (
                        <Badge className="bg-green-500 text-white">Completas</Badge>
                      )}
                      {customer.consolidatedStatus === "partial" && (
                        <Badge className="bg-yellow-500 text-white">Parcial</Badge>
                      )}
                      {customer.consolidatedStatus === "none" && <Badge variant="secondary">Sem Análises</Badge>}
                    </div>
                    <p className="text-sm text-muted-foreground mb-4">{customer.document}</p>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {/* Análise Restritiva */}
                      <div className="border rounded-lg p-4 bg-gradient-to-br from-blue-50 to-blue-100/30">
                        <h4 className="font-semibold text-sm mb-3 flex items-center gap-2">
                          <div className="h-2 w-2 rounded-full bg-blue-600"></div>
                          Análise Restritiva
                        </h4>
                        {customer.hasRestrictive ? (
                          <div className="space-y-3">
                            {customer.restrictiveCreditScore !== null && (
                              <div>
                                <div className="flex items-center justify-between mb-1">
                                  <span className="text-xs text-muted-foreground">Score Crédito</span>
                                  {customer.risk_level && (
                                    <Badge variant="outline" className="text-xs">
                                      Classe {customer.risk_level}
                                    </Badge>
                                  )}
                                </div>
                                <div className="text-3xl font-bold text-blue-600">
                                  {customer.restrictiveCreditScore}
                                </div>
                              </div>
                            )}
                            {customer.restrictiveRecoveryScore !== null && (
                              <div>
                                <div className="flex items-center justify-between mb-1">
                                  <span className="text-xs text-muted-foreground">Score Recuperação</span>
                                  {customer.restrictiveRecoveryClass && (
                                    <Badge variant="outline" className="text-xs">
                                      Classe {customer.restrictiveRecoveryClass}
                                    </Badge>
                                  )}
                                </div>
                                <div className="text-2xl font-bold text-orange-600">
                                  {customer.restrictiveRecoveryScore}
                                </div>
                              </div>
                            )}
                            {customer.last_analysis_date && (
                              <div className="text-xs text-muted-foreground pt-2 border-t">
                                {new Date(customer.last_analysis_date).toLocaleDateString("pt-BR")}
                              </div>
                            )}
                          </div>
                        ) : (
                          <p className="text-sm text-muted-foreground italic">Não realizada</p>
                        )}
                      </div>

                      {/* Análise Comportamental */}
                      <div className="border rounded-lg p-4 bg-gradient-to-br from-yellow-50 to-yellow-100/30">
                        <h4 className="font-semibold text-sm mb-3 flex items-center gap-2">
                          <div className="h-2 w-2 rounded-full bg-yellow-600"></div>
                          Análise Comportamental
                        </h4>
                        {customer.hasBehavioral && customer.behavioralData ? (
                          <div className="space-y-3">
                            {(() => {
                              const rawData = customer.behavioralData.data

                              // Check if analysis is complete (has credito/recupere structure)
                              const creditScore = rawData?.credito?.resposta?.score
                              const recoveryScore = rawData?.recupere?.resposta?.score

                              if (!creditScore && !recoveryScore) {
                                return <p className="text-sm text-muted-foreground italic">Sem dados disponíveis</p>
                              }

                              return (
                                <>
                                  {creditScore?.pontos !== undefined && (
                                    <div>
                                      <div className="flex items-center justify-between mb-1">
                                        <span className="text-xs text-muted-foreground">Score Crédito</span>
                                        {creditScore.classe && (
                                          <Badge variant="outline" className="text-xs">
                                            Classe {creditScore.classe}
                                          </Badge>
                                        )}
                                      </div>
                                      <div className="text-3xl font-bold text-blue-600">{creditScore.pontos}</div>
                                    </div>
                                  )}
                                  {recoveryScore?.pontos !== undefined && (
                                    <div>
                                      <div className="flex items-center justify-between mb-1">
                                        <span className="text-xs text-muted-foreground">Score Recuperação</span>
                                        {recoveryScore.classe && (
                                          <Badge variant="outline" className="text-xs">
                                            Classe {recoveryScore.classe}
                                          </Badge>
                                        )}
                                      </div>
                                      <div className="text-2xl font-bold text-orange-600">{recoveryScore.pontos}</div>
                                    </div>
                                  )}
                                  {customer.behavioralData.created_at && (
                                    <div className="text-xs text-muted-foreground pt-2 border-t">
                                      {new Date(customer.behavioralData.created_at).toLocaleDateString("pt-BR")}
                                    </div>
                                  )}
                                </>
                              )
                            })()}
                          </div>
                        ) : (
                          <p className="text-sm text-muted-foreground italic">Não realizada</p>
                        )}
                      </div>
                    </div>
                  </div>

                  <Button
                    onClick={() => setSelectedCustomer(customer)}
                    variant="outline"
                    size="sm"
                    className="shrink-0 gap-2"
                  >
                    <Eye className="h-4 w-4" />
                    Ver Detalhes
                  </Button>
                </div>
              </Card>
            )
          })
        )}
      </div>

      {/* Sheet de Detalhes */}
      <Sheet open={!!selectedCustomer} onOpenChange={(open) => !open && setSelectedCustomer(null)}>
        <SheetContent className="w-full sm:max-w-6xl overflow-y-auto px-6 sm:px-8">
          <SheetHeader className="pb-4 border-b">
            <SheetTitle className="text-2xl">{selectedCustomer?.name}</SheetTitle>
            <p className="text-sm text-muted-foreground">{selectedCustomer?.document}</p>
          </SheetHeader>

          {selectedCustomer && (
            <Tabs defaultValue="overview" className="mt-6">
              <TabsList className="grid w-full grid-cols-3 mb-6">
                <TabsTrigger value="overview">Visão Geral</TabsTrigger>
                <TabsTrigger value="restrictive">Análise Restritiva</TabsTrigger>
                <TabsTrigger value="behavioral">Análise Comportamental</TabsTrigger>
              </TabsList>

              <TabsContent value="overview" className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 px-2">
                  {/* Card Análise Restritiva */}
                  <Card className="border-2 border-blue-200 overflow-hidden">
                    <div className="bg-gradient-to-r from-blue-500 to-blue-600 p-6 text-white">
                      {selectedCustomer.hasRestrictive ? (
                        <Badge className="bg-white text-blue-600">Completa</Badge>
                      ) : (
                        <Badge className="bg-gray-200 text-gray-600">Não Realizada</Badge>
                      )}
                    </div>

                    <div className="p-6 space-y-6">
                      {selectedCustomer.hasRestrictive ? (
                        <>
                          {/* Score de Crédito */}
                          <div className="bg-blue-50 rounded-lg p-6">
                            <p className="text-sm text-muted-foreground mb-2">Score de Crédito</p>
                            <div className="flex items-end gap-3">
                              <p className="text-5xl font-bold text-blue-600">
                                {selectedCustomer.restrictiveCreditScore || "N/A"}
                              </p>
                              {selectedCustomer.risk_level && (
                                <Badge variant="outline" className="mb-2">
                                  Classe {selectedCustomer.risk_level}
                                </Badge>
                              )}
                            </div>
                          </div>

                          {/* Score de Recuperação */}
                          {selectedCustomer.restrictiveRecoveryScore && (
                            <div className="bg-orange-50 rounded-lg p-6">
                              <p className="text-sm text-muted-foreground mb-2">Score de Recuperação</p>
                              <div className="flex items-end gap-3">
                                <p className="text-4xl font-bold text-orange-600">
                                  {selectedCustomer.restrictiveRecoveryScore}
                                </p>
                                {selectedCustomer.restrictiveRecoveryClass && (
                                  <Badge variant="outline" className="mb-2">
                                    Classe {selectedCustomer.restrictiveRecoveryClass}
                                  </Badge>
                                )}
                              </div>
                            </div>
                          )}

                          {/* Sanções e Punições */}
                          <div className="grid grid-cols-2 gap-4 pt-4 border-t">
                            <div className="text-center p-4 bg-red-50 rounded-lg">
                              <p className="text-xs text-muted-foreground mb-1">Sanções CEIS</p>
                              <p className="text-2xl font-bold text-red-600">
                                {selectedCustomer.restrictiveData?.ceis_count || 0}
                              </p>
                            </div>
                            <div className="text-center p-4 bg-orange-50 rounded-lg">
                              <p className="text-xs text-muted-foreground mb-1">Punições CNEP</p>
                              <p className="text-2xl font-bold text-orange-600">
                                {selectedCustomer.restrictiveData?.cnep_count || 0}
                              </p>
                            </div>
                          </div>

                          {selectedCustomer.last_analysis_date && (
                            <p className="text-xs text-muted-foreground text-center pt-4 border-t">
                              Última análise:{" "}
                              {new Date(selectedCustomer.last_analysis_date).toLocaleDateString("pt-BR")}
                            </p>
                          )}
                        </>
                      ) : (
                        <div className="text-center py-8">
                          <AlertCircle className="h-12 w-12 text-muted-foreground mx-auto mb-3" />
                          <p className="text-muted-foreground">Análise não realizada</p>
                        </div>
                      )}
                    </div>
                  </Card>

                  {/* Card Análise Comportamental */}
                  <Card className="border-2 border-yellow-200 overflow-hidden">
                    <div className="bg-gradient-to-r from-yellow-500 to-orange-500 p-6 text-white">
                      {selectedCustomer.hasBehavioral ? (
                        <Badge className="bg-white text-orange-600">Completa</Badge>
                      ) : (
                        <Badge className="bg-gray-200 text-gray-600">Não Realizada</Badge>
                      )}
                    </div>

                    <div className="p-6 space-y-6">
                      {selectedCustomer.hasBehavioral && selectedCustomer.behavioralData ? (
                        <>
                          {/* Score de Crédito */}
                          {(() => {
                            const rawData =
                              selectedCustomer.behavioralData.data_assertiva || selectedCustomer.behavioralData.data

                            console.log(
                              "[v0] Processing behavioral for:",
                              selectedCustomer.name,
                              "rawData keys:",
                              rawData ? Object.keys(rawData) : "none",
                            )

                            const creditScore = rawData?.credito?.resposta?.score
                            const recoveryScore = rawData?.recupere?.resposta?.score

                            return (
                              <>
                                {creditScore?.pontos !== undefined && (
                                  <div>
                                    <div className="flex items-center justify-between mb-1">
                                      <span className="text-xs text-muted-foreground">Score Crédito</span>
                                      {creditScore.classe && (
                                        <Badge variant="outline" className="text-xs">
                                          Classe {creditScore.classe}
                                        </Badge>
                                      )}
                                    </div>
                                    <div className="text-5xl font-bold text-blue-600 mb-3">{creditScore.pontos}</div>
                                    {creditScore.descricao && (
                                      <p className="text-sm text-muted-foreground mt-2">{creditScore.descricao}</p>
                                    )}
                                  </div>
                                )}
                                {recoveryScore?.pontos !== undefined && (
                                  <div>
                                    <div className="flex items-center justify-between mb-1">
                                      <span className="text-xs text-muted-foreground">Score Recuperação</span>
                                      {recoveryScore.classe && (
                                        <Badge variant="outline" className="text-xs">
                                          Classe {recoveryScore.classe}
                                        </Badge>
                                      )}
                                    </div>
                                    <div className="text-5xl font-bold text-orange-600 mb-3">
                                      {recoveryScore.pontos}
                                    </div>
                                    {recoveryScore.descricao && (
                                      <p className="text-sm text-muted-foreground mt-2">{recoveryScore.descricao}</p>
                                    )}
                                  </div>
                                )}
                              </>
                            )
                          })()}

                          <Card className="p-6">
                            <h4 className="font-semibold mb-4 flex items-center gap-2">
                              <DollarSign className="h-5 w-5 text-green-600" />
                              Faturamento Estimado
                            </h4>
                            <p className="text-4xl font-bold text-green-600">
                              {selectedCustomer.behavioralData.data_assertiva?.credito?.resposta?.faturamentoPresumido
                                ? `R$ ${Number(selectedCustomer.behavioralData.data_assertiva.credito.resposta.faturamentoPresumido).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`
                                : selectedCustomer.behavioralData.data?.credito?.resposta?.faturamentoPresumido
                                  ? `R$ ${Number(selectedCustomer.behavioralData.data.credito.resposta.faturamentoPresumido).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`
                                  : "Não disponível"}
                            </p>
                          </Card>

                          <Card className="p-6 bg-red-50/50">
                            <h4 className="font-semibold mb-4 flex items-center gap-2">
                              <AlertTriangle className="h-5 w-5 text-red-600" />
                              Protestos
                            </h4>
                            <div className="grid grid-cols-3 gap-4">
                              <div>
                                <p className="text-sm text-muted-foreground">Quantidade Total</p>
                                <p className="text-3xl font-bold text-red-600">
                                  {selectedCustomer.behavioralData.data_assertiva?.acoes?.resposta?.protestos?.length ||
                                    selectedCustomer.behavioralData.data?.acoes?.resposta?.protestos?.length ||
                                    0}
                                </p>
                              </div>
                              <div>
                                <p className="text-sm text-muted-foreground">Valor Total</p>
                                <p className="text-2xl font-bold text-red-600">R$ 0,00</p>
                              </div>
                              <div>
                                <p className="text-sm text-muted-foreground">Status</p>
                                <Badge variant="outline" className="text-green-600 border-green-600">
                                  Sem Protestos
                                </Badge>
                              </div>
                            </div>
                          </Card>
                        </>
                      ) : (
                        <div className="text-center py-8">
                          <AlertCircle className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                          <p className="text-muted-foreground">
                            Análise Comportamental não realizada para este cliente.
                          </p>
                        </div>
                      )}
                    </div>
                  </Card>
                </div>
              </TabsContent>

              <TabsContent value="restrictive" className="space-y-4">
                {selectedCustomer.hasRestrictive ? (
                  <>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <Card className="p-6 bg-gradient-to-br from-blue-50 to-blue-100/50 border-2 border-blue-200">
                        <h4 className="text-sm font-semibold text-muted-foreground mb-3">SCORE DE CRÉDITO</h4>
                        <p className="text-6xl font-bold text-blue-600 mb-3">
                          {selectedCustomer.restrictiveCreditScore || 0}
                        </p>
                        {selectedCustomer.risk_level && (
                          <Badge className="bg-blue-600 text-white">Classe {selectedCustomer.risk_level}</Badge>
                        )}
                        <p className="text-xs text-muted-foreground mt-3">Análise Restritiva</p>
                      </Card>

                      {selectedCustomer.restrictiveRecoveryScore && (
                        <Card className="p-6 bg-gradient-to-br from-orange-50 to-orange-100/50 border-2 border-orange-200">
                          <h4 className="text-sm font-semibold text-muted-foreground mb-3">SCORE DE RECUPERAÇÃO</h4>
                          <p className="text-6xl font-bold text-orange-600 mb-3">
                            {selectedCustomer.restrictiveRecoveryScore}
                          </p>
                          {selectedCustomer.restrictiveRecoveryClass && (
                            <Badge className="bg-orange-600 text-white">
                              Classe {selectedCustomer.restrictiveRecoveryClass}
                            </Badge>
                          )}
                          <p className="text-xs text-muted-foreground mt-3">Probabilidade de recuperação</p>
                        </Card>
                      )}
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <Card className="p-6 border-2 border-red-200">
                        <h4 className="text-sm font-semibold text-muted-foreground mb-2">Sanções CEIS</h4>
                        <p className="text-5xl font-bold text-red-600">
                          {selectedCustomer.restrictiveData?.ceis_count || 0}
                        </p>
                        <p className="text-xs text-muted-foreground mt-2">Empresas Inidôneas</p>
                      </Card>

                      <Card className="p-6 border-2 border-orange-200">
                        <h4 className="text-sm font-semibold text-muted-foreground mb-2">Punições CNEP</h4>
                        <p className="text-5xl font-bold text-orange-600">
                          {selectedCustomer.restrictiveData?.cnep_count || 0}
                        </p>
                        <p className="text-xs text-muted-foreground mt-2">Empresas Punidas</p>
                      </Card>
                    </div>

                    <Card className="p-6">
                      <h4 className="font-semibold mb-4 flex items-center gap-2">
                        <Building2 className="h-5 w-5" />
                        Informações do Cliente
                      </h4>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <p className="text-sm text-muted-foreground">Nome Completo</p>
                          <p className="font-semibold">{selectedCustomer.name}</p>
                        </div>
                        <div>
                          <p className="text-sm text-muted-foreground">CPF/CNPJ</p>
                          <p className="font-semibold">{selectedCustomer.document}</p>
                        </div>
                        {selectedCustomer.last_analysis_date && (
                          <div>
                            <p className="text-sm text-muted-foreground">Data da Análise</p>
                            <p className="font-semibold">
                              {new Date(selectedCustomer.last_analysis_date).toLocaleDateString("pt-BR")}
                            </p>
                          </div>
                        )}
                      </div>
                    </Card>
                  </>
                ) : (
                  <Card className="p-8 text-center">
                    <AlertCircle className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                    <p className="text-muted-foreground">Análise Restritiva não realizada para este cliente.</p>
                  </Card>
                )}
              </TabsContent>

              <TabsContent value="behavioral" className="space-y-4">
                {selectedCustomer.hasBehavioral && selectedCustomer.behavioralData ? (
                  <>
                    <div className="grid grid-cols-2 gap-4">
                      <Card className="p-6 bg-gradient-to-br from-blue-50 to-blue-100/50 border-2 border-blue-200">
                        <h4 className="text-sm font-semibold text-muted-foreground mb-3">SCORE DE CRÉDITO</h4>
                        <p className="text-6xl font-bold text-blue-600 mb-3">
                          {selectedCustomer.behavioralData.data_assertiva?.credito?.resposta?.score?.pontos ||
                            selectedCustomer.behavioralData.data?.credito?.resposta?.score?.pontos ||
                            0}
                        </p>
                        {(selectedCustomer.behavioralData.data_assertiva?.credito?.resposta?.score?.classe ||
                          selectedCustomer.behavioralData.data?.credito?.resposta?.score?.classe) && (
                          <>
                            <Badge className="bg-blue-600 text-white mb-2">
                              Classe{" "}
                              {selectedCustomer.behavioralData.data_assertiva?.credito?.resposta?.score?.classe ||
                                selectedCustomer.behavioralData.data?.credito?.resposta?.score?.classe}
                            </Badge>
                            <p className="text-xs text-muted-foreground mt-2">
                              {selectedCustomer.behavioralData.data_assertiva?.credito?.resposta?.score?.descricao ||
                                selectedCustomer.behavioralData.data?.credito?.resposta?.score?.descricao}
                            </p>
                          </>
                        )}
                      </Card>

                      <Card className="p-6 bg-gradient-to-br from-orange-50 to-orange-100/50 border-2 border-orange-200">
                        <h4 className="text-sm font-semibold text-muted-foreground mb-3">SCORE DE RECUPERAÇÃO</h4>
                        <p className="text-6xl font-bold text-orange-600 mb-3">
                          {selectedCustomer.behavioralData.data_assertiva?.recupere?.resposta?.score?.pontos ||
                            selectedCustomer.behavioralData.data?.recupere?.resposta?.score?.pontos ||
                            0}
                        </p>
                        {(selectedCustomer.behavioralData.data_assertiva?.recupere?.resposta?.score?.classe ||
                          selectedCustomer.behavioralData.data?.recupere?.resposta?.score?.classe) && (
                          <>
                            <Badge className="bg-orange-600 text-white mb-2">
                              Classe{" "}
                              {selectedCustomer.behavioralData.data_assertiva?.recupere?.resposta?.score?.classe ||
                                selectedCustomer.behavioralData.data?.recupere?.resposta?.score?.classe}
                            </Badge>
                            <p className="text-xs text-muted-foreground mt-2">
                              {selectedCustomer.behavioralData.data_assertiva?.recupere?.resposta?.score?.descricao ||
                                selectedCustomer.behavioralData.data?.recupere?.resposta?.score?.descricao}
                            </p>
                          </>
                        )}
                      </Card>
                    </div>

                    <Card className="p-6">
                      <h4 className="font-semibold mb-4 flex items-center gap-2">
                        <DollarSign className="h-5 w-5 text-green-600" />
                        Faturamento Estimado
                      </h4>
                      <p className="text-4xl font-bold text-green-600">
                        {selectedCustomer.behavioralData.data_assertiva?.credito?.resposta?.faturamentoPresumido
                          ? `R$ ${Number(selectedCustomer.behavioralData.data_assertiva.credito.resposta.faturamentoPresumido).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`
                          : selectedCustomer.behavioralData.data?.credito?.resposta?.faturamentoPresumido
                            ? `R$ ${Number(selectedCustomer.behavioralData.data.credito.resposta.faturamentoPresumido).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`
                            : "Não disponível"}
                      </p>
                    </Card>

                    <Card className="p-6 bg-red-50/50">
                      <h4 className="font-semibold mb-4 flex items-center gap-2">
                        <AlertTriangle className="h-5 w-5 text-red-600" />
                        Protestos
                      </h4>
                      <div className="grid grid-cols-3 gap-4">
                        <div>
                          <p className="text-sm text-muted-foreground">Quantidade Total</p>
                          <p className="text-3xl font-bold text-red-600">
                            {selectedCustomer.behavioralData.data_assertiva?.acoes?.resposta?.protestos?.length ||
                              selectedCustomer.behavioralData.data?.acoes?.resposta?.protestos?.length ||
                              0}
                          </p>
                        </div>
                        <div>
                          <p className="text-sm text-muted-foreground">Valor Total</p>
                          <p className="text-2xl font-bold text-red-600">R$ 0,00</p>
                        </div>
                        <div>
                          <p className="text-sm text-muted-foreground">Status</p>
                          <Badge variant="outline" className="text-green-600 border-green-600">
                            Sem Protestos
                          </Badge>
                        </div>
                      </div>
                    </Card>
                  </>
                ) : (
                  <Card className="p-8 text-center">
                    <AlertCircle className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                    <p className="text-muted-foreground">Análise Comportamental não realizada para este cliente.</p>
                  </Card>
                )}
              </TabsContent>
            </Tabs>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}
