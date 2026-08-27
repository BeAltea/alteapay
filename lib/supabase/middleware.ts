import { createServerClient } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"

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
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
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
      const url = request.nextUrl.clone()
      url.pathname = "/"
      return NextResponse.redirect(url)
    }

    if (user && !userError) {
      try {
        const serviceSupabase = createServerClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
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
