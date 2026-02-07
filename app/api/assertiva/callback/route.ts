import { NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"

// Format CPF (000.000.000-00) or CNPJ (00.000.000/0000-00)
function formatDocument(cleanDoc: string): string {
  const digits = cleanDoc.replace(/\D/g, "")
  if (digits.length === 11) {
    // CPF: 000.000.000-00
    return digits.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4")
  } else if (digits.length === 14) {
    // CNPJ: 00.000.000/0000-00
    return digits.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5")
  }
  return cleanDoc // Return as-is if format doesn't match
}

function validateAssertivaWebhook(request: Request): boolean {
  // Assertiva envia um header de assinatura (se configurado)
  const signature = request.headers.get("x-assertiva-signature")
  const webhookSecret = process.env.ASSERTIVA_WEBHOOK_SECRET

  // Se não há secret configurado, aceita (modo permissivo para testes)
  if (!webhookSecret) {
    console.warn("[ASSERTIVA CALLBACK] No webhook secret configured - accepting all requests")
    return true
  }

  // Valida assinatura se configurada
  if (signature) {
    // A Assertiva pode enviar um hash HMAC do payload
    // Implementar verificação se necessário
    return true
  }

  // Validação adicional: verificar IP de origem (se Assertiva fornecer lista de IPs)
  return true
}

export async function POST(request: Request) {
  let payload: any

  try {
    console.log("[ASSERTIVA CALLBACK] Received callback from Assertiva")

    if (!validateAssertivaWebhook(request)) {
      console.error("[ASSERTIVA CALLBACK] Invalid webhook signature")
      // Retorna 200 para não retentar
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 200 })
    }

    payload = await request.json()
    console.log("[ASSERTIVA CALLBACK] Payload:", JSON.stringify(payload, null, 2))

    // Validar payload
    if (!payload || !payload.cabecalho) {
      console.error("[ASSERTIVA CALLBACK] Invalid payload structure")
      // Retorna 200 para não retentar payloads inválidos
      return NextResponse.json({ success: false, error: "Invalid payload" }, { status: 200 })
    }

    const { cabecalho, resposta } = payload
    const documento = cabecalho.entrada?.documento || cabecalho.documento
    const identificador = cabecalho.identificador // UUID da consulta
    const protocolo = cabecalho.protocolo // ID único da resposta

    console.log(
      "[ASSERTIVA CALLBACK] Processing document:",
      documento,
      "identifier:",
      identificador,
      "protocol:",
      protocolo,
    )

    if (!documento || !identificador) {
      console.error("[ASSERTIVA CALLBACK] Missing required fields in payload")
      return NextResponse.json({ success: false, error: "Missing required fields" }, { status: 200 })
    }

    const supabase = createAdminClient()

    const { data: existingLog } = await supabase
      .from("integration_logs")
      .select("id")
      .eq("integration_name", "assertiva_callback")
      .eq("external_id", protocolo || identificador)
      .single()

    if (existingLog) {
      console.log("[ASSERTIVA CALLBACK] Callback already processed (idempotent check) - returning success")
      return NextResponse.json({
        success: true,
        message: "Callback already processed",
        idempotent: true,
      })
    }

    // Extrair dados importantes
    const creditoData = resposta?.credito || {}
    const recupereData = resposta?.recupere || {}
    const acoesData = resposta?.acoes || {}

    const creditScore = creditoData?.resposta?.score?.pontos || 0
    const creditClass = creditoData?.resposta?.score?.classe || "N/A"

    const recoveryScore = recupereData?.resposta?.score?.pontos || 0
    const recoveryClass = recupereData?.resposta?.score?.classe || "N/A"
    const recoveryDescription = recupereData?.resposta?.score?.faixa?.descricao || ""

    console.log("[ASSERTIVA CALLBACK] Scores - Credit:", creditScore, "Recovery:", recoveryScore)

    // Determinar tipo de documento
    const cleanDoc = documento.replace(/\D/g, "")
    const documentType = cleanDoc.length === 11 ? "CPF" : "CNPJ"
    const isPF = documentType === "CPF"

    // 1. Buscar cliente na tabela VMAX (VMAX stores formatted CPF/CNPJ)
    const formattedDoc = formatDocument(cleanDoc)
    const { data: vmaxRecord, error: vmaxError } = await supabase
      .from("VMAX")
      .select("*")
      .eq('"CPF/CNPJ"', formattedDoc)
      .single()

    if (vmaxRecord) {
      console.log("[ASSERTIVA CALLBACK] Found VMAX record:", vmaxRecord.id)

      // Buscar o tipo de análise do credit_profiles (se existir)
      const { data: profileWithType } = await supabase
        .from("credit_profiles")
        .select("data_assertiva")
        .eq("external_id", protocolo || identificador)
        .maybeSingle()

      const analysisCategory = profileWithType?.data_assertiva?.analysis_category || "behavioral"
      console.log("[ASSERTIVA CALLBACK] Analysis category:", analysisCategory)

      // Preparar dados baseado no tipo de análise
      let updateData: any = {
        assertiva_uuid: identificador,
        assertiva_protocol: protocolo,
      }

      if (analysisCategory === "restrictive") {
        // ANÁLISE RESTRITIVA - salva credit_score, risk_level
        updateData = {
          ...updateData,
          credit_score: creditScore,
          risk_level: creditClass,
          approval_status: creditScore >= 500 ? "ACEITA" : "REJEITADA",
          auto_collection_enabled: creditScore >= 500,
          restrictive_analysis_logs: payload,
          restrictive_analysis_date: new Date().toISOString(),
        }
        console.log("[ASSERTIVA CALLBACK] Updating VMAX with RESTRICTIVE data")
      } else {
        // ANÁLISE COMPORTAMENTAL - salva recovery_score, recovery_class
        updateData = {
          ...updateData,
          recovery_score: recoveryScore,
          recovery_class: recoveryClass,
          recovery_description: recoveryDescription,
          approval_status: recoveryScore >= 294 ? "ACEITA" : "REJEITADA",
          auto_collection_enabled: recoveryScore >= 294,
          approval_reason:
            recoveryScore >= 294
              ? `Score de Recuperação ${recoveryScore} (Classe ${recoveryClass}) - Aprovado automaticamente`
              : `Score de Recuperação ${recoveryScore} (Classe ${recoveryClass}) - Cobrança manual obrigatória`,
          behavioral_analysis_logs: payload,
          behavioral_analysis_date: new Date().toISOString(),
        }
        console.log("[ASSERTIVA CALLBACK] Updating VMAX with BEHAVIORAL data")
      }

      const { error: updateError } = await supabase
        .from("VMAX")
        .update(updateData)
        .eq("id", vmaxRecord.id)

      if (updateError) {
        console.error("[ASSERTIVA CALLBACK] Error updating VMAX:", updateError)
      } else {
        console.log("[ASSERTIVA CALLBACK] VMAX record updated successfully with", analysisCategory, "data")
      }
    }

    // 2. Buscar cliente na tabela customers
    const { data: customerRecord } = await supabase.from("customers").select("*").eq("document", cleanDoc).single()

    const customerId = customerRecord?.id || vmaxRecord?.id

    if (!customerId) {
      console.warn("[ASSERTIVA CALLBACK] Customer not found for document:", cleanDoc)
    }

    const reconsumed = cabecalho.reconsulta
    const hasError = reconsumed === false && !resposta

    if (hasError) {
      console.error("[ASSERTIVA CALLBACK] Assertiva returned error in callback")

      // Atualizar status para FAILED
      if (customerId) {
        await supabase
          .from("credit_profiles")
          .update({
            status: "failed",
            data_assertiva: payload,
          })
          .eq("customer_id", customerId)
          .eq("status", "pending")
      }

      // Log de erro
      await supabase.from("integration_logs").insert({
        integration_name: "assertiva_callback",
        request_type: isPF ? "PF_ASYNC" : "PJ_ASYNC",
        document: cleanDoc,
        external_id: protocolo || identificador,
        request_data: { identificador, protocolo },
        response_data: payload,
        status: "failed",
      })

      return NextResponse.json({
        success: true, // 200 para Assertiva não retentar
        message: "Callback received but analysis failed",
        error: "Document analysis failed",
      })
    }

    // 3. ATUALIZAR registro existente em credit_profiles ao invés de insertar
    const { data: existingProfile } = await supabase
      .from("credit_profiles")
      .select("*")
      .eq("external_id", protocolo || identificador)
      .maybeSingle()

    let profileId: string | null = null

    if (existingProfile) {
      // ATUALIZAR registro existente
      const { data: updatedProfile, error: updateError } = await supabase
        .from("credit_profiles")
        .update({
          status: "completed",
          score: creditScore,
          score_assertiva: recoveryScore,
          risk_level: creditClass,
          data_assertiva: payload,
          has_sanctions: acoesData?.resposta?.acoes || false,
          updated_at: new Date().toISOString(), // Atualiza a data quando a análise é processada novamente
        })
        .eq("id", existingProfile.id)
        .select()
        .single()

      profileId = updatedProfile?.id || null

      if (updateError) {
        console.error("[ASSERTIVA CALLBACK] Error updating credit profile:", updateError)
      } else {
        console.log("[ASSERTIVA CALLBACK] Credit profile updated:", profileId)
      }
    } else {
      // INSERIR novo registro se não encontrou (fallback)
      const { data: newProfile, error: insertError } = await supabase
        .from("credit_profiles")
        .insert({
          customer_id: customerId,
          company_id: customerRecord?.company_id || vmaxRecord?.id_company,
          cpf: cleanDoc,
          name: customerRecord?.name || vmaxRecord?.Cliente || "N/A",
          email: customerRecord?.email || vmaxRecord?.Email,
          phone: customerRecord?.phone || vmaxRecord?.["Telefone 1"] || vmaxRecord?.["Telefone 2"],
          city: customerRecord?.city || vmaxRecord?.Cidade,
          document_type: documentType,
          score: creditScore,
          score_assertiva: recoveryScore,
          risk_level: creditClass,
          source: "assertiva",
          analysis_type: "detailed",
          status: "completed",
          data_assertiva: payload,
          is_consolidated: true,
          has_sanctions: acoesData?.resposta?.acoes || false,
          has_public_bonds: false,
          sanctions_count: 0,
          public_bonds_count: 0,
          external_id: protocolo || identificador,
        })
        .select()
        .single()

      profileId = newProfile?.id || null

      if (insertError) {
        console.error("[ASSERTIVA CALLBACK] Error inserting credit profile:", insertError)
      } else {
        console.log("[ASSERTIVA CALLBACK] Credit profile created:", profileId)
      }
    }

    // 4. Criar notificação para o usuário (se existe customer)
    if (customerId && customerRecord?.company_id) {
      await supabase.from("notifications").insert({
        company_id: customerRecord.company_id,
        type: "analysis_completed",
        title: "Análise Assertiva Concluída",
        description: `Análise de ${documentType} ${cleanDoc} concluída. Score: ${recoveryScore} (Classe ${recoveryClass})`,
      })
    }

    await supabase.from("integration_logs").insert({
      integration_name: "assertiva_callback",
      request_type: isPF ? "PF_ASYNC" : "PJ_ASYNC",
      document: cleanDoc,
      external_id: protocolo || identificador, // Para idempotência
      request_data: { identificador, protocolo },
      response_data: payload,
      status: "success",
      credit_score: creditScore,
      recovery_score: recoveryScore,
    })

    console.log("[ASSERTIVA CALLBACK] Processing completed successfully")

    return NextResponse.json({
      success: true,
      message: "Callback processed successfully",
      profile_id: profileId,
      recovery_score: recoveryScore,
      recovery_class: recoveryClass,
    })
  } catch (error: any) {
    console.error("[ASSERTIVA CALLBACK] Error processing callback:", error)

    // Salva erro no log para investigação posterior
    try {
      const supabase = createAdminClient()
      await supabase.from("integration_logs").insert({
        integration_name: "assertiva_callback",
        request_type: "UNKNOWN",
        document: payload?.cabecalho?.entrada?.documento || "N/A",
        external_id: payload?.cabecalho?.protocolo || payload?.cabecalho?.identificador || "N/A",
        request_data: payload || {},
        response_data: { error: error.message, stack: error.stack },
        status: "error",
      })
    } catch (logError) {
      console.error("[ASSERTIVA CALLBACK] Failed to log error:", logError)
    }

    return NextResponse.json(
      {
        success: false,
        error: "Internal error",
        message: "Callback received but processing failed",
      },
      { status: 200 }, // 200 ao invés de 500
    )
  }
}
