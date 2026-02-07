import { createAdminClient } from "@/lib/supabase/admin"
import { Button } from "@/components/ui/button"
import Link from "next/link"
import {
  Building2,
  Users,
  DollarSign,
  BarChart3,
  ArrowRight,
  Eye,
  Search,
  Globe,
  Mail,
  Zap,
  Plus,
} from "lucide-react"

interface CompanyStats {
  id: string
  name: string
  totalCustomers: number
  totalDebts: number
  totalAmount: number
  recoveredAmount: number
  recoveryRate: number
  overdueDebts: number
  admins: number
}

export const dynamic = "force-dynamic"
export const revalidate = 0

export default async function SuperAdminDashboardPage() {
  console.log("[v0] ========== SUPER ADMIN PAGE v3 - PAGINATION ENABLED ==========")

  const supabase = createAdminClient()

  const { data: companies } = await supabase.from("companies").select("id, name").order("name")

  // Buscar TODOS os registros VMAX (paginação para superar limite de 1000)
  let allVmaxRecords: any[] = []
  let page = 0
  const pageSize = 1000
  let hasMore = true

  while (hasMore) {
    const { data: vmaxPage, error: vmaxPageError } = await supabase
      .from("VMAX")
      .select("*")
      .range(page * pageSize, (page + 1) * pageSize - 1)

    if (vmaxPageError) {
      console.log("[v0] VMAX page error:", vmaxPageError.message)
      break
    }

    console.log(`[v0] VMAX page ${page}: ${vmaxPage?.length || 0} records`)

    if (vmaxPage && vmaxPage.length > 0) {
      allVmaxRecords = [...allVmaxRecords, ...vmaxPage]
      page++
      hasMore = vmaxPage.length === pageSize
    } else {
      hasMore = false
    }
  }

  console.log("[v0] TOTAL VMAX records loaded (after pagination):", allVmaxRecords.length)

  const companiesStats: CompanyStats[] = []

  if (companies) {
    for (const company of companies) {
      // SOMENTE dados da tabela VMAX (tabela customers foi descontinuada)
      const vmaxCustomers =
        allVmaxRecords?.filter((v) => {
          const match =
            String(v.id_company || "")
              .toLowerCase()
              .trim() === String(company.id).toLowerCase().trim()
          return match
        }) || []

      const totalCustomers = vmaxCustomers?.length || 0

      // SOMENTE dados da tabela VMAX
      const vmaxOverdueDebts = vmaxCustomers?.filter((v) => {
        const diasInadStr = String(v["Dias Inad."] || "0")
        return (Number(diasInadStr.replace(/\./g, "")) || 0) > 0
      }).length || 0

      const vmaxTotalAmount =
        vmaxCustomers?.reduce((sum, v) => {
          const vencidoStr = String(v.Vencido || "0")
          const cleanValue = vencidoStr.replace(/R\$/g, "").replace(/\s/g, "").replace(/\./g, "").replace(",", ".")
          const value = Number(cleanValue) || 0
          return sum + value
        }, 0) || 0

      const { data: admins } = await supabase
        .from("profiles")
        .select("id")
        .eq("company_id", company.id)
        .eq("role", "admin")

      companiesStats.push({
        id: company.id,
        name: company.name,
        totalCustomers,
        totalDebts: vmaxCustomers?.length || 0,
        totalAmount: vmaxTotalAmount,
        recoveredAmount: 0,
        recoveryRate: 0,
        overdueDebts: vmaxOverdueDebts,
        admins: admins?.length || 0,
      })
    }
  }

  const totalStats = {
    totalCompanies: companiesStats.length,
    totalCustomers: companiesStats.reduce((sum, company) => sum + company.totalCustomers, 0),
    totalDebts: companiesStats.reduce((sum, company) => sum + company.totalDebts, 0),
    totalAmount: companiesStats.reduce((sum, company) => sum + company.totalAmount, 0),
    totalOverdue: companiesStats.reduce((sum, company) => sum + company.overdueDebts, 0),
    totalAdmins: companiesStats.reduce((sum, company) => sum + company.admins, 0),
  }

  // Get total analyses count
  const { count: analysesCount } = await supabase
    .from("credit_profiles")
    .select("*", { count: "exact", head: true })

  const { data: recentAnalyses } = await supabase
    .from("credit_profiles")
    .select("id, name, company_id, created_at, score, analysis_type, companies(name)")
    .order("created_at", { ascending: false })
    .limit(4)

  const recentActivity =
    recentAnalyses?.map((analysis) => ({
      id: analysis.id,
      type: analysis.analysis_type === "behavioral" ? "behavioral" : "credit",
      description: analysis.analysis_type === "behavioral"
        ? "Análise 360 concluída"
        : `Análise de Crédito realizada — Score: ${analysis.score || "N/A"}`,
      risk: analysis.analysis_type === "behavioral" ? "Médio" : null,
      company: analysis.companies?.name || "Empresa",
      time: new Date(analysis.created_at).toLocaleDateString("pt-BR"),
    })) || []

  const formatCurrency = (value: number) => {
    if (value >= 1000000) {
      return `R$ ${(value / 1000000).toFixed(1)}M`
    }
    if (value >= 1000) {
      return `R$ ${(value / 1000).toFixed(1)}k`
    }
    return `R$ ${value.toFixed(2)}`
  }

  return (
    <div className="min-h-screen bg-[#0F1117]">
      <div className="p-8">
        {/* Page Header */}
        <div className="flex justify-between items-start mb-8">
          <div>
            <h1 className="text-[28px] font-bold text-[#F0F1F5] font-serif mb-1">
              Painel Super Admin
            </h1>
            <p className="text-sm text-[#9DA3B7]">
              Visão geral de todas as empresas e operações da plataforma
            </p>
          </div>
          <Button
            asChild
            className="bg-gradient-to-r from-[#F5A623] to-[#C77A00] text-[#0F1117] font-semibold px-5 py-2.5 rounded-[10px] shadow-[0_4px_16px_rgba(245,166,35,0.25)] hover:shadow-[0_6px_24px_rgba(245,166,35,0.35)] hover:-translate-y-0.5 transition-all border-0"
          >
            <Link href="/super-admin/companies/new">
              <Plus className="mr-2 h-4 w-4" />
              Nova Empresa
            </Link>
          </Button>
        </div>

        {/* Stats Grid - 4 cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {/* Total de Empresas */}
          <div className="bg-[#1A1D27] border border-[#323647] rounded-[14px] p-5 relative overflow-hidden transition-all hover:border-[#464B5F] hover:-translate-y-0.5 group">
            <div className="absolute top-0 right-0 w-20 h-20 bg-gradient-radial from-[rgba(245,166,35,0.06)] to-transparent" />
            <div className="w-10 h-10 rounded-[10px] bg-[rgba(245,166,35,0.1)] flex items-center justify-center mb-3.5">
              <Building2 className="h-[18px] w-[18px] text-[#F5A623]" />
            </div>
            <div className="text-xs text-[#6B7188] uppercase tracking-[1px] font-medium mb-1.5">
              Total de Empresas
            </div>
            <div className="text-[26px] font-bold text-[#F0F1F5] leading-tight">
              {totalStats.totalCompanies}
            </div>
            <div className="inline-flex items-center gap-1 text-xs mt-2 px-2 py-0.5 rounded-md bg-[rgba(45,212,168,0.1)] text-[#2DD4A8] font-medium">
              ↑ Ativa
            </div>
          </div>

          {/* Total de Clientes */}
          <div className="bg-[#1A1D27] border border-[#323647] rounded-[14px] p-5 relative overflow-hidden transition-all hover:border-[#464B5F] hover:-translate-y-0.5 group">
            <div className="absolute top-0 right-0 w-20 h-20 bg-gradient-radial from-[rgba(245,166,35,0.06)] to-transparent" />
            <div className="w-10 h-10 rounded-[10px] bg-[rgba(91,141,239,0.1)] flex items-center justify-center mb-3.5">
              <Users className="h-[18px] w-[18px] text-[#5B8DEF]" />
            </div>
            <div className="text-xs text-[#6B7188] uppercase tracking-[1px] font-medium mb-1.5">
              Total de Clientes
            </div>
            <div className="text-[26px] font-bold text-[#F0F1F5] leading-tight">
              {totalStats.totalCustomers.toLocaleString("pt-BR")}
            </div>
            <div className="inline-flex items-center gap-1 text-xs mt-2 px-2 py-0.5 rounded-md bg-[rgba(45,212,168,0.1)] text-[#2DD4A8] font-medium">
              ↑ {totalStats.totalAdmins} admins
            </div>
          </div>

          {/* Valor em Cobrança */}
          <div className="bg-[#1A1D27] border border-[#323647] rounded-[14px] p-5 relative overflow-hidden transition-all hover:border-[#464B5F] hover:-translate-y-0.5 group">
            <div className="absolute top-0 right-0 w-20 h-20 bg-gradient-radial from-[rgba(245,166,35,0.06)] to-transparent" />
            <div className="w-10 h-10 rounded-[10px] bg-[rgba(45,212,168,0.1)] flex items-center justify-center mb-3.5">
              <DollarSign className="h-[18px] w-[18px] text-[#2DD4A8]" />
            </div>
            <div className="text-xs text-[#6B7188] uppercase tracking-[1px] font-medium mb-1.5">
              Valor em Cobrança
            </div>
            <div className="text-[26px] font-bold text-[#F0F1F5] leading-tight">
              {formatCurrency(totalStats.totalAmount)}
            </div>
            <div className="inline-flex items-center gap-1 text-xs mt-2 px-2 py-0.5 rounded-md bg-[rgba(240,104,104,0.1)] text-[#F06868] font-medium">
              {totalStats.totalDebts.toLocaleString("pt-BR")} dívidas ativas
            </div>
          </div>

          {/* Análises Realizadas */}
          <div className="bg-[#1A1D27] border border-[#323647] rounded-[14px] p-5 relative overflow-hidden transition-all hover:border-[#464B5F] hover:-translate-y-0.5 group">
            <div className="absolute top-0 right-0 w-20 h-20 bg-gradient-radial from-[rgba(245,166,35,0.06)] to-transparent" />
            <div className="w-10 h-10 rounded-[10px] bg-[rgba(240,104,104,0.1)] flex items-center justify-center mb-3.5">
              <BarChart3 className="h-[18px] w-[18px] text-[#F06868]" />
            </div>
            <div className="text-xs text-[#6B7188] uppercase tracking-[1px] font-medium mb-1.5">
              Análises Realizadas
            </div>
            <div className="text-[26px] font-bold text-[#F0F1F5] leading-tight">
              {(analysesCount || 0).toLocaleString("pt-BR")}
            </div>
            <div className="inline-flex items-center gap-1 text-xs mt-2 px-2 py-0.5 rounded-md bg-[rgba(45,212,168,0.1)] text-[#2DD4A8] font-medium">
              ↑ 18% este mês
            </div>
          </div>
        </div>

        {/* First Two-Column Grid: Companies + System Status */}
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-6 mb-6">
          {/* Empresas Clientes Card */}
          <div className="bg-[#1A1D27] border border-[#323647] rounded-[14px] overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-[#252836]">
              <span className="text-[15px] font-semibold text-[#F0F1F5]">Empresas Clientes</span>
              <Link
                href="/super-admin/companies"
                className="text-xs text-[#F5A623] font-medium hover:underline cursor-pointer"
              >
                Ver Todas →
              </Link>
            </div>
            <div className="p-4">
              {companiesStats.length === 0 ? (
                <div className="text-center py-8 text-[#6B7188]">
                  Nenhuma empresa cadastrada
                </div>
              ) : (
                companiesStats.map((company, index) => (
                  <div
                    key={company.id}
                    className={`flex items-center gap-3.5 py-3 ${
                      index !== companiesStats.length - 1 ? "border-b border-[#252836]" : ""
                    }`}
                  >
                    <div className="w-10 h-10 rounded-[10px] bg-[#323647] flex items-center justify-center text-[#F5A623] font-bold text-sm flex-shrink-0">
                      {company.name.substring(0, 2).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold text-[#F0F1F5]">{company.name}</div>
                      <div className="text-xs text-[#6B7188]">
                        {company.totalCustomers.toLocaleString("pt-BR")} clientes · {company.totalDebts.toLocaleString("pt-BR")} dívidas
                      </div>
                    </div>
                    <div className="flex gap-6 items-center">
                      <div className="text-right">
                        <div className="text-[10px] text-[#6B7188] uppercase tracking-[0.5px]">Em Cobrança</div>
                        <div className="text-sm font-semibold text-[#F0F1F5]">{formatCurrency(company.totalAmount)}</div>
                      </div>
                      <div className="text-right">
                        <div className="text-[10px] text-[#6B7188] uppercase tracking-[0.5px]">Status</div>
                        <span className="inline-block px-2.5 py-1 rounded-md text-[11px] font-semibold bg-[rgba(240,104,104,0.1)] text-[#F06868]">
                          {company.overdueDebts} em atraso
                        </span>
                      </div>
                      <Link href={`/super-admin/companies/${company.id}`}>
                        <button className="w-8 h-8 rounded-lg bg-[#252836] border border-[#323647] text-[#6B7188] flex items-center justify-center hover:bg-[#323647] hover:text-[#F0F1F5] transition-colors">
                          <Eye className="h-4 w-4" />
                        </button>
                      </Link>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Visão do Sistema Card */}
          <div className="bg-[#1A1D27] border border-[#323647] rounded-[14px] overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-[#252836]">
              <span className="text-[15px] font-semibold text-[#F0F1F5]">Visão do Sistema</span>
              <Link
                href="/super-admin/reports"
                className="text-xs text-[#F5A623] font-medium hover:underline cursor-pointer"
              >
                Relatório →
              </Link>
            </div>
            <div className="p-4">
              <div className="flex items-center gap-3 py-3.5 border-b border-[#252836]">
                <span className="w-2.5 h-2.5 rounded-full bg-[#2DD4A8] shadow-[0_0_8px_rgba(45,212,168,0.4)] flex-shrink-0" />
                <span className="text-[13px] font-medium text-[#F0F1F5] flex-1">Sistema Operacional</span>
                <span className="text-xs text-[#6B7188]">Todas conectadas</span>
              </div>
              <div className="flex items-center gap-3 py-3.5 border-b border-[#252836]">
                <span className="w-2.5 h-2.5 rounded-full bg-[#F5A623] shadow-[0_0_8px_rgba(245,166,35,0.4)] flex-shrink-0" />
                <span className="text-[13px] font-medium text-[#F0F1F5] flex-1">Casos Críticos</span>
                <span className="text-xs text-[#F5A623]">{totalStats.totalOverdue.toLocaleString("pt-BR")}</span>
              </div>
              <div className="flex items-center gap-3 py-3.5 border-b border-[#252836]">
                <span className="w-2.5 h-2.5 rounded-full bg-[#F5A623] shadow-[0_0_8px_rgba(245,166,35,0.4)] flex-shrink-0" />
                <span className="text-[13px] font-medium text-[#F0F1F5] flex-1">Monitoramento IA</span>
                <span className="text-xs text-[#6B7188]">Analisando padrões</span>
              </div>
              <div className="flex items-center gap-3 py-3.5 border-b border-[#252836]">
                <span className="w-2.5 h-2.5 rounded-full bg-[#2DD4A8] shadow-[0_0_8px_rgba(45,212,168,0.4)] flex-shrink-0" />
                <span className="text-[13px] font-medium text-[#F0F1F5] flex-1">Gateway de Pagamento</span>
                <span className="text-xs text-[#6B7188]">Operacional</span>
              </div>
              <div className="flex items-center gap-3 py-3.5">
                <span className="w-2.5 h-2.5 rounded-full bg-[#2DD4A8] shadow-[0_0_8px_rgba(45,212,168,0.4)] flex-shrink-0" />
                <span className="text-[13px] font-medium text-[#F0F1F5] flex-1">SendGrid Email</span>
                <span className="text-xs text-[#6B7188]">Conectado</span>
              </div>
            </div>
          </div>
        </div>

        {/* Second Two-Column Grid: Activity + Quick Analyses */}
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-6">
          {/* Atividade Recente Card */}
          <div className="bg-[#1A1D27] border border-[#323647] rounded-[14px] overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-[#252836]">
              <span className="text-[15px] font-semibold text-[#F0F1F5]">Atividade Recente</span>
              <Link
                href="/super-admin/reports"
                className="text-xs text-[#F5A623] font-medium hover:underline cursor-pointer"
              >
                Ver Tudo →
              </Link>
            </div>
            <div className="p-4">
              {recentActivity.length === 0 ? (
                <div className="text-center py-8 text-[#6B7188]">
                  Nenhuma atividade recente
                </div>
              ) : (
                recentActivity.map((activity, index) => (
                  <div
                    key={activity.id}
                    className={`flex gap-3.5 py-3 ${
                      index !== recentActivity.length - 1 ? "border-b border-[#252836]" : ""
                    }`}
                  >
                    <div
                      className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${
                        activity.type === "credit"
                          ? "bg-[rgba(91,141,239,0.1)]"
                          : activity.type === "behavioral"
                          ? "bg-[rgba(45,212,168,0.1)]"
                          : activity.type === "email"
                          ? "bg-[rgba(245,166,35,0.1)]"
                          : "bg-[rgba(240,104,104,0.1)]"
                      }`}
                    >
                      {activity.type === "credit" ? (
                        <Search className={`h-3.5 w-3.5 text-[#5B8DEF]`} />
                      ) : activity.type === "behavioral" ? (
                        <Globe className={`h-3.5 w-3.5 text-[#2DD4A8]`} />
                      ) : activity.type === "email" ? (
                        <Mail className={`h-3.5 w-3.5 text-[#F5A623]`} />
                      ) : (
                        <Zap className={`h-3.5 w-3.5 text-[#F06868]`} />
                      )}
                    </div>
                    <div>
                      <div className="text-[13px] text-[#F0F1F5] leading-relaxed">
                        <span className="font-semibold">
                          {activity.type === "credit" ? "Análise de Crédito" :
                           activity.type === "behavioral" ? "Análise 360" :
                           activity.type === "email" ? "Email em massa" : "Régua de cobrança"}
                        </span>{" "}
                        {activity.type === "credit" ? `realizada — Score: ${activity.description.split("Score: ")[1] || "N/A"}` :
                         activity.type === "behavioral" ? `concluída — Risco: ${activity.risk || "N/A"}` :
                         "ativada"}
                      </div>
                      <div className="text-[11px] text-[#6B7188] mt-0.5">
                        {activity.company} · {activity.time}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Análises Rápidas Card */}
          <div className="bg-[#1A1D27] border border-[#323647] rounded-[14px] overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-[#252836]">
              <span className="text-[15px] font-semibold text-[#F0F1F5]">Análises Rápidas</span>
            </div>
            <div className="p-4 flex flex-col gap-3">
              {/* Análise de Crédito */}
              <Link href="/super-admin/analises">
                <div className="bg-[#252836] rounded-xl p-4 border border-[#323647] cursor-pointer transition-all hover:border-[#F5A623]">
                  <div className="flex items-center gap-3 mb-2">
                    <Search className="h-5 w-5 text-[#F5A623]" />
                    <span className="font-semibold text-[15px] text-[#F0F1F5]">Análise de Crédito</span>
                  </div>
                  <p className="text-xs text-[#6B7188] leading-relaxed">
                    Consulta restritiva, score de crédito, pendências financeiras e histórico de inadimplência via SERPRO.
                  </p>
                  <div className="mt-2.5 text-xs text-[#F5A623] font-semibold flex items-center gap-1">
                    Executar Análise <ArrowRight className="h-3 w-3" />
                  </div>
                </div>
              </Link>

              {/* Análise 360 */}
              <Link href="/super-admin/analises/comportamental">
                <div className="bg-[#252836] rounded-xl p-4 border border-[#323647] cursor-pointer transition-all hover:border-[#5B8DEF]">
                  <div className="flex items-center gap-3 mb-2">
                    <Globe className="h-5 w-5 text-[#5B8DEF]" />
                    <span className="font-semibold text-[15px] text-[#F0F1F5]">Análise 360</span>
                  </div>
                  <p className="text-xs text-[#6B7188] leading-relaxed">
                    Visão completa: crédito + comportamental + propensão de pagamento com IA preditiva.
                  </p>
                  <div className="mt-2.5 text-xs text-[#5B8DEF] font-semibold flex items-center gap-1">
                    Executar Análise <ArrowRight className="h-3 w-3" />
                  </div>
                </div>
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
