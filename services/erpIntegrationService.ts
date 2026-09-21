import { createClient } from "@/lib/supabase/server"

export interface ERPCustomer {
  external_id: string
  name: string
  document: string
  email?: string
  phone?: string
  address?: string
  credit_limit?: number
  payment_terms?: string
}

export interface ERPInvoice {
  external_id: string
  customer_external_id: string
  amount: number
  due_date: string
  status: "pending" | "paid" | "overdue"
  description?: string
}

export interface ERPSyncResult {
  success: boolean
  customers_synced: number
  invoices_synced: number
  errors: string[]
}

export class ERPIntegrationService {
  // Sincroniza clientes do ERP para o sistema
  static async syncCustomers(companyId: string, customers: ERPCustomer[]): Promise<ERPSyncResult> {
    console.log("[v0] ERPIntegrationService.syncCustomers - Starting", {
      companyId,
      customersCount: customers.length,
    })

    const supabase = await createClient()
    const errors: string[] = []
    let customersSynced = 0

    for (const erpCustomer of customers) {
      try {
        // Verifica se o cliente já existe
        const { data: existing } = await supabase
          .from("customers")
          .select("id")
          .eq("company_id", companyId)
          .eq("document", erpCustomer.document)
          .single()

        if (existing) {
          // Atualiza cliente existente
          const { error } = await supabase
            .from("customers")
            .update({
              name: erpCustomer.name,
              email: erpCustomer.email,
              phone: erpCustomer.phone,
              updated_at: new Date().toISOString(),
            })
            .eq("id", existing.id)

          if (error) {
            errors.push(`Erro ao atualizar cliente ${erpCustomer.name}: ${error.message}`)
          } else {
            customersSynced++
          }
        } else {
          // Cria novo cliente
          const { error } = await supabase.from("customers").insert({
            company_id: companyId,
            name: erpCustomer.name,
            document: erpCustomer.document,
            document_type: erpCustomer.document.length === 11 ? "cpf" : "cnpj",
            email: erpCustomer.email,
            phone: erpCustomer.phone,
            status: "active",
          })

          if (error) {
            errors.push(`Erro ao criar cliente ${erpCustomer.name}: ${error.message}`)
          } else {
            customersSynced++
          }
        }
      } catch (error) {
        errors.push(
          `Erro ao processar cliente ${erpCustomer.name}: ${error instanceof Error ? error.message : "Erro desconhecido"}`,
        )
      }
    }

    console.log("[v0] ERPIntegrationService.syncCustomers - Completed", {
      customersSynced,
      errorsCount: errors.length,
    })

    return {
      success: errors.length === 0,
      customers_synced: customersSynced,
      invoices_synced: 0,
      errors,
    }
  }

  // Sincroniza faturas do ERP para o sistema
  static async syncInvoices(companyId: string, invoices: ERPInvoice[]): Promise<ERPSyncResult> {
    console.log("[v0] ERPIntegrationService.syncInvoices - Starting", {
      companyId,
      invoicesCount: invoices.length,
    })

    const supabase = await createClient()
    const errors: string[] = []
    let invoicesSynced = 0

    for (const erpInvoice of invoices) {
      try {
        // Busca o cliente pelo external_id
        const { data: customer } = await supabase
          .from("customers")
          .select("id")
          .eq("company_id", companyId)
          .eq("document", erpInvoice.customer_external_id)
          .single()

        if (!customer) {
          errors.push(`Cliente não encontrado para fatura ${erpInvoice.external_id}`)
          continue
        }

        // Verifica se a fatura já existe
        const { data: existing } = await supabase
          .from("debts")
          .select("id")
          .eq("company_id", companyId)
          .eq("customer_id", customer.id)
          .eq("amount", erpInvoice.amount)
          .eq("due_date", erpInvoice.due_date)
          .single()

        if (!existing) {
          // Cria nova dívida (o schema real de `debts` usa `amount`; não existem
          // as colunas original_amount/current_amount).
          const { error } = await supabase.from("debts").insert({
            company_id: companyId,
            customer_id: customer.id,
            amount: erpInvoice.amount,
            due_date: erpInvoice.due_date,
            status: erpInvoice.status === "paid" ? "paid" : "pending",
            description: erpInvoice.description || `Fatura ${erpInvoice.external_id}`,
          })

          if (error) {
            errors.push(`Erro ao criar fatura ${erpInvoice.external_id}: ${error.message}`)
          } else {
            invoicesSynced++
          }
        }
      } catch (error) {
        errors.push(
          `Erro ao processar fatura ${erpInvoice.external_id}: ${error instanceof Error ? error.message : "Erro desconhecido"}`,
        )
      }
    }

    console.log("[v0] ERPIntegrationService.syncInvoices - Completed", {
      invoicesSynced,
      errorsCount: errors.length,
    })

    return {
      success: errors.length === 0,
      customers_synced: 0,
      invoices_synced: invoicesSynced,
      errors,
    }
  }

  // Exporta base de clientes para formato CSV
  static async exportCustomersToCSV(companyId: string): Promise<string> {
    console.log("[v0] ERPIntegrationService.exportCustomersToCSV - Starting", { companyId })

    const supabase = await createClient()

    const { data: customers, error } = await supabase
      .from("customers")
      .select("*")
      .eq("company_id", companyId)
      .order("name")

    if (error) {
      throw new Error(`Erro ao buscar clientes: ${error.message}`)
    }

    // Gera CSV
    const headers = ["Nome", "Documento", "Email", "Telefone", "Status"]
    const rows = customers.map((c) => [c.name, c.document, c.email || "", c.phone || "", c.status])

    const csv = [headers, ...rows].map((row) => row.join(",")).join("\n")

    console.log("[v0] ERPIntegrationService.exportCustomersToCSV - Completed", {
      customersCount: customers.length,
    })

    return csv
  }
}
