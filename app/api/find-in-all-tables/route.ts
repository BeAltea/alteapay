import { createClient } from "@supabase/supabase-js"
import { NextResponse } from "next/server"
import { getServerSupabaseUrl } from "@/lib/supabase/url"

export async function POST(request: Request) {
  try {
    const { cpfCnpj } = await request.json()

    if (!cpfCnpj) {
      return NextResponse.json({ error: "CPF/CNPJ é obrigatório" }, { status: 400 })
    }

    const supabaseAdmin = createClient(getServerSupabaseUrl(), process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })

    const cleanCpfCnpj = cpfCnpj.replace(/\D/g, "")
    const formattedCpfCnpj = cpfCnpj

    // Busca empresas e suas tabelas de clientes configuradas
    const { data: companies } = await supabaseAdmin.from("companies").select("id, name, cnpj, customer_table_name")

    const vmaxCompany = companies?.find(
      (c) => c.name?.toUpperCase() === "VMAX" || c.customer_table_name?.toUpperCase() === "VMAX",
    )

    // APENAS busca em tabelas que existem (configuradas nas empresas)
    const tablesToSearch: string[] = []

    if (companies && companies.length > 0) {
      companies.forEach((company) => {
        if (company.customer_table_name) {
          // Só adiciona se a empresa tem uma tabela de clientes configurada
          if (!tablesToSearch.includes(company.customer_table_name)) {
            tablesToSearch.push(company.customer_table_name)
          }
        }
      })
    }

    // Se não há tabelas configuradas, retorna não encontrado
    if (tablesToSearch.length === 0) {
      return NextResponse.json({
        found: false,
        message: "Nenhuma tabela de clientes configurada",
      })
    }

    for (const tableName of tablesToSearch) {
      try {
        // Buscar TODOS os registros (paginação para superar limite de 1000)
        let allRecords: any[] = []
        let page = 0
        const pageSize = 1000
        let hasMore = true

        while (hasMore) {
          const { data: recordsPage, error: fetchError } = await supabaseAdmin
            .from(tableName)
            .select("*")
            .range(page * pageSize, (page + 1) * pageSize - 1)

          if (fetchError) {
            // Silently skip tables that don't exist
            break
          }

          if (recordsPage && recordsPage.length > 0) {
            allRecords = [...allRecords, ...recordsPage]
            page++
            hasMore = recordsPage.length === pageSize
          } else {
            hasMore = false
          }
        }

        if (allRecords.length > 0) {
          const possibleColumns = ["CPF/CNPJ", "cpf_cnpj", "cpf", "cnpj", "document", "Cliente"]

          for (const record of allRecords) {
            for (const colName of possibleColumns) {
              const value = record[colName]
              if (value) {
                const cleanValue = String(value).replace(/\D/g, "")

                if (cleanValue === cleanCpfCnpj || value === formattedCpfCnpj) {
                  const matchingCompany =
                    companies?.find(
                      (c) =>
                        c.customer_table_name === tableName ||
                        c.name.toUpperCase() === tableName.toUpperCase() ||
                        c.name.toUpperCase().replace(/\s+/g, "_") === tableName.toUpperCase(),
                    ) || vmaxCompany

                  return NextResponse.json({
                    found: true,
                    table: tableName,
                    data: record,
                    company_id: matchingCompany?.id || null,
                    company_name: matchingCompany?.name || tableName,
                    column_used: colName,
                  })
                }
              }
            }
          }
        }
      } catch {
        // Silently skip tables with errors
        continue
      }
    }

    return NextResponse.json({
      found: false,
      message: "CPF/CNPJ não encontrado",
    })
  } catch (error) {
    console.error("Erro na busca:", error)
    return NextResponse.json({ error: "Erro interno do servidor" }, { status: 500 })
  }
}
