import { journeyGate, updateSession } from "@/lib/supabase/middleware"
import type { NextRequest } from "next/server"
import { NextResponse } from "next/server"

/** CSP da página embed do chat white-label: só as origens permitidas do
 * tenant (tenant_chat_config.allowed_origins) podem enquadrá-la em iframe.
 * Consulta via PostgREST com service role (mesmo padrão do updateSession). */
async function embedFrameAncestors(request: NextRequest): Promise<string> {
  const own = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"
  try {
    const base = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!base || !key) return `'self' ${own}`
    const resp = await fetch(
      `${base}/rest/v1/tenant_chat_config?widget_enabled=eq.true&select=allowed_origins`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } },
    )
    if (!resp.ok) return `'self' ${own}`
    const rows = (await resp.json()) as Array<{ allowed_origins: string[] }>
    const origins = new Set<string>([own])
    for (const row of rows) for (const o of row.allowed_origins ?? []) origins.add(o)
    return `'self' ${Array.from(origins).join(" ")}`
  } catch {
    return `'self' ${own}`
  }
}

export async function middleware(request: NextRequest) {
  const currentPath = request.nextUrl.pathname

  if (currentPath.startsWith("/api/")) {
    return NextResponse.next()
  }

  // Páginas legais públicas: sem auth, sem redirect (exigência Meta/ANPD)
  if (currentPath === "/politica-de-privacidade" || currentPath === "/termos-de-uso") {
    return NextResponse.next()
  }

  // Gate D13: jornada pública white-label /c/[token] e endpoint genérico
  // /t/{slug}/negociar. Bloqueia (404) quando a flag está off ou quando o tenant
  // está em modo admin-only sem sessão admin. noindex garantido pelo layout.
  if (currentPath.startsWith("/c/") || currentPath.startsWith("/t/")) {
    const blocked = await journeyGate(request)
    if (blocked) return blocked
    // Autenticado por token/cookie de chat (não por usuário Supabase): não passa
    // por updateSession para não sofrer redirect de rota protegida. Nunca em
    // iframe de terceiros.
    const response = NextResponse.next()
    response.headers.set("X-Frame-Options", "SAMEORIGIN")
    response.headers.set("X-Robots-Tag", "noindex, nofollow")
    return response
  }

  if (currentPath.startsWith("/negociar/embed/")) {
    const response = NextResponse.next()
    response.headers.set(
      "Content-Security-Policy",
      `frame-ancestors ${await embedFrameAncestors(request)}`,
    )
    return response
  }

  if (currentPath.startsWith("/negociar/")) {
    // Página própria do chat nunca roda em iframe de terceiros.
    const response = await updateSession(request)
    response.headers.set("X-Frame-Options", "SAMEORIGIN")
    return response
  }

  return await updateSession(request)
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
}
