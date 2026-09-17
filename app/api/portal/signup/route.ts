import { createClient } from "@supabase/supabase-js"
import { NextResponse } from "next/server"
import { getServerSupabaseUrl } from "@/lib/supabase/url"

export const dynamic = "force-dynamic"

// Supabase Admin client for user management
const supabaseAdmin = createClient(
  getServerSupabaseUrl(),
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

function cleanDoc(doc: string): string {
  return doc.replace(/[^0-9]/g, "")
}

function validateCPF(cpf: string): boolean {
  const d = cleanDoc(cpf)
  if (d.length !== 11 || /^(\d)\1+$/.test(d)) return false
  let sum = 0
  for (let i = 0; i < 9; i++) sum += parseInt(d[i]) * (10 - i)
  let check = 11 - (sum % 11)
  if (check >= 10) check = 0
  if (parseInt(d[9]) !== check) return false
  sum = 0
  for (let i = 0; i < 10; i++) sum += parseInt(d[i]) * (11 - i)
  check = 11 - (sum % 11)
  if (check >= 10) check = 0
  return parseInt(d[10]) === check
}

function validateCNPJ(cnpj: string): boolean {
  const d = cleanDoc(cnpj)
  if (d.length !== 14 || /^(\d)\1+$/.test(d)) return false
  const w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
  const w2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
  let sum = 0
  for (let i = 0; i < 12; i++) sum += parseInt(d[i]) * w1[i]
  let check = sum % 11 < 2 ? 0 : 11 - (sum % 11)
  if (parseInt(d[12]) !== check) return false
  sum = 0
  for (let i = 0; i < 13; i++) sum += parseInt(d[i]) * w2[i]
  check = sum % 11 < 2 ? 0 : 11 - (sum % 11)
  return parseInt(d[13]) === check
}

export async function POST(request: Request) {
  try {
    const { email, password, full_name, document_type, document_number, phone } = await request.json()

    // Validate required fields
    if (!email || !password || !full_name || !document_type || !document_number) {
      return NextResponse.json(
        { error: "Preencha todos os campos obrigatorios." },
        { status: 400 }
      )
    }

    const cleaned = cleanDoc(document_number)

    // Validate document
    if (document_type === "cpf" && !validateCPF(cleaned)) {
      return NextResponse.json({ error: "CPF invalido." }, { status: 400 })
    }
    if (document_type === "cnpj" && !validateCNPJ(cleaned)) {
      return NextResponse.json({ error: "CNPJ invalido." }, { status: 400 })
    }

    // Check if document already registered
    const { data: existingDoc } = await supabaseAdmin
      .from("final_clients")
      .select("id")
      .eq("document_number", cleaned)
      .maybeSingle()

    if (existingDoc) {
      return NextResponse.json(
        { error: "Este documento ja esta cadastrado. Faca login com seu email." },
        { status: 409 }
      )
    }

    // Create auth user using Supabase Admin API
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: email.toLowerCase().trim(),
      password,
      email_confirm: true,
      user_metadata: {
        full_name,
        document_type,
        document_number: cleaned,
        role: "final_client",
      },
    })

    if (authError) {
      if (authError.message?.includes("already been registered")) {
        return NextResponse.json(
          { error: "Este email ja possui uma conta. Faca login." },
          { status: 409 }
        )
      }
      console.error("[PORTAL-SIGNUP] Auth error:", authError)
      return NextResponse.json({ error: "Erro ao criar conta." }, { status: 500 })
    }

    // Create final_clients record
    const { error: insertError } = await supabaseAdmin.from("final_clients").insert({
      user_id: authData.user.id,
      email: email.toLowerCase().trim(),
      full_name,
      document_type,
      document_number: cleaned,
      phone: phone || null,
      password_hash: null, // Not used with Supabase Auth
    })

    if (insertError) {
      console.error("[PORTAL-SIGNUP] Insert error:", insertError)
      // Rollback: delete the auth user
      await supabaseAdmin.auth.admin.deleteUser(authData.user.id)
      return NextResponse.json({ error: "Erro ao criar perfil." }, { status: 500 })
    }

    console.log(`[PORTAL-SIGNUP] Created account for ${email} with document ${cleaned}`)

    return NextResponse.json({
      success: true,
      message: "Conta criada com sucesso! Faca login para acessar.",
    })
  } catch (err: any) {
    console.error("[PORTAL-SIGNUP] Error:", err)
    return NextResponse.json({ error: "Erro interno." }, { status: 500 })
  }
}
