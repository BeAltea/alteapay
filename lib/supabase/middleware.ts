import { createServerClient } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"
import { getServerSupabaseUrl } from "./url"

// Primeiro segmento das rotas REAIS do app (app/*). Usado para distinguir uma
// rota protegida existente (usuário anônimo → redirect p/ "/") de um path que
// simplesmente NÃO existe (usuário anônimo → deixa o Next renderizar o
// not-found = 404 real, em vez do "soft-404" 307→/ que prejudica o SEO).
// Manter em sincronia ao adicionar novas rotas top-level em app/.
const KNOWN_ROUTE_SEGMENTS = new Set([
  "api", "auth", "create-users", "dashboard", "demo", "dev", "empresa",
  "localize", "negociar", "portal", "super-admin", "test-dark", "user-dashboard", "c", "t", "n",
])

// --- Gate D13 da jornada pública /c/[token] ---------------------------------
// Regras:
//   - CHAT_JOURNEY_ENABLED !== "true"  → 404 (rota "não existe").
//   - flag on + tenant.journey_public_enabled = true  → passa (o layout decide).
//   - flag on + journey_public_enabled = false (modo admin-only) → exige sessão
//     Supabase autenticada com role admin/super_admin; sem ela → 404 (não 403).
// O lookup usa PostgREST com service role (mesmo padrão de embedFrameAncestors
// em middleware.ts) e é uma única leitura indexada por token_hash.
async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest("SHA-256", data)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

/** Resolve journey_public_enabled do tenant dono do token. null = desconhecido. */
async function journeyPublicEnabledForToken(token: string): Promise<boolean | null> {
  try {
    const base = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!base || !key) return null
    const headers = { apikey: key, Authorization: `Bearer ${key}` }
    const tokenHash = await sha256Hex(token)
    const tokRes = await fetch(
      `${base}/rest/v1/chat_access_tokens?token_hash=eq.${tokenHash}&select=company_id&limit=1`,
      { headers },
    )
    if (!tokRes.ok) return null
    const toks = (await tokRes.json()) as Array<{ company_id: string }>
    const companyId = toks[0]?.company_id
    if (!companyId) return null
    const cfgRes = await fetch(
      `${base}/rest/v1/tenant_chat_config?company_id=eq.${companyId}&select=journey_public_enabled&limit=1`,
      { headers },
    )
    if (!cfgRes.ok) return null
    const cfgs = (await cfgRes.json()) as Array<{ journey_public_enabled: boolean }>
    return Boolean(cfgs[0]?.journey_public_enabled)
  } catch {
    return null
  }
}

/** Resolve journey_public_enabled do tenant dono do SLUG genérico. null = desconhecido.
 *  Match por branding->>'slug'; fallback: nome da empresa slugificado. */
async function journeyPublicEnabledForSlug(slug: string): Promise<boolean | null> {
  try {
    const base = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!base || !key) return null
    const headers = { apikey: key, Authorization: `Bearer ${key}` }
    const clean = slug.trim().toLowerCase()

    // 1) branding->>'slug' explícito
    const bySlug = await fetch(
      `${base}/rest/v1/tenant_chat_config?branding->>slug=eq.${encodeURIComponent(clean)}&select=journey_public_enabled&limit=1`,
      { headers },
    )
    if (bySlug.ok) {
      const rows = (await bySlug.json()) as Array<{ journey_public_enabled: boolean }>
      if (rows.length > 0) return Boolean(rows[0].journey_public_enabled)
    }

    // 2) fallback pelo nome da empresa slugificado
    const companiesRes = await fetch(`${base}/rest/v1/companies?select=id,name`, { headers })
    if (!companiesRes.ok) return null
    const companies = (await companiesRes.json()) as Array<{ id: string; name: string }>
    const slugify = (n: string) =>
      (n ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
        .replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")
    const match = companies.find((c) => slugify(c.name) === clean)
    if (!match) return null
    const cfgRes = await fetch(
      `${base}/rest/v1/tenant_chat_config?company_id=eq.${match.id}&select=journey_public_enabled&limit=1`,
      { headers },
    )
    if (!cfgRes.ok) return null
    const cfgs = (await cfgRes.json()) as Array<{ journey_public_enabled: boolean }>
    // sem config = público desligado por padrão (indeterminado seguro)
    return cfgs.length > 0 ? Boolean(cfgs[0].journey_public_enabled) : false
  } catch {
    return null
  }
}

/** Resolve o estado do LINK ÚNICO público /n/{code}: liga só se
 *  public_link_enabled=true E (sem validade OU validade no futuro).
 *  null = desconhecido/inválido → tratado como desligado (seguro). */
async function publicLinkEnabledForCode(code: string): Promise<boolean | null> {
  try {
    const base = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!base || !key) return null
    const clean = code.trim()
    // 6–64 alfanuméricos: rejeita cedo lixo/injeção (mesma regra do public-link.ts).
    if (!/^[A-Za-z0-9]{6,64}$/.test(clean)) return false
    const headers = { apikey: key, Authorization: `Bearer ${key}` }
    const res = await fetch(
      `${base}/rest/v1/tenant_chat_config?public_link_code=eq.${encodeURIComponent(clean)}&select=public_link_enabled,public_link_valid_until&limit=1`,
      { headers },
    )
    if (!res.ok) return null
    const rows = (await res.json()) as Array<{
      public_link_enabled: boolean
      public_link_valid_until: string | null
    }>
    if (rows.length === 0) return false
    if (!rows[0].public_link_enabled) return false
    const until = rows[0].public_link_valid_until
    if (until) {
      const t = Date.parse(until)
      if (Number.isFinite(t) && t < Date.now()) return false
    }
    return true
  } catch {
    return null
  }
}

/** true se o usuário autenticado tem role admin/super_admin (para o modo admin-only). */
async function requestUserIsAdmin(request: NextRequest): Promise<boolean> {
  try {
    const supabase = createServerClient(
      getServerSupabaseUrl(),
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll()
          },
          setAll() {
            /* read-only aqui */
          },
        },
      },
    )
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return false
    const service = createServerClient(
      getServerSupabaseUrl(),
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { cookies: { getAll: () => [], setAll: () => {} } },
    )
    const { data: profile } = await service
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single()
    return profile?.role === "super_admin" || profile?.role === "admin"
  } catch {
    return false
  }
}

/** Aplica o gate D13 (jornada /c/{token} e endpoint genérico /t/{slug}/negociar).
 *  Retorna NextResponse (404) para bloquear, ou null p/ seguir. */
export async function journeyGate(request: NextRequest): Promise<NextResponse | null> {
  const currentPath = request.nextUrl.pathname
  const isCampaign = currentPath.startsWith("/c/")
  const isGeneric = currentPath.startsWith("/t/")
  const isPublicLink = currentPath.startsWith("/n/")
  if (!isCampaign && !isGeneric && !isPublicLink) return null

  if (process.env.CHAT_JOURNEY_ENABLED !== "true") {
    return new NextResponse(null, { status: 404 })
  }

  // --- LINK ÚNICO /n/{code} ---------------------------------------------------
  // Espelha /c/ e /t/ (CHAT_JOURNEY_ENABLED + public_link_enabled). Diferença
  // deliberada: quando o link está desligado/expirado/desconhecido, NÃO
  // devolvemos 404 nem redirect — deixamos passar para a PÁGINA renderizar a
  // casca neutra "não há negociação disponível", evitando enumeração por status.
  // Admin/super_admin logado sempre passa (preview).
  if (isPublicLink) {
    const code = currentPath.split("/")[2] ?? ""
    const enabled = code ? await publicLinkEnabledForCode(code) : false
    if (enabled === true) return null
    // desligado/indeterminado: admin passa (preview); público segue p/ a página
    // neutra (a própria page.tsx só revela algo se resolvePublicLink der ok).
    const isAdmin = await requestUserIsAdmin(request)
    if (isAdmin) return null
    return null
  }

  let publicEnabled: boolean | null = null
  if (isCampaign) {
    const token = currentPath.split("/")[2] ?? ""
    publicEnabled = token ? await journeyPublicEnabledForToken(token) : null
  } else {
    // /t/{slug}/negociar — o slug é o 2º segmento
    const slug = currentPath.split("/")[2] ?? ""
    publicEnabled = slug ? await journeyPublicEnabledForSlug(slug) : null
  }

  // Modo público explicitamente ligado → segue (o layout valida token/slug).
  if (publicEnabled === true) return null

  // Público desligado ou indeterminado → só passa para admin/super_admin logado.
  const isAdmin = await requestUserIsAdmin(request)
  if (isAdmin) return null
  return new NextResponse(null, { status: 404 })
}

export async function updateSession(request: NextRequest) {
  const currentPath = request.nextUrl.pathname
  const url = request.nextUrl.clone()

  // Verifica se é um callback de recuperação de senha do Supabase
  // O link vem no formato: /?token=xxx&type=recovery ou com hash #access_token=xxx
  const token = url.searchParams.get("token")
  const type = url.searchParams.get("type")
  
  // Se vier token de recovery na URL raiz, redireciona para /auth/confirm
  if (currentPath === "/" && token && type === "recovery") {
    url.pathname = "/auth/confirm"
    url.searchParams.set("token_hash", token)
    url.searchParams.set("type", "recovery")
    return NextResponse.redirect(url)
  }

  // Verifica se há access_token e type=recovery no hash (após processamento do Supabase)
  // Isso acontece quando o Supabase redireciona de volta após verificar o token
  const accessToken = url.searchParams.get("access_token")
  const refreshToken = url.searchParams.get("refresh_token")
  const tokenType = url.searchParams.get("type")
  
  if (currentPath === "/" && accessToken && tokenType === "recovery") {
    // Redireciona para reset-password mantendo os tokens na URL para o cliente processar
    url.pathname = "/auth/reset-password"
    return NextResponse.redirect(url)
  }

  if (
    currentPath.startsWith("/_next") ||
    currentPath.startsWith("/api/") ||
    currentPath.startsWith("/_vercel") ||
    currentPath.includes(".") ||
    currentPath === "/favicon.ico"
  ) {
    return NextResponse.next()
  }

  let supabaseResponse = NextResponse.next({
    request,
  })

  try {
    const supabase = createServerClient(
      getServerSupabaseUrl(),
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll()
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
            supabaseResponse = NextResponse.next({
              request,
            })
            cookiesToSet.forEach(({ name, value, options }) => supabaseResponse.cookies.set(name, value, options))
          },
        },
      },
    )

    const publicPaths = ["/", "/auth/login", "/auth/register", "/auth/portal-register", "/auth/verify-email", "/auth/callback", "/auth/error", "/auth/reset-password", "/auth/forgot-password", "/auth/confirm"]
    // /negociar: chat público do devedor (auth pelo token de handoff, não por
    // usuário Supabase). /demo e /dev: páginas locais de validação mock.
    const isPublicPath =
      publicPaths.includes(currentPath) ||
      currentPath.startsWith("/auth/") ||
      currentPath.startsWith("/negociar") ||
      currentPath.startsWith("/demo") ||
      currentPath.startsWith("/dev")

    let user = null
    let userError = null

    try {
      const { data, error } = await supabase.auth.getUser()
      user = data.user
      userError = error
    } catch (error) {
      if (isPublicPath) {
        return supabaseResponse
      }
      userError = error
    }

    if ((!user || userError) && isPublicPath) {
      return supabaseResponse
    }

    if ((!user || userError) && !isPublicPath) {
      const seg = currentPath.split("/")[1] ?? ""
      // Rota protegida existente: mantém o portão de login (redirect p/ "/").
      if (KNOWN_ROUTE_SEGMENTS.has(seg)) {
        const url = request.nextUrl.clone()
        url.pathname = "/"
        return NextResponse.redirect(url)
      }
      // Path inexistente: NÃO redireciona — segue para o Next renderizar o
      // not-found (404 real + página amigável), evitando o soft-404.
      return supabaseResponse
    }

    if (user && !userError) {
      try {
        const serviceSupabase = createServerClient(
          getServerSupabaseUrl(),
          process.env.SUPABASE_SERVICE_ROLE_KEY!,
          {
            cookies: {
              getAll() {
                return request.cookies.getAll()
              },
              setAll(cookiesToSet) {
                cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
                supabaseResponse = NextResponse.next({
                  request,
                })
                cookiesToSet.forEach(({ name, value, options }) => supabaseResponse.cookies.set(name, value, options))
              },
            },
          },
        )

        const { data: profile, error: profileError } = await serviceSupabase
          .from("profiles")
          .select("role, company_id")
          .eq("id", user.id)
          .single()

        let userRole = profile?.role || "user"

        if (profileError && profileError.code === "PGRST116") {
          const { data: newProfile, error: insertError } = await serviceSupabase
            .from("profiles")
            .insert({
              id: user.id,
              email: user.email,
              role: "user",
              full_name: user.user_metadata?.full_name || null,
              company_id: null,
            })
            .select("role, company_id")
            .single()

          if (!insertError && newProfile) {
            userRole = newProfile.role
          }
        }

        // Check if user is a final_client (by checking final_clients table or user_metadata)
        const isFinalClient = user.user_metadata?.role === "final_client"
        if (!isFinalClient && userRole === "user") {
          // Check if there's a final_clients record for this user
          const { data: finalClientRecord } = await serviceSupabase
            .from("final_clients")
            .select("id")
            .eq("user_id", user.id)
            .maybeSingle()

          if (finalClientRecord) {
            userRole = "final_client"
          }
        } else if (isFinalClient) {
          userRole = "final_client"
        }

        // Redirect authenticated users from landing/auth pages to their dashboard
        const authPagesToRedirect = ["/", "/auth/login", "/auth/register"]
        if (authPagesToRedirect.includes(currentPath) && user) {
          const url = request.nextUrl.clone()
          if (userRole === "super_admin" || userRole === "viewer") {
            url.pathname = "/super-admin"
          } else if (userRole === "admin") {
            url.pathname = "/dashboard"
          } else if (userRole === "final_client") {
            url.pathname = "/portal"
          } else if (userRole === "localize_only") {
            url.pathname = "/localize"
          } else {
            url.pathname = "/user-dashboard"
          }
          return NextResponse.redirect(url)
        }

        // Access control: redirect to appropriate dashboard based on role
        const getDefaultPath = (role: string) => {
          switch (role) {
            case "super_admin": return "/super-admin"
            case "viewer": return "/super-admin" // Viewer has read-only access to super-admin
            case "admin": return "/dashboard"
            case "final_client": return "/portal"
            case "localize_only": return "/localize"
            default: return "/user-dashboard"
          }
        }

        // Allow both super_admin and viewer roles to access super-admin routes
        // Viewer role is read-only and restricted to their assigned company
        const superAdminAllowedRoles = ["super_admin", "viewer"]
        if (currentPath.startsWith("/super-admin") && !superAdminAllowedRoles.includes(userRole)) {
          const url = request.nextUrl.clone()
          url.pathname = getDefaultPath(userRole)
          return NextResponse.redirect(url)
        }

        if (
          currentPath.startsWith("/dashboard") &&
          !currentPath.startsWith("/user-dashboard") &&
          userRole !== "admin"
        ) {
          const url = request.nextUrl.clone()
          url.pathname = getDefaultPath(userRole)
          return NextResponse.redirect(url)
        }

        if (currentPath.startsWith("/user-dashboard") && userRole !== "user") {
          const url = request.nextUrl.clone()
          url.pathname = getDefaultPath(userRole)
          return NextResponse.redirect(url)
        }

        // Final clients can only access /portal
        if (currentPath.startsWith("/portal") && userRole !== "final_client") {
          const url = request.nextUrl.clone()
          url.pathname = getDefaultPath(userRole)
          return NextResponse.redirect(url)
        }

        // Localize page: only localize_only and super_admin can access
        const localizeAllowedRoles = ["localize_only", "super_admin"]
        if (currentPath.startsWith("/localize") && !localizeAllowedRoles.includes(userRole)) {
          const url = request.nextUrl.clone()
          url.pathname = getDefaultPath(userRole)
          return NextResponse.redirect(url)
        }

        // localize_only users can ONLY access /localize (restrict from all other dashboards)
        if (userRole === "localize_only" && !currentPath.startsWith("/localize")) {
          const url = request.nextUrl.clone()
          url.pathname = "/localize"
          return NextResponse.redirect(url)
        }
      } catch (error) {
        console.error("[v0] Erro ao verificar perfil:", error)
      }
    }

    return supabaseResponse
  } catch (error) {
    console.error("[v0] Erro no middleware:", error)
    return supabaseResponse
  }
}
