"use client"

import { createClient } from "@/lib/supabase/client"

// Session storage keys
const SESSION_START_KEY = "altea_session_start"
const LAST_ACTIVITY_KEY = "altea_last_activity"

// Prefixos das rotas da JORNADA DO DEVEDOR (/n/{code}, /c/{token}, /t/{slug},
// /negociar). Essas páginas NÃO usam sessão Supabase de admin — o devedor
// autentica via cookie próprio de chat (`alteapay_chat_session` + modal em
// components/journey/chat.tsx). O AuthProvider e o SessionMonitor (timeout de
// inatividade/máximo do admin) devem ser NO-OP nessas rotas: nunca chamar
// getUser, nunca iniciar o timer, NUNCA secureSignOut/redirect p/ /auth/login.
const JOURNEY_PATH_PREFIXES = ["/n/", "/c/", "/t/", "/negociar"]

/**
 * Retorna true se o path informado (ou o pathname atual do window) pertence à
 * jornada do devedor e, portanto, deve ficar totalmente isento do mecanismo de
 * sessão/timeout do admin.
 */
export function isJourneyPath(pathname?: string | null): boolean {
  const path =
    pathname ?? (typeof window !== "undefined" ? window.location.pathname : "")
  if (!path) return false
  return JOURNEY_PATH_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(prefix),
  )
}

/**
 * Records the session start time
 */
export function recordSessionStart() {
  if (typeof window === "undefined") return

  const now = Date.now()
  // Only set session start if not already set (i.e., new login)
  if (!sessionStorage.getItem(SESSION_START_KEY)) {
    sessionStorage.setItem(SESSION_START_KEY, now.toString())
  }
  sessionStorage.setItem(LAST_ACTIVITY_KEY, now.toString())
}

/**
 * Updates the last activity timestamp
 */
export function updateLastActivity() {
  if (typeof window === "undefined") return
  sessionStorage.setItem(LAST_ACTIVITY_KEY, Date.now().toString())
}

/**
 * Gets the session start time
 */
export function getSessionStart(): number | null {
  if (typeof window === "undefined") return null
  const start = sessionStorage.getItem(SESSION_START_KEY)
  return start ? parseInt(start, 10) : null
}

/**
 * Gets the last activity timestamp
 */
export function getLastActivity(): number | null {
  if (typeof window === "undefined") return null
  const activity = sessionStorage.getItem(LAST_ACTIVITY_KEY)
  return activity ? parseInt(activity, 10) : null
}

/**
 * Clears all session data including localStorage, sessionStorage, and cookies
 */
export function clearAllSessionData() {
  if (typeof window === "undefined") return

  console.log("[v0] Clearing all session data...")

  // Clear localStorage
  try {
    // Get all keys that might be auth-related
    const keysToRemove: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key) {
        // Clear Supabase auth tokens and any app-specific keys
        if (
          key.startsWith("sb-") ||
          key.includes("supabase") ||
          key.includes("auth") ||
          key.includes("altea")
        ) {
          keysToRemove.push(key)
        }
      }
    }
    keysToRemove.forEach((key) => localStorage.removeItem(key))

    // Also clear everything as a safety measure
    localStorage.clear()
  } catch (e) {
    console.error("[v0] Error clearing localStorage:", e)
  }

  // Clear sessionStorage
  try {
    sessionStorage.clear()
  } catch (e) {
    console.error("[v0] Error clearing sessionStorage:", e)
  }

  // Clear cookies (auth-related)
  try {
    const cookies = document.cookie.split(";")
    for (const cookie of cookies) {
      const name = cookie.split("=")[0].trim()
      if (
        name.startsWith("sb-") ||
        name.includes("supabase") ||
        name.includes("auth")
      ) {
        // Clear cookie for various paths
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=${window.location.hostname}`
      }
    }
  } catch (e) {
    console.error("[v0] Error clearing cookies:", e)
  }

  console.log("[v0] Session data cleared")
}

/**
 * Performs a secure sign out with complete session cleanup
 */
export async function secureSignOut(options?: {
  reason?: "inactivity" | "max_session" | "user_initiated"
  showToast?: boolean
}) {
  console.log("[v0] Secure sign out initiated:", options?.reason || "user_initiated")

  try {
    const supabase = createClient()

    // Sign out from Supabase (local scope to avoid server round-trip issues)
    await supabase.auth.signOut({ scope: "local" })
    console.log("[v0] Supabase sign out successful")
  } catch (error) {
    console.error("[v0] Supabase sign out error:", error)
    // Continue with cleanup even if sign out fails
  }

  // Clear all session data
  clearAllSessionData()

  // Build redirect URL with optional reason parameter
  let redirectUrl = "/auth/login"
  if (options?.reason === "inactivity") {
    redirectUrl += "?reason=inactivity"
  } else if (options?.reason === "max_session") {
    redirectUrl += "?reason=session_expired"
  }

  // Force hard redirect to login page
  window.location.href = redirectUrl
}

/**
 * Checks if the current session is still valid
 */
export async function isSessionValid(): Promise<boolean> {
  try {
    const supabase = createClient()
    const { data: { user }, error } = await supabase.auth.getUser()

    if (error || !user) {
      console.log("[v0] Session invalid - no user or error:", error?.message)
      return false
    }

    return true
  } catch (error) {
    console.error("[v0] Error checking session validity:", error)
    return false
  }
}
