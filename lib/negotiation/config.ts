// Configuração do BFF de negociação (envs + defaults do cluster local).

export const HANDOFF_TOKEN_TTL_HOURS = Number(process.env.NEGOTIATION_TOKEN_TTL_HOURS || "24")

export function agentBaseUrl(): string {
  return (
    process.env.NEGOTIATION_AGENT_URL ||
    "http://negotiation-agent.alteapay-negotiation.svc.cluster.local"
  ).replace(/\/$/, "")
}

/** Token compartilhado v2→agente (x-app-token). Mesmo secret do sentido inverso. */
export function appSharedToken(): string {
  return process.env.APP_SHARED_TOKEN || process.env.AGENT_APP_TOKEN || ""
}

export function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/$/, "")
}

export const MAX_MESSAGE_CHARS = 2000
export const CONSENT_VERSION = "2026-07-02.v1"

/** Data corrente (YYYY-MM-DD) em America/Sao_Paulo — nunca UTC. */
export function todaySaoPaulo(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" })
}

/** Dias em atraso de uma dívida (due_date DATE) contados em America/Sao_Paulo. */
export function agingDays(dueDate: string): number {
  const today = todaySaoPaulo()
  const diffMs = Date.UTC(
    Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10)),
  ) - Date.UTC(
    Number(dueDate.slice(0, 4)), Number(dueDate.slice(5, 7)) - 1, Number(dueDate.slice(8, 10)),
  )
  return Math.max(0, Math.floor(diffMs / 86_400_000))
}
