import { createAdminClient } from "@/lib/supabase/server"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import Link from "next/link"
import { Building2, DollarSign, TrendingUp, Plus, Eye, Edit, Clock } from "lucide-react"
import { CompanyFilters } from "@/components/super-admin/company-filters"
import { DeleteCompanyButton } from "@/components/super-admin/delete-company-button"
import { formatCompactCurrency } from "@/lib/format-currency"

interface Company {
  id: string
  name: string
  email: string
  cnpj: string
  status: string
  totalCustomers: number
  totalDebts: number
  totalAmount: number
  recoveryRate: number
  adminCount: number
  avgDaysOverdue: number
  phone: string // Added phone field
}

export const dynamic = "force-dynamic"
export const revalidate = 0 // Force no cache for this page

async function fetchCompanies() {
  console.log("[v0] ========== COMPANIES PAGE v3 - PAGINATION ENABLED ==========")
  
  const supabase = createAdminClient()

  const { data: companiesData, error: companiesError } = await supabase.from("companies").select("*")

  if (companiesError) {
    console.error("[v0] Error fetching companies:", companiesError)
    return []
  }

  // SOMENTE dados da tabela VMAX (tabelas customers, debts e payments foram descontinuadas)

  const { data: adminsData, error: adminsError } = await supabase
    .from("profiles")
    .select("company_id, role")
    .eq("role", "admin")

  if (adminsError) {
    console.error("[v0] Error fetching admins:", adminsError)
  }

  // Buscar TODOS os registros VMAX (paginação para superar limite de 1000)
  let vmaxData: any[] = []
  let page = 0
  const pageSize = 1000
  let hasMore = true

  while (hasMore) {
    const { data: vmaxPage, error: vmaxPageError } = await supabase
      .from("VMAX")
      .select("*")
      .range(page * pageSize, (page + 1) * pageSize - 1)

    if (vmaxPageError) {
      console.error("[v0] Error fetching VMAX page:", vmaxPageError)
      break
    }

    console.log(`[v0] VMAX page ${page}: ${vmaxPage?.length || 0} records`)

    if (vmaxPage && vmaxPage.length > 0) {
      vmaxData = [...vmaxData, ...vmaxPage]
      page++
      hasMore = vmaxPage.length === pageSize
    } else {
      hasMore = false
    }
  }

  console.log("[v0] TOTAL VMAX records loaded (after pagination):", vmaxData.length)

  const companies: Company[] = (companiesData || []).map((company) => {
    const companyAdmins = adminsData?.filter((a) => a.company_id === company.id) || []

    // SOMENTE dados da tabela VMAX
    const companyVmaxData = vmaxData.filter((v) => {
      const vmaxCompanyId = v.id_company?.toString().toLowerCase().trim()
      const match = vmaxCompanyId === company.id.toString().toLowerCase().trim()
      return match
    })

    console.log(`[v0] Company ${company.name} - Total VMAX records:`, companyVmaxData.length)

    const vmaxSampleData = companyVmaxData.slice(0, 3).map((v) => ({
      Vencido: v.Vencido,
      DT_Cancelamento: v.DT_Cancelamento,
    }))
    console.log(`[v0] Sample VMAX data (first 3):`, JSON.stringify(vmaxSampleData))

    const vmaxTotalAmount = companyVmaxData.reduce((sum, v, index) => {
      const vencidoStr = String(v.Vencido || "0")
      const cleanValue = vencidoStr.replace(/R\$/g, "").replace(/\s/g, "").replace(/\./g, "").replace(",", ".")
      const value = Number(cleanValue) || 0

      // Log first 5 for debugging
      if (index < 5) {
        console.log(`[v0] VMAX ${index}: Original="${vencidoStr}", Cleaned="${cleanValue}", Value=${value}`)
      }

      return sum + value
    }, 0)

    console.log(`[v0] Company ${company.name} - Final vmaxTotalAmount: ${vmaxTotalAmount}`)

    const vmaxWithOverdue = companyVmaxData.filter((v) => {
      const diasInadStr = String(v["Dias Inad."] || "0")
      const diasInad = Number(diasInadStr.replace(/\./g, "")) || 0
      return diasInad > 0
    })

    const avgDaysOverdue =
      vmaxWithOverdue.length > 0
        ? vmaxWithOverdue.reduce((sum, v) => {
            const diasInadStr = String(v["Dias Inad."] || "0")
            return sum + (Number(diasInadStr.replace(/\./g, "")) || 0)
          }, 0) / vmaxWithOverdue.length
        : 0

    const paidAmount = companyVmaxData
      .filter((v) => v["DT Cancelamento"])
      .reduce((sum, v) => {
        const vencidoStr = String(v.Vencido || "0")
        const cleanValue = vencidoStr.replace(/R\$/g, "").replace(/\s/g, "").replace(/\./g, "").replace(",", ".")
        const value = Number(cleanValue) || 0
        return sum + value
      }, 0)

    const recoveryRate = 0 // No recovery data available yet

    const totalCustomers = companyVmaxData.length
    const totalDebts = companyVmaxData.filter((v) => !v["DT Cancelamento"]).length

    console.log(
      `[v0] Company ${company.name} - totalAmount: ${vmaxTotalAmount}, VMAX records: ${companyVmaxData.length}`,
    )

    return {
      id: company.id,
      name: company.name,
      email: company.email || "N/A",
      cnpj: company.cnpj || "N/A",
      status: company.status || "active",
      totalCustomers,
      totalDebts,
      totalAmount: vmaxTotalAmount,
      recoveryRate: Number(recoveryRate.toFixed(1)),
      avgDaysOverdue: Math.round(avgDaysOverdue),
      adminCount: companyAdmins.length,
      phone: company.phone || "N/A", // Added phone field
    }
  })

  console.log("[v0] Super Admin Stats:")
  const totalCustomersAllCompanies = companies.reduce((sum, c) => sum + c.totalCustomers, 0)
  const totalAmountAllCompanies = companies.reduce((sum, c) => sum + c.totalAmount, 0)
  const avgPerClient = totalCustomersAllCompanies > 0 ? totalAmountAllCompanies / totalCustomersAllCompanies : 0

  const companiesWithOverdue = companies.filter((c) => c.avgDaysOverdue > 0)
  const totalAvgDaysOverdue = companiesWithOverdue.reduce((sum, c) => sum + c.avgDaysOverdue, 0)
  const avgDaysOverdueAll = companiesWithOverdue.length > 0 ? totalAvgDaysOverdue / companiesWithOverdue.length : 0

  return {
    companies,
    stats: {
      totalCompanies: companies.length,
      totalVolume: companies.reduce((sum, c) => sum + c.totalAmount, 0),
      avgPerClient: avgPerClient,
      totalCustomersAllCompanies: totalCustomersAllCompanies,
      avgDaysOverdue: Math.round(avgDaysOverdueAll),
    },
  }
}

export default async function SuperAdminCompaniesPage() {
  const { companies, stats } = await fetchCompanies()

  const totalCustomers = companies.reduce((sum, c) => sum + c.totalCustomers, 0)
  const avgDebtPerCustomer = totalCustomers > 0 ? stats.totalVolume / totalCustomers : 0

  return (
    <div className="w-full overflow-x-hidden space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Gerenciamento de Empresas</h1>
          <p className="text-muted-foreground">Gerencie todas as empresas clientes da plataforma Altea Pay.</p>
        </div>
        <Button asChild>
          <Link href="/super-admin/companies/new">
            <Plus className="mr-2 h-4 w-4" />
            Nova Empresa
          </Link>
        </Button>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total de Empresas</CardTitle>
            <Building2 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalCompanies}</div>
            <p className="text-xs text-muted-foreground">Todas as empresas</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Volume Total</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatCompactCurrency(stats.totalVolume)}</div>
            <p className="text-xs text-muted-foreground">Em cobrança</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Média por Cliente</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatCompactCurrency(stats.avgPerClient)}</div>
            <p className="text-xs text-muted-foreground">{stats.totalCustomersAllCompanies} clientes totais</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Dias em Atraso</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.avgDaysOverdue}</div>
            <p className="text-xs text-muted-foreground">Média geral</p>
          </CardContent>
        </Card>
      </div>

      {/* Search and Filters */}
      <CompanyFilters />

      {/* Companies List */}
      <Card>
        <CardHeader>
          <CardTitle>Empresas Cadastradas</CardTitle>
          <CardDescription>Lista completa de todas as empresas clientes</CardDescription>
        </CardHeader>
        <CardContent>
          {companies.length === 0 ? (
            <div className="text-center py-8">
              <Building2 className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
              <p className="text-lg font-medium text-gray-900 dark:text-white">Nenhuma empresa cadastrada</p>
              <p className="text-gray-600 dark:text-gray-400 mb-4">Comece adicionando sua primeira empresa</p>
              <Button asChild>
                <Link href="/super-admin/companies/new">
                  <Plus className="mr-2 h-4 w-4" />
                  Nova Empresa
                </Link>
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              {companies.map((company) => (
                <div
                  key={company.id}
                  className="flex flex-col lg:flex-row lg:items-center justify-between p-4 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center space-x-4 mb-3 lg:mb-0">
                      <Avatar className="h-12 w-12">
                        <AvatarImage
                          src={`/ceholder-svg-key-1z7vp.jpg?key=1z7vp&height=48&width=48`}
                          alt={company.name}
                        />
                        <AvatarFallback className="bg-altea-gold/10 text-altea-navy">
                          {company.name
                            .split(" ")
                            .map((n) => n[0])
                            .join("")
                            .slice(0, 2)}
                        </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center space-x-2 mb-1">
                          <h3 className="font-medium text-gray-900 dark:text-white truncate">{company.name}</h3>
                          <Badge
                            variant={
                              company.status === "active"
                                ? "default"
                                : company.status === "suspended"
                                  ? "destructive"
                                  : "secondary"
                            }
                            className="text-xs"
                          >
                            {company.status === "active"
                              ? "Ativa"
                              : company.status === "suspended"
                                ? "Suspensa"
                                : "Inativa"}
                          </Badge>
                        </div>
                        <div className="flex flex-col sm:flex-row sm:items-center sm:space-x-4 text-sm text-gray-500 dark:text-gray-400">
                          <span>CNPJ: {company.cnpj}</span>
                          <span className="hidden sm:inline">•</span>
                          <span>{company.email}</span>
                          {/* Added phone field to display company phone */}
                          <span className="hidden sm:inline">•</span>
                          <span>{company.phone}</span>
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-col sm:flex-row sm:items-center gap-4 lg:gap-6 mt-4 lg:mt-0">
                      <div className="grid grid-cols-2 sm:flex sm:space-x-6 gap-4 sm:gap-0">
                        <div className="text-center sm:text-right">
                          <p className="text-sm font-medium text-gray-900 dark:text-white">
                            {company.totalCustomers.toLocaleString()}
                          </p>
                          <p className="text-xs text-gray-500 dark:text-gray-400">Clientes</p>
                        </div>

                        <div className="text-center sm:text-right">
                          <p className="text-sm font-medium text-gray-900 dark:text-white">
                            {formatCompactCurrency(company.totalAmount)}
                          </p>
                          <p className="text-xs text-gray-500 dark:text-gray-400">Volume</p>
                        </div>

                        <div className="text-center sm:text-right">
                          <p
                            className={`text-sm font-medium ${
                              company.recoveryRate === 0
                                ? "text-green-600 dark:text-green-400"
                                : company.recoveryRate <= 30
                                  ? "text-yellow-600 dark:text-yellow-400"
                                  : company.recoveryRate <= 60
                                    ? "text-orange-600 dark:text-orange-400"
                                    : "text-red-600 dark:text-red-400"
                            }`}
                          >
                            {company.recoveryRate.toFixed(1)}%
                          </p>
                          <p className="text-xs text-gray-500 dark:text-gray-400">Recuperação</p>
                        </div>

                        <div className="text-center sm:text-right">
                          <p className="text-sm font-medium text-gray-900 dark:text-white">{company.adminCount}</p>
                          <p className="text-xs text-gray-500 dark:text-gray-400">Admins</p>
                        </div>

                        <div className="text-center sm:text-right">
                          <p
                            className={`text-sm font-medium ${
                              company.avgDaysOverdue === 0
                                ? "text-green-600 dark:text-green-400"
                                : company.avgDaysOverdue <= 30
                                  ? "text-yellow-600 dark:text-yellow-400"
                                  : company.avgDaysOverdue <= 60
                                    ? "text-orange-600 dark:text-orange-400"
                                    : "text-red-600 dark:text-red-400"
                            }`}
                          >
                            {company.avgDaysOverdue} dias
                          </p>
                          <p className="text-xs text-gray-500 dark:text-gray-400">Atraso Médio</p>
                        </div>
                      </div>

                      <div className="flex space-x-2">
                        <Button asChild size="sm" variant="outline">
                          <Link href={`/super-admin/companies/${company.id}`}>
                            <Eye className="h-4 w-4 mr-1" />
                            Ver
                          </Link>
                        </Button>
                        <Button asChild size="sm" variant="outline">
                          <Link href={`/super-admin/companies/${company.id}/edit`}>
                            <Edit className="h-4 w-4 mr-1" />
                            Editar
                          </Link>
                        </Button>
                        <DeleteCompanyButton companyId={company.id} companyName={company.name} />
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
