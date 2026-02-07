"use server"

import { createAdminClient } from "@/lib/supabase/admin"

export async function getAnalysesData() {
  try {
    console.log("[SERVER] getAnalysesData - Starting (VMAX ONLY)...")

    const supabase = createAdminClient()

    // SOMENTE dados da tabela VMAX (tabela customers foi descontinuada)
    // Buscar registros com análise RESTRITIVA (restrictive_analysis_logs ou analysis_metadata antigo)
    const { data: vmaxData, error: vmaxError } = await supabase
      .from("VMAX")
      .select(
        'id, Cliente, "CPF/CNPJ", id_company, Cidade, "Dias Inad.", credit_score, risk_level, approval_status, analysis_metadata, last_analysis_date, recovery_score, recovery_class, restrictive_analysis_logs, restrictive_analysis_date',
      )
      .or("restrictive_analysis_logs.not.is.null,analysis_metadata.not.is.null") // Com análise restritiva
      .order("restrictive_analysis_date", { ascending: false, nullsFirst: false })

    if (vmaxError) {
      console.error("[SERVER] Error loading VMAX:", vmaxError)
    }

    console.log("[SERVER] getAnalysesData - VMAX records loaded:", vmaxData?.length || 0)

    const { data: profilesData, error: profilesError } = await supabase
      .from("credit_profiles")
      .select("*")
      .eq("source", "assertiva")
      .order("created_at", { ascending: false })

    if (profilesError) {
      console.error("[SERVER] Error loading profiles:", profilesError)
    }

    const allAnalyses = [
      ...(vmaxData || []).map((v) => ({
        id: v.id,
        customer_id: v.id,
        name: v.Cliente,
        document: v["CPF/CNPJ"],
        company_id: v.id_company,
        city: v.Cidade || "N/A",
        source_table: "vmax" as const,
        dias_inad: Number(String(v["Dias Inad."] || "0").replace(/\D/g, "")) || 0,
        credit_score: v.credit_score,
        risk_level: v.risk_level,
        approval_status: v.approval_status,
        // Usar restrictive_analysis_logs se existir, senão analysis_metadata (compatibilidade)
        analysis_metadata: v.restrictive_analysis_logs || v.analysis_metadata,
        last_analysis_date: v.restrictive_analysis_date || v.last_analysis_date,
      })),
      ...(profilesData || []).map((p) => ({
        id: p.id,
        customer_id: p.customer_id,
        name: p.name || "N/A",
        document: "N/A",
        company_id: p.company_id,
        city: p.city || "N/A",
        source_table: "credit_profiles" as const,
        dias_inad: 0,
        credit_score: p.score,
        risk_level: p.risk_level,
        approval_status: null,
        analysis_metadata: p.assertiva_data,
        last_analysis_date: p.created_at,
      })),
    ]

    console.log("[SERVER] getAnalysesData - Total analyses (VMAX + profiles):", allAnalyses.length)

    if (allAnalyses.length === 0) {
      return { success: true, data: [] }
    }

    const companyIds = [...new Set(allAnalyses.map((c) => c.company_id).filter(Boolean))]
    const { data: companiesData } = await supabase.from("companies").select("id, name").in("id", companyIds)

    const companiesMap = new Map(companiesData?.map((c) => [c.id, c]) || [])

    const formattedAnalyses = allAnalyses.map((analysis) => {
      const company = companiesMap.get(analysis.company_id)

      return {
        id: analysis.id,
        customer_id: analysis.customer_id,
        company_id: analysis.company_id,
        cpf: analysis.document || "N/A",
        score: analysis.credit_score || 0,
        source: "assertiva",
        analysis_type: "detailed",
        status: "completed",
        created_at: analysis.last_analysis_date || new Date().toISOString(),
        customer_name: analysis.name || "N/A",
        company_name: company?.name || "N/A",
        source_table: analysis.source_table,
        data: analysis.analysis_metadata,
        assertiva_data: analysis.analysis_metadata?.assertiva_data || analysis.analysis_metadata,
        dias_inad: analysis.dias_inad,
        risk_level: analysis.risk_level,
        approval_status: analysis.approval_status,
      }
    })

    console.log("[SERVER] getAnalysesData - Formatted analyses:", formattedAnalyses.length)

    return { success: true, data: formattedAnalyses }
  } catch (error: any) {
    console.error("[SERVER] getAnalysesData - Error:", error)
    return { success: false, error: error.message, data: [] }
  }
}

export async function getCustomerDetails(customerId: string) {
  try {
    console.log("[SERVER] getCustomerDetails - Starting for customer:", customerId)

    const supabase = createAdminClient()

    const { data: customerData, error: customerError } = await supabase
      .from("customers")
      .select("*")
      .eq("id", customerId)
      .single()

    let customer = customerData
    let isVMAX = false

    if (customerError || !customerData) {
      const { data: vmaxData, error: vmaxError } = await supabase.from("VMAX").select("*").eq("id", customerId).single()

      if (vmaxError || !vmaxData) {
        throw new Error("Cliente não encontrado")
      }

      customer = {
        id: vmaxData.id,
        name: vmaxData.Cliente,
        document: vmaxData["CPF/CNPJ"],
        company_id: vmaxData.id_company,
        city: vmaxData.Cidade,
        dias_inad: Number(String(vmaxData["Dias Inad."] || "0").replace(/\D/g, "")) || 0,
      }
      isVMAX = true
    }

    const { data: profileData } = await supabase
      .from("credit_profiles")
      .select("*")
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single()

    const { data: companyData } = await supabase.from("companies").select("*").eq("id", customer.company_id).single()

    const { data: analysisHistory } = await supabase
      .from("credit_profiles")
      .select("*")
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false })

    return {
      success: true,
      data: {
        customer,
        profile: profileData,
        company: companyData,
        analysisHistory: analysisHistory || [],
        isVMAX,
      },
    }
  } catch (error: any) {
    console.error("[SERVER] getCustomerDetails - Error:", error)
    return { success: false, error: error.message }
  }
}

export async function runAnalysis(customerId: string, document: string) {
  try {
    console.log("[SERVER] runAnalysis - Starting for customer:", customerId, "document:", document)

    const supabase = createAdminClient()

    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const { data: recentProfile } = await supabase
      .from("credit_profiles")
      .select("*")
      .eq("customer_id", customerId)
      .gte("created_at", oneDayAgo)
      .order("created_at", { ascending: false })
      .limit(1)
      .single()

    if (recentProfile) {
      console.log("[SERVER] runAnalysis - Recent analysis found, returning existing data")
      return {
        success: true,
        data: recentProfile,
        message: "Análise recente encontrada (últimas 24 horas)",
      }
    }

    const assertivaUrl = process.env.ASSERTIVA_BASE_URL
    const clientId = process.env.ASSERTIVA_CLIENT_ID
    const clientSecret = process.env.ASSERTIVA_CLIENT_SECRET

    if (!assertivaUrl || !clientId || !clientSecret) {
      throw new Error("Credenciais da API restritiva não configuradas")
    }

    const response = await fetch(`${assertivaUrl}/credit-analysis`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      },
      body: JSON.stringify({
        document: document.replace(/\D/g, ""),
        customer_id: customerId,
      }),
    })

    if (!response.ok) {
      throw new Error(`Erro na API restritiva: ${response.statusText}`)
    }

    const analysisData = await response.json()

    const { data: newProfile, error: insertError } = await supabase
      .from("credit_profiles")
      .insert({
        customer_id: customerId,
        score: analysisData.score || 0,
        source: "assertiva",
        analysis_type: "credit_check",
        data: analysisData,
      })
      .select()
      .single()

    if (insertError) {
      throw insertError
    }

    console.log("[SERVER] runAnalysis - Analysis completed successfully")

    return {
      success: true,
      data: newProfile,
      message: "Análise restritiva realizada com sucesso",
    }
  } catch (error: any) {
    console.error("[SERVER] runAnalysis - Error:", error)
    return {
      success: false,
      error: error.message,
      message: "Erro ao realizar análise restritiva",
    }
  }
}

export async function getAllCustomers() {
  try {
    const supabase = createAdminClient()
    // Buscar TODOS os registros VMAX (sem limite)
    let allVmaxData: any[] = []
    let page = 0
    const pageSize = 1000
    let hasMore = true

    while (hasMore) {
      const { data: vmaxPage, error: vmaxPageError } = await supabase
        .from("VMAX")
        .select(
          'id, Cliente, "CPF/CNPJ", id_company, Cidade, "Dias Inad.", Vencido, credit_score, risk_level, approval_status, analysis_metadata, last_analysis_date, recovery_score, recovery_class, restrictive_analysis_logs, restrictive_analysis_date, behavioral_analysis_logs, behavioral_analysis_date',
        )
        .order("Cliente")
        .range(page * pageSize, (page + 1) * pageSize - 1)

      if (vmaxPageError) {
        console.error("[SERVER] getAllCustomers - Error loading VMAX page:", vmaxPageError)
        break
      }

      if (vmaxPage && vmaxPage.length > 0) {
        allVmaxData = [...allVmaxData, ...vmaxPage]
        page++
        hasMore = vmaxPage.length === pageSize
      } else {
        hasMore = false
      }
    }

    const vmaxData = allVmaxData
    const vmaxError = null

    // SOMENTE dados da tabela VMAX (tabela customers foi descontinuada)
    const allCustomers = (vmaxData || []).map((v) => {
        let score = v.credit_score

        // Usar logs restritivos se existir, senão analysis_metadata (compatibilidade)
        const analysisLogs = v.restrictive_analysis_logs || v.analysis_metadata
        const analysisDate = v.restrictive_analysis_date || v.last_analysis_date

        if (!score && analysisLogs) {
          try {
            const metadata = analysisLogs as any
            score =
              metadata?.assertiva_data?.credito?.resposta?.score?.pontos ||
              metadata?.credito?.resposta?.score?.pontos ||
              null
          } catch (e) {
            console.error("[SERVER] Error extracting score from metadata:", e)
          }
        }

        if (score === 0) {
          score = 5
        }

        // Parse Vencido field (currency string like "R$ 1.234,56" or number)
        let vencido = 0
        if (v.Vencido) {
          const vencidoStr = String(v.Vencido)
          const cleanValue = vencidoStr
            .replace(/R\$/g, "")
            .replace(/\s/g, "")
            .replace(/\./g, "")
            .replace(",", ".")
          vencido = Number(cleanValue) || 0
        }

        return {
          id: v.id,
          name: v.Cliente,
          document: v["CPF/CNPJ"],
          company_id: v.id_company,
          city: v.Cidade || "N/A",
          source_table: "VMAX" as const,
          dias_inad: Number(String(v["Dias Inad."] || "0").replace(/\D/g, "")) || 0,
          vencido,
          credit_score: score,
          risk_level: v.risk_level,
          approval_status: v.approval_status,
          analysis_metadata: analysisLogs,
          last_analysis_date: analysisDate,
          recovery_score: v.recovery_score,
          recovery_class: v.recovery_class,
          // Novos campos separados
          restrictive_analysis_logs: v.restrictive_analysis_logs,
          restrictive_analysis_date: v.restrictive_analysis_date,
          behavioral_analysis_logs: v.behavioral_analysis_logs,
          behavioral_analysis_date: v.behavioral_analysis_date,
      }
    })

    console.log("[SERVER] getAllCustomers - Total VMAX customers:", allCustomers.length)

    if (allCustomers.length === 0) {
      return { success: true, data: [] }
    }

    const companyIds = [...new Set(allCustomers.map((c) => c.company_id).filter(Boolean))]
    const { data: companiesData } = await supabase.from("companies").select("id, name").in("id", companyIds)

    const companiesMap = new Map(companiesData?.map((c) => [c.id, c]) || [])

    const formattedCustomers = allCustomers.map((customer: any) => {
      const company = companiesMap.get(customer.company_id)

      return {
        id: customer.id,
        name: customer.name || "N/A",
        document: customer.document || "N/A",
        city: customer.city,
        company_name: company?.name || "N/A",
        company_id: customer.company_id,
        source_table: customer.source_table,
        dias_inad: customer.dias_inad,
        vencido: customer.vencido,
        credit_score: customer.credit_score,
        risk_level: customer.risk_level,
        approval_status: customer.approval_status,
        analysis_metadata: customer.analysis_metadata,
        last_analysis_date: customer.last_analysis_date,
        recovery_score: customer.recovery_score,
        recovery_class: customer.recovery_class,
        // Novos campos separados para cada tipo de análise
        restrictive_analysis_logs: customer.restrictive_analysis_logs,
        restrictive_analysis_date: customer.restrictive_analysis_date,
        behavioral_analysis_logs: customer.behavioral_analysis_logs,
        behavioral_analysis_date: customer.behavioral_analysis_date,
      }
    })

    console.log("[SERVER] getAllCustomers - Formatted customers:", formattedCustomers.length)

    return { success: true, data: formattedCustomers }
  } catch (error: any) {
    console.error("[SERVER] getAllCustomers - Error:", error)
    return { success: false, error: error.message, data: [] }
  }
}

export async function getAllCompanies() {
  try {
    console.log("[SERVER] getAllCompanies - Starting...")

    const supabase = createAdminClient()

    const { data: companiesData, error: companiesError } = await supabase
      .from("companies")
      .select("id, name")
      .order("name")

    if (companiesError) {
      console.error("[SERVER] getAllCompanies - Error loading companies:", companiesError)
      throw companiesError
    }

    console.log("[SERVER] getAllCompanies - Companies loaded:", companiesData?.length || 0)

    return { success: true, data: companiesData || [] }
  } catch (error: any) {
    console.error("[SERVER] getAllCompanies - Error:", error)
    return { success: false, error: error.message, data: [] }
  }
}

export async function getAutomaticCollectionStats() {
  const supabase = createAdminClient()

  try {
    console.log("[v0] getAutomaticCollectionStats - Starting...")

    const { data: allVmax, error: allVmaxError } = await supabase
      .from("VMAX")
      .select("id, Cliente, approval_status, auto_collection_enabled, collection_processed_at")

    if (allVmaxError) throw allVmaxError

    console.log("[v0] Total VMAX records:", allVmax?.length || 0)
    console.log("[v0] VMAX with ACEITA status:", allVmax?.filter((v) => v.approval_status === "ACEITA").length || 0)
    console.log(
      "[v0] VMAX with auto_collection_enabled:",
      allVmax?.filter((v) => v.auto_collection_enabled).length || 0,
    )

    // Buscar clientes elegíveis para régua automática (ACEITA + auto_collection_enabled)
    const { data: eligible, error: eligibleError } = await supabase
      .from("VMAX")
      .select("id, Cliente, Vencido, collection_count, last_collection_attempt, collection_processed_at")
      .eq("approval_status", "ACEITA")
      .eq("auto_collection_enabled", true)

    if (eligibleError) throw eligibleError

    console.log("[v0] Eligible for auto collection:", eligible?.length || 0)

    // Buscar últimas ações de cobrança automática
    const { data: recentActions, error: actionsError } = await supabase
      .from("collection_actions")
      .select("*")
      .eq("action_type", "auto_collection")
      .order("created_at", { ascending: false })
      .limit(10)

    if (actionsError) throw actionsError

    console.log("[v0] Recent auto collection actions:", recentActions?.length || 0)

    // Calcular estatísticas
    const notProcessed = eligible?.filter((d) => !d.collection_processed_at) || []
    const alreadyProcessed = eligible?.filter((d) => d.collection_processed_at) || []
    const lastExecution = recentActions?.[0]?.created_at || null

    console.log(
      "[v0] Stats - eligible:",
      eligible?.length || 0,
      "notProcessed:",
      notProcessed.length,
      "alreadyProcessed:",
      alreadyProcessed.length,
    )

    return {
      eligible: eligible?.length || 0,
      notProcessed: notProcessed.length,
      alreadyProcessed: alreadyProcessed.length,
      recentActions: recentActions || [],
      lastExecution,
    }
  } catch (error) {
    console.error("[v0] Error fetching automatic collection stats:", error)
    return {
      eligible: 0,
      notProcessed: 0,
      alreadyProcessed: 0,
      recentActions: [],
      lastExecution: null,
    }
  }
}
