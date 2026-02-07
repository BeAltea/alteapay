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
    <div className="w-full space-y-6">
        {/* Page Header */}
        <div className="flex justify-between items-start mb-8">
          <div>
            <h1 className="text-[28px] font-bold text-[var(--sa-text-primary)] font-serif mb-1">
              Painel Super Admin
            </h1>
            <p className="text-sm text-[var(--sa-text-secondary)]">
              Visão geral de todas as empresas e operações da plataforma
            </p>
          </div>
          <Button
            asChild
            className="bg-gradient-to-r from-[var(--sa-gold-400)] to-[var(--sa-gold-600)] text-[var(--sa-bg-primary)] font-semibold px-5 py-2.5 rounded-[10px] shadow-[0_4px_16px_rgba(245,166,35,0.25)] hover:shadow-[0_6px_24px_rgba(245,166,35,0.35)] hover:-translate-y-0.5 transition-all border-0"
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
          <div className="bg-[var(--sa-bg-secondary)] border border-[var(--sa-border-primary)] rounded-[14px] p-5 relative overflow-hidden transition-all hover:border-[var(--sa-border-secondary)] hover:-translate-y-0.5 group">
            <div className="absolute top-0 right-0 w-20 h-20 bg-gradient-radial from-[rgba(245,166,35,0.06)] to-transparent" />
            <div className="w-10 h-10 rounded-[10px] bg-[var(--sa-orange-bg)] flex items-center justify-center mb-3.5">
              <Building2 className="h-[18px] w-[18px] text-[var(--sa-gold-400)]" />
            </div>
            <div className="text-xs text-[var(--sa-text-muted)] uppercase tracking-[1px] font-medium mb-1.5">
              Total de Empresas
            </div>
            <div className="text-[26px] font-bold text-[var(--sa-text-primary)] leading-tight">
              {totalStats.totalCompanies}
            </div>
            <div className="inline-flex items-center gap-1 text-xs mt-2 px-2 py-0.5 rounded-md bg-[var(--sa-green-bg)] text-[var(--sa-green)] font-medium">
              ↑ Ativa
            </div>
          </div>

          {/* Total de Clientes */}
          <div className="bg-[var(--sa-bg-secondary)] border border-[var(--sa-border-primary)] rounded-[14px] p-5 relative overflow-hidden transition-all hover:border-[var(--sa-border-secondary)] hover:-translate-y-0.5 group">
            <div className="absolute top-0 right-0 w-20 h-20 bg-gradient-radial from-[rgba(245,166,35,0.06)] to-transparent" />
            <div className="w-10 h-10 rounded-[10px] bg-[var(--sa-blue-bg)] flex items-center justify-center mb-3.5">
              <Users className="h-[18px] w-[18px] text-[var(--sa-blue)]" />
            </div>
            <div className="text-xs text-[var(--sa-text-muted)] uppercase tracking-[1px] font-medium mb-1.5">
              Total de Clientes
            </div>
            <div className="text-[26px] font-bold text-[var(--sa-text-primary)] leading-tight">
              {totalStats.totalCustomers.toLocaleString("pt-BR")}
            </div>
            <div className="inline-flex items-center gap-1 text-xs mt-2 px-2 py-0.5 rounded-md bg-[var(--sa-green-bg)] text-[var(--sa-green)] font-medium">
              ↑ {totalStats.totalAdmins} admins
            </div>
          </div>

          {/* Valor em Cobrança */}
          <div className="bg-[var(--sa-bg-secondary)] border border-[var(--sa-border-primary)] rounded-[14px] p-5 relative overflow-hidden transition-all hover:border-[var(--sa-border-secondary)] hover:-translate-y-0.5 group">
            <div className="absolute top-0 right-0 w-20 h-20 bg-gradient-radial from-[rgba(245,166,35,0.06)] to-transparent" />
            <div className="w-10 h-10 rounded-[10px] bg-[var(--sa-green-bg)] flex items-center justify-center mb-3.5">
              <DollarSign className="h-[18px] w-[18px] text-[var(--sa-green)]" />
            </div>
            <div className="text-xs text-[var(--sa-text-muted)] uppercase tracking-[1px] font-medium mb-1.5">
              Valor em Cobrança
            </div>
            <div className="text-[26px] font-bold text-[var(--sa-text-primary)] leading-tight">
              {formatCurrency(totalStats.totalAmount)}
            </div>
            <div className="inline-flex items-center gap-1 text-xs mt-2 px-2 py-0.5 rounded-md bg-[var(--sa-red-bg)] text-[var(--sa-red)] font-medium">
              {totalStats.totalDebts.toLocaleString("pt-BR")} dívidas ativas
            </div>
          </div>

          {/* Análises Realizadas */}
          <div className="bg-[var(--sa-bg-secondary)] border border-[var(--sa-border-primary)] rounded-[14px] p-5 relative overflow-hidden transition-all hover:border-[var(--sa-border-secondary)] hover:-translate-y-0.5 group">
            <div className="absolute top-0 right-0 w-20 h-20 bg-gradient-radial from-[rgba(245,166,35,0.06)] to-transparent" />
            <div className="w-10 h-10 rounded-[10px] bg-[var(--sa-red-bg)] flex items-center justify-center mb-3.5">
              <BarChart3 className="h-[18px] w-[18px] text-[var(--sa-red)]" />
            </div>
            <div className="text-xs text-[var(--sa-text-muted)] uppercase tracking-[1px] font-medium mb-1.5">
              Análises Realizadas
            </div>
            <div className="text-[26px] font-bold text-[var(--sa-text-primary)] leading-tight">
              {(analysesCount || 0).toLocaleString("pt-BR")}
            </div>
            <div className="inline-flex items-center gap-1 text-xs mt-2 px-2 py-0.5 rounded-md bg-[var(--sa-green-bg)] text-[var(--sa-green)] font-medium">
              ↑ 18% este mês
            </div>
          </div>
        </div>

        {/* First Two-Column Grid: Companies + System Status */}
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-6 mb-6">
          {/* Empresas Clientes Card */}
          <div className="bg-[var(--sa-bg-secondary)] border border-[var(--sa-border-primary)] rounded-[14px] overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--sa-bg-tertiary)]">
              <span className="text-[15px] font-semibold text-[var(--sa-text-primary)]">Empresas Clientes</span>
              <Link
                href="/super-admin/companies"
                className="text-xs text-[var(--sa-gold-400)] font-medium hover:underline cursor-pointer"
              >
                Ver Todas →
              </Link>
            </div>
            <div className="p-4">
              {companiesStats.length === 0 ? (
                <div className="text-center py-8 text-[var(--sa-text-muted)]">
                  Nenhuma empresa cadastrada
                </div>
              ) : (
                companiesStats.map((company, index) => (
                  <div
                    key={company.id}
                    className={`flex items-center gap-3.5 py-3 ${
                      index !== companiesStats.length - 1 ? "border-b border-[var(--sa-bg-tertiary)]" : ""
                    }`}
                  >
                    <div className="w-10 h-10 rounded-[10px] bg-[var(--sa-border-primary)] flex items-center justify-center text-[var(--sa-gold-400)] font-bold text-sm flex-shrink-0">
                      {company.name.substring(0, 2).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold text-[var(--sa-text-primary)]">{company.name}</div>
                      <div className="text-xs text-[var(--sa-text-muted)]">
                        {company.totalCustomers.toLocaleString("pt-BR")} clientes · {company.totalDebts.toLocaleString("pt-BR")} dívidas
                      </div>
                    </div>
                    <div className="flex gap-6 items-center">
                      <div className="text-right">
                        <div className="text-[10px] text-[var(--sa-text-muted)] uppercase tracking-[0.5px]">Em Cobrança</div>
                        <div className="text-sm font-semibold text-[var(--sa-text-primary)]">{formatCurrency(company.totalAmount)}</div>
                      </div>
                      <div className="text-right">
                        <div className="text-[10px] text-[var(--sa-text-muted)] uppercase tracking-[0.5px]">Status</div>
                        <span className="inline-block px-2.5 py-1 rounded-md text-[11px] font-semibold bg-[var(--sa-red-bg)] text-[var(--sa-red)]">
                          {company.overdueDebts} em atraso
                        </span>
                      </div>
                      <Link href={`/super-admin/companies/${company.id}`}>
                        <button className="w-8 h-8 rounded-lg bg-[var(--sa-bg-tertiary)] border border-[var(--sa-border-primary)] text-[var(--sa-text-muted)] flex items-center justify-center hover:bg-[var(--sa-border-primary)] hover:text-[var(--sa-text-primary)] transition-colors">
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
          <div className="bg-[var(--sa-bg-secondary)] border border-[var(--sa-border-primary)] rounded-[14px] overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--sa-bg-tertiary)]">
              <span className="text-[15px] font-semibold text-[var(--sa-text-primary)]">Visão do Sistema</span>
              <Link
                href="/super-admin/reports"
                className="text-xs text-[var(--sa-gold-400)] font-medium hover:underline cursor-pointer"
              >
                Relatório →
              </Link>
            </div>
            <div className="p-4">
              <div className="flex items-center gap-3 py-3.5 border-b border-[var(--sa-bg-tertiary)]">
                <span className="w-2.5 h-2.5 rounded-full bg-[var(--sa-green)] shadow-[0_0_8px_rgba(45,212,168,0.4)] flex-shrink-0" />
                <span className="text-[13px] font-medium text-[var(--sa-text-primary)] flex-1">Sistema Operacional</span>
                <span className="text-xs text-[var(--sa-text-muted)]">Todas conectadas</span>
              </div>
              <div className="flex items-center gap-3 py-3.5 border-b border-[var(--sa-bg-tertiary)]">
                <span className="w-2.5 h-2.5 rounded-full bg-[var(--sa-gold-400)] shadow-[0_0_8px_rgba(245,166,35,0.4)] flex-shrink-0" />
                <span className="text-[13px] font-medium text-[var(--sa-text-primary)] flex-1">Casos Críticos</span>
                <span className="text-xs text-[var(--sa-gold-400)]">{totalStats.totalOverdue.toLocaleString("pt-BR")}</span>
              </div>
              <div className="flex items-center gap-3 py-3.5 border-b border-[var(--sa-bg-tertiary)]">
                <span className="w-2.5 h-2.5 rounded-full bg-[var(--sa-gold-400)] shadow-[0_0_8px_rgba(245,166,35,0.4)] flex-shrink-0" />
                <span className="text-[13px] font-medium text-[var(--sa-text-primary)] flex-1">Monitoramento IA</span>
                <span className="text-xs text-[var(--sa-text-muted)]">Analisando padrões</span>
              </div>
              <div className="flex items-center gap-3 py-3.5 border-b border-[var(--sa-bg-tertiary)]">
                <span className="w-2.5 h-2.5 rounded-full bg-[var(--sa-green)] shadow-[0_0_8px_rgba(45,212,168,0.4)] flex-shrink-0" />
                <span className="text-[13px] font-medium text-[var(--sa-text-primary)] flex-1">Gateway de Pagamento</span>
                <span className="text-xs text-[var(--sa-text-muted)]">Operacional</span>
              </div>
              <div className="flex items-center gap-3 py-3.5">
                <span className="w-2.5 h-2.5 rounded-full bg-[var(--sa-green)] shadow-[0_0_8px_rgba(45,212,168,0.4)] flex-shrink-0" />
                <span className="text-[13px] font-medium text-[var(--sa-text-primary)] flex-1">SendGrid Email</span>
                <span className="text-xs text-[var(--sa-text-muted)]">Conectado</span>
              </div>
            </div>
          </div>
        </div>

        {/* Second Two-Column Grid: Activity + Quick Analyses */}
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-6">
          {/* Atividade Recente Card */}
          <div className="bg-[var(--sa-bg-secondary)] border border-[var(--sa-border-primary)] rounded-[14px] overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--sa-bg-tertiary)]">
              <span className="text-[15px] font-semibold text-[var(--sa-text-primary)]">Atividade Recente</span>
              <Link
                href="/super-admin/reports"
                className="text-xs text-[var(--sa-gold-400)] font-medium hover:underline cursor-pointer"
              >
                Ver Tudo →
              </Link>
            </div>
            <div className="p-4">
              {recentActivity.length === 0 ? (
                <div className="text-center py-8 text-[var(--sa-text-muted)]">
                  Nenhuma atividade recente
                </div>
              ) : (
                recentActivity.map((activity, index) => (
                  <div
                    key={activity.id}
                    className={`flex gap-3.5 py-3 ${
                      index !== recentActivity.length - 1 ? "border-b border-[var(--sa-bg-tertiary)]" : ""
                    }`}
                  >
                    <div
                      className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${
                        activity.type === "credit"
                          ? "bg-[var(--sa-blue-bg)]"
                          : activity.type === "behavioral"
                          ? "bg-[var(--sa-green-bg)]"
                          : activity.type === "email"
                          ? "bg-[var(--sa-orange-bg)]"
                          : "bg-[var(--sa-red-bg)]"
                      }`}
                    >
                      {activity.type === "credit" ? (
                        <Search className="h-3.5 w-3.5 text-[var(--sa-blue)]" />
                      ) : activity.type === "behavioral" ? (
                        <Globe className="h-3.5 w-3.5 text-[var(--sa-green)]" />
                      ) : activity.type === "email" ? (
                        <Mail className="h-3.5 w-3.5 text-[var(--sa-gold-400)]" />
                      ) : (
                        <Zap className="h-3.5 w-3.5 text-[var(--sa-red)]" />
                      )}
                    </div>
                    <div>
                      <div className="text-[13px] text-[var(--sa-text-primary)] leading-relaxed">
                        <span className="font-semibold">
                          {activity.type === "credit" ? "Análise de Crédito" :
                           activity.type === "behavioral" ? "Análise 360" :
                           activity.type === "email" ? "Email em massa" : "Régua de cobrança"}
                        </span>{" "}
                        {activity.type === "credit" ? `realizada — Score: ${activity.description.split("Score: ")[1] || "N/A"}` :
                         activity.type === "behavioral" ? `concluída — Risco: ${activity.risk || "N/A"}` :
                         "ativada"}
                      </div>
                      <div className="text-[11px] text-[var(--sa-text-muted)] mt-0.5">
                        {activity.company} · {activity.time}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Análises Rápidas Card */}
          <div className="bg-[var(--sa-bg-secondary)] border border-[var(--sa-border-primary)] rounded-[14px] overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--sa-bg-tertiary)]">
              <span className="text-[15px] font-semibold text-[var(--sa-text-primary)]">Análises Rápidas</span>
            </div>
            <div className="p-4 flex flex-col gap-3">
              {/* Análise de Crédito */}
              <Link href="/super-admin/analises">
                <div className="bg-[var(--sa-bg-tertiary)] rounded-xl p-4 border border-[var(--sa-border-primary)] cursor-pointer transition-all hover:border-[var(--sa-gold-400)]">
                  <div className="flex items-center gap-3 mb-2">
                    <Search className="h-5 w-5 text-[var(--sa-gold-400)]" />
                    <span className="font-semibold text-[15px] text-[var(--sa-text-primary)]">Análise de Crédito</span>
                  </div>
                  <p className="text-xs text-[var(--sa-text-muted)] leading-relaxed">
                    Consulta restritiva, score de crédito, pendências financeiras e histórico de inadimplência via SERPRO.
                  </p>
                  <div className="mt-2.5 text-xs text-[var(--sa-gold-400)] font-semibold flex items-center gap-1">
                    Executar Análise <ArrowRight className="h-3 w-3" />
                  </div>
                </div>
              </Link>

              {/* Análise 360 */}
              <Link href="/super-admin/analises/comportamental">
                <div className="bg-[var(--sa-bg-tertiary)] rounded-xl p-4 border border-[var(--sa-border-primary)] cursor-pointer transition-all hover:border-[var(--sa-blue)]">
                  <div className="flex items-center gap-3 mb-2">
                    <Globe className="h-5 w-5 text-[var(--sa-blue)]" />
                    <span className="font-semibold text-[15px] text-[var(--sa-text-primary)]">Análise 360</span>
                  </div>
                  <p className="text-xs text-[var(--sa-text-muted)] leading-relaxed">
                    Visão completa: crédito + comportamental + propensão de pagamento com IA preditiva.
                  </p>
                  <div className="mt-2.5 text-xs text-[var(--sa-blue)] font-semibold flex items-center gap-1">
                    Executar Análise <ArrowRight className="h-3 w-3" />
                  </div>
                </div>
              </Link>
            </div>
          </div>
        </div>
    </div>
  )
}
