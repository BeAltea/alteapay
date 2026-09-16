import { createClient } from "@supabase/supabase-js"
import { NextResponse } from "next/server"
import { getServerSupabaseUrl } from "@/lib/supabase/url"

export async function POST(request: Request) {
  try {
    const { email, cnpj } = await request.json()

    console.log("[API] Buscando empresa por email/CNPJ:", { email, cnpj })

    const supabase = createClient(
      getServerSupabaseUrl(),
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      }
    )

    // Fetch all companies (service role bypasses RLS)
    const { data: allCompanies, error } = await supabase
      .from("companies")
      .select("*")

    if (error) {
      console.error("[API] Erro ao buscar companies:", error)
      return NextResponse.json({ company: null, error: error.message })
    }

    console.log("[API] Total de empresas encontradas:", allCompanies?.length || 0)
    
    if (allCompanies && allCompanies.length > 0) {
      console.log("[API] Empresas no banco:", allCompanies.map((c: any) => ({
        name: c.name,
        cnpj: c.cnpj,
        email: c.email
      })))
    }

    // Find matching company
    const foundCompany = allCompanies?.find((comp: any) => {
      const companyCnpj = comp.cnpj?.replace(/\D/g, "")
      const inputCnpj = cnpj?.replace(/\D/g, "")
      const cnpjMatch = companyCnpj === inputCnpj
      const emailMatch = comp.email?.toLowerCase() === email?.toLowerCase()
      
      console.log("[API] Comparando:", {
        company: comp.name,
        companyCnpj,
        inputCnpj,
        cnpjMatch,
        companyEmail: comp.email,
        inputEmail: email,
        emailMatch
      })
      
      return cnpjMatch || emailMatch
    })

    console.log("[API] Empresa encontrada:", foundCompany ? foundCompany.name : "Nenhuma")

    return NextResponse.json({ company: foundCompany || null, error: null })
  } catch (error) {
    console.error("[API] Erro no check-company:", error)
    return NextResponse.json({ company: null, error: "Erro interno do servidor" })
  }
}
