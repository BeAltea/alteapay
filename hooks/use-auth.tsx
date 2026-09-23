"use client"

import type React from "react"
import { createContext, useContext, useState, useEffect, useRef } from "react"
import { createClient } from "@/lib/supabase/client"
import type { User } from "@supabase/supabase-js"
import { secureSignOut, recordSessionStart, isJourneyPath } from "@/lib/auth-utils"

interface Profile {
  id: string
  email: string
  full_name: string | null
  role: "super_admin" | "admin" | "user"
  company_id: string | null
}

interface AuthContextType {
  user: User | null
  profile: Profile | null
  loading: boolean
  companyId: string | null
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)
  const supabase = createClient()

  const fetchingRef = useRef(false)
  const lastFetchRef = useRef<number>(0)
  const mountedRef = useRef(true)

  useEffect(() => {
    // Rotas da jornada do devedor (/n/, /c/, /t/, /negociar) NÃO usam sessão
    // Supabase de admin. Não rodar getUser/onAuthStateChange/recordSessionStart
    // aqui — o chat do devedor tem a própria sessão (cookie + modal). Sem isso, o
    // auth do admin do operador logado vaza para dentro do chat e o dispara.
    if (isJourneyPath()) {
      setLoading(false)
      return
    }

    mountedRef.current = true

    const fetchUser = async () => {
      // Evitar múltiplas requisições simultâneas
      if (fetchingRef.current) {
        return
      }

      // Debounce de 2 segundos entre requisições
      const now = Date.now()
      if (now - lastFetchRef.current < 2000) {
        return
      }

      fetchingRef.current = true
      lastFetchRef.current = now

      try {
        const {
          data: { user: authUser },
          error: userError,
        } = await supabase.auth.getUser()

        if (!mountedRef.current) return

        if (userError || !authUser) {
          setUser(null)
          setProfile(null)
          setLoading(false)
          return
        }

        setUser(authUser)

        const { data: profileData, error: profileError } = await supabase
          .from("profiles")
          .select("id, email, full_name, role, company_id")
          .eq("id", authUser.id)
          .single()

        if (!mountedRef.current) return

        if (profileError) {
          console.error("[v0] Erro ao carregar perfil:", profileError)
          setProfile(null)
        } else {
          setProfile(profileData)
        }
      } catch (error) {
        if (mountedRef.current) {
          console.error("[v0] Erro na autenticação:", error)
        }
      } finally {
        if (mountedRef.current) {
          setLoading(false)
          fetchingRef.current = false
        }
      }
    }

    fetchUser()

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mountedRef.current) return

      if (session?.user) {
        setUser(session.user)
        lastFetchRef.current = 0
        fetchUser()
        // Record session start for timeout tracking
        recordSessionStart()
      } else {
        setUser(null)
        setProfile(null)
      }
    })

    return () => {
      mountedRef.current = false
      subscription.unsubscribe()
    }
  }, [])

  const signOut = async () => {
    await secureSignOut({ reason: "user_initiated" })
    setUser(null)
    setProfile(null)
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        loading,
        companyId: profile?.company_id || null,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)

  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider")
  }

  return context
}
