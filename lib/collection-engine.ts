"use server"

import { createAdminClient } from "@/lib/supabase/server"
import { sendEmail, generateDebtCollectionEmail } from "@/lib/notifications/email"
import { sendSMS, generateDebtCollectionSMS } from "@/lib/notifications/sms"

export type RiskTier = "LOW" | "MEDIUM" | "HIGH"
export type TaskType = "AUTO_MESSAGE" | "ASSISTED_COLLECTION" | "MANUAL_COLLECTION"
export type TaskStatus = "pending" | "in_progress" | "completed" | "cancelled"

/**
 * Motor de Regras de Cobrança Automática
 * Processa dívidas baseado no score de recuperação do devedor
 */
export async function processCollectionByScore(params: {
  debtId: string
  customerId: string
  cpf: string
  amount: number
  dueDate: string
}) {
  const supabase = createAdminClient()

  try {
    // 1. Chamar endpoint /score-check para obter recovery_score
    const appBaseUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/+$/, "")
    const scoreResponse = await fetch(`${appBaseUrl}/api/score-check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cpf: params.cpf,
        customerId: params.customerId,
        debtId: params.debtId,
      }),
    })

    if (!scoreResponse.ok) {
      throw new Error("Falha ao verificar score de recuperação")
    }

    const scoreData = await scoreResponse.json()
    const { recovery_score, recovery_class } = scoreData

    console.log(
      `[v0] Collection Engine - Debt: ${params.debtId}, Recovery Score: ${recovery_score}, Recovery Class: ${recovery_class}`,
    )

    // 2. Motor de Regras interpreta o score de recuperação e executa ação
    let actionResult: any

    // Processa réguas de cobrança (padrão + customizadas)
    actionResult = await processCollectionRules(params.debtId, params.customerId, recovery_score)

    // 3. Registrar log de auditoria
    await supabase.from("integration_logs").insert({
      integration_name: "collection_engine",
      operation: "auto_collection_process",
      request_data: {
        debt_id: params.debtId,
        customer_id: params.customerId,
        cpf: params.cpf,
        amount: params.amount,
      },
      response_data: {
        recovery_score,
        recovery_class,
        action: actionResult?.action,
        task_id: actionResult?.taskId,
      },
      status: "success",
    })

    return {
      success: true,
      recovery_score,
      recovery_class,
      action: actionResult?.action,
      message: actionResult?.message,
    }
  } catch (error: any) {
    console.error("[v0] Collection Engine Error:", error)

    await supabase.from("integration_logs").insert({
      integration_name: "collection_engine",
      operation: "auto_collection_process",
      request_data: params,
      response_data: { error: error.message },
      status: "error",
    })

    return {
      success: false,
      error: error.message,
    }
  }
}

/**
 * Processa réguas de cobrança (padrão + customizadas)
 */
export async function processCollectionRules(debtId: string, customerId: string, recoveryScore: number) {
  const supabase = createAdminClient()

  try {
    // 1. Verificar se existe régua customizada para este cliente
    const { data: customRules } = await supabase
      .from("collection_rules")
      .select("*")
      .eq("is_active", true)
      .eq("rule_type", "custom")
      .contains("active_for_customers", [customerId])
      .gte("max_score", recoveryScore)
      .lte("min_score", recoveryScore)
      .order("priority", { ascending: false })
      .limit(1)

    if (customRules && customRules.length > 0) {
      // Usar régua customizada
      console.log(`[v0] Using custom rule for customer ${customerId}:`, customRules[0].name)
      return await applyCustomRule(debtId, customerId, customRules[0], recoveryScore)
    }

    // 2. Se não houver régua customizada, usar régua padrão baseada em recovery score
    console.log(`[v0] Using default rule for customer ${customerId}`)
    return await applyDefaultRule(debtId, customerId, recoveryScore)
  } catch (error) {
    console.error("[v0] Error processing collection rules:", error)
    throw error
  }
}

/**
 * Aplica régua customizada
 */
async function applyCustomRule(debtId: string, customerId: string, rule: any, recoveryScore: number) {
  const supabase = createAdminClient()

  console.log(`[v0] Applying custom rule: ${rule.name} (${rule.process_type})`)

  if (rule.process_type === "automatic") {
    // Disparo automático
    return await dispatchAutoMessage({ debtId, customerId })
  } else if (rule.process_type === "semi_automatic") {
    // Tarefa assistida
    return await createAssistedCollectionTask({
      debtId,
      customerId,
      priority: rule.priority,
      description: `Régua customizada: ${rule.name} - Recovery Score: ${recoveryScore}`,
    })
  } else {
    // Manual
    return await createManualCollectionTask({
      debtId,
      customerId,
      priority: rule.priority,
      description: `Régua customizada (manual): ${rule.name} - Recovery Score: ${recoveryScore}`,
    })
  }
}

/**
 * Aplica régua padrão do sistema
 * Nova lógica baseada em Recovery Score:
 * - Score >= 294 (Classes C, B, A): Cobrança automática
 * - Score < 294 (Classes D, E, F): Cobrança manual
 */
async function applyDefaultRule(debtId: string, customerId: string, recoveryScore: number) {
  if (recoveryScore >= 294) {
    // CLASSES C, B, A - Cobrança automática permitida
    console.log(`[v0] Recovery Score ${recoveryScore} >= 294 - Automatic collection allowed`)
    return await dispatchAutoMessage({ debtId, customerId })
  } else {
    // CLASSES D, E, F - Cobrança manual obrigatória
    console.log(`[v0] Recovery Score ${recoveryScore} < 294 - Manual collection required`)
    return await createManualCollectionTask({
      debtId,
      customerId,
      priority: "high",
      description: `Cobrança manual obrigatória - Recovery Score: ${recoveryScore} (Classes D, E ou F). Disparos automáticos bloqueados.`,
    })
  }
}

/**
 * RISCO BAIXO - Dispara mensagem automática
 */
async function dispatchAutoMessage(params: any) {
  const supabase = createAdminClient()

  // Buscar dados do cliente e empresa
  const { data: debt } = await supabase
    .from("debts")
    .select(`
      *,
      customer:customers(id, name, email, phone),
      company:companies(id, name)
    `)
    .eq("id", params.debtId)
    .single()

  if (!debt || !debt.customer) {
    throw new Error("Cliente não encontrado")
  }

  const paymentLink = `${(process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/+$/, "")}/user-dashboard/debts/${params.debtId}`

  // Enviar por Email
  if (debt.customer.email) {
    const emailHtml = await generateDebtCollectionEmail({
      customerName: debt.customer.name,
      debtAmount: debt.amount,
      dueDate: new Date(debt.due_date).toLocaleDateString("pt-BR"),
      companyName: debt.company.name,
      paymentLink,
    })

    await sendEmail({
      to: debt.customer.email,
      subject: `Cobrança Automática - ${debt.company.name}`,
      html: emailHtml,
    })
  }

  // Enviar por SMS
  if (debt.customer.phone) {
    const smsBody = await generateDebtCollectionSMS({
      customerName: debt.customer.name,
      debtAmount: debt.amount,
      companyName: debt.company.name,
      paymentLink,
    })

    await sendSMS({
      to: debt.customer.phone,
      body: smsBody,
    })
  }

  // Registrar ação automática
  await supabase.from("collection_actions").insert({
    debt_id: params.debtId,
    action_type: "auto_message",
    status: "sent",
    company_id: debt.company_id,
  })

  return {
    action: "AUTO_MESSAGE",
    message: "Mensagem automática enviada com sucesso (Email + SMS)",
  }
}

/**
 * RISCO MÉDIO - Cria tarefa de cobrança assistida
 */
async function createAssistedCollectionTask(params: any) {
  const supabase = createAdminClient()

  const { data: task } = await supabase
    .from("collection_tasks")
    .insert({
      debt_id: params.debtId,
      customer_id: params.customerId,
      task_type: "ASSISTED_COLLECTION",
      status: "pending",
      priority: params.priority || "medium",
      description: params.description || `Cobrança assistida via WhatsApp - Cliente com risco médio (Score 350-490)`,
      amount: params.amount,
      due_date: params.dueDate,
    })
    .select()
    .single()

  return {
    action: "ASSISTED_COLLECTION",
    taskId: task?.id,
    message: "Tarefa de cobrança assistida criada para operador humano",
  }
}

/**
 * RISCO ALTO - Cria tarefa manual e bloqueia automação
 */
async function createManualCollectionTask(params: any) {
  const supabase = createAdminClient()

  const { data: task } = await supabase
    .from("collection_tasks")
    .insert({
      debt_id: params.debtId,
      customer_id: params.customerId,
      task_type: "MANUAL_COLLECTION",
      status: "pending",
      priority: params.priority || "high",
      description:
        params.description ||
        `Cobrança 100% manual - Cliente com alto risco (Score < 350). Disparos automáticos bloqueados.`,
      amount: params.amount,
      due_date: params.dueDate,
      auto_dispatch_blocked: true,
    })
    .select()
    .single()

  return {
    action: "MANUAL_COLLECTION",
    taskId: task?.id,
    message: "Tarefa de cobrança manual criada. Disparos automáticos bloqueados.",
  }
}
