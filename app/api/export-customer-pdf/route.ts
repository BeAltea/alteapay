import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { getServerSupabaseUrl } from "@/lib/supabase/url"

export const dynamic = "force-dynamic"

export async function POST(request: NextRequest) {
  try {
    const { customerId } = await request.json()

    if (!customerId) {
      return NextResponse.json({ error: "Customer ID is required" }, { status: 400 })
    }

    const supabaseUrl = getServerSupabaseUrl()
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })

    const { data: cliente, error } = await supabase.from("VMAX").select("*").eq("id", customerId).maybeSingle()

    if (error) {
      console.error("[v0] export-customer-pdf - Error fetching customer:", error)
      return NextResponse.json({ error: "Error fetching customer: " + error.message }, { status: 500 })
    }

    if (!cliente) {
      console.error("[v0] export-customer-pdf - Customer not found:", customerId)
      return NextResponse.json({ error: "Customer not found" }, { status: 404 })
    }

    // Buscar empresa
    let companyData = null
    if (cliente.id_company) {
      const { data: company } = await supabase
        .from("companies")
        .select("id, name")
        .eq("id", cliente.id_company)
        .maybeSingle()

      if (company) {
        companyData = company
      }
    }

    const html = generateCustomerPDFHTML(cliente, companyData)

    return NextResponse.json(
      { html },
      {
        headers: {
          "Content-Type": "application/json",
        },
      },
    )
  } catch (error: any) {
    console.error("[v0] export-customer-pdf - Error:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

function generateCustomerPDFHTML(cliente: any, company: any): string {
  const formatDate = (dateString: string | null) => {
    if (!dateString) return "N/A"
    try {
      // Try DD/MM/YYYY format
      if (typeof dateString === "string" && dateString.includes("/")) {
        return dateString
      }
      return new Date(dateString).toLocaleDateString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      })
    } catch {
      return dateString
    }
  }

  const formatCurrency = (value: any) => {
    if (!value) return "R$ 0,00"
    const numValue =
      typeof value === "string" ? Number.parseFloat(value.replace(/[^\d,-]/g, "").replace(",", ".")) : value
    if (isNaN(numValue)) return "R$ 0,00"
    return `R$ ${numValue.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }

  const getScoreColor = (score: number | null) => {
    if (!score) return "#6B7280"
    if (score >= 700) return "#10B981"
    if (score >= 500) return "#F59E0B"
    return "#EF4444"
  }

  const getRiskLevel = (score: number | null) => {
    if (!score) return "Não Avaliado"
    if (score >= 700) return "Baixo Risco"
    if (score >= 500) return "Risco Médio"
    if (score >= 300) return "Alto Risco"
    return "Risco Muito Alto"
  }

  const assertiva_data = cliente.analysis_metadata || {}
  const scoreRecupere = assertiva_data.score_recupere?.pontos || 0
  const scoreRecupereClass = assertiva_data.score_recupere?.classe || "N/A"
  const scoreRecupereDescricao = assertiva_data.score_recupere?.descricao || ""
  const sancoesNum = assertiva_data.sancoes_ceis_number || 0
  const punicoesNum = assertiva_data.punicoes_cnep_number || 0
  const protestos = assertiva_data.protestos?.lista || []
  const ultimasConsultas = assertiva_data.ultimas_consultas?.lista || []
  const debitos = assertiva_data.debitos?.lista || []
  const chequesSemFundo = assertiva_data.cheques_sem_fundo?.lista || []

  // Extract additional fields
  const pendenciasFinanceiras = assertiva_data.pendencias_financeiras || {}
  const provisoes = pendenciasFinanceiras.lista || []
  const acoes = assertiva_data.acoes?.lista || []
  const participacaoEmpresas = assertiva_data.participacao_empresas?.lista || []
  const participacaoFalencia = assertiva_data.participacao_falencia?.lista || []

  const scoreColor = getScoreColor(cliente.credit_score)
  const riskLevel = getRiskLevel(cliente.credit_score)

  const totalDebitos = debitos.reduce((sum: number, d: any) => {
    const valor =
      typeof d.valor === "string" ? Number.parseFloat(d.valor.replace(/[^\d,-]/g, "").replace(",", ".")) : d.valor
    return sum + (valor || 0)
  }, 0)

  const totalProtestos = protestos.reduce((sum: number, p: any) => {
    const valor =
      typeof p.valor === "string" ? Number.parseFloat(p.valor.replace(/[^\d,-]/g, "").replace(",", ".")) : p.valor
    return sum + (valor || 0)
  }, 0)

  return `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Relatório de Crédito - ${cliente.Cliente}</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      line-height: 1.6;
      color: #0D1B2A;
      background: #F9FAFB;
      padding: 0;
    }
    
    .container {
      max-width: 1200px;
      margin: 0 auto;
      background: white;
      min-height: 100vh;
    }
    
    .no-print {
      padding: 20px;
      background: linear-gradient(135deg, #0D1B2A 0%, #1a2f47 100%);
      color: white;
      text-align: center;
    }
    
    .no-print button {
      background: #D4AF37;
      color: #0D1B2A;
      border: none;
      padding: 14px 36px;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 700;
      cursor: pointer;
      margin-top: 10px;
      transition: all 0.3s ease;
    }
    
    .no-print button:hover {
      background: #E5C158;
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(212, 175, 55, 0.4);
    }
    
    .content {
      padding: 40px;
    }
    
    .header {
      text-align: center;
      margin-bottom: 40px;
      padding-bottom: 20px;
      border-bottom: 4px solid #D4AF37;
    }
    
    .header h1 {
      font-size: 32px;
      color: #0D1B2A;
      margin-bottom: 10px;
      font-weight: 700;
    }
    
    .header p {
      color: #6B7280;
      font-size: 14px;
    }
    
    .company-logo {
      font-size: 20px;
      font-weight: 700;
      color: #D4AF37;
      margin-bottom: 15px;
    }
    
    .section {
      margin-bottom: 35px;
      page-break-inside: avoid;
    }
    
    .section-title {
      font-size: 20px;
      font-weight: 700;
      color: #0D1B2A;
      margin-bottom: 20px;
      padding-bottom: 10px;
      border-bottom: 3px solid #D4AF37;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    
    .section-icon {
      font-size: 24px;
    }
    
    .info-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 20px;
      margin-bottom: 20px;
    }
    
    .info-item {
      padding: 18px;
      background: #F9FAFB;
      border-radius: 10px;
      border-left: 5px solid #D4AF37;
    }
    
    .info-label {
      font-size: 12px;
      color: #6B7280;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      margin-bottom: 6px;
      font-weight: 600;
    }
    
    .info-value {
      font-size: 17px;
      font-weight: 600;
      color: #0D1B2A;
      word-break: break-word;
    }
    
    .score-box {
      background: linear-gradient(135deg, ${scoreColor} 0%, ${scoreColor}dd 100%);
      color: white;
      padding: 40px;
      border-radius: 16px;
      text-align: center;
      margin-bottom: 35px;
      box-shadow: 0 10px 25px rgba(13, 27, 42, 0.3);
    }
    
    .score-value {
      font-size: 80px;
      font-weight: 800;
      margin-bottom: 15px;
      text-shadow: 3px 3px 6px rgba(0, 0, 0, 0.3);
    }
    
    .score-label {
      font-size: 16px;
      opacity: 0.95;
      margin-bottom: 8px;
      font-weight: 500;
    }
    
    .risk-badge {
      display: inline-block;
      padding: 10px 24px;
      background: white;
      color: ${scoreColor};
      border-radius: 25px;
      font-size: 16px;
      font-weight: 700;
      margin-top: 12px;
    }
    
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 15px;
      margin-bottom: 35px;
    }
    
    .summary-card {
      background: #F9FAFB;
      padding: 20px;
      border-radius: 12px;
      text-align: center;
      border: 2px solid #E5E7EB;
    }
    
    .summary-card.danger {
      background: #FEF2F2;
      border-color: #FCA5A5;
    }
    
    .summary-card.warning {
      background: #FFFBEB;
      border-color: #FCD34D;
    }
    
    .summary-card.success {
      background: #F0FDF4;
      border-color: #86EFAC;
    }
    
    .summary-card.info {
      background: #EFF6FF;
      border-color: #93C5FD;
    }
    
    .summary-number {
      font-size: 36px;
      font-weight: 800;
      margin-bottom: 5px;
    }
    
    .summary-label {
      font-size: 13px;
      color: #6B7280;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    
    .list-item {
      padding: 16px;
      background: #F9FAFB;
      border-radius: 8px;
      margin-bottom: 12px;
      border-left: 4px solid #D4AF37;
    }
    
    .list-item-title {
      font-weight: 700;
      color: #0D1B2A;
      margin-bottom: 8px;
      font-size: 15px;
    }
    
    .list-item-detail {
      font-size: 14px;
      color: #6B7280;
      margin-bottom: 4px;
    }
    
    .list-item-detail strong {
      color: #0D1B2A;
      font-weight: 600;
    }
    
    .badge {
      display: inline-block;
      padding: 6px 14px;
      border-radius: 14px;
      font-size: 13px;
      font-weight: 700;
      margin-right: 8px;
      margin-bottom: 8px;
    }
    
    .badge-success {
      background: #D1FAE5;
      color: #065F46;
    }
    
    .badge-danger {
      background: #FEE2E2;
      color: #991B1B;
    }
    
    .badge-warning {
      background: #FEF3C7;
      color: #92400E;
    }
    
    .badge-info {
      background: #DBEAFE;
      color: #1E40AF;
    }
    
    .empty-state {
      text-align: center;
      padding: 40px;
      background: #F9FAFB;
      border-radius: 12px;
      border: 2px dashed #D1D5DB;
    }
    
    .empty-state-icon {
      font-size: 48px;
      margin-bottom: 15px;
      opacity: 0.5;
    }
    
    .empty-state-text {
      color: #6B7280;
      font-size: 15px;
    }
    
    .footer {
      margin-top: 60px;
      padding-top: 30px;
      border-top: 3px solid #D4AF37;
      text-align: center;
      color: #6B7280;
      font-size: 13px;
    }
    
    .footer-logo {
      font-size: 24px;
      font-weight: 700;
      color: #0D1B2A;
      margin-bottom: 10px;
    }
    
    .footer-logo span {
      color: #D4AF37;
    }
    
    .table-container {
      overflow-x: auto;
      margin-top: 15px;
    }
    
    .data-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }
    
    .data-table th {
      background: #0D1B2A;
      color: white;
      padding: 12px;
      text-align: left;
      font-weight: 600;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    
    .data-table td {
      padding: 12px;
      border-bottom: 1px solid #E5E7EB;
    }
    
    .data-table tr:hover {
      background: #F9FAFB;
    }
    
    .financial-highlight {
      background: linear-gradient(135deg, #10B981 0%, #059669 100%);
      color: white;
      padding: 30px;
      border-radius: 12px;
      margin-bottom: 20px;
    }
    
    .financial-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 20px;
      margin-top: 20px;
    }
    
    .financial-item {
      background: rgba(255, 255, 255, 0.2);
      padding: 20px;
      border-radius: 10px;
      text-align: center;
    }
    
    .financial-item-label {
      font-size: 13px;
      opacity: 0.9;
      margin-bottom: 10px;
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    
    .financial-item-value {
      font-size: 28px;
      font-weight: 800;
    }
    
    @media print {
      body {
        background: white;
      }
      
      .no-print {
        display: none !important;
      }
      
      .container {
        max-width: 100%;
      }
      
      .content {
        padding: 20px;
      }
      
      .section {
        page-break-inside: avoid;
      }
      
      .score-box {
        box-shadow: none;
      }
    }
    
    @page {
      margin: 1.5cm;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="no-print">
      <h2>Relatório Pronto para Download</h2>
      <p>Clique no botão abaixo para baixar o relatório em PDF</p>
      <button onclick="window.print()">Baixar como PDF</button>
    </div>
    
    <div class="content">
      <div class="header">
        ${company ? `<div class="company-logo">${company.name}</div>` : ""}
        <h1>Relatório de Análise de Crédito</h1>
        <p>Documento gerado em ${new Date().toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}</p>
      </div>

      <!-- Resumo Executivo -->
      <div class="section">
        <div class="section-title">
          <span class="section-icon">📈</span> Resumo Executivo
        </div>
        <div class="summary-grid">
          <div class="summary-card ${debitos.length === 0 ? "success" : "danger"}">
            <div class="summary-number" style="color: ${debitos.length === 0 ? "#10B981" : "#EF4444"}">
              ${debitos.length}
            </div>
            <div class="summary-label">Débitos</div>
            ${totalDebitos > 0 ? `<div style="font-size: 12px; margin-top: 5px; color: #6B7280;">${formatCurrency(totalDebitos)}</div>` : ""}
          </div>
          <div class="summary-card ${protestos.length === 0 ? "success" : "danger"}">
            <div class="summary-number" style="color: ${protestos.length === 0 ? "#10B981" : "#EF4444"}">
              ${protestos.length}
            </div>
            <div class="summary-label">Protestos</div>
            ${totalProtestos > 0 ? `<div style="font-size: 12px; margin-top: 5px; color: #6B7280;">${formatCurrency(totalProtestos)}</div>` : ""}
          </div>
          <div class="summary-card ${chequesSemFundo.length === 0 ? "success" : "warning"}">
            <div class="summary-number" style="color: ${chequesSemFundo.length === 0 ? "#10B981" : "#F59E0B"}">
              ${chequesSemFundo.length}
            </div>
            <div class="summary-label">Cheques s/ Fundo</div>
          </div>
          <div class="summary-card ${sancoesNum === 0 && punicoesNum === 0 ? "success" : "danger"}">
            <div class="summary-number" style="color: ${sancoesNum === 0 && punicoesNum === 0 ? "#10B981" : "#EF4444"}">
              ${sancoesNum + punicoesNum}
            </div>
            <div class="summary-label">Sanções/Punições</div>
          </div>
        </div>
      </div>

      <!-- Informações Básicas -->
      <div class="section">
        <div class="section-title">
          <span class="section-icon">👤</span> Informações do Cliente
        </div>
        <div class="info-grid">
          <div class="info-item">
            <div class="info-label">Nome Completo</div>
            <div class="info-value">${cliente.Cliente || "N/A"}</div>
          </div>
          <div class="info-item">
            <div class="info-label">CPF/CNPJ</div>
            <div class="info-value">${cliente["CPF/CNPJ"] || "N/A"}</div>
          </div>
          <div class="info-item">
            <div class="info-label">Email</div>
            <div class="info-value" style="font-size: 14px;">${cliente.Email || "N/A"}</div>
          </div>
          <div class="info-item">
            <div class="info-label">Telefone</div>
            <div class="info-value">${cliente["Telefone 1"] || cliente["Telefone 2"] || "N/A"}</div>
          </div>
          <div class="info-item">
            <div class="info-label">Cidade/UF</div>
            <div class="info-value">${cliente.Cidade || "N/A"}</div>
          </div>
          <div class="info-item">
            <div class="info-label">Empresa</div>
            <div class="info-value">${cliente.Empresa || company?.name || "N/A"}</div>
          </div>
        </div>
      </div>

      <!-- Adicionada seção de Capacidade Financeira com Renda Presumida e Limite Presumido -->
      ${
        cliente.presumed_income || cliente.presumed_limit
          ? `
      <div class="section">
        <div class="section-title">
          <span class="section-icon">💳</span> Capacidade Financeira
        </div>
        <div class="financial-highlight">
          <h3 style="margin-bottom: 15px; font-size: 20px;">Análise de Crédito Estimada</h3>
          <div class="financial-grid">
            ${
              cliente.presumed_income
                ? `
            <div class="financial-item">
              <div class="financial-item-label">Renda Presumida</div>
              <div class="financial-item-value">${formatCurrency(cliente.presumed_income)}</div>
            </div>
            `
                : ""
            }
            ${
              cliente.presumed_limit
                ? `
            <div class="financial-item">
              <div class="financial-item-label">Limite Presumido</div>
              <div class="financial-item-value">${formatCurrency(cliente.presumed_limit)}</div>
            </div>
            `
                : ""
            }
          </div>
        </div>
      </div>
      `
          : ""
      }

      <!-- Informações Financeiras -->
      <div class="section">
        <div class="section-title">
          <span class="section-icon">💰</span> Informações Financeiras
        </div>
        <div class="info-grid">
          <div class="info-item">
            <div class="info-label">Valor Vencido</div>
            <div class="info-value" style="color: #EF4444; font-size: 20px;">${formatCurrency(cliente.Vencido)}</div>
          </div>
          <div class="info-item">
            <div class="info-label">Primeira Vencida</div>
            <div class="info-value">${formatDate(cliente.Vecto)}</div>
          </div>
          <div class="info-item">
            <div class="info-label">Dias em Inadimplência</div>
            <div class="info-value" style="color: #F59E0B; font-size: 20px;">${Number(String(cliente["Dias Inad."] || "0").replace(/\D/g, "")) || 0} dias</div>
          </div>
          <div class="info-item">
            <div class="info-label">Status de Aprovação</div>
            <div class="info-value">
              <span class="badge ${cliente.approval_status === "ACEITA" ? "badge-success" : cliente.approval_status === "REJEITA" ? "badge-danger" : "badge-warning"}">
                ${cliente.approval_status || "Pendente"}
              </span>
            </div>
          </div>
          ${
            cliente.approval_reason
              ? `
          <div class="info-item" style="grid-column: span 2;">
            <div class="info-label">Motivo da Aprovação/Rejeição</div>
            <div class="info-value" style="font-size: 14px;">${cliente.approval_reason}</div>
          </div>
          `
              : ""
          }
          <div class="info-item">
            <div class="info-label">Nível de Risco</div>
            <div class="info-value">
              <span class="badge ${cliente.risk_level === "low" ? "badge-success" : cliente.risk_level === "medium" ? "badge-warning" : "badge-danger"}">
                ${cliente.risk_level || "N/A"}
              </span>
            </div>
          </div>
          <div class="info-item">
            <div class="info-label">Classificação de Comportamento</div>
            <div class="info-value">${cliente.behavior_classification || "N/A"}</div>
          </div>
        </div>
      </div>

      <!-- Score de Crédito -->
      ${
        cliente.credit_score
          ? `
      <div class="section">
        <div class="score-box">
          <div class="score-label">Score de Crédito</div>
          <div class="score-value">${cliente.credit_score}</div>
          <div class="risk-badge">${riskLevel}</div>
        </div>
      </div>
      `
          : ""
      }

      <!-- Score Recupere -->
      ${
        scoreRecupere > 0
          ? `
      <div class="section">
        <div class="section-title">
          <span class="section-icon">💎</span> Score Recupere
        </div>
        <div class="score-box" style="background: linear-gradient(135deg, #8B5CF6 0%, #6D28D9 100%);">
          <div class="score-label">Probabilidade de Recuperação</div>
          <div class="score-value">${scoreRecupere}</div>
          <div class="risk-badge" style="color: #8B5CF6;">Classe ${scoreRecupereClass}</div>
          <p style="margin-top: 15px; font-size: 14px; opacity: 0.9;">
            ${scoreRecupereDescricao || "Este score indica a probabilidade de recuperação de crédito baseada no histórico de pagamento e comportamento financeiro."}
          </p>
        </div>
      </div>
      `
          : ""
      }

      <!-- Provisões Públicas -->
      ${
        provisoes.length > 0
          ? `
      <div class="section">
        <div class="section-title">
          <span class="section-icon">⚠️</span> Provisões Públicas (${provisoes.length})
        </div>
        <div class="table-container">
          <table class="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Descrição</th>
                <th>Valor</th>
                <th>Data</th>
              </tr>
            </thead>
            <tbody>
              ${provisoes
                .map(
                  (p: any, idx: number) => `
                <tr>
                  <td>${idx + 1}</td>
                  <td style="max-width: 300px;">${p.descricao || p.tipo || "N/A"}</td>
                  <td style="color: #EF4444;">${formatCurrency(p.valor)}</td>
                  <td>${formatDate(p.data)}</td>
                </tr>
              `,
                )
                .join("")}
            </tbody>
          </table>
        </div>
      </div>
      `
          : ""
      }

      <!-- Débitos Registrados -->
      ${
        debitos.length > 0
          ? `
      <div class="section">
        <div class="section-title">
          <span class="section-icon">⚠️</span> Débitos Registrados (${debitos.length})
        </div>
        <div class="table-container">
          <table class="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Data</th>
                <th>Valor</th>
                <th>Credor</th>
                <th>Tipo</th>
              </tr>
            </thead>
            <tbody>
              ${debitos
                .map(
                  (d: any, idx: number) => `
                <tr>
                  <td>${idx + 1}</td>
                  <td>${formatDate(d.data)}</td>
                  <td><strong style="color: #EF4444;">${formatCurrency(d.valor)}</strong></td>
                  <td>${d.credor || "N/A"}</td>
                  <td>${d.tipo || "N/A"}</td>
                </tr>
              `,
                )
                .join("")}
            </tbody>
            <tfoot>
              <tr style="background: #F3F4F6; font-weight: 700;">
                <td colspan="2" style="text-align: right;">TOTAL:</td>
                <td colspan="3" style="color: #EF4444;">${formatCurrency(totalDebitos)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
      `
          : `
      <div class="section">
        <div class="section-title">
          <span class="section-icon">✓</span> Débitos Registrados
        </div>
        <div class="empty-state">
          <div class="empty-state-icon">✓</div>
          <div class="empty-state-text">Nenhum débito registrado</div>
        </div>
      </div>
      `
      }

      <!-- Protestos -->
      ${
        protestos.length > 0
          ? `
      <div class="section">
        <div class="section-title">
          <span class="section-icon">📋</span> Protestos (${protestos.length})
        </div>
        <div class="table-container">
          <table class="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Data</th>
                <th>Valor</th>
                <th>Cartório</th>
                <th>Cidade/UF</th>
              </tr>
            </thead>
            <tbody>
              ${protestos
                .map(
                  (p: any, idx: number) => `
                <tr>
                  <td>${idx + 1}</td>
                  <td>${formatDate(p.data)}</td>
                  <td><strong style="color: #EF4444;">${formatCurrency(p.valor)}</strong></td>
                  <td>${p.cartorio || "N/A"}</td>
                  <td>${p.cidade || "N/A"} - ${p.uf || "N/A"}</td>
                </tr>
              `,
                )
                .join("")}
            </tbody>
            <tfoot>
              <tr style="background: #F3F4F6; font-weight: 700;">
                <td colspan="2" style="text-align: right;">TOTAL:</td>
                <td colspan="3" style="color: #EF4444;">${formatCurrency(totalProtestos)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
      `
          : `
      <div class="section">
        <div class="section-title">
          <span class="section-icon">✓</span> Protestos
        </div>
        <div class="empty-state">
          <div class="empty-state-icon">✓</div>
          <div class="empty-state-text">Nenhum protesto registrado</div>
        </div>
      </div>
      `
      }

      <!-- Cheques sem Fundo -->
      ${
        chequesSemFundo.length > 0
          ? `
      <div class="section">
        <div class="section-title">
          <span class="section-icon">💳</span> Cheques sem Fundo (${chequesSemFundo.length})
        </div>
        <div class="table-container">
          <table class="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Data</th>
                <th>Banco</th>
                <th>Agência</th>
                <th>Número do Cheque</th>
              </tr>
            </thead>
            <tbody>
              ${chequesSemFundo
                .map(
                  (c: any, idx: number) => `
                <tr>
                  <td>${idx + 1}</td>
                  <td>${formatDate(c.data)}</td>
                  <td>${c.banco || "N/A"}</td>
                  <td>${c.agencia || "N/A"}</td>
                  <td>${c.numero || "N/A"}</td>
                </tr>
              `,
                )
                .join("")}
            </tbody>
          </table>
        </div>
      </div>
      `
          : `
      <div class="section">
        <div class="section-title">
          <span class="section-icon">✓</span> Cheques sem Fundo
        </div>
        <div class="empty-state">
          <div class="empty-state-icon">✓</div>
          <div class="empty-state-text">Nenhum cheque sem fundo registrado</div>
        </div>
      </div>
      `
      }

      <!-- Sanções e Punições -->
      ${
        sancoesNum > 0 || punicoesNum > 0
          ? `
      <div class="section">
        <div class="section-title">
          <span class="section-icon">🚨</span> Sanções e Punições
        </div>
        <div class="info-grid">
          <div class="info-item">
            <div class="info-label">Sanções CEIS</div>
            <div class="info-value" style="color: #EF4444; font-size: 24px;">${sancoesNum}</div>
          </div>
          <div class="info-item">
            <div class="info-label">Punições CNEP</div>
            <div class="info-value" style="color: #EF4444; font-size: 24px;">${punicoesNum}</div>
          </div>
        </div>
      </div>
      `
          : ""
      }

      <!-- Histórico de Consultas -->
      ${
        ultimasConsultas.length > 0
          ? `
      <div class="section">
        <div class="section-title">
          <span class="section-icon">🔍</span> Histórico de Consultas
        </div>
        ${ultimasConsultas
          .map(
            (consulta: any) => `
          <div class="list-item">
            <div class="list-item-detail"><strong>Data:</strong> ${formatDate(consulta.data)}</div>
          </div>
        `,
          )
          .join("")}
      </div>
      `
          : ""
      }

      <div class="footer">
        <div class="footer-logo">
          Altea <span>Pay</span>
        </div>
        <p>Este relatório é confidencial e destinado exclusivamente ao uso autorizado.</p>
        <p>© ${new Date().getFullYear()} Altea Tecnologia. Todos os direitos reservados.</p>
      </div>
    </div>
  </div>
</body>
</html>
`
}
