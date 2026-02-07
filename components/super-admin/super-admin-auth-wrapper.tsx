"use client"

import type React from "react"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { createBrowserClient } from "@/lib/supabase/client"
import type { User } from "@supabase/supabase-js"
import { SuperAdminSidebar, MobileSuperAdminSidebarContext } from "@/components/super-admin/super-admin-sidebar"
import { SuperAdminHeader } from "@/components/super-admin/super-admin-header"

export function SuperAdminAuthWrapper({
  children,
}: {
  children: React.ReactNode
}) {
  const router = useRouter()
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let supabase
    try {
      supabase = createBrowserClient()
    } catch (err) {
      console.error("[v0] Failed to create Supabase client:", err)
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
          console.error("[v0] Auth error:", error)
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

        // Check if user has 'super_admin' role
        const { data: profile, error: profileError } = await supabase
          .from("profiles")
          .select("role, company_id")
          .eq("id", user.id)
          .single()

        if (profileError) {
          console.error("[v0] Profile error:", profileError)
          router.push("/auth/login")
          return
        }

        if (profile?.role !== "super_admin") {
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
      } catch (error) {
        console.error("[v0] Auth check error:", error)
        setError("Authentication error. Please try again.")
      } finally {
        setLoading(false)
      }
    }

    checkAuth()
  }, [router])

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center bg-[var(--sa-bg-primary)]">
        <div className="text-center max-w-md p-6">
          <div className="text-[var(--sa-red)] mb-4">
            <svg className="w-16 h-16 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-[var(--sa-text-primary)] mb-2">Erro de Autenticação</h2>
          <p className="text-[var(--sa-text-secondary)] mb-4">{error}</p>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-gradient-to-r from-[var(--sa-gold-400)] to-[var(--sa-gold-600)] text-[var(--sa-bg-primary)] rounded-lg hover:opacity-90 transition-colors font-semibold"
          >
            Tentar Novamente
          </button>
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-[var(--sa-bg-primary)]">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-[var(--sa-gold-400)] border-r-transparent align-[-0.125em] motion-reduce:animate-[spin_1.5s_linear_infinite]" />
          <p className="mt-4 text-sm text-[var(--sa-text-secondary)]">Carregando...</p>
        </div>
      </div>
    )
  }

  if (!user) {
    return null
  }

  return (
    <MobileSuperAdminSidebarContext.Provider value={{ isMobileMenuOpen, setIsMobileMenuOpen }}>
      <div className="flex h-screen bg-[var(--sa-bg-primary)] overflow-hidden">
        {/* Desktop Sidebar */}
        <div className="hidden lg:block lg:w-64 lg:flex-shrink-0">
          <SuperAdminSidebar user={user} />
        </div>

        {/* Main Content Area */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <SuperAdminHeader user={user} />
          <main className="flex-1 overflow-y-auto bg-[var(--sa-bg-primary)]">
            {children}
          </main>
        </div>
      </div>
    </MobileSuperAdminSidebarContext.Provider>
  )
}
