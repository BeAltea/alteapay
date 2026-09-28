"use server"

import { clientIpHash, resolveClientIp } from "@/lib/http/client-ip"
import { createServerClient } from "@/lib/supabase/server"
import { headers } from "next/headers"

interface LogSecurityEventParams {
  event_type:
    | "login"
    | "logout"
    | "failed_login"
    | "data_access"
    | "data_export"
    | "data_delete"
    | "config_change"
    | "permission_change"
    | "api_call"
    | "integration_call"
    | "user_created"
    | "user_updated"
    | "user_deleted"
    | "company_created"
    | "company_updated"
    | "company_deleted"
    | "credit_analysis"
    | "report_generated"
  severity?: "low" | "medium" | "high" | "critical"
  action: string
  resource_type?: string
  resource_id?: string
  metadata?: Record<string, any>
  status?: "success" | "failed" | "blocked" | "pending"
  user_id?: string
  company_id?: string
}

export async function logSecurityEvent(params: LogSecurityEventParams) {
  try {
    const supabase = await createServerClient()

    if (!supabase) {
      console.error("[v0] ❌ Failed to create Supabase client for security logging")
      return
    }

    const headersList = await headers()

    // Get current user from session
    const {
      data: { user },
    } = await supabase.auth.getUser()

    // IP: nunca o 1º elemento do X-Forwarded-For (escrito pelo cliente) nem o IP
    // em claro. Grava o hash salgado (CLIENT_IP_HASH_SALT) do IP da fonte
    // confiável (TRUSTED_CLIENT_IP_SOURCE, lib/http/client-ip.ts); sem IP
    // confiável ou sem sal → null. Nenhum consumidor lê o IP em claro.
    const ip_address = clientIpHash(resolveClientIp(headersList))
    const user_agent = headersList.get("user-agent") || "Unknown"

    // Get user profile for additional info
    let user_email = user?.email || "system@alteapay.com"
    let company_id = params.company_id

    if (user?.id && !company_id) {
      const { data: profile } = await supabase.from("profiles").select("email, company_id").eq("id", user.id).single()

      if (profile) {
        user_email = profile.email || user_email
        company_id = profile.company_id
      }
    }

    // Insert security event
    const { error } = await supabase.from("security_events").insert({
      event_type: params.event_type,
      severity: params.severity || "medium",
      user_id: params.user_id || user?.id,
      user_email,
      company_id,
      ip_address,
      user_agent,
      action: params.action,
      resource_type: params.resource_type,
      resource_id: params.resource_id,
      metadata: params.metadata || {},
      status: params.status || "success",
    })

    if (error) {
      console.error("[v0] ❌ Error logging security event:", error)
    }
  } catch (error) {
    console.error("[v0] ❌ Failed to log security event:", error instanceof Error ? error.message : error)
  }
}
