"use server"

import { createAdminClient } from "@/lib/supabase/admin"

interface AsyncAnalysisParams {
  documento: string
  identificador?: string
  tipo: "pf" | "pj"
  customerId?: string
  companyId?: string
  consultasAdicionais?: string[]
  analysisType?: "restrictive" | "behavioral" // Tipo de análise: restritiva ou comportamental
}

export async function runAsyncAssertivaAnalysis(params: AsyncAnalysisParams) {
  try {
    console.log("[RUN ASYNC ANALYSIS] Starting analysis for:", params.documento, "type:", params.tipo)

    const { documento, tipo, identificador, customerId, companyId, consultasAdicionais, analysisType = "behavioral" } = params

    const cleanDoc = documento.replace(/\D/g, "")

    let finalCompanyId = companyId

    if (!finalCompanyId && customerId) {
      const supabaseAdmin = createAdminClient()

      // Primeiro tentar na tabela customers
      const { data: customerData, error: customerError } = await supabaseAdmin
        .from("customers")
        .select("company_id")
        .eq("id", customerId)
        .maybeSingle()

      if (customerData?.company_id) {
        finalCompanyId = customerData.company_id
        console.log("[RUN ASYNC ANALYSIS] company_id found in customers:", finalCompanyId)
      }

      // Se não encontrou, buscar na tabela VMAX pelo ID
      if (!finalCompanyId) {
        const { data: vmaxData, error: vmaxError } = await supabaseAdmin
          .from("VMAX")
          .select("id_company")
          .eq("id", customerId)
          .maybeSingle()

        if (vmaxData?.id_company) {
          finalCompanyId = vmaxData.id_company
          console.log("[RUN ASYNC ANALYSIS] company_id found in VMAX:", finalCompanyId)
        } else if (vmaxError) {
          console.error("[RUN ASYNC ANALYSIS] VMAX query error:", vmaxError)
        }
      }
    }

    // Tentar buscar na tabela customers primeiro
    if (!finalCompanyId) {
      const supabaseAdmin = createAdminClient()

      const { data: customerData, error: customerError } = await supabaseAdmin
        .from("customers")
        .select("company_id")
        .eq("document", cleanDoc)
        .maybeSingle()

      if (customerData?.company_id) {
        finalCompanyId = customerData.company_id
        console.log("[RUN ASYNC ANALYSIS] company_id found in customers:", finalCompanyId)
      }

      // Se não encontrou, buscar na tabela VMAX
      if (!finalCompanyId) {
        const { data: vmaxData, error: vmaxError } = await supabaseAdmin
          .from("VMAX")
          .select('id_company, "CPF/CNPJ"')
          .eq('"CPF/CNPJ"', cleanDoc)
          .maybeSingle()

        if (vmaxData?.id_company) {
          finalCompanyId = vmaxData.id_company
          console.log("[RUN ASYNC ANALYSIS] company_id found in VMAX:", finalCompanyId)
        } else if (vmaxError) {
          console.error("[RUN ASYNC ANALYSIS] VMAX query error:", vmaxError)
        }
      }
    }

    console.log("[RUN ASYNC ANALYSIS] Final company_id:", finalCompanyId)

    if (!finalCompanyId) {
      throw new Error("Cliente não encontrado no sistema. Importe o cliente antes de fazer a análise.")
    }

    // Validar documento
    if (tipo === "pf" && cleanDoc.length !== 11) {
      throw new Error("CPF inválido")
    }
    if (tipo === "pj" && cleanDoc.length !== 14) {
      throw new Error("CNPJ inválido")
    }

    const baseUrl = process.env.ASSERTIVA_BASE_URL
    const clientId = process.env.ASSERTIVA_CLIENT_ID
    const clientSecret = process.env.ASSERTIVA_CLIENT_SECRET
    const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "https://alteapay.com").replace(/\/+$/, "")

    if (!baseUrl || !clientId || !clientSecret) {
      throw new Error("Credenciais da Assertiva não configuradas")
    }

    console.log("[RUN ASYNC ANALYSIS] Generating OAuth token...")
    const tokenResponse = await fetch(`${baseUrl}/oauth2/v3/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      },
      body: "grant_type=client_credentials",
    })

    if (!tokenResponse.ok) {
      throw new Error(`Erro ao gerar token: ${tokenResponse.statusText}`)
    }

    const { access_token } = await tokenResponse.json()
    console.log("[RUN ASYNC ANALYSIS] Token generated successfully")

    const callbackUrl = `${appUrl.replace(/\/$/, "")}/api/assertiva/callback`

    const generatedId = identificador || `${tipo}_${cleanDoc}_${Date.now()}`
    const payload = [
      {
        urlEntregaResultado: callbackUrl,
        identificador: generatedId,
        doc: cleanDoc,
        idFinalidade: 2,
        consultasAdicionais: consultasAdicionais || [],
      },
    ]

    const endpoint = tipo === "pf" ? `${baseUrl}/credito/v1/pf` : `${baseUrl}/credito/v1/pj`

    console.log("[RUN ASYNC ANALYSIS] Calling Assertiva API:", endpoint)
    console.log("[RUN ASYNC ANALYSIS] Payload:", JSON.stringify(payload, null, 2))

    const startTime = Date.now()
    const analysisResponse = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${access_token}`,
      },
      body: JSON.stringify(payload),
    })

    if (!analysisResponse.ok) {
      const errorText = await analysisResponse.text()
      console.error("[RUN ASYNC ANALYSIS] API Error:", errorText)
      throw new Error(`Erro na API Assertiva: ${analysisResponse.statusText}`)
    }

    const result = await analysisResponse.json()
    console.log("[RUN ASYNC ANALYSIS] API Response:", JSON.stringify(result, null, 2))

    if (!result?.success || !Array.isArray(result.body) || !result.body[0]?.uuid) {
      throw new Error("Falha ao enviar análise para fila")
    }

    const uuid = result.body[0].uuid
    const identificadorResponse = result.body[0].identificador
    const message = result.body[0].mensagem || "Consulta enviada para processamento"
    const duration = Date.now() - startTime

    console.log("[RUN ASYNC ANALYSIS] Analysis queued successfully. UUID:", uuid)

    const supabaseAdmin = createAdminClient()

    console.log("[RUN ASYNC ANALYSIS] Saving to integration_logs...")
    await supabaseAdmin.from("integration_logs").insert({
      company_id: finalCompanyId,
      cpf: cleanDoc,
      operation: `assertiva_${tipo}_async`,
      status: "success",
      details: {
        uuid,
        identificador: identificadorResponse,
        message,
        tipo,
        documento: cleanDoc,
        endpoint,
      },
      duration_ms: duration,
    })
    console.log("[RUN ASYNC ANALYSIS] integration_logs saved successfully")

    console.log("[RUN ASYNC ANALYSIS] Saving to credit_profiles...")
    console.log("[RUN ASYNC ANALYSIS] Data:", {
      company_id: finalCompanyId,
      customer_id: customerId || null,
      cpf: cleanDoc,
      document_type: tipo === "pf" ? "CPF" : "CNPJ",
      external_id: identificadorResponse,
    })

    const { data: profileData, error: profileError } = await supabaseAdmin
      .from("credit_profiles")
      .upsert(
        {
          company_id: finalCompanyId,
          customer_id: customerId || null,
          cpf: cleanDoc,
          document_type: tipo === "pf" ? "CPF" : "CNPJ",
          source: "assertiva",
          analysis_type: "detailed",
          status: "pending",
          external_id: identificadorResponse,
          data_assertiva: {
            uuid,
            identificador: identificadorResponse,
            queued_at: new Date().toISOString(),
            analysis_category: analysisType, // Salva o tipo de análise para uso no callback
          },
        },
        {
          onConflict: "company_id,cpf,source,analysis_type",
        },
      )
      .select()

    if (profileError) {
      console.error("[RUN ASYNC ANALYSIS] Error saving credit_profiles:", profileError)
    } else {
      console.log("[RUN ASYNC ANALYSIS] credit_profiles saved successfully:", profileData)
    }

    return {
      success: true,
      message: "Análise enviada para processamento assíncrono",
      uuid,
      identificador: identificadorResponse,
      estimatedTime: "2-5 minutos",
    }
  } catch (error: any) {
    console.error("[RUN ASYNC ANALYSIS] Error:", error)
    return {
      success: false,
      error: error.message,
    }
  }
}

export async function checkAsyncAnalysisStatus(identificador: string) {
  try {
    const supabase = createAdminClient()

    const { data: profile, error } = await supabase
      .from("credit_profiles")
      .select("*")
      .eq("external_id", identificador)
      .order("created_at", { ascending: false })
      .limit(1)
      .single()

    if (error) throw error

    return {
      success: true,
      status: profile.status,
      data: profile,
    }
  } catch (error: any) {
    return {
      success: false,
      error: error.message,
    }
  }
}
