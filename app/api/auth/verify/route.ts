import { createClient } from "@/lib/supabase/server"
import { type NextRequest, NextResponse } from "next/server"

// Esta rota captura os redirects do Supabase após verificar o token
// O Supabase redireciona para: redirect_to + #access_token=xxx&refresh_token=xxx&type=recovery
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const token = searchParams.get("token")
  const type = searchParams.get("type")
  
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, "") || request.nextUrl.origin
  
  // Se tiver token de recovery, redireciona para processar
  if (token && type === "recovery") {
    const redirectUrl = new URL("/auth/confirm", baseUrl)
    redirectUrl.searchParams.set("token_hash", token)
    redirectUrl.searchParams.set("type", "recovery")
    return NextResponse.redirect(redirectUrl)
  }
  
  // Fallback - redireciona para página de reset com os parâmetros
  if (type === "recovery") {
    const redirectUrl = new URL("/auth/reset-password", baseUrl)
    // Copia todos os parâmetros da URL
    searchParams.forEach((value, key) => {
      redirectUrl.searchParams.set(key, value)
    })
    return NextResponse.redirect(redirectUrl)
  }
  
  // Para outros tipos ou sem parâmetros, vai para login
  return NextResponse.redirect(new URL("/auth/login", baseUrl))
}
