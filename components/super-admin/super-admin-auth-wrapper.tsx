"use client"

import type React from "react"
import { createContext, useContext, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { createBrowserClient } from "@/lib/supabase/client"
import type { User } from "@supabase/supabase-js"
import { SuperAdminSidebar, MobileSuperAdminSidebarContext } from "@/components/super-admin/super-admin-sidebar"
import { SuperAdminHeader } from "@/components/super-admin/super-admin-header"
import { Eye } from "lucide-react"

// Context for user role - allows components to check if user is viewer
interface SuperAdminContextType {
  user: User | null
  role: string | null
  companyId: string | null
  isViewer: boolean
  canPerformActions: boolean
}

const SuperAdminContext = createContext<SuperAdminContextType>({
  user: null,
  role: null,
  companyId: null,
  isViewer: false,
  canPerformActions: true,
})

export function useSuperAdminContext() {
  return useContext(SuperAdminContext)
}

// Demo/Viewer banner component
function DemoBanner() {
  return (
    <div className="bg-amber-50 border-b border-amber-200 px-4 py-2 flex items-center gap-2 text-sm text-amber-800">
      <Eye className="w-4 h-4 flex-shrink-0" />
      <span>
        <strong>Modo Demonstracao</strong> — Voce esta navegando em modo somente leitura.
        Nenhuma acao pode ser executada nesta conta.
      </span>
    </div>
  )
}

export function SuperAdminAuthWrapper({
  children,
}: {
  children: React.ReactNode
}) {
  const router = useRouter()
  const [user, setUser] = useState<User | null>(null)
  const [role, setRole] = useState<string | null>(null)
  const [companyId, setCompanyId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isViewer = role === "viewer"
  const canPerformActions = role !== "viewer"

  useEffect(() => {
    let supabase
    try {
      supabase = createBrowserClient()
    } catch (err) {
      console.error("[AlteaPay] Failed to create Supabase client:", err)
      setError("Failed to initialize authentication. Please check your configuration.")
      setLoading(false)
      return
    }

    const checkAuth = async () => {
      try {
        const {
          data: { user },
          error,
        } = await supabase.auth.getUser()

        if (error) {
          console.error("[AlteaPay] Auth error:", error)
          if (error.message.includes("Failed to fetch")) {
            setError("Network error. Please check your internet connection.")
            setLoading(false)
            return
          }
          router.push("/auth/login")
          return
        }

        if (!user) {
          router.push("/auth/login")
          return
        }

        // Check if user has allowed role
        const { data: profile, error: profileError } = await supabase
          .from("profiles")
          .select("role, company_id")
          .eq("id", user.id)
          .single()

        if (profileError) {
          console.error("[AlteaPay] Profile error:", profileError)
          router.push("/auth/login")
          return
        }

        // Allow both super_admin and viewer roles
        const allowedRoles = ["super_admin", "viewer"]
        if (!allowedRoles.includes(profile?.role || "")) {
          // Redirect based on role
          if (profile?.role === "admin") {
            router.push("/dashboard")
          } else if (profile?.role === "user") {
            router.push("/user-dashboard")
          } else {
            router.push("/auth/login")
          }
          return
        }

        setUser(user)
        setRole(profile?.role || null)
        setCompanyId(profile?.company_id || null)
      } catch (error) {
        console.error("[AlteaPay] Auth check error:", error)
        setError("Authentication error. Please try again.")
      } finally {
        setLoading(false)
      }
    }

    checkAuth()
  }, [router])

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-50 dark:bg-gray-900">
        <div className="text-center max-w-md p-6">
          <div className="text-red-500 mb-4">
            <svg className="w-16 h-16 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">Erro de Autenticacao</h2>
          <p className="text-gray-600 dark:text-gray-400 mb-4">{error}</p>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            Tentar Novamente
          </button>
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-50 dark:bg-gray-900">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent align-[-0.125em] motion-reduce:animate-[spin_1.5s_linear_infinite]" />
          <p className="mt-4 text-sm text-gray-600 dark:text-gray-400">Carregando...</p>
        </div>
      </div>
    )
  }

  if (!user) {
    return null
  }

  return (
    <SuperAdminContext.Provider value={{ user, role, companyId, isViewer, canPerformActions }}>
      <MobileSuperAdminSidebarContext.Provider value={{ isMobileMenuOpen, setIsMobileMenuOpen }}>
        <div className="flex h-screen bg-gray-50 dark:bg-gray-900 overflow-hidden">
          {/* Desktop Sidebar */}
          <div className="hidden lg:block lg:w-64 lg:flex-shrink-0">
            <SuperAdminSidebar user={user} />
          </div>

          {/* Main Content Area */}
          <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
            <SuperAdminHeader user={user} />
            {/* Demo banner for viewer role */}
            {isViewer && <DemoBanner />}
            {/* min-h-0 lets this flex child shrink so the scroll area computes
                its height correctly and never clips the top (page title). */}
            <main className="flex-1 min-h-0 overflow-y-auto">
              <div className="p-4 sm:p-6 lg:p-8">{children}</div>
            </main>
          </div>
        </div>
      </MobileSuperAdminSidebarContext.Provider>
    </SuperAdminContext.Provider>
  )
}
