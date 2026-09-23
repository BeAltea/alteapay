"use client"

import { useEffect, useRef, useCallback } from "react"
import { useRouter, usePathname } from "next/navigation"
import { useToast } from "@/hooks/use-toast"
import {
  secureSignOut,
  recordSessionStart,
  updateLastActivity,
  getSessionStart,
  getLastActivity,
  isSessionValid,
  isJourneyPath,
} from "@/lib/auth-utils"

// Configuration
const INACTIVITY_TIMEOUT = 30 * 60 * 1000 // 30 minutes
const SESSION_CHECK_INTERVAL = 60 * 1000 // 1 minute
const MAX_SESSION_DURATION = 8 * 60 * 60 * 1000 // 8 hours
const WARNING_BEFORE_TIMEOUT = 5 * 60 * 1000 // 5 minutes warning

// Events that indicate user activity
const ACTIVITY_EVENTS = [
  "mousedown",
  "mousemove",
  "keypress",
  "keydown",
  "scroll",
  "touchstart",
  "click",
  "focus",
]

interface SessionMonitorProps {
  enabled?: boolean
}

export function SessionMonitor({ enabled = true }: SessionMonitorProps) {
  const router = useRouter()
  const pathname = usePathname()
  const { toast } = useToast()

  const checkIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const warningShownRef = useRef(false)
  const isInitializedRef = useRef(false)

  // Handle user activity
  const handleActivity = useCallback(() => {
    updateLastActivity()
    // Reset warning if user becomes active
    if (warningShownRef.current) {
      warningShownRef.current = false
    }
  }, [])

  // Check session status
  const checkSession = useCallback(async () => {
    const now = Date.now()
    const sessionStart = getSessionStart()
    const lastActivity = getLastActivity()

    // Skip check if no session data (user might not be logged in yet)
    if (!sessionStart || !lastActivity) {
      return
    }

    // Check max session duration
    const sessionDuration = now - sessionStart
    if (sessionDuration >= MAX_SESSION_DURATION) {
      console.log("[v0] SessionMonitor - Max session duration exceeded")
      toast({
        title: "Sessao expirada",
        description: "Sua sessao expirou por tempo maximo. Por favor, faca login novamente.",
        variant: "destructive",
      })
      await secureSignOut({ reason: "max_session" })
      return
    }

    // Check inactivity timeout
    const inactivityDuration = now - lastActivity
    if (inactivityDuration >= INACTIVITY_TIMEOUT) {
      console.log("[v0] SessionMonitor - Inactivity timeout exceeded")
      toast({
        title: "Sessao encerrada por inatividade",
        description: "Voce foi desconectado por ficar inativo por muito tempo.",
        variant: "destructive",
      })
      await secureSignOut({ reason: "inactivity" })
      return
    }

    // Show warning before timeout
    const timeUntilTimeout = INACTIVITY_TIMEOUT - inactivityDuration
    if (timeUntilTimeout <= WARNING_BEFORE_TIMEOUT && !warningShownRef.current) {
      warningShownRef.current = true
      const minutesLeft = Math.ceil(timeUntilTimeout / 60000)
      toast({
        title: "Aviso de inatividade",
        description: `Sua sessao sera encerrada em ${minutesLeft} minuto${minutesLeft > 1 ? "s" : ""} por inatividade. Mova o mouse ou pressione uma tecla para continuar.`,
        variant: "default",
      })
    }

    // Periodically verify session with server
    const isValid = await isSessionValid()
    if (!isValid) {
      console.log("[v0] SessionMonitor - Server session invalid")
      toast({
        title: "Sessao invalida",
        description: "Sua sessao foi encerrada. Por favor, faca login novamente.",
        variant: "destructive",
      })
      await secureSignOut({ reason: "user_initiated" })
    }
  }, [toast])

  useEffect(() => {
    // Skip on public/auth pages e nas rotas da jornada do devedor (/n/, /c/,
    // /t/, /negociar): o devedor não é admin e não tem sessão Supabase — o
    // timeout de inatividade/máximo e o secureSignOut (redirect p/ /auth/login)
    // NUNCA podem disparar dentro do chat do devedor.
    if (
      pathname?.startsWith("/auth/") ||
      pathname === "/" ||
      isJourneyPath(pathname) ||
      !enabled
    ) {
      return
    }

    // Initialize session tracking
    if (!isInitializedRef.current) {
      recordSessionStart()
      isInitializedRef.current = true
    }

    // Add activity listeners
    ACTIVITY_EVENTS.forEach((event) => {
      window.addEventListener(event, handleActivity, { passive: true })
    })

    // Start periodic session check
    checkIntervalRef.current = setInterval(checkSession, SESSION_CHECK_INTERVAL)

    // Initial activity record
    handleActivity()

    // Cleanup
    return () => {
      ACTIVITY_EVENTS.forEach((event) => {
        window.removeEventListener(event, handleActivity)
      })

      if (checkIntervalRef.current) {
        clearInterval(checkIntervalRef.current)
      }
    }
  }, [pathname, enabled, handleActivity, checkSession])

  // Handle visibility change (tab focus/blur)
  useEffect(() => {
    if (
      pathname?.startsWith("/auth/") ||
      pathname === "/" ||
      isJourneyPath(pathname) ||
      !enabled
    ) {
      return
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        // Check session immediately when tab becomes visible
        handleActivity()
        checkSession()
      }
    }

    document.addEventListener("visibilitychange", handleVisibilityChange)

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange)
    }
  }, [pathname, enabled, handleActivity, checkSession])

  // This component doesn't render anything visible
  return null
}
