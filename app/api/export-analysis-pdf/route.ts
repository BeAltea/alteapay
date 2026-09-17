import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { getServerSupabaseUrl } from "@/lib/supabase/url"

export async function POST(request: NextRequest) {
  try {
    const { analysisId } = await request.json()

    if (!analysisId) {
      return NextResponse.json({ error: "Analysis ID is required" }, { status: 400 })
    }

    console.log("[v0] export-analysis-pdf - Fetching analysis:", analysisId)

    const supabaseUrl = getServerSupabaseUrl()
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })

    const { data: analysis, error } = await supabase
      .from("credit_profiles")
      .select("*")
      .eq("id", analysisId)
      .maybeSingle()

    if (error) {
      console.error("[v0] export-analysis-pdf - Error fetching analysis:", error)
      return NextResponse.json({ error: "Error fetching analysis: " + error.message }, { status: 500 })
    }

    if (!analysis) {
      console.error("[v0] export-analysis-pdf - Analysis not found:", analysisId)
      return NextResponse.json({ error: "Analysis not found" }, { status: 404 })
    }

    let customerData = null
    if (analysis.customer_id) {
      const { data: customer } = await supabase
        .from("VMAX")
        .select('id, "CPF/CNPJ", Cliente, Cidade')
        .eq("id", analysis.customer_id)
        .maybeSingle()

      if (customer) {
        customerData = customer
        console.log("[v0] export-analysis-pdf - Customer data found:", {
          name: customer.Cliente,
          city: customer.Cidade,
        })
      }
    }

    let companyData = null
    if (analysis.company_id) {
      const { data: company } = await supabase
        .from("companies")
        .select("id, name")
        .eq("id", analysis.company_id)
        .maybeSingle()

      if (company) {
        companyData = company
      }
    }

    console.log("[v0] export-analysis-pdf - Analysis found:", {
      id: analysis.id,
      cpf: analysis.cpf,
      score: analysis.score,
      source: analysis.source,
      has_data: !!analysis.data,
      customer_name: customerData?.Cliente || analysis.customer_name,
      customer_city: customerData?.Cidade,
    })

    const customer = {
      name: customerData?.Cliente || analysis.customer_name || "N/A",
      document: analysis.cpf,
      city: customerData?.Cidade || "N/A",
      email: "N/A",
      phone: "N/A",
    }

    // Gerar HTML do PDF
    const html = generatePDFHTML({
      name: customer.name,
      cpf: customer.document,
      city: customer.city,
      email: customer.email,
      phone: customer.phone,
      score: analysis.score,
      source: analysis.source,
      analysis_type: analysis.analysis_type,
      data: analysis.data,
      created_at: analysis.created_at,
      customers: customerData,
      companies: companyData,
    })

    console.log("[v0] export-analysis-pdf - PDF HTML generated successfully")

    return NextResponse.json(
      { html },
      {
        headers: {
          "Content-Type": "application/json",
        },
      },
    )
  } catch (error: any) {
    console.error("[v0] export-analysis-pdf - Error:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

function generatePDFHTML(analysis: any): string {
  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })
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

  const scoreColor = getScoreColor(analysis.score)
  const riskLevel = getRiskLevel(analysis.score)

  const totalCEIS = analysis.data?.sancoes_ceis?.length || 0
  const totalCNEP = analysis.data?.punicoes_cnep?.length || 0
  const totalCEPIM = analysis.data?.impedimentos_cepim?.length || 0
  const totalCEAF = analysis.data?.expulsoes_ceaf?.length || 0
  const totalVinculos = analysis.data?.vinculos_publicos?.length || 0
  const totalRestrictions = totalCEIS + totalCNEP + totalCEPIM + totalCEAF

  const scoreRecupere = analysis.data?.score_recupere?.pontos || analysis.data?.recupere?.resposta?.score?.pontos
  const rendaPresumida =
    analysis.data?.renda_presumida?.valor || analysis.data?.credito?.resposta?.rendaPresumida?.valor
  const debitos = analysis.data?.debitos?.list || analysis.data?.credito?.resposta?.registrosDebitos?.list || []
  const debitosTotal =
    analysis.data?.debitos?.valorTotal || analysis.data?.credito?.resposta?.registrosDebitos?.valorTotal || 0
  const protestos = analysis.data?.protestos?.list || analysis.data?.credito?.resposta?.protestosPublicos?.list || []
  const acoesJudiciais = analysis.data?.acoes_judiciais?.list || analysis.data?.acoes?.resposta?.acoes || []
  const chequesSemFundo = analysis.data?.cheques_sem_fundo || analysis.data?.credito?.resposta?.cheques || []
  const dividasAtivas = analysis.data?.dividas_ativas || analysis.data?.credito?.resposta?.dividasUniao || []
  const analiseComportamental = analysis.data?.analise_comportamental || analysis.data?.comportamental

  return `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Relatório de Análise de Crédito - ${analysis.name}</title>
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
    }
    
    .score-box {
      background: linear-gradient(135deg, #0D1B2A 0%, #1a2f47 100%);
      color: white;
      padding: 40px;
      border-radius: 16px;
      text-align: center;
      margin-bottom: 35px;
      box-shadow: 0 10px 25px rgba(13, 27, 42, 0.3);
      border: 3px solid #D4AF37;
    }
    
    .score-value {
      font-size: 80px;
      font-weight: 800;
      margin-bottom: 15px;
      color: #D4AF37;
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
      background: #D4AF37;
      color: #0D1B2A;
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
    
    .alert-box {
      padding: 18px;
      border-radius: 10px;
      margin-bottom: 18px;
      border-left: 5px solid;
    }
    
    .alert-danger {
      background: #FEF2F2;
      border-color: #EF4444;
      color: #991B1B;
    }
    
    .alert-warning {
      background: #FFFBEB;
      border-color: #F59E0B;
      color: #92400E;
    }
    
    .alert-info {
      background: #EFF6FF;
      border-color: #3B82F6;
      color: #1E40AF;
    }
    
    .alert-success {
      background: #F0FDF4;
      border-color: #10B981;
      color: #065F46;
    }
    
    .alert-title {
      font-weight: 700;
      margin-bottom: 8px;
      font-size: 15px;
    }
    
    .alert-content {
      font-size: 14px;
      line-height: 1.6;
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
    
    .badge {
      display: inline-block;
      padding: 6px 14px;
      border-radius: 14px;
      font-size: 13px;
      font-weight: 700;
      margin-right: 8px;
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
    
    .badge-gold {
      background: #D4AF37;
      color: #0D1B2A;
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
    }
    
    .empty-state-text {
      color: #6B7280;
      font-size: 15px;
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
      <h2>📄 Relatório Pronto para Download</h2>
      <p>Clique no botão abaixo para baixar o relatório em PDF</p>
      <button onclick="window.print()">📥 Baixar como PDF</button>
    </div>
    
    <div class="content">
      <div class="header">
        <h1>📊 Relatório de Análise de Crédito</h1>
        <p>Documento gerado em ${formatDate(analysis.created_at)}</p>
        <div style="margin-top: 15px;">
          <span class="badge badge-gold">
            Análise de Crédito
          </span>
          <span class="badge ${analysis.analysis_type === "free" ? "badge-info" : "badge-success"}">
            ${analysis.analysis_type === "free" ? "Análise Básica" : "Análise Detalhada"}
          </span>
        </div>
      </div>

      <!-- Resumo Executivo -->
      <div class="section">
        <div class="section-title">
          <span class="section-icon">📈</span> Resumo Executivo
        </div>
        <div class="summary-grid">
          <div class="summary-card ${totalRestrictions === 0 ? "success" : totalRestrictions < 5 ? "warning" : "danger"}">
            <div class="summary-number" style="color: ${totalRestrictions === 0 ? "#10B981" : totalRestrictions < 5 ? "#F59E0B" : "#EF4444"}">
              ${totalRestrictions}
            </div>
            <div class="summary-label">Total de Restrições</div>
          </div>
          <div class="summary-card danger">
            <div class="summary-number" style="color: #EF4444">
              ${totalCEIS}
            </div>
            <div class="summary-label">Sanções CEIS</div>
          </div>
          <div class="summary-card warning">
            <div class="summary-number" style="color: #F59E0B">
              ${totalCNEP}
            </div>
            <div class="summary-label">Punições CNEP</div>
          </div>
          <div class="summary-card info">
            <div class="summary-number" style="color: #3B82F6">
              ${totalVinculos}
            </div>
            <div class="summary-label">Vínculos Públicos</div>
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
            <div class="info-value">${analysis.name}</div>
          </div>
          <div class="info-item">
            <div class="info-label">CPF/CNPJ</div>
            <div class="info-value">${analysis.cpf}</div>
          </div>
          <div class="info-item">
            <div class="info-label">Cidade</div>
            <div class="info-value">${analysis.city}</div>
          </div>
          <div class="info-item">
            <div class="info-label">Email</div>
            <div class="info-value">${analysis.email}</div>
          </div>
          <div class="info-item">
            <div class="info-label">Telefone</div>
            <div class="info-value">${analysis.phone}</div>
          </div>
          <div class="info-item">
            <div class="info-label">Data da Análise</div>
            <div class="info-value">${formatDate(analysis.created_at)}</div>
          </div>
        </div>
      </div>

      <!-- Score de Crédito -->
      <div class="section">
        <div class="score-box">
          <div class="score-label">Score de Crédito</div>
          <div class="score-value">${analysis.score || "N/A"}</div>
          <div class="risk-badge">${riskLevel}</div>
        </div>
      </div>

      <!-- Assertiva Data Section -->
      ${
        analysis.source === "assertiva"
          ? `
      <div class="section">
        <div class="section-title">
          <span class="section-icon">📈</span> Score Recupere
        </div>
        <div class="score-box" style="background: linear-gradient(135deg, #10B981 0%, #059669 100%);">
          <div class="score-label">Índice de Recuperação</div>
          <div class="score-value">${scoreRecupere}</div>
          <div class="risk-badge">${analysis.scoreRecupereClass || "N/A"}</div>
        </div>
      </div>
      `
          : ""
      }

      ${
        rendaPresumida !== undefined
          ? `
      <div class="section">
        <div class="section-title">
          <span class="section-icon">💰</span> Renda Presumida
        </div>
        <div class="alert-box alert-info">
          <div class="alert-title">Renda Estimada</div>
          <div class="alert-content" style="font-size: 24px; font-weight: 700;">
            R$ ${rendaPresumida.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}
          </div>
        </div>
      </div>
      `
          : ""
      }

      ${
        debitos.length > 0
          ? `
      <div class="section">
        <div class="section-title">
          <span class="section-icon">⚠️</span> Débitos Registrados (${debitos.length})
        </div>
        ${debitos
          .map(
            (debito: any, idx: number) => `
          <div class="list-item">
            <div class="list-item-title">Débito #${idx + 1} - ${debito.credor || "Credor não informado"}</div>
            <div class="list-item-detail"><strong>Valor:</strong> R$ ${(debito.valor || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}</div>
          </div>
        `,
          )
          .join("")}
        <div class="alert-box alert-warning">
          <div class="alert-title">Total de Débitos</div>
          <div class="alert-content" style="font-size: 20px; font-weight: 700;">
            R$ ${debitosTotal.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}
          </div>
        </div>
      </div>
      `
          : ""
      }

      ${
        protestos.length > 0
          ? `
      <div class="section">
        <div class="section-title">
          <span class="section-icon">🚨</span> Protestos (${protestos.length})
        </div>
        ${protestos
          .map(
            (protesto: any, idx: number) => `
          <div class="list-item">
            <div class="list-item-title">Protesto #${idx + 1} - ${protesto.cartorio || "Cartório não informado"}</div>
            <div class="list-item-detail"><strong>Valor:</strong> R$ ${(protesto.valor || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}</div>
            ${protesto.data ? `<div class="list-item-detail"><strong>Data:</strong> ${new Date(protesto.data).toLocaleDateString("pt-BR")}</div>` : ""}
            ${protesto.cidade ? `<div class="list-item-detail"><strong>Cidade:</strong> ${protesto.cidade}</div>` : ""}
          </div>
        `,
          )
          .join("")}
      </div>
      `
          : ""
      }

      ${
        acoesJudiciais.length > 0
          ? `
      <div class="section">
        <div class="section-title">
          <span class="section-icon">⚖️</span> Ações Judiciais (${acoesJudiciais.length})
        </div>
        ${acoesJudiciais
          .map(
            (acao: any, idx: number) => `
          <div class="list-item">
            <div class="list-item-title">Ação #${idx + 1} - ${acao.tribunal || "Tribunal não informado"}</div>
            ${acao.processo ? `<div class="list-item-detail"><strong>Processo:</strong> ${acao.processo}</div>` : ""}
            ${acao.valorCausa ? `<div class="list-item-detail"><strong>Valor da Causa:</strong> R$ ${acao.valorCausa.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}</div>` : ""}
          </div>
        `,
          )
          .join("")}
      </div>
      `
          : ""
      }

      ${
        chequesSemFundo.length > 0
          ? `
      <div class="section">
        <div class="section-title">
          <span class="section-icon">💳</span> Cheques Sem Fundo (${chequesSemFundo.length})
        </div>
        ${chequesSemFundo
          .map(
            (cheque: any, idx: number) => `
          <div class="list-item">
            <div class="list-item-title">Cheque #${idx + 1}</div>
            ${cheque.banco ? `<div class="list-item-detail"><strong>Banco:</strong> ${cheque.banco}</div>` : ""}
            ${cheque.agencia ? `<div class="list-item-detail"><strong>Agência:</strong> ${cheque.agencia}</div>` : ""}
            ${cheque.quantidade ? `<div class="list-item-detail"><strong>Quantidade:</strong> ${cheque.quantidade}</div>` : ""}
            ${cheque.valor ? `<div class="list-item-detail"><strong>Valor:</strong> R$ ${cheque.valor.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}</div>` : ""}
          </div>
        `,
          )
          .join("")}
      </div>
      `
          : ""
      }

      ${
        dividasAtivas.length > 0
          ? `
      <div class="section">
        <div class="section-title">
          <span class="section-icon">🏛️</span> Dívidas Ativas da União (${dividasAtivas.length})
        </div>
        ${dividasAtivas
          .map(
            (divida: any, idx: number) => `
          <div class="list-item">
            <div class="list-item-title">Dívida #${idx + 1}</div>
            ${divida.tipo ? `<div class="list-item-detail"><strong>Tipo:</strong> ${divida.tipo}</div>` : ""}
            ${divida.numero ? `<div class="list-item-detail"><strong>Número:</strong> ${divida.numero}</div>` : ""}
            ${divida.valor ? `<div class="list-item-detail"><strong>Valor:</strong> R$ ${divida.valor.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}</div>` : ""}
            ${divida.situacao ? `<div class="list-item-detail"><strong>Situação:</strong> ${divida.situacao}</div>` : ""}
          </div>
        `,
          )
          .join("")}
      </div>
      `
          : ""
      }

      ${
        analiseComportamental
          ? `
      <div class="section">
        <div class="section-title">
          <span class="section-icon">📊</span> Análise Comportamental
        </div>
        <div class="alert-box alert-info">
          <div class="alert-title">Status da Consulta</div>
          <div class="alert-content">
            ${analiseComportamental.uuid ? `<div class="list-item-detail"><strong>ID da Consulta:</strong> ${analiseComportamental.uuid}</div>` : ""}
            ${analiseComportamental.mensagem ? `<div class="list-item-detail"><strong>Mensagem:</strong> ${analiseComportamental.mensagem}</div>` : ""}
            ${analiseComportamental.status ? `<div class="list-item-detail"><strong>Status:</strong> ${analiseComportamental.status}</div>` : ""}
          </div>
        </div>
      </div>
      `
          : ""
      }

      <!-- Situação do CPF/CNPJ -->
      <div class="section">
        <div class="section-title">
          <span class="section-icon">📄</span> Situação do Documento
        </div>
        <div class="alert-box ${analysis.data.situacao_cpf === "REGULAR" ? "alert-success" : "alert-danger"}">
          <div class="alert-title">Status: ${analysis.data.situacao_cpf}</div>
          <div class="alert-content">
            ${analysis.data.situacao_cpf === "REGULAR" ? "✅ Documento em situação regular perante a Receita Federal." : "⚠️ Documento com restrições. Verificar pendências junto à Receita Federal."}
          </div>
        </div>
      </div>

      <!-- Sanções CEIS -->
      <div class="section">
        <div class="section-title">
          <span class="section-icon">⚠️</span> Sanções CEIS - Cadastro de Empresas Inidôneas e Suspensas (${totalCEIS})
        </div>
        ${analysis.data.sancoes_ceis
          .map(
            (sancao: any, idx: number) => `
          <div class="list-item">
            <div class="list-item-title">Sanção #${idx + 1} - ${sancao.fonteSancao?.nomeExibicao || sancao.orgaoSancionador || "Órgão não informado"}</div>
            ${sancao.tipoSancao?.descricaoResumida ? `<div class="list-item-detail"><strong>Tipo:</strong> ${sancao.tipoSancao.descricaoResumida}</div>` : ""}
            ${sancao.dataPublicacao ? `<div class="list-item-detail"><strong>Data de Publicação:</strong> ${new Date(sancao.dataPublicacao).toLocaleDateString("pt-BR")}</div>` : ""}
            ${sancao.dataInicioSancao ? `<div class="list-item-detail"><strong>Início:</strong> ${new Date(sancao.dataInicioSancao).toLocaleDateString("pt-BR")}</div>` : ""}
            ${sancao.dataFimSancao ? `<div class="list-item-detail"><strong>Término:</strong> ${new Date(sancao.dataFimSancao).toLocaleDateString("pt-BR")}</div>` : ""}
            ${sancao.fundamentacaoLegal ? `<div class="list-item-detail"><strong>Fundamentação Legal:</strong> ${sancao.fundamentacaoLegal}</div>` : ""}
          </div>
        `,
          )
          .join("")}
      </div>

      <!-- Punições CNEP -->
      <div class="section">
        <div class="section-title">
          <span class="section-icon">🚫</span> Punições CNEP - Cadastro Nacional de Empresas Punidas (${totalCNEP})
        </div>
        ${analysis.data.punicoes_cnep
          .map(
            (punicao: any, idx: number) => `
          <div class="list-item">
            <div class="list-item-title">Punição #${idx + 1} - ${punicao.orgaoSancionador?.nome || "Órgão não informado"}</div>
            ${punicao.tipoSancao?.descricaoResumida ? `<div class="list-item-detail"><strong>Tipo:</strong> ${punicao.tipoSancao.descricaoResumida}</div>` : ""}
            ${punicao.dataPublicacaoSancao ? `<div class="list-item-detail"><strong>Data de Publicação:</strong> ${new Date(punicao.dataPublicacaoSancao).toLocaleDateString("pt-BR")}</div>` : ""}
            ${punicao.dataInicioSancao ? `<div class="list-item-detail"><strong>Início:</strong> ${new Date(punicao.dataInicioSancao).toLocaleDateString("pt-BR")}</div>` : ""}
            ${punicao.dataFimSancao ? `<div class="list-item-detail"><strong>Término:</strong> ${new Date(punicao.dataFimSancao).toLocaleDateString("pt-BR")}</div>` : ""}
            ${punicao.valorMulta ? `<div class="list-item-detail"><strong>Valor da Multa:</strong> R$ ${Number.parseFloat(punicao.valorMulta).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}</div>` : ""}
            ${punicao.fundamentacaoLegal ? `<div class="list-item-detail"><strong>Fundamentação Legal:</strong> ${punicao.fundamentacaoLegal}</div>` : ""}
          </div>
        `,
          )
          .join("")}
      </div>

      <!-- Impedimentos CEPIM -->
      <div class="section">
        <div class="section-title">
          <span class="section-icon">🔒</span> Impedimentos CEPIM - Entidades Privadas sem Fins Lucrativos Impedidas (${totalCEPIM})
        </div>
        ${analysis.data.impedimentos_cepim
          .map(
            (impedimento: any, idx: number) => `
          <div class="list-item">
            <div class="list-item-title">Impedimento #${idx + 1} - ${impedimento.nome || "Nome não informado"}</div>
            ${impedimento.orgao_sancionador ? `<div class="list-item-detail"><strong>Órgão Sancionador:</strong> ${impedimento.orgao_sancionador}</div>` : ""}
            ${impedimento.motivo ? `<div class="list-item-detail"><strong>Motivo:</strong> ${impedimento.motivo}</div>` : ""}
            ${impedimento.uf ? `<div class="list-item-detail"><strong>UF:</strong> ${impedimento.uf}</div>` : ""}
            ${impedimento.cnpj ? `<div class="list-item-detail"><strong>CNPJ:</strong> ${impedimento.cnpj}</div>` : ""}
            ${impedimento.convenio ? `<div class="list-item-detail"><strong>Convênio:</strong> ${impedimento.convenio}</div>` : ""}
          </div>
        `,
          )
          .join("")}
      </div>

      <!-- Expulsões CEAF -->
      <div class="section">
        <div class="section-title">
          <span class="section-icon">❌</span> Expulsões CEAF - Cadastro de Expulsões da Administração Federal (${totalCEAF})
        </div>
        ${analysis.data.expulsoes_ceaf
          .map(
            (expulsao: any, idx: number) => `
          <div class="list-item">
            <div class="list-item-title">Expulsão #${idx + 1} - ${expulsao.nome || "Nome não informado"}</div>
            ${expulsao.orgao ? `<div class="list-item-detail"><strong>Órgão:</strong> ${expulsao.orgao}</div>` : ""}
            ${expulsao.tipoExpulsao ? `<div class="list-item-detail"><strong>Tipo:</strong> ${expulsao.tipoExpulsao}</div>` : ""}
            ${expulsao.data_expulsao ? `<div class="list-item-detail"><strong>Data da Expulsão:</strong> ${new Date(expulsao.data_expulsao).toLocaleDateString("pt-BR")}</div>` : ""}
            ${expulsao.motivo ? `<div class="list-item-detail"><strong>Motivo:</strong> ${expulsao.motivo}</div>` : ""}
            ${expulsao.cargo ? `<div class="list-item-detail"><strong>Cargo:</strong> ${expulsao.cargo}</div>` : ""}
          </div>
        `,
          )
          .join("")}
      </div>

      <!-- Estado Limpo -->
      ${
        totalRestrictions === 0 && totalVinculos === 0
          ? `
      <div class="section">
        <div class="empty-state">
          <div class="empty-state-icon">✅</div>
          <div class="empty-state-text">
            <strong>Nenhuma restrição ou vínculo encontrado!</strong><br>
            Este cliente não possui sanções, punições, impedimentos, expulsões ou vínculos públicos registrados no Portal da Transparência.
          </div>
        </div>
      </div>
      `
          : ""
      }

      <div class="footer">
        <div class="footer-logo">Cobrança<span>Auto</span></div>
        <p>Relatório de Análise de Crédito Completo</p>
        <p>Gerado em ${formatDate(analysis.created_at)}</p>
      </div>
    </div>
  </div>
  
  <script>
    window.addEventListener('load', function() {
      setTimeout(function() {
        // Auto-trigger print can be enabled by uncommenting the line below
        // window.print();
      }, 500);
    });
  </script>
</body>
</html>
  `
}
