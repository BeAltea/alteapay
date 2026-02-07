"use client"

import { useState, useEffect, useMemo } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  UsersRound,
  Building2,
  DollarSign,
  Search,
  AlertCircle,
  Loader2,
  Eye,
  Phone,
  Mail,
  CheckCircle2,
  Clock,
  XCircle,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  ChevronLeft,
  ChevronRight,
  Handshake,
  Brain,
  Shield,
} from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { getAllCustomers, getAllCompanies } from "@/app/actions/analyses-actions"
import Link from "next/link"

interface Customer {
  id: string
  name: string
  document: string
  city: string
  company_name: string
  company_id: string
  source_table: string
  dias_inad: number
  credit_score: number | null
  risk_level: string | null
  approval_status: string | null
  analysis_metadata: any
  last_analysis_date: string | null
  recovery_score: number | null
  recovery_class: string | null
  restrictive_analysis_logs: any
  restrictive_analysis_date: string | null
  behavioral_analysis_logs: any
  behavioral_analysis_date: string | null
  email?: string
  phone?: string
  vencido?: number
}

interface Company {
  id: string
  name: string
}

type SortField = "name" | "document" | "dias_inad" | "vencido"
type SortDirection = "asc" | "desc"

export default function ClientesPage() {
  const [customers, setCustomers] = useState<Customer[]>([])
  const [companies, setCompanies] = useState<Company[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>("")
  const [searchTerm, setSearchTerm] = useState("")
  const [sortField, setSortField] = useState<SortField>("name")
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc")
  const [currentPage, setCurrentPage] = useState(1)
  const [filterStatus, setFilterStatus] = useState<string>("all")
  const { toast } = useToast()

  const ITEMS_PER_PAGE = 50

  useEffect(() => {
    loadData()
  }, [])

  const loadData = async () => {
    try {
      setLoading(true)
      const [customersRes, companiesRes] = await Promise.all([
        getAllCustomers(),
        getAllCompanies(),
      ])

      if (customersRes.success) {
        setCustomers(customersRes.data)
      } else {
        toast({
          title: "Erro ao carregar clientes",
          description: customersRes.error,
          variant: "destructive",
        })
      }

      if (companiesRes.success) {
        setCompanies(companiesRes.data)
      }
    } catch (error: any) {
      toast({
        title: "Erro",
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
    setCurrentPage(1)
  }

  const getSortIcon = (field: SortField) => {
    if (sortField !== field) return <ArrowUpDown className="h-4 w-4 ml-1" />
    return sortDirection === "asc" ? <ArrowUp className="h-4 w-4 ml-1" /> : <ArrowDown className="h-4 w-4 ml-1" />
  }

  // Filter and sort customers
  const filteredCustomers = useMemo(() => {
    let result = customers

    // Filter by company
    if (selectedCompanyId) {
      result = result.filter((c) => c.company_id === selectedCompanyId)
    }

    // Filter by search term
    if (searchTerm) {
      const search = searchTerm.toLowerCase()
      result = result.filter(
        (c) =>
          c.name?.toLowerCase().includes(search) ||
          c.document?.toLowerCase().includes(search)
      )
    }

    // Filter by analysis status
    if (filterStatus !== "all") {
      result = result.filter((c) => {
        const hasRestrictive = !!c.restrictive_analysis_logs
        const hasBehavioral = !!c.behavioral_analysis_logs

        switch (filterStatus) {
          case "with_restrictive":
            return hasRestrictive
          case "without_restrictive":
            return !hasRestrictive
          case "with_behavioral":
            return hasBehavioral
          case "without_behavioral":
            return !hasBehavioral
          default:
            return true
        }
      })
    }

    // Sort
    result = [...result].sort((a, b) => {
      const direction = sortDirection === "asc" ? 1 : -1
      switch (sortField) {
        case "name":
          return direction * (a.name || "").localeCompare(b.name || "")
        case "document":
          return direction * (a.document || "").localeCompare(b.document || "")
        case "dias_inad":
          return direction * ((a.dias_inad || 0) - (b.dias_inad || 0))
        case "vencido":
          return direction * ((a.vencido || 0) - (b.vencido || 0))
        default:
          return 0
      }
    })

    return result
  }, [customers, selectedCompanyId, searchTerm, filterStatus, sortField, sortDirection])

  // Pagination
  const totalPages = Math.ceil(filteredCustomers.length / ITEMS_PER_PAGE)
  const paginatedCustomers = filteredCustomers.slice(
    (currentPage - 1) * ITEMS_PER_PAGE,
    currentPage * ITEMS_PER_PAGE
  )

  // Stats for the selected company
  const stats = useMemo(() => {
    const data = selectedCompanyId
      ? customers.filter((c) => c.company_id === selectedCompanyId)
      : customers

    return {
      total: data.length,
      withRestrictiveAnalysis: data.filter((c) => !!c.restrictive_analysis_logs).length,
      withBehavioralAnalysis: data.filter((c) => !!c.behavioral_analysis_logs).length,
      totalDebt: data.reduce((acc, c) => acc + (c.vencido || 0), 0),
    }
  }, [customers, selectedCompanyId])

  const getAnalysisStatusBadge = (type: "restrictive" | "behavioral", customer: Customer) => {
    if (type === "restrictive") {
      if (customer.restrictive_analysis_logs) {
        return (
          <Badge className="bg-green-500/20 text-green-400 border-green-500/30 hover:bg-green-500/30">
            <CheckCircle2 className="h-3 w-3 mr-1" />
            Concluída
          </Badge>
        )
      }
      return (
        <Badge variant="outline" className="border-[var(--sa-border-primary)] text-[var(--sa-text-muted)]">
          <Clock className="h-3 w-3 mr-1" />
          Pendente
        </Badge>
      )
    } else {
      if (customer.behavioral_analysis_logs) {
        return (
          <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30 hover:bg-blue-500/30">
            <CheckCircle2 className="h-3 w-3 mr-1" />
            Concluída
          </Badge>
        )
      }
      return (
        <Badge variant="outline" className="border-[var(--sa-border-primary)] text-[var(--sa-text-muted)]">
          <Clock className="h-3 w-3 mr-1" />
          Pendente
        </Badge>
      )
    }
  }

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: "BRL",
    }).format(value)
  }

  if (loading) {
    return (
      <div className="w-full space-y-6">
        <div className="space-y-2">
          <div className="h-8 w-48 bg-[var(--sa-bg-tertiary)] rounded animate-pulse" />
          <div className="h-4 w-72 bg-[var(--sa-bg-tertiary)] rounded animate-pulse" />
        </div>
        <Card className="bg-[var(--sa-bg-secondary)] border-[var(--sa-border-primary)]">
          <CardContent className="p-12 text-center">
            <Loader2 className="h-8 w-8 animate-spin mx-auto mb-4 text-[var(--sa-gold-400)]" />
            <p className="text-[var(--sa-text-muted)]">Carregando clientes...</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="w-full space-y-6">
      {/* Header */}
      <div className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight text-[var(--sa-text-primary)]">Clientes</h1>
        <p className="text-[var(--sa-text-muted)]">
          Visualize e gerencie todos os clientes cadastrados na plataforma
        </p>
      </div>

      {/* Company Selector */}
      <Card className="bg-[var(--sa-bg-secondary)] border-[var(--sa-border-primary)]">
        <CardHeader className="pb-4">
          <CardTitle className="text-[var(--sa-text-primary)] flex items-center gap-2">
            <Building2 className="h-5 w-5 text-[var(--sa-gold-400)]" />
            Selecionar Empresa
          </CardTitle>
          <CardDescription className="text-[var(--sa-text-muted)]">
            Escolha uma empresa para visualizar seus clientes ou veja todos os clientes
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Select value={selectedCompanyId} onValueChange={(value) => {
            setSelectedCompanyId(value === "all" ? "" : value)
            setCurrentPage(1)
          }}>
            <SelectTrigger className="w-full md:w-[400px] bg-[var(--sa-bg-tertiary)] border-[var(--sa-border-primary)] text-[var(--sa-text-primary)]">
              <SelectValue placeholder="Selecione uma empresa..." />
            </SelectTrigger>
            <SelectContent className="bg-[var(--sa-bg-secondary)] border-[var(--sa-border-primary)]">
              <SelectItem value="all" className="text-[var(--sa-text-primary)]">
                Todas as empresas ({customers.length} clientes)
              </SelectItem>
              {companies.map((company) => {
                const count = customers.filter((c) => c.company_id === company.id).length
                return (
                  <SelectItem key={company.id} value={company.id} className="text-[var(--sa-text-primary)]">
                    {company.name} ({count} clientes)
                  </SelectItem>
                )
              })}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card className="bg-[var(--sa-bg-secondary)] border-[var(--sa-border-primary)]">
          <CardContent className="p-6">
            <div className="flex items-center gap-4">
              <div className="p-3 rounded-lg bg-[var(--sa-gold-400)]/10">
                <UsersRound className="h-6 w-6 text-[var(--sa-gold-400)]" />
              </div>
              <div>
                <p className="text-sm text-[var(--sa-text-muted)]">Total de Clientes</p>
                <p className="text-2xl font-bold text-[var(--sa-text-primary)]">{stats.total}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-[var(--sa-bg-secondary)] border-[var(--sa-border-primary)]">
          <CardContent className="p-6">
            <div className="flex items-center gap-4">
              <div className="p-3 rounded-lg bg-green-500/10">
                <Shield className="h-6 w-6 text-green-500" />
              </div>
              <div>
                <p className="text-sm text-[var(--sa-text-muted)]">Análise Restritiva</p>
                <p className="text-2xl font-bold text-[var(--sa-text-primary)]">{stats.withRestrictiveAnalysis}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-[var(--sa-bg-secondary)] border-[var(--sa-border-primary)]">
          <CardContent className="p-6">
            <div className="flex items-center gap-4">
              <div className="p-3 rounded-lg bg-blue-500/10">
                <Brain className="h-6 w-6 text-blue-500" />
              </div>
              <div>
                <p className="text-sm text-[var(--sa-text-muted)]">Análise 360</p>
                <p className="text-2xl font-bold text-[var(--sa-text-primary)]">{stats.withBehavioralAnalysis}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-[var(--sa-bg-secondary)] border-[var(--sa-border-primary)]">
          <CardContent className="p-6">
            <div className="flex items-center gap-4">
              <div className="p-3 rounded-lg bg-red-500/10">
                <DollarSign className="h-6 w-6 text-red-500" />
              </div>
              <div>
                <p className="text-sm text-[var(--sa-text-muted)]">Dívida Total</p>
                <p className="text-2xl font-bold text-[var(--sa-text-primary)]">
                  {formatCurrency(stats.totalDebt)}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters and Search */}
      <div className="flex flex-col md:flex-row gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-[var(--sa-text-muted)]" />
          <Input
            placeholder="Buscar por nome ou CPF/CNPJ..."
            value={searchTerm}
            onChange={(e) => {
              setSearchTerm(e.target.value)
              setCurrentPage(1)
            }}
            className="pl-10 bg-[var(--sa-bg-tertiary)] border-[var(--sa-border-primary)] text-[var(--sa-text-primary)] placeholder:text-[var(--sa-text-muted)]"
          />
        </div>

        <Select value={filterStatus} onValueChange={(value) => {
          setFilterStatus(value)
          setCurrentPage(1)
        }}>
          <SelectTrigger className="w-full md:w-[220px] bg-[var(--sa-bg-tertiary)] border-[var(--sa-border-primary)] text-[var(--sa-text-primary)]">
            <SelectValue placeholder="Filtrar por análise" />
          </SelectTrigger>
          <SelectContent className="bg-[var(--sa-bg-secondary)] border-[var(--sa-border-primary)]">
            <SelectItem value="all" className="text-[var(--sa-text-primary)]">Todos os clientes</SelectItem>
            <SelectItem value="with_restrictive" className="text-[var(--sa-text-primary)]">Com Análise Restritiva</SelectItem>
            <SelectItem value="without_restrictive" className="text-[var(--sa-text-primary)]">Sem Análise Restritiva</SelectItem>
            <SelectItem value="with_behavioral" className="text-[var(--sa-text-primary)]">Com Análise 360</SelectItem>
            <SelectItem value="without_behavioral" className="text-[var(--sa-text-primary)]">Sem Análise 360</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Sort Buttons */}
      <div className="flex flex-wrap gap-2">
        <Button
          variant={sortField === "name" ? "default" : "outline"}
          size="sm"
          onClick={() => handleSort("name")}
          className={sortField === "name"
            ? "bg-[var(--sa-gold-400)] text-[var(--sa-bg-primary)] hover:bg-[var(--sa-gold-500)]"
            : "border-[var(--sa-border-primary)] text-[var(--sa-text-secondary)] hover:bg-[var(--sa-bg-tertiary)] hover:text-[var(--sa-text-primary)]"
          }
        >
          Nome {getSortIcon("name")}
        </Button>
        <Button
          variant={sortField === "document" ? "default" : "outline"}
          size="sm"
          onClick={() => handleSort("document")}
          className={sortField === "document"
            ? "bg-[var(--sa-gold-400)] text-[var(--sa-bg-primary)] hover:bg-[var(--sa-gold-500)]"
            : "border-[var(--sa-border-primary)] text-[var(--sa-text-secondary)] hover:bg-[var(--sa-bg-tertiary)] hover:text-[var(--sa-text-primary)]"
          }
        >
          CPF/CNPJ {getSortIcon("document")}
        </Button>
        <Button
          variant={sortField === "dias_inad" ? "default" : "outline"}
          size="sm"
          onClick={() => handleSort("dias_inad")}
          className={sortField === "dias_inad"
            ? "bg-[var(--sa-gold-400)] text-[var(--sa-bg-primary)] hover:bg-[var(--sa-gold-500)]"
            : "border-[var(--sa-border-primary)] text-[var(--sa-text-secondary)] hover:bg-[var(--sa-bg-tertiary)] hover:text-[var(--sa-text-primary)]"
          }
        >
          Dias em Atraso {getSortIcon("dias_inad")}
        </Button>
      </div>

      {/* Results Count */}
      <div className="text-sm text-[var(--sa-text-muted)]">
        Mostrando {paginatedCustomers.length} de {filteredCustomers.length} clientes
        {selectedCompanyId && companies.find(c => c.id === selectedCompanyId) && (
          <span> da empresa <span className="text-[var(--sa-gold-400)]">{companies.find(c => c.id === selectedCompanyId)?.name}</span></span>
        )}
      </div>

      {/* Customers List */}
      <div className="space-y-3">
        {filteredCustomers.length === 0 ? (
          <Card className="bg-[var(--sa-bg-secondary)] border-[var(--sa-border-primary)]">
            <CardContent className="p-12 text-center">
              <AlertCircle className="h-12 w-12 mx-auto mb-4 text-[var(--sa-text-muted)]" />
              <p className="text-lg font-medium mb-2 text-[var(--sa-text-primary)]">Nenhum cliente encontrado</p>
              <p className="text-sm text-[var(--sa-text-muted)]">
                {selectedCompanyId
                  ? "Esta empresa ainda não possui clientes cadastrados"
                  : "Selecione uma empresa ou ajuste os filtros"}
              </p>
            </CardContent>
          </Card>
        ) : (
          paginatedCustomers.map((customer) => (
            <Card
              key={customer.id}
              className="bg-[var(--sa-bg-secondary)] border-[var(--sa-border-primary)] hover:border-[var(--sa-gold-400)]/30 transition-colors"
            >
              <CardContent className="p-4">
                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                  {/* Customer Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start gap-3">
                      <div className="w-10 h-10 rounded-full bg-[var(--sa-gold-400)]/10 flex items-center justify-center flex-shrink-0">
                        <UsersRound className="h-5 w-5 text-[var(--sa-gold-400)]" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="font-semibold text-base text-[var(--sa-text-primary)] truncate">
                          {customer.name}
                        </h3>
                        <p className="text-sm text-[var(--sa-text-muted)] font-mono">{customer.document}</p>
                        {!selectedCompanyId && customer.company_name && (
                          <p className="text-xs text-[var(--sa-text-muted)] flex items-center gap-1 mt-1">
                            <Building2 className="h-3 w-3" />
                            {customer.company_name}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Analysis Status */}
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="flex flex-col items-start gap-1">
                      <span className="text-[10px] uppercase tracking-wider text-[var(--sa-text-muted)]">Crédito</span>
                      {getAnalysisStatusBadge("restrictive", customer)}
                    </div>
                    <div className="flex flex-col items-start gap-1">
                      <span className="text-[10px] uppercase tracking-wider text-[var(--sa-text-muted)]">360</span>
                      {getAnalysisStatusBadge("behavioral", customer)}
                    </div>
                    {customer.dias_inad > 0 && (
                      <div className="flex flex-col items-start gap-1">
                        <span className="text-[10px] uppercase tracking-wider text-[var(--sa-text-muted)]">Atraso</span>
                        <Badge className="bg-red-500/20 text-red-400 border-red-500/30">
                          {customer.dias_inad} dias
                        </Badge>
                      </div>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2">
                    <Link href={`/super-admin/companies/${customer.company_id}/customers/${customer.id}`}>
                      <Button
                        variant="outline"
                        size="sm"
                        className="border-[var(--sa-border-primary)] text-[var(--sa-text-secondary)] hover:bg-[var(--sa-bg-tertiary)] hover:text-[var(--sa-text-primary)]"
                      >
                        <Eye className="h-4 w-4 mr-1" />
                        Ver Detalhes
                      </Button>
                    </Link>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-[var(--sa-text-muted)]">
            Página {currentPage} de {totalPages}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              className="border-[var(--sa-border-primary)] text-[var(--sa-text-secondary)] hover:bg-[var(--sa-bg-tertiary)] hover:text-[var(--sa-text-primary)] disabled:opacity-50"
            >
              <ChevronLeft className="h-4 w-4 mr-1" />
              Anterior
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
              className="border-[var(--sa-border-primary)] text-[var(--sa-text-secondary)] hover:bg-[var(--sa-bg-tertiary)] hover:text-[var(--sa-text-primary)] disabled:opacity-50"
            >
              Próxima
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
